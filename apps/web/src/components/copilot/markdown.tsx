import { Fragment, ReactNode } from 'react';

/**
 * Renders the copilot's answer, which the model writes as simple Markdown, as React
 * elements: headings, paragraphs, bullet and numbered lists, tables, bold, italics and
 * inline code. No HTML is ever injected and links are shown as plain text.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-3 text-sm leading-6">{blocks(text)}</div>;
}

function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let i = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('**')) out.push(<strong key={k} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k} className="rounded bg-surface-hover px-1 font-mono text-[0.85em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) out.push(t.slice(1, t.indexOf(']')));
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push(<p key={key} className="font-semibold text-fg">{inline(h[2], key)}</p>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? 'right' : 'left'));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const numeric = (c: number) => align[c] === 'right' || rows.every((r) => /^[-−]?[₹$€£]?[\d,.]+%?$|^—$/.test(r[c] ?? ''));
      out.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>{head.map((c, j) => <th key={j} className={`border-b border-line px-2 py-1 font-medium text-fg-muted ${numeric(j) ? 'text-right' : 'text-left'}`}>{inline(c, `${key}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{head.map((_, j) => <td key={j} className={`border-b border-line/60 px-2 py-1 ${numeric(j) ? 'num text-right' : ''}`}>{inline(r[j] ?? '', `${key}r${ri}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key} className={`space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    out.push(
      <p key={key}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j ? <br /> : null}
            {inline(p, `${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}
