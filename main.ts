// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It implements all of
// SPEC.md: the command line, the output and exit codes, safe paths and format detection (sections 1 to 4), matching
// lines at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9) and the all-or-nothing write (section 10). Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves (old path, new path) by move edits that succeeded, for the `R` lines of section 2. */
  readonly moves: Array<readonly [string, string]> = [];
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
}

type Edit = (tree: Tree) => void;

/** A file as its lines, its own line break, and whether it ends with that break (section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a hunk or chunk body: context (in O and N), old only, or new only (sections 6 and 8). */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** The patch line was empty: an empty context line, dropped at the end of a body (sections 6 and 8). */
  fromEmpty?: boolean;
  /** A `\` line follows this one: no line break after it at the end of the file (section 6). */
  noBreak?: boolean;
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierNorm(tier: number, s: string): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

/** Every start position at which O occurs in lines under one tier's comparison (section 5). */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const want = O.map((l) => tierNorm(tier, l));
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (tierNorm(tier, lines[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs somewhere `pred` allows, with those occurrences (section 5). */
function findTierWhere(lines: string[], O: string[], strict: boolean, pred: (pos: number) => boolean): { tier: number; occ: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(lines, O, tier).filter(pred);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is (section 8). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const want = tierNorm(tier, anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (tierNorm(tier, lines[i]!) === want) return i;
    }
  }
  return -1;
}

/** A tier-2 added line, re-indented from the patch's indent P to the file's F (section 5). */
function reindent(text: string, F: string, P: string): string {
  if (text.trim() === '') return text;
  return text.startsWith(P) ? F + text.slice(P.length) : text;
}

/**
 * Splice a body's items into lines at `at`: context lines are written as the file's own matched lines, added lines
 * as they are (re-indented at tier 2). Returns the new lines and how many were written.
 */
function applyItems(lines: string[], items: BodyItem[], at: number, tier: number): { lines: string[]; written: number } {
  const oLen = items.filter((it) => it.kind !== 'add').length;
  const firstO = items.find((it) => it.kind !== 'add');
  const F = leadWs(lines[at] ?? '');
  const P = firstO === undefined ? '' : leadWs(firstO.text);
  const seg: string[] = [];
  let oi = at;
  for (const it of items) {
    if (it.kind === 'ctx') {
      seg.push(lines[oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else {
      seg.push(tier === 2 ? reindent(it.text, F, P) : it.text);
    }
  }
  return { lines: [...lines.slice(0, at), ...seg, ...lines.slice(at + oLen)], written: seg.length };
}

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
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
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its stated old start A and its body lines (section 6). */
interface UHunk {
  A: number;
  items: BodyItem[];
}

/** One unified section: where each of its paths came from, its flags and its hunks (section 6). */
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

/** The path a `---` or `+++` line names: up to the first tab, spaces removed, one a/ or b/ prefix removed. */
function hdrPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hdrOld ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.hdrNew ?? sec.renameTo ?? sec.gitNew;
    const creation = sec.newFile || oldP === '/dev/null';
    const deletion = !creation && (sec.delFile || newP === '/dev/null');
    if (creation) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const fileLines: string[] = [];
      let lastAdd: BodyItem | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            fileLines.push(it.text);
            lastAdd = it;
          }
        }
      }
      tree.now.set(p, joinFile({ lines: fileLines, br: '\n', final: !(lastAdd !== null && lastAdd.noBreak === true) }));
      return;
    }
    if (deletion) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (o !== n && !safe(n)) throw new Fail('unsafe', n);
    const text = tree.get(o);
    if (text === null) throw new Fail('missing', o);
    if (o !== n && tree.get(n) !== null) throw new Fail('exists', n);
    const fl = splitFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      const O = h.items.filter((it) => it.kind !== 'add').map((it) => it.text);
      const nCount = h.items.filter((it) => it.kind !== 'del').length;
      if (O.length === 0) {
        const adds = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const at = Math.max(0, Math.min(h.A + d, fl.lines.length));
        const atEnd = at === fl.lines.length;
        fl.lines.splice(at, 0, ...adds);
        if (atEnd) {
          const lastItem = h.items[h.items.length - 1];
          fl.final = !(lastItem !== undefined && lastItem.noBreak === true);
        }
        d += adds.length;
      } else {
        const found = findTierWhere(fl.lines, O, strict, () => true);
        if (found === null) throw new Fail('no-match', o);
        const target = h.A - 1 + d;
        let pos = found.occ[0]!;
        for (const cand of found.occ) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const ranToEnd = pos + O.length === fl.lines.length;
        const res = applyItems(fl.lines, h.items, pos, found.tier);
        fl.lines = res.lines;
        if (ranToEnd) {
          let lastNew: BodyItem | undefined;
          for (let k = h.items.length - 1; k >= 0; k -= 1) {
            if (h.items[k]!.kind !== 'del') {
              lastNew = h.items[k];
              break;
            }
          }
          fl.final = !(lastNew !== undefined && lastNew.noBreak === true);
        }
        d += nCount - O.length;
      }
    }
    const out = joinFile(fl);
    if (o !== n) {
      tree.now.set(n, out);
      tree.now.set(o, null);
      tree.moves.push([o, n]);
    } else {
      tree.now.set(o, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = {
      gitOld: null,
      gitNew: null,
      hdrOld: null,
      hdrNew: null,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      delFile: false,
      hasPair: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPair) cur = newSection();
      cur.hdrOld = hdrPath(line.slice(4));
      cur.hdrNew = hdrPath(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { A: parseInt(hm[1]!, 10), items: [] };
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '') {
          hunk.items.push({ kind: 'ctx', text: '', fromEmpty: true });
          i += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') hunk.items.push({ kind: 'ctx', text: l.slice(1) });
        else if (c === '-') hunk.items.push({ kind: 'del', text: l.slice(1) });
        else if (c === '+') hunk.items.push({ kind: 'add', text: l.slice(1) });
        else if (c === '\\') {
          const last = hunk.items[hunk.items.length - 1];
          if (last !== undefined) last.noBreak = true;
        } else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it: a trailing context line whose text is empty, whether
      // the patch line was empty or held only the context marker's space (sections 4 and 6).
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: newLines, br: '\n', final: true }));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const fl = splitFile(text);
    const found = findTierWhere(fl.lines, oldLines, strict, () => true);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    // One shared splice with the other formats: the old lines as old-only items, the new lines as new-only ones,
    // so the tier-2 re-indentation of section 5 is computed the same way everywhere.
    const items: BodyItem[] = [
      ...oldLines.map((t): BodyItem => ({ kind: 'del', text: t })),
      ...newLines.map((t): BodyItem => ({ kind: 'add', text: t })),
    ];
    fl.lines = applyItems(fl.lines, items, found.occ[0]!, found.tier).lines;
    tree.now.set(path, joinFile(fl));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const te = lines[j]!.trimEnd();
      if (te === '=======') {
        eq = j;
        break;
      }
      if (te === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), whether `*** End of File` ended it, and its body lines (section 8). */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** One V4A section (section 8). */
interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  /** An Add File section's lines as add items; fromEmpty marks a line the patch held empty, not a `+` line. */
  addLines: BodyItem[];
  chunks: V4aChunk[];
  line: number;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ lines: sec.addLines.map((it) => it.text), br: '\n', final: true }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const fl = splitFile(text);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const idx = findAnchor(fl.lines, chunk.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', p);
        cursor = idx + 1;
      }
      const O = chunk.items.filter((it) => it.kind !== 'add').map((it) => it.text);
      if (O.length === 0) {
        const adds = chunk.items.map((it) => it.text);
        const at = chunk.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
      } else {
        const found = findTierWhere(fl.lines, O, strict, (pos) => pos >= cursor && (!chunk.eof || pos + O.length === fl.lines.length));
        if (found === null) throw new Fail('no-match', p);
        const res = applyItems(fl.lines, chunk.items, found.occ[0]!, found.tier);
        fl.lines = res.lines;
        cursor = found.occ[0]! + res.written;
      }
    }
    const out = joinFile(fl);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(p, null);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const MOV = '*** Move to: ';
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let curChunk: V4aChunk | null = null;
  const finishSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      // Blank lines at the end of a section are not part of it; a `+` line with empty text is a file line and stays.
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1]!.fromEmpty === true) cur.addLines.pop();
    }
    if (cur.kind === 'upd') {
      const last = cur.chunks[cur.chunks.length - 1];
      if (last !== undefined) {
        // Blank lines at the end of a section are not part of it (sections 4 and 8): a trailing context line
        // whose text is empty, whether the patch line was empty or only whitespace.
        while (last.items.length > 0) {
          const tail = last.items[last.items.length - 1]!;
          if (tail.kind === 'ctx' && tail.text === '') last.items.pop();
          else break;
        }
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
    }
    sections.push(cur);
    cur = null;
    curChunk = null;
  };
  for (let i = firstIdx + 1; i < lastIdx; i += 1) {
    const line = lines[i]!;
    if (line.startsWith(ADD) || line.startsWith(DEL) || line.startsWith(UPD)) {
      finishSection();
      const kind = line.startsWith(ADD) ? 'add' : line.startsWith(DEL) ? 'del' : 'upd';
      const prefix = kind === 'add' ? ADD : kind === 'del' ? DEL : UPD;
      cur = { kind, path: line.slice(prefix.length).trim(), moveTo: null, addLines: [], chunks: [], line: i + 1 };
      curChunk = null;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push({ kind: 'add', text: line.slice(1) });
      else if (line === '') cur.addLines.push({ kind: 'add', text: '', fromEmpty: true });
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // An Update File section: an optional Move to as its first line, then chunks.
    if (line.startsWith(MOV) && cur.chunks.length === 0 && curChunk === null && cur.moveTo === null) {
      cur.moveTo = line.slice(MOV.length).trim();
      continue;
    }
    if (line === '*** End of File') {
      if (curChunk === null) {
        curChunk = { anchor: null, eof: true, items: [] };
        cur.chunks.push(curChunk);
      } else {
        curChunk.eof = true;
      }
      curChunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      cur.chunks.push(curChunk);
      continue;
    }
    if (line === '' && curChunk === null) continue;
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (curChunk === null) {
        curChunk = { anchor: null, eof: false, items: [] };
        cur.chunks.push(curChunk);
      }
      if (line === '') curChunk.items.push({ kind: 'ctx', text: '', fromEmpty: true });
      else if (line[0] === ' ') curChunk.items.push({ kind: 'ctx', text: line.slice(1) });
      else if (line[0] === '-') curChunk.items.push({ kind: 'del', text: line.slice(1) });
      else curChunk.items.push({ kind: 'add', text: line.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  finishSection();
  return sections.map((s) => v4aEdit(s, strict));
}

/** One line of the success output (section 2), with the path it sorts by. */
interface Row {
  key: string;
  line: string;
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Row[] = [];
  const rowByPath = new Map<string, Row>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    rowByPath.set(p, row);
  }
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
    if (tree.original(oldP) === null || finalOf(oldP) !== null) continue;
    if (tree.original(newP) !== null || finalOf(newP) === null) continue;
    const dRow = rowByPath.get(oldP);
    const aRow = rowByPath.get(newP);
    if (dRow === undefined || aRow === undefined) continue;
    rows.splice(rows.indexOf(dRow), 1);
    rows.splice(rows.indexOf(aRow), 1);
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    consumed.add(oldP);
    consumed.add(newP);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
