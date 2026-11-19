import { inflateSync } from 'node:zlib';

/**
 * Structural checks on uploaded files (SEC-018). Talk2Tax keeps invoices, receipts and notices,
 * which never need to run anything, so a PDF that can run JavaScript, launch programs, carry other
 * files or submit forms is refused, whatever an antivirus says about it. Compressed streams
 * (including object streams, where such keys hide) are inflated and checked too.
 */

/** PDF name keys that make a document able to act on its own. */
const ACTIVE = ['JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'XFA', 'SubmitForm', 'ImportData'];
const NAME = new RegExp(`/(${ACTIVE.join('|')})(?![A-Za-z0-9#])`, 'g');
const MAX_INFLATED = 5 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 25 * 1024 * 1024;

/** Undoes #xx escapes in PDF names (/J#61vaScript is /JavaScript). */
function unescapeNames(text: string): string {
  return text.replace(/\/[^\s/<>[\](){}%]*/g, (n) => (n.includes('#') ? n.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : n));
}

function activeIn(text: string, found: Set<string>) {
  for (const m of unescapeNames(text).matchAll(NAME)) found.add(m[1]!);
}

/** The active-content features a PDF uses (empty when none). */
export function pdfActiveContent(buf: Buffer): string[] {
  const found = new Set<string>();
  const raw = buf.toString('latin1');
  activeIn(raw, found);
  let inflated = 0;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) && inflated < MAX_TOTAL_INFLATED) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    re.lastIndex = end;
    const data = buf.subarray(start, end);
    if (data.length < 2 || data[0] !== 0x78) continue; // not zlib
    try {
      const out = inflateSync(data, { maxOutputLength: MAX_INFLATED });
      inflated += out.length;
      activeIn(out.toString('latin1'), found);
    } catch {
      // A stream that does not inflate (truncated, or not Flate): only its raw bytes were checked.
    }
  }
  return ACTIVE.filter((k) => found.has(k));
}

/** Why a file is refused on structure alone, or null. */
export function inspectFile(buf: Buffer, contentType: string): { kind: 'ACTIVE_CONTENT'; detail: string } | null {
  if (contentType === 'application/pdf') {
    const active = pdfActiveContent(buf);
    if (active.length) return { kind: 'ACTIVE_CONTENT', detail: active.join(', ') };
  }
  return null;
}
