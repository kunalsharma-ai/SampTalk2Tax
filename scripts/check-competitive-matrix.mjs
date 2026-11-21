#!/usr/bin/env node
/**
 * COMP-044, COMP-046, COMP-047: the competitive feature matrix (docs/COMPETITIVE_FEATURE_MATRIX.md)
 * stays honest. Every code is on the directive's scale; every finding that says a competitor has
 * something names an official https source and the date it was verified; no finding rests on a
 * review site or another vendor's comparison page; and each summary cell agrees with its detail row.
 *
 *   node scripts/check-competitive-matrix.mjs          exits 1 and lists each problem
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CODES = new Set(['EM', 'EL', 'AO', 'AI', 'NC', 'PD']);
/** Codes that say the vendor has the capability, so they need a source. */
const NEEDS_SOURCE = new Set(['EM', 'EL', 'AO', 'AI']);
/** Not the vendor's own word: review and comparison sites. */
const UNOFFICIAL = ['g2.com', 'capterra.com', 'trustradius.com', 'getapp.com', 'softwareadvice.com', 'gartner.com', 'forrester.com', 'reddit.com', 'wikipedia.org', 'medium.com', 'quora.com'];
/** Whether a source URL is on a review or comparison site (or a subdomain of one). */
export function isUnofficial(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return UNOFFICIAL.some((d) => host === d || host.endsWith(`.${d}`));
}
/** Summary rows whose cells are words rather than codes. */
const TEXT_ROWS = new Set(['Subscription model', 'Limitations']);

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRule = (line) => /^\|(?:\s*-+\s*\|)+\s*$/.test(line.trim());

/** The tables of the document, each with the heading above it. */
function tables(text) {
  const out = [];
  let heading = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{2,3}\s+(.*)/);
    if (h) heading = h[1].trim();
    if (lines[i].trim().startsWith('|') && lines[i + 1] && isRule(lines[i + 1])) {
      const header = cells(lines[i]);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push({ line: j + 1, cells: cells(lines[j]) });
      out.push({ heading, header, rows });
      i = j - 1;
    }
  }
  return out;
}

/** Every problem in the matrix text, with its line number. */
export function checkMatrix(text) {
  const problems = [];
  const all = tables(text);
  const details = new Map();
  for (const t of all) {
    if (t.header[0] !== 'Capability' || t.header[1] !== 'Code') continue;
    const verified = t.header[3]?.match(/verified (\d{4}-\d{2}-\d{2})/);
    if (!verified) problems.push({ line: t.rows[0]?.line ?? 0, problem: `${t.heading}: the source column names no verification date` });
    const rows = new Map();
    for (const r of t.rows) {
      const [capability, code, finding, source] = r.cells;
      rows.set(capability, code);
      if (code !== '—' && !CODES.has(code)) problems.push({ line: r.line, problem: `${t.heading} / ${capability}: "${code}" is not on the scale` });
      if (!finding) problems.push({ line: r.line, problem: `${t.heading} / ${capability}: no finding` });
      const urls = (source ?? '').match(/https?:\/\/\S+/g) ?? [];
      if (NEEDS_SOURCE.has(code) && !urls.length) problems.push({ line: r.line, problem: `${t.heading} / ${capability}: ${code} needs an official source` });
      for (const u of urls) {
        if (!u.startsWith('https://')) problems.push({ line: r.line, problem: `${t.heading} / ${capability}: source is not https` });
        if (isUnofficial(u)) problems.push({ line: r.line, problem: `${t.heading} / ${capability}: ${u} is not an official vendor source` });
      }
    }
    details.set(t.heading, rows);
  }
  for (const t of all) {
    if (t.header[0] !== 'Capability' || t.header[1] === 'Code') continue;
    for (const r of t.rows) {
      const capability = r.cells[0];
      t.header.slice(1).forEach((vendor, k) => {
        const code = r.cells[k + 1];
        if (TEXT_ROWS.has(capability)) return;
        if (!CODES.has(code)) return problems.push({ line: r.line, problem: `${vendor} / ${capability}: "${code}" is not on the scale` });
        const section = [...details.keys()].find((h) => h === vendor || h.startsWith(`${vendor} `) || h.endsWith(` ${vendor}`) || h.includes(vendor));
        if (!section) return problems.push({ line: r.line, problem: `${vendor}: no detail section` });
        const detail = details.get(section).get(capability === 'Enterprise' ? 'Enterprise' : capability);
        if (detail === undefined) return problems.push({ line: r.line, problem: `${vendor} / ${capability}: no detail row` });
        if (detail !== code) problems.push({ line: r.line, problem: `${vendor} / ${capability}: summary says ${code}, detail says ${detail}` });
      });
    }
  }
  return problems;
}

const MATRIX = fileURLToPath(new URL('../docs/COMPETITIVE_FEATURE_MATRIX.md', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkMatrix(readFileSync(MATRIX, 'utf8'));
  if (problems.length) {
    console.error('The competitive feature matrix has unsourced or inconsistent findings (COMP-044, COMP-046, COMP-047):');
    for (const p of problems) console.error(`  docs/COMPETITIVE_FEATURE_MATRIX.md:${p.line}  ${p.problem}`);
    process.exit(1);
  }
  console.log('Every competitive finding is on the scale, sourced, dated and consistent.');
}
