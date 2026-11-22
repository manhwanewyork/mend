// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), finds the lines each edit names at the first of three
// matching tiers, and changes every file or none. Node 22, standard library
// only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: the patch cannot be read in its format. Carries the stdout line. */
class ParseFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed. Carries the code and the path the failure concerns. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines plus its own line break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseDoc(text: string): Doc {
  let br = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') br = '\r\n';
  if (text === '') return { lines: [], br, eol: false };
  const lines = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    lines.pop();
    eol = true;
  }
  return { lines, br, eol };
}

function serializeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.eol ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  doc(p: string): Doc | null {
    const t = this.get(p);
    return t === null ? null : parseDoc(t);
  }
  setDoc(p: string, d: Doc): void {
    this.now.set(p, serializeDoc(d));
  }
}

interface Ctx {
  strict: boolean;
  moves: { old: string; nw: string }[];
}

type Edit = (tree: Tree, ctx: Ctx) => void;

/* ------------------------------------------------------------------ */
/* Matching (SPEC.md section 5)                                        */
/* ------------------------------------------------------------------ */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions i (from `from`) where O matches lines i, i+1, ... at this tier. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at least once from `from`. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (index into O) or an added line (null). */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * The lines that replace the k matched lines at `at`: a context line is the
 * file's own matched line; at tier 2 every other line is re-indented from
 * O's first line's leading whitespace to the file's first matched line's.
 */
function buildReplacement(lines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  const P = leadingWs(O[0] ?? '');
  const F = leadingWs(lines[at] ?? '');
  return N.map((nl) => {
    if (nl.ctx !== null) return lines[at + nl.ctx]!;
    if (tier !== 2) return nl.text;
    if (nl.text === '' || /^[ \t]+$/.test(nl.text)) return nl.text;
    if (nl.text.startsWith(P)) return F + nl.text.slice(P.length);
    return nl.text;
  });
}

/** O and N built from body lines: context lines belong to both, `-` to O, `+` to N. */
function buildON(body: { kind: 'ctx' | 'old' | 'new'; text: string }[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      N.push({ text: b.text, ctx: O.length });
      O.push(b.text);
    } else if (b.kind === 'old') O.push(b.text);
    else N.push({ text: b.text, ctx: null });
  }
  return { O, N };
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4)                                        */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  A: number;
  O: string[];
  N: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsAfterLastN: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusBs: boolean;
  hasPlus: boolean;
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, one leading a/ or b/ removed. */
function dashPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim().replace(/^[ab]\//, '');
  return p === '/dev/null' ? null : p;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
  const A = Number(m[1]);
  const body: { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0];
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j++;
    } else if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j++;
    } else if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      j++;
    } else if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1) });
      j++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it: a context line
  // whose text is empty (a raw empty line, or one holding a single space).
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  const { O, N } = buildON(body.filter((b) => b.kind !== 'bs'));
  let lastN = -1;
  let lastPlus = -1;
  body.forEach((b, k) => {
    if (b.kind === 'ctx' || b.kind === 'new') lastN = k;
    if (b.kind === 'new') lastPlus = k;
  });
  const bsAfterLastN = lastN >= 0 && body[lastN + 1]?.kind === 'bs';
  const lastPlusBs = lastPlus >= 0 && body[lastPlus + 1]?.kind === 'bs';
  return { hunk: { A, O, N, bsAfterLastN, lastPlusBs, hasPlus: lastPlus >= 0 }, next: j };
}

/** Parse one section's header and hunks, starting at line `start`. Returns the next line to look at. */
function parseSection(lines: string[], start: number, sec: Section): number {
  let i = start;
  let seenHunk = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (seenHunk) return i;
      sec.dashOld = dashPath(l);
      sec.dashNew = dashPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const h = parseHunk(lines, i);
      sec.hunks.push(h.hunk);
      i = h.next;
      seenHunk = true;
      continue;
    }
    if (!seenHunk) {
      if (l.startsWith('--- ')) throw new ParseFault(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) sec.dashNew = dashPath(l);
      else if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l.trimEnd());
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const sec: Section = {
        gitOld: m[1],
        gitNew: m[2],
        dashOld: undefined,
        dashNew: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(sec);
      i = parseSection(lines, i + 1, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        gitOld: undefined,
        gitNew: undefined,
        dashOld: undefined,
        dashNew: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(sec);
      i = parseSection(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new ParseFault(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map(sectionEdit);
}

/** Apply a section's hunks in order to a doc. Throws EditFault('no-match', path) on a failing hunk. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let lines = [...doc.lines];
  let eol = doc.eol;
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      const pos = Math.max(0, Math.min(h.A + d, lines.length));
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...h.N.map((n) => n.text));
      if (atEnd && h.N.length > 0) eol = !h.bsAfterLastN;
      d += h.N.length;
      continue;
    }
    const found = findTier(lines, h.O, strict);
    if (found === null) throw new EditFault('no-match', path);
    const target = h.A - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + h.O.length === lines.length;
    const repl = buildReplacement(lines, best, h.O, h.N, found.tier);
    lines.splice(best, h.O.length, ...repl);
    if (atEnd) eol = !h.bsAfterLastN;
    d += h.N.length - h.O.length;
  }
  return { lines, br: doc.br, eol };
}

function sectionEdit(sec: Section): Edit {
  const oldPath = sec.dashOld !== undefined ? sec.dashOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.dashNew !== undefined ? sec.dashNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const isCreate = oldPath === null || sec.newFile;
  const isDelete = newPath === null || sec.deletedFile;
  return (tree, ctx) => {
    if (isCreate) {
      if (newPath === undefined || newPath === null) throw new EditFault('unsafe', '/dev/null');
      if (!safe(newPath)) throw new EditFault('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      const created: string[] = [];
      for (const h of sec.hunks) for (const n of h.N) if (n.ctx === null) created.push(n.text);
      let eol = false;
      if (created.length > 0) {
        eol = true;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          const h = sec.hunks[k]!;
          if (h.hasPlus) {
            eol = !h.lastPlusBs;
            break;
          }
        }
      }
      tree.now.set(newPath, created.length === 0 ? '' : created.join('\n') + (eol ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldPath === undefined || oldPath === null) throw new EditFault('unsafe', '/dev/null');
      if (!safe(oldPath)) throw new EditFault('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new EditFault('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === undefined || newPath === undefined) throw new EditFault('unsafe', '/dev/null');
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new EditFault('unsafe', oldPath);
      if (!safe(newPath)) throw new EditFault('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new EditFault('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      const out = applyHunks(parseDoc(before), sec.hunks, ctx.strict, oldPath);
      tree.now.set(newPath, serializeDoc(out));
      tree.now.set(oldPath, null);
      ctx.moves.push({ old: oldPath, nw: newPath });
      return;
    }
    if (!safe(oldPath)) throw new EditFault('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new EditFault('missing', oldPath);
    const out = applyHunks(parseDoc(before), sec.hunks, ctx.strict, oldPath);
    tree.setDoc(oldPath, out);
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const tr = lines[j]!.trim();
      if (tr === '' || tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(`error: parse ${s + 1}`);
    let e = s + 1;
    while (e < lines.length) {
      const t = lines[e]!.trimEnd();
      if (t === '=======') break;
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new ParseFault(`error: parse ${s + 1}`);
      e++;
    }
    if (e >= lines.length) throw new ParseFault(`error: parse ${s + 1}`);
    let r = e + 1;
    while (r < lines.length) {
      const t = lines[r]!.trimEnd();
      if (t === '>>>>>>> REPLACE') break;
      if (t === '<<<<<<< SEARCH') throw new ParseFault(`error: parse ${s + 1}`);
      r++;
    }
    if (r >= lines.length) throw new ParseFault(`error: parse ${s + 1}`);
    const old = lines.slice(s + 1, e);
    const nw = lines.slice(e + 1, r);
    edits.push(searchReplaceEdit(path, old, nw));
    prevEnd = r;
    prevPath = path;
    i = r + 1;
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, old: string[], nw: string[]): Edit {
  return (tree, ctx) => {
    if (!safe(path)) throw new EditFault('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const doc = parseDoc(before);
    const found = findTier(doc.lines, old, ctx.strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.occ.length > 1) throw new EditFault('ambiguous', path);
    const at = found.occ[0]!;
    const repl = buildReplacement(doc.lines, at, old, nw.map((t) => ({ text: t, ctx: null })), found.tier);
    const lines = [...doc.lines];
    lines.splice(at, old.length, ...repl);
    tree.setDoc(path, { lines, br: doc.br, eol: doc.eol });
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** A section's raw lines (with absolute indices) up to the next section or `last`; trailing blank lines dropped. */
function collectV4aSection(lines: string[], from: number, last: number): { raw: { text: string; idx: number }[]; next: number } {
  const raw: { text: string; idx: number }[] = [];
  let j = from;
  while (j < last && !isV4aSectionStart(lines[j]!)) {
    raw.push({ text: lines[j]!, idx: j });
    j++;
  }
  while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
  return { raw, next: j };
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const { raw, next } = collectV4aSection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new ParseFault(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new EditFault('unsafe', path);
        if (tree.get(path) !== null) throw new EditFault('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = next;
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const { raw, next } = collectV4aSection(lines, i + 1, last);
      for (const r of raw) {
        if (r.text.trim() !== '') throw new ParseFault(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new EditFault('unsafe', path);
        if (tree.get(path) === null) throw new EditFault('missing', path);
        tree.now.set(path, null);
      });
      i = next;
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const { raw, next } = collectV4aSection(lines, i + 1, last);
      edits.push(updateFileEdit(path, raw, i + 1));
      i = next;
    } else {
      throw new ParseFault(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

function updateFileEdit(path: string, raw: { text: string; idx: number }[], updateLine: number): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
    k++;
  }
  const chunks: { anchor: string | null; eof: boolean; body: { kind: 'ctx' | 'old' | 'new'; text: string }[] }[] = [];
  let cur: { anchor: string | null; eof: boolean; body: { kind: 'ctx' | 'old' | 'new'; text: string }[] } | null = null;
  let firstChunk = true;
  const startChunk = (anchor: string | null): void => {
    cur = { anchor, eof: false, body: [] };
    chunks.push(cur);
  };
  while (k < raw.length) {
    const { text, idx } = raw[k]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      startChunk(anchor === '' ? null : anchor);
      firstChunk = false;
      k++;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new ParseFault(`error: parse ${idx + 1}`);
      cur.eof = true;
      cur = null;
      firstChunk = false;
      k++;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (!firstChunk) throw new ParseFault(`error: parse ${idx + 1}`);
        startChunk(null);
        firstChunk = false;
      }
      if (text === '') cur!.body.push({ kind: 'ctx', text: '' });
      else if (text[0] === ' ') cur!.body.push({ kind: 'ctx', text: text.slice(1) });
      else if (text[0] === '-') cur!.body.push({ kind: 'old', text: text.slice(1) });
      else cur!.body.push({ kind: 'new', text: text.slice(1) });
      k++;
      continue;
    }
    throw new ParseFault(`error: parse ${idx + 1}`);
  }
  const built: Chunk[] = [];
  for (const c of chunks) {
    const { O, N } = buildON(c.body);
    built.push({ anchor: c.anchor, eof: c.eof, O, N });
  }
  if (built.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${updateLine}`);
  return (tree, ctx) => {
    if (!safe(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new EditFault('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const out = applyChunks(parseDoc(before), built, ctx.strict, path);
    if (moveTo !== null) {
      tree.now.set(moveTo, serializeDoc(out));
      tree.now.set(path, null);
      ctx.moves.push({ old: path, nw: moveTo });
    } else {
      tree.setDoc(path, out);
    }
  };
}

/** The first line at or after `cursor` equal to `anchor` at the first tier where one is, or null. */
function findAnchorLine(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let p = cursor; p < lines.length; p++) {
      if (lineEq(lines[p]!, anchor, t)) return p;
    }
  }
  return null;
}

/** Apply a V4A Update File section's chunks in order, tracking the cursor. */
function applyChunks(doc: Doc, chunks: Chunk[], strict: boolean, path: string): Doc {
  let lines = [...doc.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const foundAt = findAnchorLine(lines, ch.anchor, cursor, strict);
      if (foundAt === null) throw new EditFault('no-match', path);
      cursor = foundAt + 1;
    }
    if (ch.O.length === 0) {
      const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines.splice(pos, 0, ...ch.N.map((n) => n.text));
      cursor = pos + ch.N.length;
      continue;
    }
    const found = findTier(lines, ch.O, strict, cursor);
    if (found === null) throw new EditFault('no-match', path);
    let pos: number | null = null;
    for (const p of found.occ) {
      if (ch.eof && p + ch.O.length !== lines.length) continue;
      pos = p;
      break;
    }
    if (pos === null) throw new EditFault('no-match', path);
    const repl = buildReplacement(lines, pos, ch.O, ch.N, found.tier);
    lines.splice(pos, ch.O.length, ...repl);
    cursor = pos + repl.length;
  }
  return { lines, br: doc.br, eol: doc.eol };
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const crlf = parseDoc(before).br === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      const nw = norm(newStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count++;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const out = t.slice(0, at) + nw + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new EditFault('no-match', p);
      const lines = [...doc.lines];
      lines.splice(line, 0, ...add);
      tree.setDoc(p, { lines, br: doc.br, eol: doc.eol });
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFault('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running (sections 1, 2, 10)                                         */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const ctx: Ctx = { strict, moves: [] };
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = outputRows(tree, ctx.moves);
  if (!check) {
    const deleted: string[] = [];
    const written: string[] = [];
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) deleted.push(p);
      else written.push(p);
    }
    // Deletes first (a deleted path may be the parent of a written one),
    // each list in byte order so the write sequence is deterministic.
    const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
    deleted.sort(byBytes);
    written.sort(byBytes);
    for (const p of deleted) rmSync(p, { force: true });
    for (const p of written) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p)!);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

/** The changed paths as output rows, in byte order; a move that succeeded prints as one R line sorted by its new path. */
function outputRows(tree: Tree, moves: { old: string; nw: string }[]): string[] {
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const m of moves) {
    if (changed.get(m.old) === 'D' && changed.get(m.nw) === 'A') {
      used.add(m.old);
      used.add(m.nw);
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  for (const [p, k] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${k} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return rows.map((r) => r.line);
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
