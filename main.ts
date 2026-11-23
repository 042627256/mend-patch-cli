// main.ts - mend: the CLI SPEC.md specifies (v4, full SPEC rewrite)
// Node 22, standard library only. Run: node main.ts [options] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';
const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
const tierNorm: Array<(s: string) => string> = [(s) => s, trailWs, bothWs];

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function fileLineBreak(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

function splitFile(text: string): { lines: string[]; br: string; finalBr: boolean } {
  const br = fileLineBreak(text);
  const lines = text === '' ? [] : text.split(br);
  const finalBr = text !== '' && text.endsWith(br);
  if (finalBr) lines.pop();
  return { lines, br, finalBr };
}

function tierMatches(lines: string[], pat: string[], tier: number): number[] {
  const f = tierNorm[tier]!;
  const p = pat.map(f);
  const out: number[] = [];
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) {
      if (f(lines[i + j]!) !== p[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], pat: string[], strict: boolean): { tier: number; at: number[] } | null {
  for (const tier of (strict ? [0] : [0, 1, 2])) {
    const at = tierMatches(lines, pat, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

function reindent(n: string, F: string, P: string): string {
  if (n === '' || n.trim() === '') return n;
  return n.startsWith(P) ? F + n.slice(P.length) : n;
}

/** The tree as edits leave it: changed paths in `now` (null = deleted), rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>(); // newPath -> oldPath

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  recordMove(oldP: string, newP: string): void { this.moves.set(newP, oldP); }
}

type Edit = (tree: Tree) => void;

// ============================================================================
// UNIFIED DIFFS (Section 6)
// ============================================================================

interface UHunk { a: number; body: string[]; }

interface USec {
  old: string | null;
  new: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function pathSpec(text: string): string | null {
  const raw = text.split('\t')[0]!.trim();
  return raw === '/dev/null' ? null : raw.replace(/^(a|b)\//, '');
}

function parseUnified(lines: string[]): USec[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  let headerDone = false;
  const fresh = (): USec => {
    cur = { old: null, new: null, isCreate: false, isDelete: false, hunks: [] };
    secs.push(cur!);
    headerDone = false;
    return cur!;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = fresh();
      s.old = m[1]!;
      s.new = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (cur === null || headerDone) fresh();
      cur!.old = pathSpec(l.slice(4));
      cur!.new = pathSpec(lines[i + 1]!.slice(4));
      headerDone = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !headerDone && cur.hunks.length === 0) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      i++;
      continue;
    }
    if (l.startsWith('rename from ') && cur !== null && !headerDone) {
      cur!.old = l.slice(12).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ') && cur !== null && !headerDone) {
      cur!.new = l.slice(10).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      if (cur !== null) cur!.isCreate = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      if (cur !== null) cur!.isDelete = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        const pairAhead = bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
        if (pairAhead || bl.startsWith('diff --git ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          hunk.body.push(bl);
          i++;
        } else {
          break;
        }
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur!.hunks.push(hunk);
      continue;
    }
    i++;
  }
  return secs;
}

type UEntry = { t: 'ctx' | 'old' | 'new' | 'nl'; x: string };

function bodyEntries(body: string[]): UEntry[] {
  const es: UEntry[] = [];
  for (const bl of body) {
    if (bl === '') es.push({ t: 'ctx', x: '' });
    else if (bl.startsWith('\\')) es.push({ t: 'nl', x: '' });
    else if (bl.startsWith(' ')) es.push({ t: 'ctx', x: bl.slice(1) });
    else if (bl.startsWith('-')) es.push({ t: 'old', x: bl.slice(1) });
    else es.push({ t: 'new', x: bl.slice(1) });
  }
  return es;
}

/** Apply a section's hunks to the file at `path`; returns the new text. */
function applyHunks(t: Tree, path: string, hunks: UHunk[], strict: boolean): string {
  const content = t.get(path);
  if (content === null) throw new Fail('missing', path);
  const { lines, br, finalBr } = splitFile(content);
  let d = 0;
  let forceBreak: boolean | null = null;
  for (const h of hunks) {
    const es = bodyEntries(h.body);
    let lastOut = -1;
    for (let k = 0; k < es.length; k++) {
      if (es[k]!.t === 'ctx' || es[k]!.t === 'new') lastOut = k;
    }
    const stripEol = lastOut >= 0 && lastOut + 1 < es.length && es[lastOut + 1]!.t === 'nl';
    const O: string[] = [];
    const ctxOff: number[] = [];
    for (const e of es) {
      if (e.t === 'ctx') { O.push(e.x); ctxOff.push(O.length - 1); }
      else if (e.t === 'old') O.push(e.x);
    }
    const N: Array<{ ctx: boolean; x: string }> = [];
    for (const e of es) {
      if (e.t === 'ctx') N.push({ ctx: true, x: e.x });
      else if (e.t === 'new') N.push({ ctx: false, x: e.x });
    }
    if (O.length === 0) {
      const preLen = lines.length;
      const at = Math.min(h.a + d, preLen);
      const ins = N.map((n) => n.x);
      lines.splice(at, 0, ...ins);
      d += ins.length;
      if (at === preLen) forceBreak = !stripEol;
    } else {
      const expected = h.a - 1 + d;
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      let best = found.at[0]!;
      for (const m of found.at) {
        if (Math.abs(m - expected) < Math.abs(best - expected)) best = m;
      }
      const pos = best;
      const atEnd = pos + O.length === lines.length;
      const F = leadWs(lines[pos]!);
      const P = leadWs(O[0]!);
      const outLines: string[] = [];
      let k = 0;
      for (const n of N) {
        if (n.ctx) { outLines.push(lines[pos + ctxOff[k]!]!); k++; }
        else outLines.push(found.tier === 2 ? reindent(n.x, F, P) : n.x);
      }
      lines.splice(pos, O.length, ...outLines);
      d += outLines.length - O.length;
      if (atEnd) forceBreak = !stripEol;
    }
  }
  const endBr = forceBreak === null ? finalBr : forceBreak;
  return lines.length === 0 ? '' : lines.join(br) + (endBr ? br : '');
}

function buildUnifiedEdits(secs: USec[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const sec of secs) {
    const create = (sec.isCreate || sec.old === null) && !(sec.isDelete || sec.new === null);
    const del = (sec.isDelete || sec.new === null) && !(sec.isCreate || sec.old === null);
    if (create && sec.new !== null) {
      const np = sec.new;
      const all = bodyEntries(sec.hunks.flatMap((h) => h.body));
      const out: string[] = [];
      let lastPlus = -1;
      for (let k = 0; k < all.length; k++) {
        if (all[k]!.t === 'new') { lastPlus = k; out.push(all[k]!.x); }
      }
      const strip = lastPlus >= 0 && lastPlus + 1 < all.length && all[lastPlus + 1]!.t === 'nl';
      edits.push((t) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (t.get(np) !== null) throw new Fail('exists', np);
        t.now.set(np, out.length === 0 ? '' : out.join('\n') + (strip ? '' : '\n'));
      });
      continue;
    }
    if (del && sec.old !== null) {
      const op = sec.old;
      edits.push((t) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (t.get(op) === null) throw new Fail('missing', op);
        t.now.set(op, null);
      });
      continue;
    }
    if (sec.old !== null && sec.new !== null && !create && !del) {
      if (sec.old !== sec.new) {
        const op = sec.old;
        const np = sec.new;
        edits.push((t) => {
          if (!safe(op)) throw new Fail('unsafe', op);
          if (!safe(np)) throw new Fail('unsafe', np);
          if (t.get(op) === null) throw new Fail('missing', op);
          if (t.get(np) !== null) throw new Fail('exists', np);
          const text = applyHunks(t, op, sec.hunks, strict);
          t.recordMove(op, np);
          t.now.set(op, null);
          t.now.set(np, text);
        });
      } else {
        const p = sec.old;
        edits.push((t) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          t.now.set(p, applyHunks(t, p, sec.hunks, strict));
        });
      }
    }
  }
  return edits;
}

// ============================================================================
// SEARCH/REPLACE BLOCKS (Section 7)
// ============================================================================

interface SRBlock { path: string; old: string[]; new: string[]; }

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let curPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const pl = lines[j]!;
      if (blank(pl)) continue;
      if (pl.trim().startsWith('```')) continue;
      path = pl.trim();
      break;
    }
    if (path === null) path = curPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    i++;
    const oldL: string[] = [];
    while (i < lines.length && lines[i]!.trimEnd() !== '=======' && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
      oldL.push(lines[i]!);
      i++;
    }
    if (i >= lines.length || lines[i]!.trimEnd() === '>>>>>>> REPLACE') {
      throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    i++;
    const newL: string[] = [];
    while (i < lines.length && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
      newL.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    prevEnd = i;
    curPath = path;
    blocks.push({ path, old: oldL, new: newL });
  }
  return blocks;
}

function buildSREdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => (t: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (t.get(b.path) !== null) throw new Fail('exists', b.path);
      t.now.set(b.path, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return;
    }
    const content = t.get(b.path);
    if (content === null) throw new Fail('missing', b.path);
    const { lines, br, finalBr } = splitFile(content);
    const found = findTier(lines, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.at[0]!;
    const F = leadWs(lines[pos]!);
    const P = leadWs(b.old[0]!);
    const outLines = found.tier === 2 ? b.new.map((n) => reindent(n, F, P)) : b.new.slice();
    lines.splice(pos, b.old.length, ...outLines);
    t.now.set(b.path, lines.length === 0 ? '' : lines.join(br) + (finalBr ? br : ''));
  });
}

// ============================================================================
// V4A PATCHES (Section 8)
// ============================================================================

interface VChunk { anchor: string; eof: boolean; body: string[]; }

interface VSec {
  type: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  updateLine: number;
  addEntries: string[];
  chunks: VChunk[];
}

function parseV4A(lines: string[]): VSec[] {
  let f = 0;
  while (f < lines.length && blank(lines[f]!)) f++;
  if (f >= lines.length || lines[f]!.trim() !== '*** Begin Patch') throw new Exit2('error: parse 1');
  const secs: VSec[] = [];
  let cur: VSec | null = null;
  let chunk: VChunk | null = null;
  const closePrev = (): void => {
    if (cur === null) return;
    if (cur.type === 'add') {
      while (cur.addEntries.length > 0 && cur.addEntries[cur.addEntries.length - 1] === '') cur.addEntries.pop();
    } else if (cur.type === 'update') {
      for (const c of cur.chunks) {
        while (c.body.length > 0 && blank(c.body[c.body.length - 1]!)) c.body.pop();
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) {
        throw new Exit2(`error: parse ${cur.updateLine}`);
      }
    }
  };
  let i = f + 1;
  while (i < lines.length) {
    const l = lines[i]!;
    const t = l.trim();
    if (t === '*** End Patch') break;
    if (t.startsWith('*** Add File: ')) {
      closePrev();
      cur = { type: 'add', path: t.slice(14).trim(), moveTo: null, updateLine: i + 1, addEntries: [], chunks: [] };
      secs.push(cur);
      chunk = null;
      i++;
      continue;
    }
    if (t.startsWith('*** Delete File: ')) {
      closePrev();
      cur = { type: 'delete', path: t.slice(17).trim(), moveTo: null, updateLine: i + 1, addEntries: [], chunks: [] };
      secs.push(cur);
      chunk = null;
      i++;
      continue;
    }
    if (t.startsWith('*** Update File: ')) {
      closePrev();
      cur = { type: 'update', path: t.slice(17).trim(), moveTo: null, updateLine: i + 1, addEntries: [], chunks: [] };
      secs.push(cur);
      chunk = null;
      i++;
      continue;
    }
    if (t.startsWith('*** Move to: ')) {
      if (cur === null || cur.type !== 'update' || cur.moveTo !== null || cur.chunks.length > 0) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      cur.moveTo = t.slice(13).trim();
      i++;
      continue;
    }
    if (t === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      chunk = null;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null || cur.type !== 'update') throw new Exit2(`error: parse ${i + 1}`);
      chunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
      cur.chunks.push(chunk);
      i++;
      continue;
    }
    if (cur === null) {
      if (blank(l)) { i++; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.type === 'add') {
      if (l === '') { cur.addEntries.push(''); i++; continue; }
      if (l.startsWith('+')) { cur.addEntries.push(l.slice(1)); i++; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.type === 'delete') {
      if (blank(l)) { i++; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // update section body line
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (chunk === null) {
        if (blank(l)) { i++; continue; }
        if (cur.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        chunk = { anchor: '', eof: false, body: [] };
        cur.chunks.push(chunk);
      }
      chunk.body.push(l);
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closePrev();
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  return secs;
}

function buildV4AEdits(secs: VSec[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const sec of secs) {
    if (sec.type === 'delete') {
      const p = sec.path;
      edits.push((t) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (t.get(p) === null) throw new Fail('missing', p);
        t.now.set(p, null);
      });
      continue;
    }
    if (sec.type === 'add') {
      const p = sec.path;
      const text = sec.addEntries.length === 0 ? '' : sec.addEntries.join('\n') + '\n';
      edits.push((t) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (t.get(p) !== null) throw new Fail('exists', p);
        t.now.set(p, text);
      });
      continue;
    }
    const p = sec.path;
    const mv = sec.moveTo;
    edits.push((t) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const content = t.get(p);
      if (content === null) throw new Fail('missing', p);
      if (mv !== null && t.get(mv) !== null) throw new Fail('exists', mv);
      const { lines, br, finalBr } = splitFile(content);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        const es: UEntry[] = [];
        for (const bl of chunk.body) {
          if (bl === '') es.push({ t: 'ctx', x: '' });
          else if (bl.startsWith(' ')) es.push({ t: 'ctx', x: bl.slice(1) });
          else if (bl.startsWith('-')) es.push({ t: 'old', x: bl.slice(1) });
          else es.push({ t: 'new', x: bl.slice(1) });
        }
        const O: string[] = [];
        const ctxOff: number[] = [];
        for (const e of es) {
          if (e.t === 'ctx') { O.push(e.x); ctxOff.push(O.length - 1); }
          else if (e.t === 'old') O.push(e.x);
        }
        const N: Array<{ ctx: boolean; x: string }> = [];
        for (const e of es) {
          if (e.t === 'ctx') N.push({ ctx: true, x: e.x });
          else if (e.t === 'new') N.push({ ctx: false, x: e.x });
        }
        if (chunk.anchor !== '') {
          let apos = -1;
          for (const tier of (strict ? [0] : [0, 1, 2])) {
            const f = tierNorm[tier]!;
            const target = f(chunk.anchor);
            for (let k = cursor; k < lines.length; k++) {
              if (f(lines[k]!) === target) { apos = k; break; }
            }
            if (apos >= 0) break;
          }
          if (apos < 0) throw new Fail('no-match', p);
          cursor = apos + 1;
        }
        if (O.length === 0) {
          const pos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
          const ins = N.map((n) => n.x);
          lines.splice(pos, 0, ...ins);
          cursor = pos + ins.length;
        } else {
          let pos = -1;
          let usedTier = 0;
          for (const tier of (strict ? [0] : [0, 1, 2])) {
            const at = tierMatches(lines, O, tier);
            for (const m of at) {
              if (m >= cursor) { pos = m; usedTier = tier; break; }
            }
            if (pos >= 0) break;
          }
          if (pos < 0) throw new Fail('no-match', p);
          if (chunk.eof && pos + O.length !== lines.length) throw new Fail('no-match', p);
          const F = leadWs(lines[pos]!);
          const P = leadWs(O[0]!);
          const outLines: string[] = [];
          let k = 0;
          for (const n of N) {
            if (n.ctx) { outLines.push(lines[pos + ctxOff[k]!]!); k++; }
            else outLines.push(usedTier === 2 ? reindent(n.x, F, P) : n.x);
          }
          lines.splice(pos, O.length, ...outLines);
          cursor = pos + outLines.length;
        }
      }
      const text = lines.length === 0 ? '' : lines.join(br) + (finalBr ? br : '');
      if (mv !== null) {
        t.recordMove(p, mv);
        t.now.set(p, null);
        t.now.set(mv, text);
      } else {
        t.now.set(p, text);
      }
    });
  }
  return edits;
}

// ============================================================================
// FORMAT DETECTION (Section 4)
// ============================================================================

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

// ============================================================================
// JSON EDITS (Section 9)
// ============================================================================

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
      const { lines, br, finalBr } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (finalBr ? br : ''));
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
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
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
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ============================================================================
// MAIN RUN
// ============================================================================

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null || !FORMATS.includes(a.slice(9))) return { code: 2, out: ['error: usage'] };
        format = a.slice(9);
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try { text = readFileSync(file ?? 0, 'utf8'); }
  catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = buildUnifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = buildSREdits(parseSR(lines), strict);
    else if (kind === 'v4a') edits = buildV4AEdits(parseV4A(lines), strict);
    else return { code: 2, out: ['error: format'] };
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const suppressed = new Set<string>();
  for (const [np, op] of tree.moves) {
    if (
      tree.original(op) !== null && tree.now.get(op) === null &&
      tree.original(np) === null && tree.now.get(np) !== null
    ) suppressed.add(op);
  }
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  changed.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: string[] = [];
  for (const p of changed) {
    if (suppressed.has(p)) continue;
    const op = tree.moves.get(p);
    if (op !== undefined && suppressed.has(op)) {
      rows.push(`R ${op} -> ${p}`);
      continue;
    }
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  rows.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);

  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: rows };
}

// ============================================================================
// TRIAL HANDOVER
// ============================================================================

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
