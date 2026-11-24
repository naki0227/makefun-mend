// mend: one patch tool for every AI edit format.
//
// `node main.ts [options] [PATCH]` reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every
// change or none. SPEC.md is the whole contract; this file implements it
// with the Node 22 standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (see the end of this file): keep
// that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format: the exit-2 line it prints. */
class ParseError {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit that could not be applied: its code and the path it concerns. */
class ApplyError {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** One edit of a patch: apply it to the tree, or throw an ApplyError. */
type Edit = (tree: WorkTree) => void;

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` off each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and no segment is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file as its lines, its own line break, and whether it ends with that break (section 3). */
interface TextFile {
  lines: string[];
  br: string;
  endsWithBreak: boolean;
}

function readTextFile(text: string): TextFile {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const parts = text.split(br);
  if (endsWithBreak) parts.pop();
  return { lines: parts, br, endsWithBreak };
}

function writeTextFile(f: TextFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

/** The tree as the edits leave it: `state` holds what changed (null: deleted). */
class WorkTree {
  private disk = new Map<string, string | null>();
  readonly state = new Map<string, string | null>();
  /** Moves by move edits that succeeded, for the `R` lines of section 2. */
  readonly moves: Array<[string, string]> = [];

  /** The file's text before the patch, or null when it did not exist. */
  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  /** The file's text as earlier edits left it, or null when it is not there. */
  current(p: string): string | null {
    return this.state.has(p) ? this.state.get(p)! : this.before(p);
  }
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function normLine(tier: number, s: string): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimBothWs(s);
}

/** Every start position where `old` occurs in `lines` under one tier's comparison (section 5). */
function findOccurrences(lines: string[], old: string[], tier: number): number[] {
  const want = old.map((l) => normLine(tier, l));
  const found: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(tier, lines[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier at which `old` occurs somewhere `ok` allows, with those occurrences. */
function firstTierWith(
  lines: string[],
  old: string[],
  strict: boolean,
  ok: (pos: number) => boolean,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = findOccurrences(lines, old, tier).filter(ok);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor`, at the first tier where one is (section 8). */
function findAnchorLine(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = normLine(tier, anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(tier, lines[i]!) === want) return i;
    }
  }
  return -1;
}

/** One body line of a hunk or chunk: in both old and new, old only, or new only. */
interface BodyLine {
  side: 'both' | 'old' | 'new';
  text: string;
  /** A `\` line follows this one: no break after it at the file's end. */
  noBreak?: boolean;
  /** This line came from an empty patch line, not from a `+` or context marker. */
  blank?: boolean;
}

/** A new line at tier 2, re-indented from the patch's lead P to the file's lead F (section 5). */
function reindentLine(text: string, fileLead: string, patchLead: string): string {
  if (text.trim() === '') return text;
  return text.startsWith(patchLead) ? fileLead + text.slice(patchLead.length) : text;
}

/**
 * Replace the old lines at `at` with the body's lines: `both` lines are
 * written as the file's own matched lines, `new` lines as they are
 * (re-indented at tier 2). Returns the new lines and how many were written.
 */
function spliceBody(lines: string[], body: BodyLine[], at: number, tier: number): { lines: string[]; written: number } {
  const oldCount = body.filter((b) => b.side !== 'new').length;
  const firstOld = body.find((b) => b.side !== 'new');
  const fileLead = leadWs(lines[at] ?? '');
  const patchLead = firstOld === undefined ? '' : leadWs(firstOld.text);
  const seg: string[] = [];
  let oi = at;
  for (const b of body) {
    if (b.side === 'both') {
      seg.push(lines[oi]!);
      oi += 1;
    } else if (b.side === 'old') {
      oi += 1;
    } else {
      seg.push(tier === 2 ? reindentLine(b.text, fileLead, patchLead) : b.text);
    }
  }
  return { lines: [...lines.slice(0, at), ...seg, ...lines.slice(at + oldCount)], written: seg.length };
}

/** The format of a patch, by the first rule of section 4 that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (section 9), or null when the value is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  const needExisting = (tree: WorkTree): string => {
    if (!isSafePath(p)) throw new ApplyError('unsafe', p);
    const t = tree.current(p);
    if (t === null) throw new ApplyError('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new ApplyError('unsafe', p);
      if (tree.current(p) !== null) throw new ApplyError('exists', p);
      tree.state.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new ApplyError('no-match', p);
      if (count > 1) throw new ApplyError('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.state.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      const before = needExisting(tree);
      const f = readTextFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new ApplyError('no-match', p);
      f.lines.splice(lineNo, 0, ...added);
      tree.state.set(p, writeTextFile(f));
    };
  }
  return null;
}

/** The edits of a JSON patch: one array, or one edit object a line (section 9). */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  const startLine = first + 1;
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseError(`error: parse ${startLine}`);
    }
    if (!Array.isArray(value)) throw new ParseError(`error: parse ${startLine}`);
    const edits: Edit[] = [];
    for (const item of value) {
      const e = jsonEditObject(item);
      if (e === null) throw new ParseError(`error: parse ${startLine}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One SEARCH/REPLACE block as an edit (section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new ApplyError('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new ApplyError('exists', path);
      tree.state.set(path, writeTextFile({ lines: newLines, br: '\n', endsWithBreak: true }));
      return;
    }
    const text = tree.current(path);
    if (text === null) throw new ApplyError('missing', path);
    const f = readTextFile(text);
    const found = firstTierWith(f.lines, oldLines, strict, () => true);
    if (found === null) throw new ApplyError('no-match', path);
    if (found.at.length > 1) throw new ApplyError('ambiguous', path);
    // One shared splice with the other formats: the old lines as old-only
    // items, the new lines as new-only ones, so the tier-2 re-indentation
    // of section 5 is computed the same way everywhere.
    const body: BodyLine[] = [
      ...oldLines.map((t): BodyLine => ({ side: 'old', text: t })),
      ...newLines.map((t): BodyLine => ({ side: 'new', text: t })),
    ];
    f.lines = spliceBody(f.lines, body, found.at[0]!, found.tier).lines;
    tree.state.set(path, writeTextFile(f));
  };
}

/** The edits of a SEARCH/REPLACE patch (section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    let eqAt = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eqAt = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eqAt < 0) throw new ParseError(`error: parse ${searchAt + 1}`);
    let endAt = -1;
    for (let j = eqAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        endAt = j;
        break;
      }
    }
    if (endAt < 0) throw new ParseError(`error: parse ${searchAt + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchAt + 1, eqAt), lines.slice(eqAt + 1, endAt), strict));
    prevPath = path;
    prevEnd = endAt;
    i = endAt + 1;
  }
  return edits;
}

/** One unified hunk: its stated old start A and its body lines (section 6). */
interface UnifiedHunk {
  oldStart: number;
  body: BodyLine[];
}

/** One unified section: where each of its paths came from, its flags and its hunks (section 6). */
interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hasHeadPair: boolean;
  hunks: UnifiedHunk[];
}

/** The path a `---` or `+++` line names: up to the first tab, spaces removed, one `a/` or `b/` prefix removed. */
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** One unified section as an edit (section 6). */
function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.headOld ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.headNew ?? sec.renameTo ?? sec.gitNew;
    const creating = sec.isNewFile || oldP === '/dev/null';
    const deleting = !creating && (sec.isDeletedFile || newP === '/dev/null');
    if (creating) {
      const p = newP!;
      if (!isSafePath(p)) throw new ApplyError('unsafe', p);
      if (tree.current(p) !== null) throw new ApplyError('exists', p);
      const added: string[] = [];
      let lastAdd: BodyLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.side === 'new') {
            added.push(b.text);
            lastAdd = b;
          }
        }
      }
      tree.state.set(p, writeTextFile({ lines: added, br: '\n', endsWithBreak: !(lastAdd !== null && lastAdd.noBreak === true) }));
      return;
    }
    if (deleting) {
      const p = oldP!;
      if (!isSafePath(p)) throw new ApplyError('unsafe', p);
      if (tree.current(p) === null) throw new ApplyError('missing', p);
      tree.state.set(p, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!isSafePath(from)) throw new ApplyError('unsafe', from);
    if (from !== to && !isSafePath(to)) throw new ApplyError('unsafe', to);
    const text = tree.current(from);
    if (text === null) throw new ApplyError('missing', from);
    if (from !== to && tree.current(to) !== null) throw new ApplyError('exists', to);
    const f = readTextFile(text);
    let drift = 0;
    for (const h of sec.hunks) {
      const oldLines = h.body.filter((b) => b.side !== 'new').map((b) => b.text);
      const newCount = h.body.filter((b) => b.side !== 'old').length;
      if (oldLines.length === 0) {
        const added = h.body.filter((b) => b.side === 'new').map((b) => b.text);
        const at = Math.max(0, Math.min(h.oldStart + drift, f.lines.length));
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...added);
        if (atEnd) {
          const last = h.body[h.body.length - 1];
          f.endsWithBreak = !(last !== undefined && last.noBreak === true);
        }
        drift += added.length;
      } else {
        const found = firstTierWith(f.lines, oldLines, strict, () => true);
        if (found === null) throw new ApplyError('no-match', from);
        const want = h.oldStart - 1 + drift;
        let pos = found.at[0]!;
        for (const cand of found.at) {
          if (Math.abs(cand - want) < Math.abs(pos - want)) pos = cand;
        }
        const runsToEnd = pos + oldLines.length === f.lines.length;
        const res = spliceBody(f.lines, h.body, pos, found.tier);
        f.lines = res.lines;
        if (runsToEnd) {
          let lastNew: BodyLine | undefined;
          for (let k = h.body.length - 1; k >= 0; k -= 1) {
            if (h.body[k]!.side !== 'old') {
              lastNew = h.body[k];
              break;
            }
          }
          f.endsWithBreak = !(lastNew !== undefined && lastNew.noBreak === true);
        }
        drift += newCount - oldLines.length;
      }
    }
    const out = writeTextFile(f);
    if (from !== to) {
      tree.state.set(to, out);
      tree.state.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.state.set(from, out);
    }
  };
}

/** The edits of a unified diff patch (section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  const freshSection = (): UnifiedSection => {
    const s: UnifiedSection = {
      gitOld: null,
      gitNew: null,
      headOld: null,
      headNew: null,
      renameFrom: null,
      renameTo: null,
      isNewFile: false,
      isDeletedFile: false,
      hasHeadPair: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let cur: UnifiedSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      cur = freshSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasHeadPair) cur = freshSection();
      cur.headOld = headerPath(line.slice(4));
      cur.headNew = headerPath(lines[i + 1]!.slice(4));
      cur.hasHeadPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new ParseError(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseError(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new ParseError(`error: parse ${i + 1}`);
      const hunk: UnifiedHunk = { oldStart: parseInt(hm[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '') {
          hunk.body.push({ side: 'both', text: '' });
          i += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') hunk.body.push({ side: 'both', text: l.slice(1) });
        else if (c === '-') hunk.body.push({ side: 'old', text: l.slice(1) });
        else if (c === '+') hunk.body.push({ side: 'new', text: l.slice(1) });
        else if (c === '\\') {
          const last = hunk.body[hunk.body.length - 1];
          if (last !== undefined) last.noBreak = true;
        } else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it: a trailing
      // context line whose text is empty, whether the patch line was empty
      // or held only the context marker's space.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.side === 'both' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNewFile = true;
      else if (line.startsWith('deleted file mode')) cur.isDeletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One V4A chunk: its anchor (null: none), whether `*** End of File` ended it, and its body lines (section 8). */
interface V4aChunk {
  anchor: string | null;
  atEnd: boolean;
  body: BodyLine[];
}

/** One V4A section (section 8). */
interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  /** An Add File section's lines as new items; `blank` marks a line the patch held empty, not a `+` line. */
  added: BodyLine[];
  chunks: V4aChunk[];
  lineNo: number;
}

/** One V4A section as an edit (section 8). */
function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!isSafePath(p)) throw new ApplyError('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.current(p) !== null) throw new ApplyError('exists', p);
      tree.state.set(p, writeTextFile({ lines: sec.added.map((b) => b.text), br: '\n', endsWithBreak: true }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.current(p) === null) throw new ApplyError('missing', p);
      tree.state.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) throw new ApplyError('unsafe', sec.moveTo);
    const text = tree.current(p);
    if (text === null) throw new ApplyError('missing', p);
    if (sec.moveTo !== null && tree.current(sec.moveTo) !== null) throw new ApplyError('exists', sec.moveTo);
    const f = readTextFile(text);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const idx = findAnchorLine(f.lines, chunk.anchor, cursor, strict);
        if (idx < 0) throw new ApplyError('no-match', p);
        cursor = idx + 1;
      }
      const oldLines = chunk.body.filter((b) => b.side !== 'new').map((b) => b.text);
      if (oldLines.length === 0) {
        const added = chunk.body.map((b) => b.text);
        const at = chunk.atEnd ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...added);
        cursor = at + added.length;
      } else {
        const found = firstTierWith(
          f.lines,
          oldLines,
          strict,
          (pos) => pos >= cursor && (!chunk.atEnd || pos + oldLines.length === f.lines.length),
        );
        if (found === null) throw new ApplyError('no-match', p);
        const res = spliceBody(f.lines, chunk.body, found.at[0]!, found.tier);
        f.lines = res.lines;
        cursor = found.at[0]! + res.written;
      }
    }
    const out = writeTextFile(f);
    if (sec.moveTo !== null) {
      tree.state.set(sec.moveTo, out);
      tree.state.set(p, null);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.state.set(p, out);
    }
  };
}

/** The edits of a V4A patch (section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new ParseError('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new ParseError(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new ParseError(`error: parse ${lines.length + 1}`);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const MOV = '*** Move to: ';
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let chunk: V4aChunk | null = null;
  const closeSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      // Blank lines at the end of a section are not part of it; a `+` line
      // with empty text is a file line and stays.
      while (cur.added.length > 0 && cur.added[cur.added.length - 1]!.blank === true) cur.added.pop();
    }
    if (cur.kind === 'upd') {
      const last = cur.chunks[cur.chunks.length - 1];
      if (last !== undefined) {
        // Blank lines at the end of a section are not part of it: a trailing
        // context line whose text is empty, whether the patch line was empty
        // or only whitespace.
        while (last.body.length > 0) {
          const tail = last.body[last.body.length - 1]!;
          if (tail.side === 'both' && tail.text === '') last.body.pop();
          else break;
        }
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new ParseError(`error: parse ${cur.lineNo}`);
    }
    sections.push(cur);
    cur = null;
    chunk = null;
  };
  for (let i = firstIdx + 1; i < lastIdx; i += 1) {
    const line = lines[i]!;
    if (line.startsWith(ADD) || line.startsWith(DEL) || line.startsWith(UPD)) {
      closeSection();
      const kind = line.startsWith(ADD) ? 'add' : line.startsWith(DEL) ? 'del' : 'upd';
      const prefix = kind === 'add' ? ADD : kind === 'del' ? DEL : UPD;
      cur = { kind, path: line.slice(prefix.length).trim(), moveTo: null, added: [], chunks: [], lineNo: i + 1 };
      chunk = null;
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new ParseError(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.added.push({ side: 'new', text: line.slice(1) });
      else if (line === '') cur.added.push({ side: 'new', text: '', blank: true });
      else throw new ParseError(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (isBlank(line)) continue;
      throw new ParseError(`error: parse ${i + 1}`);
    }
    // An Update File section: an optional Move to as its first line, then chunks.
    if (line.startsWith(MOV) && cur.chunks.length === 0 && chunk === null && cur.moveTo === null) {
      cur.moveTo = line.slice(MOV.length).trim();
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) {
        chunk = { anchor: null, atEnd: true, body: [] };
        cur.chunks.push(chunk);
      } else {
        chunk.atEnd = true;
      }
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      chunk = { anchor: anchorText === '' ? null : anchorText, atEnd: false, body: [] };
      cur.chunks.push(chunk);
      continue;
    }
    if (line === '' && chunk === null) continue;
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (chunk === null) {
        chunk = { anchor: null, atEnd: false, body: [] };
        cur.chunks.push(chunk);
      }
      if (line === '') chunk.body.push({ side: 'both', text: '', blank: true });
      else if (line[0] === ' ') chunk.body.push({ side: 'both', text: line.slice(1) });
      else if (line[0] === '-') chunk.body.push({ side: 'old', text: line.slice(1) });
      else chunk.body.push({ side: 'new', text: line.slice(1) });
      continue;
    }
    throw new ParseError(`error: parse ${i + 1}`);
  }
  closeSection();
  return sections.map((s) => v4aSectionEdit(s, strict));
}

/** One line of the success output (section 2), with the path it sorts by. */
interface OutRow {
  key: string;
  line: string;
}

/** Run the CLI on its arguments: the exit code and the lines for stdout (sections 1, 2 and 10). */
function execute(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
    } else if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new ParseError('error: parse 1');
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [e.text] };
    throw e;
  }
  const tree = new WorkTree();
  const failures: ApplyError[] = [];
  for (const edit of edits) {
    const savedState = new Map(tree.state);
    const savedMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof ApplyError)) throw e;
      // A failed edit changes nothing: roll the tree back to before it.
      tree.state.clear();
      for (const [k, v] of savedState) tree.state.set(k, v);
      tree.moves.length = savedMoves;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }
  const rows: OutRow[] = [];
  const rowFor = new Map<string, OutRow>();
  for (const p of tree.state.keys()) {
    const was = tree.before(p);
    const now = tree.state.get(p)!;
    if (was === now) continue;
    const row: OutRow = { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    rowFor.set(p, row);
  }
  const usedMoves = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (usedMoves.has(oldP) || usedMoves.has(newP)) continue;
    const finalOf = (p: string): string | null => (tree.state.has(p) ? tree.state.get(p)! : tree.before(p));
    if (tree.before(oldP) === null || finalOf(oldP) !== null) continue;
    if (tree.before(newP) !== null || finalOf(newP) === null) continue;
    const dRow = rowFor.get(oldP);
    const aRow = rowFor.get(newP);
    if (dRow === undefined || aRow === undefined) continue;
    rows.splice(rows.indexOf(dRow), 1);
    rows.splice(rows.indexOf(aRow), 1);
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    usedMoves.add(oldP);
    usedMoves.add(newP);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!checkOnly) {
    for (const p of tree.state.keys()) {
      const was = tree.before(p);
      const now = tree.state.get(p)!;
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
  const result = execute(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
