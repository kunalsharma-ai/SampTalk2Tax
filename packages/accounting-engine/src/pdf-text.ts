/**
 * Reads the text of a PDF, in reading order, for the bill reader (AP-025). It understands the
 * PDFs that accounting and billing software produce: content streams stored plain or compressed
 * (Flate), compressed object streams, fonts with a ToUnicode map (as most generated PDFs have) or
 * a simple single-byte encoding, and text placed anywhere on the page (each piece of text is
 * positioned and the page is read top to bottom, left to right). Scanned pages and photos have
 * no text to read; that comes back as a problem in words, never as made-up text.
 *
 * Decompression is passed in, so this file has no Node or framework code. No regular
 * expressions run on the file's contents: everything is read with a hand-written scanner.
 */

export interface PdfTextResult {
  text: string;
  pages: number;
  problem: string | null;
}

type Ref = { ref: number };
type Name = { name: string };
type Val = number | boolean | null | string | Name | Ref | Val[] | Dict | { op: string };
type Dict = Map<string, Val>;
interface Obj {
  value: Val;
  stream: Uint8Array | null;
}

const MAX_PAGES = 200; // not money
const MAX_OBJECTS = 200_000; // not money

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const hexVal = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1);

/** Bytes as a string of char codes 0-255, one per byte. */
function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}
function bytesOf(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

/** A scanner over PDF syntax: numbers, strings, names, arrays, dictionaries, references and operators. */
class Lexer {
  pos: number;
  constructor(
    readonly s: string,
    pos = 0,
  ) {
    this.pos = pos;
  }
  private c(i = this.pos) {
    return i < this.s.length ? this.s.charCodeAt(i) : -1;
  }
  skip() {
    for (;;) {
      const c = this.c();
      if (c === -1) return;
      if (isWs(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.s.length && this.c() !== 0x0a && this.c() !== 0x0d) this.pos++;
      } else return;
    }
  }
  private word(): string {
    const start = this.pos;
    while (this.pos < this.s.length && !isWs(this.c()) && !isDelim(this.c())) this.pos++;
    return this.s.slice(start, this.pos);
  }
  private literal(): string {
    // after "("
    let depth = 1;
    let out = '';
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos++]!;
      if (ch === '\\') {
        const e = this.s[this.pos++] ?? '';
        if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === '\r') {
          if (this.s[this.pos] === '\n') this.pos++;
        } else if (e === '\n') {
          // line continuation
        } else if (e >= '0' && e <= '7') {
          let oct = e;
          for (let k = 0; k < 2 && this.s[this.pos]! >= '0' && this.s[this.pos]! <= '7'; k++) oct += this.s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else out += e;
      } else if (ch === '(') {
        depth++;
        out += ch;
      } else if (ch === ')') {
        if (--depth === 0) break;
        out += ch;
      } else out += ch;
    }
    return out;
  }
  private hex(): string {
    // after "<"
    let out = '';
    let hi = -1;
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos++);
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out += String.fromCharCode(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out += String.fromCharCode(hi * 16);
    return out;
  }
  /** The next value, or an operator; undefined at the end. */
  next(depth = 0): Val | undefined {
    this.skip();
    const c = this.c();
    if (c === -1) return undefined;
    if (depth > 64) throw new Error('Nested too deeply');
    if (c === 0x2f) {
      this.pos++;
      let n = this.word();
      if (n.includes('#')) n = n.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
      return { name: n };
    }
    if (c === 0x28) {
      this.pos++;
      return this.literal();
    }
    if (c === 0x3c) {
      if (this.c(this.pos + 1) === 0x3c) {
        this.pos += 2;
        const d: Dict = new Map();
        for (;;) {
          this.skip();
          if (this.c() === 0x3e && this.c(this.pos + 1) === 0x3e) {
            this.pos += 2;
            return d;
          }
          const k = this.next(depth + 1);
          if (k === undefined) return d;
          if (typeof k === 'object' && k && 'name' in k) {
            const v = this.next(depth + 1);
            if (v === undefined) return d;
            d.set(k.name, v);
          }
        }
      }
      this.pos++;
      return this.hex();
    }
    if (c === 0x5b) {
      this.pos++;
      const a: Val[] = [];
      for (;;) {
        this.skip();
        if (this.c() === 0x5d) {
          this.pos++;
          return a;
        }
        const v = this.next(depth + 1);
        if (v === undefined) return a;
        a.push(v);
      }
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.pos++;
      return { op: String.fromCharCode(c) };
    }
    const w = this.word();
    if (!w) {
      this.pos++;
      return { op: '' };
    }
    const n = Number(w);
    if (w !== '' && !Number.isNaN(n) && (isDigit(w.charCodeAt(0)) || w[0] === '-' || w[0] === '+' || w[0] === '.')) {
      // "12 0 R" is a reference
      if (Number.isInteger(n) && n >= 0 && isDigit(w.charCodeAt(0))) {
        const save = this.pos;
        this.skip();
        const g = this.word();
        if (g && /^\d+$/.test(g)) {
          this.skip();
          if (this.c() === 0x52 && (this.pos + 1 >= this.s.length || isWs(this.c(this.pos + 1)) || isDelim(this.c(this.pos + 1)))) {
            this.pos++;
            return { ref: n };
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return { op: w };
  }
}

const isName = (v: Val | undefined, n?: string): v is Name => !!v && typeof v === 'object' && 'name' in v && (n === undefined || v.name === n);
const isRef = (v: Val | undefined): v is Ref => !!v && typeof v === 'object' && 'ref' in v;
const isDict = (v: Val | undefined): v is Dict => v instanceof Map;
const isOp = (v: Val | undefined): v is { op: string } => !!v && typeof v === 'object' && 'op' in v;

/** One PDF file: its objects, found by scanning the file (so a damaged cross-reference table does not matter). */
class PdfFile {
  readonly objects = new Map<number, Obj>();
  private readonly src: string;
  constructor(
    bytes: Uint8Array,
    private readonly inflate: (data: Uint8Array) => Uint8Array,
  ) {
    this.src = latin1(bytes);
    this.scan();
  }

  private scan() {
    const s = this.src;
    let at = 0;
    const streams: number[] = [];
    while (this.objects.size < MAX_OBJECTS) {
      const k = s.indexOf('obj', at);
      if (k < 0) break;
      at = k + 3;
      // "<num> <gen> obj" with the keyword standing alone
      if (k > 0 && !isWs(s.charCodeAt(k - 1))) continue;
      const after = s.charCodeAt(k + 3);
      if (!(Number.isNaN(after) || isWs(after) || isDelim(after))) continue;
      let i = k - 1;
      while (i >= 0 && isWs(s.charCodeAt(i))) i--;
      const genEnd = i + 1;
      while (i >= 0 && isDigit(s.charCodeAt(i))) i--;
      if (i + 1 === genEnd) continue;
      while (i >= 0 && isWs(s.charCodeAt(i))) i--;
      const numEnd = i + 1;
      while (i >= 0 && isDigit(s.charCodeAt(i))) i--;
      if (i + 1 === numEnd) continue;
      const num = Number(s.slice(i + 1, numEnd));
      const lx = new Lexer(s, k + 3);
      let value: Val | undefined;
      try {
        value = lx.next();
      } catch {
        continue;
      }
      if (value === undefined) continue;
      let stream: Uint8Array | null = null;
      lx.skip();
      if (s.startsWith('stream', lx.pos) && isDict(value)) {
        let p = lx.pos + 6;
        if (s[p] === '\r') p++;
        if (s[p] === '\n') p++;
        const len = value.get('Length');
        let end = typeof len === 'number' && len >= 0 && s.startsWith('endstream', this.skipWs(p + len)) ? p + len : -1;
        if (end < 0) {
          end = s.indexOf('endstream', p);
          if (end < 0) continue;
          // trailing end-of-line before the keyword is not part of the data
          if (s[end - 1] === '\n') end--;
          if (s[end - 1] === '\r') end--;
        }
        stream = this.decode(value, bytesOf(s.slice(p, end)));
        at = end;
        if (isName(value.get('Type'), 'ObjStm')) streams.push(num);
      }
      // a later object with the same number (an incremental update) wins
      this.objects.set(num, { value, stream });
    }
    for (const n of streams) this.expand(n);
  }

  private skipWs(p: number) {
    while (p < this.src.length && isWs(this.src.charCodeAt(p))) p++;
    return p;
  }

  private decode(dict: Dict, raw: Uint8Array): Uint8Array | null {
    const f = dict.get('Filter');
    const filters = Array.isArray(f) ? f : f === undefined ? [] : [f];
    let data = raw;
    for (const x of filters) {
      if (!isName(x)) return null;
      if (x.name === 'FlateDecode' || x.name === 'Fl') {
        try {
          data = this.inflate(data);
        } catch {
          return null;
        }
      } else return null;
    }
    return data;
  }

  /** Objects stored inside a compressed object stream. */
  private expand(num: number) {
    const o = this.objects.get(num);
    if (!o?.stream || !isDict(o.value)) return;
    const n = o.value.get('N');
    const first = o.value.get('First');
    if (typeof n !== 'number' || typeof first !== 'number') return;
    const s = latin1(o.stream);
    const head = new Lexer(s.slice(0, first));
    const pairs: [number, number][] = [];
    for (let i = 0; i < n && i < MAX_OBJECTS; i++) {
      const a = head.next();
      const b = head.next();
      if (typeof a !== 'number' || typeof b !== 'number') break;
      pairs.push([a, b]);
    }
    for (const [objNum, off] of pairs) {
      if (this.objects.has(objNum) && this.objects.get(objNum)!.stream) continue;
      try {
        const v = new Lexer(s, first + off).next();
        if (v !== undefined && !this.objects.has(objNum)) this.objects.set(objNum, { value: v, stream: null });
      } catch {
        // skip a damaged object
      }
    }
  }

  get(v: Val | undefined, hops = 0): Val | undefined {
    if (isRef(v) && hops < 20) return this.get(this.objects.get(v.ref)?.value, hops + 1);
    return v;
  }
  streamOf(v: Val | undefined): Uint8Array | null {
    return isRef(v) ? (this.objects.get(v.ref)?.stream ?? null) : null;
  }
  get encrypted() {
    return this.src.includes('/Encrypt');
  }

  /** The pages in order: from the catalogue's page tree, else every page object in file order. */
  pages(): Dict[] {
    const out: Dict[] = [];
    const seen = new Set<Dict>();
    const walk = (node: Val | undefined, depth: number) => {
      const d = this.get(node);
      if (!isDict(d) || seen.has(d) || depth > 50 || out.length >= MAX_PAGES) return;
      seen.add(d);
      const kids = this.get(d.get('Kids'));
      if (Array.isArray(kids)) for (const k of kids) walk(k, depth + 1);
      else if (isName(d.get('Type'), 'Page') || d.has('Contents')) out.push(d);
    };
    for (const o of this.objects.values()) {
      if (isDict(o.value) && isName(o.value.get('Type'), 'Catalog')) {
        walk(o.value.get('Pages'), 0);
        break;
      }
    }
    if (!out.length) for (const o of this.objects.values()) if (isDict(o.value) && isName(o.value.get('Type'), 'Page') && out.length < MAX_PAGES) out.push(o.value);
    return out;
  }

  /** A page attribute, looked up the page tree when the page inherits it. */
  inherited(page: Dict, key: string): Val | undefined {
    let d: Val | undefined = page;
    for (let i = 0; i < 50 && isDict(d); i++) {
      if (d.has(key)) return this.get(d.get(key));
      d = this.get(d.get('Parent'));
    }
    return undefined;
  }
}

/** How a font's bytes become text. */
interface FontMap {
  bytes: 1 | 2;
  map: Map<number, string> | null;
}

/** Characters 128-159 of Windows-1252, the usual single-byte encoding. */
const WIN = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const single = (code: number) => (code >= 0x80 && code <= 0x9f ? WIN[code - 0x80]! : String.fromCharCode(code));

function utf16(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode((hex.charCodeAt(i) << 8) | hex.charCodeAt(i + 1));
  return out;
}
const codeOf = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 256 + s.charCodeAt(i);
  return n;
};

/** Reads a ToUnicode map: bfchar and bfrange entries, and whether codes are one or two bytes. */
function parseCMap(data: Uint8Array): FontMap {
  const lx = new Lexer(latin1(data));
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1;
  const stack: Val[] = [];
  let mode = '';
  for (let guard = 0; guard < 500_000; guard++) {
    const v = lx.next();
    if (v === undefined) break;
    if (!isOp(v)) {
      stack.push(v);
      continue;
    }
    const op = v.op;
    if (op === 'begincodespacerange' || op === 'beginbfchar' || op === 'beginbfrange') {
      mode = op;
      stack.length = 0;
    } else if (op === 'endcodespacerange') {
      const lo = stack[0];
      if (typeof lo === 'string' && lo.length >= 2) bytes = 2;
      stack.length = 0;
    } else if (op === 'endbfchar') {
      for (let i = 0; i + 1 < stack.length; i += 2) {
        const src = stack[i];
        const dst = stack[i + 1];
        if (typeof src === 'string' && typeof dst === 'string') {
          map.set(codeOf(src), utf16(dst));
          if (src.length >= 2) bytes = 2;
        }
      }
      stack.length = 0;
    } else if (op === 'endbfrange') {
      for (let i = 0; i + 2 < stack.length; i += 3) {
        const lo = stack[i];
        const hi = stack[i + 1];
        const dst = stack[i + 2];
        if (typeof lo !== 'string' || typeof hi !== 'string') continue;
        if (lo.length >= 2) bytes = 2;
        const a = codeOf(lo);
        const b = Math.min(codeOf(hi), a + 65535);
        if (typeof dst === 'string') {
          const base = utf16(dst);
          const last = base.charCodeAt(base.length - 1);
          for (let c = a; c <= b; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - a)));
        } else if (Array.isArray(dst)) {
          for (let c = a; c <= b && c - a < dst.length; c++) if (typeof dst[c - a] === 'string') map.set(c, utf16(dst[c - a] as string));
        }
      }
      stack.length = 0;
    } else {
      stack.length = 0;
    }
    void mode;
  }
  return { bytes, map };
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const ID: M = [1, 0, 0, 1, 0, 0];
const num = (v: Val | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

interface Run {
  x: number;
  y: number;
  size: number;
  text: string;
}

/** The text pieces on one page, each with its position on the page. */
function pageRuns(pdf: PdfFile, page: Dict): { runs: Run[]; undecodable: boolean } {
  const contents = page.get('Contents');
  const parts = Array.isArray(pdf.get(contents)) ? (pdf.get(contents) as Val[]) : [contents];
  let content = '';
  for (const p of parts) {
    const s = pdf.streamOf(p);
    if (s) content += latin1(s) + '\n';
  }
  const resources = pdf.inherited(page, 'Resources');
  const fontsDict = isDict(resources) ? pdf.get(resources.get('Font')) : undefined;
  const fonts = new Map<string, FontMap>();
  let undecodable = false;
  const fontFor = (name: string): FontMap => {
    const known = fonts.get(name);
    if (known) return known;
    let fm: FontMap = { bytes: 1, map: null };
    const f = isDict(fontsDict) ? pdf.get(fontsDict.get(name)) : undefined;
    if (isDict(f)) {
      const tu = pdf.streamOf(f.get('ToUnicode'));
      const enc = pdf.get(f.get('Encoding'));
      if (tu) fm = parseCMap(tu);
      else if (isName(enc) && (enc.name === 'Identity-H' || enc.name === 'Identity-V')) {
        fm = { bytes: 2, map: new Map() };
        undecodable = true;
      }
    }
    fonts.set(name, fm);
    return fm;
  };
  const decode = (s: string, fm: FontMap) => {
    let out = '';
    if (fm.bytes === 2) {
      for (let i = 0; i + 1 < s.length; i += 2) out += fm.map?.get((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1)) ?? '';
    } else {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out += fm.map ? (fm.map.get(c) ?? single(c)) : single(c);
      }
    }
    return out;
  };

  const runs: Run[] = [];
  let ctm: M = ID;
  const saved: M[] = [];
  let tm: M = ID;
  let tlm: M = ID;
  let font: FontMap = { bytes: 1, map: null };
  let size = 10;
  let leading = 0;
  const lx = new Lexer(content);
  const ops: Val[] = [];
  const show = (text: string) => {
    if (!text) return;
    const m = mul(tm, ctm);
    const scale = Math.hypot(m[2], m[3]) || 1;
    runs.push({ x: m[4], y: m[5], size: size * scale, text });
    // move along by an estimate of the text's width, so the next piece on the line lands after it
    tm = mul([1, 0, 0, 1, text.length * size * 0.5, 0], tm);
  };
  const newline = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  for (let guard = 0; guard < 2_000_000; guard++) {
    let v: Val | undefined;
    try {
      v = lx.next();
    } catch {
      break;
    }
    if (v === undefined) break;
    if (!isOp(v)) {
      ops.push(v);
      continue;
    }
    const a = ops;
    switch (v.op) {
      case 'q':
        saved.push(ctm);
        break;
      case 'Q':
        ctm = saved.pop() ?? ID;
        break;
      case 'cm':
        if (a.length >= 6) ctm = mul(a.slice(-6).map(num) as M, ctm);
        break;
      case 'BT':
        tm = ID;
        tlm = ID;
        break;
      case 'Tf': {
        const n = a[a.length - 2];
        if (isName(n)) font = fontFor(n.name);
        size = num(a[a.length - 1]) || size;
        break;
      }
      case 'TL':
        leading = num(a[a.length - 1]);
        break;
      case 'Td':
        newline(num(a[a.length - 2]), num(a[a.length - 1]));
        break;
      case 'TD':
        leading = -num(a[a.length - 1]);
        newline(num(a[a.length - 2]), num(a[a.length - 1]));
        break;
      case 'Tm':
        if (a.length >= 6) {
          tlm = a.slice(-6).map(num) as M;
          tm = tlm;
        }
        break;
      case 'T*':
        newline(0, -leading);
        break;
      case 'Tj':
        if (typeof a[a.length - 1] === 'string') show(decode(a[a.length - 1] as string, font));
        break;
      case "'":
        newline(0, -leading);
        if (typeof a[a.length - 1] === 'string') show(decode(a[a.length - 1] as string, font));
        break;
      case '"':
        newline(0, -leading);
        if (typeof a[a.length - 1] === 'string') show(decode(a[a.length - 1] as string, font));
        break;
      case 'TJ': {
        const arr = a[a.length - 1];
        if (Array.isArray(arr)) {
          let t = '';
          for (const x of arr) {
            if (typeof x === 'string') t += decode(x, font);
            // a wide gap inside a TJ array is a space between words
            else if (typeof x === 'number' && x < -200) t += ' ';
          }
          show(t);
        }
        break;
      }
      case 'BI': {
        // skip an inline image's data
        const end = content.indexOf('EI', lx.pos);
        lx.pos = end < 0 ? content.length : end + 2;
        break;
      }
      default:
        break;
    }
    ops.length = 0;
  }
  return { runs, undecodable };
}

/** Puts a page's text pieces into lines, top to bottom and left to right; columns are separated by two spaces or more. */
function layout(runs: Run[]): string {
  const sorted = runs.filter((r) => r.text.trim()).sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: Run[][] = [];
  for (const r of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0]!.y - r.y) <= Math.max(2, Math.min(line[0]!.size, r.size) * 0.4)) line.push(r);
    else lines.push([r]);
  }
  return lines
    .map((line) => {
      line.sort((p, q) => p.x - q.x);
      let out = '';
      let end = -Infinity;
      for (const r of line) {
        const gap = r.x - end;
        if (out) out += gap > r.size * 1.2 ? '   ' : gap > r.size * 0.1 && !out.endsWith(' ') && !r.text.startsWith(' ') ? ' ' : '';
        out += r.text;
        end = r.x + r.text.length * r.size * 0.5;
      }
      return out.trimEnd();
    })
    .join('\n');
}

/** The text of a PDF, page by page, or a problem in words when there is none to read. */
export function pdfText(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): PdfTextResult {
  const head = latin1(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) return { text: '', pages: 0, problem: 'This is not a PDF file' };
  let pdf: PdfFile;
  try {
    pdf = new PdfFile(bytes, inflate);
  } catch {
    return { text: '', pages: 0, problem: 'This PDF could not be read; it may be damaged' };
  }
  if (pdf.encrypted) return { text: '', pages: 0, problem: 'This PDF is password-protected or encrypted. Save an unprotected copy, or paste the text of the bill instead' };
  const pages = pdf.pages();
  if (!pages.length) return { text: '', pages: 0, problem: 'No pages were found in this PDF; it may be damaged' };
  const texts: string[] = [];
  let undecodable = false;
  for (const p of pages) {
    const r = pageRuns(pdf, p);
    undecodable ||= r.undecodable;
    texts.push(layout(r.runs));
  }
  const text = texts.join('\n\n').trim();
  if (!text)
    return {
      text: '',
      pages: pages.length,
      problem: undecodable
        ? 'The text in this PDF uses fonts without a character map, so it cannot be read reliably. Paste the text of the bill instead'
        : 'This PDF has no text to read; it is probably a scan or a photo. Paste the text of the bill, or enter the bill by hand',
    };
  return { text, pages: pages.length, problem: null };
}
