#!/usr/bin/env node
/**
 * Load test (QA-017) against a running API: many organisations, each with its own people, read
 * and post at a steady rate at the same time, and the results are checked against the performance
 * budgets and the books.
 *
 *   node scripts/load-test.mjs [--api http://localhost:4000] [--orgs 20] [--users 2]
 *                              [--seconds 30] [--rate 4] [--seed 20] [--check] [--out report.json]
 *
 * Each person makes `--rate` requests a second (inside the API's per-person rate limit): mostly the
 * common reads (dashboard, invoice list, accounts, trial balance, income statement), and one in
 * six posts an invoice. With `--check` it exits non-zero when a budget is missed or the books
 * disagree afterwards:
 *
 *   - common API reads: 95th percentile under 300 ms (PERF-016);
 *   - posting an invoice: 95th percentile under 1,000 ms;
 *   - no failed requests (any 5xx, or a 4xx the script did not expect);
 *   - every organisation's trial balance balances, its receivables equal the invoices posted,
 *     and invoice numbers are unique and unbroken (PERF-017, PERF-018).
 *
 * The defined test conditions are those of the run: the API and MongoDB on the machine they run
 * on, the data the script seeds, and the load above. The report prints them with the results.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const API = args.api ?? process.env.API_URL ?? 'http://localhost:4000';
const ORGS = Number(args.orgs ?? 20);
const USERS = Number(args.users ?? 2);
const SECONDS = Number(args.seconds ?? 30);
const RATE = Number(args.rate ?? 4);
const SEED = Number(args.seed ?? 20);
// The limits come from the performance budgets (PERF-014), so the numbers live in one place.
const BUDGETS = JSON.parse(readFileSync(new URL('../perf/budgets.json', import.meta.url), 'utf8')).budgets;
const limit = (key) => BUDGETS.find((b) => b.key === key).limitMs;
const BUDGET = { readP95: limit('api-read-p95'), writeP95: limit('api-post-invoice-p95') };
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const yearStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

async function call(method, path, token, body) {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, ms };
}

async function must(method, path, token, body, expect = [200, 201]) {
  const r = await call(method, path, token, body);
  if (!expect.includes(r.status)) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10;
};

// ---------------------------------------------------------------- set up

async function register(name) {
  const email = `load-${randomUUID()}@example.test`;
  const r = await must('POST', '/v1/auth/register', null, { email, name, password: 'load-test-very-long-password' });
  return { id: r.user.id, email, token: r.accessToken };
}

async function setUpOrg(i) {
  const owner = await register(`Load Owner ${i}`);
  const org = await must('POST', '/v1/orgs', owner.token, { name: `Load Test ${i} Pvt Ltd`, countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 });
  const base = `/v1/orgs/${org.id}`;
  const accounts = await must('GET', `${base}/accounts`, owner.token);
  const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
  const people = [owner];
  for (let u = 1; u < USERS; u++) {
    const p = await register(`Load Accountant ${i}.${u}`);
    await must('POST', `${base}/members`, owner.token, { email: p.email, role: 'ACCOUNTANT' });
    people.push(p);
  }
  const customer = await must('POST', `${base}/contacts`, owner.token, { name: `Customer ${i}`, isCustomer: true });
  const o = { base, acc, people, customer: customer.id, posted: [] };
  for (let n = 0; n < SEED; n++) await postInvoice(o, owner.token, null);
  return o;
}

async function postInvoice(o, token, stats) {
  const paise = 10_000 + Math.floor(Math.random() * 9_990_000);
  const amount = `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
  const body = { kind: 'INVOICE', contactId: o.customer, issueDate: today, dueDate: today, post: true, lines: [{ accountId: o.acc['4100'], quantity: '1', unitPrice: amount }] };
  const r = await call('POST', `${o.base}/sales/documents`, token, body);
  if (stats) stats.record('POST invoice', r, [201]);
  else if (r.status !== 201) throw new Error(`Seeding an invoice answered ${r.status}`);
  if (r.status === 201) o.posted.push({ number: r.json.number, total: r.json.total });
}

// ---------------------------------------------------------------- the load

class Stats {
  constructor() {
    this.by = new Map();
    this.failures = [];
  }
  record(name, r, expect) {
    const s = this.by.get(name) ?? { ms: [], count: 0, failed: 0 };
    s.count++;
    s.ms.push(r.ms);
    if (!expect.includes(r.status)) {
      s.failed++;
      if (this.failures.length < 20) this.failures.push(`${name}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    }
    this.by.set(name, s);
  }
}

const READS = [
  ['GET dashboard', (o) => `${o.base}/reports/dashboard?asOf=${today}`],
  ['GET invoices', (o) => `${o.base}/sales/documents?kind=INVOICE`],
  ['GET accounts', (o) => `${o.base}/accounts`],
  ['GET trial balance', (o) => `${o.base}/reports/trial-balance?asOf=${today}`],
  ['GET income statement', (o) => `${o.base}/reports/income-statement?from=${yearStart}&to=${today}`],
];

async function person(o, p, until, stats) {
  const gap = 1000 / RATE;
  let n = 0;
  while (performance.now() < until) {
    const started = performance.now();
    if (n % 6 === 5) await postInvoice(o, p.token, stats);
    else {
      const [name, path] = READS[n % READS.length];
      stats.record(name, await call('GET', path(o), p.token), [200]);
    }
    n++;
    const wait = gap - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

// ---------------------------------------------------------------- the books afterwards

async function checkBooks(o) {
  const token = o.people[0].token;
  const problems = [];
  const tb = await must('GET', `${o.base}/reports/trial-balance?asOf=${today}`, token);
  const totals = tb.totals ?? tb;
  if (totals.debit !== undefined && totals.credit !== undefined && totals.debit !== totals.credit) problems.push(`${o.base}: trial balance ${totals.debit} ≠ ${totals.credit}`);
  const rows = tb.rows ?? tb.accounts ?? [];
  const ar = rows.find((r) => r.code === '1200' || r.accountCode === '1200');
  const expected = o.posted.reduce((s, x) => s + Math.round(Number(x.total) * 100), 0);
  if (ar) {
    const bal = Math.round(Number(ar.balance ?? ar.debit ?? 0) * 100);
    if (bal !== expected) problems.push(`${o.base}: receivables ${bal / 100} ≠ invoices posted ${expected / 100}`);
  }
  const numbers = o.posted.map((x) => x.number);
  if (new Set(numbers).size !== numbers.length) problems.push(`${o.base}: duplicate invoice numbers`);
  const seq = numbers.map((x) => Number(String(x).replace(/\D/g, ''))).sort((a, b) => a - b);
  if (seq.some((v, i) => i > 0 && v !== seq[i - 1] + 1)) problems.push(`${o.base}: invoice numbers have gaps`);
  return { problems, hasReceivables: !!ar };
}

// ---------------------------------------------------------------- run

const health = await call('GET', '/health');
if (health.status !== 200) {
  console.error(`The API at ${API} is not answering /health (${health.status}).`);
  process.exit(2);
}
const t0 = performance.now();
const orgs = [];
for (let i = 0; i < ORGS; i += 5) orgs.push(...(await Promise.all(Array.from({ length: Math.min(5, ORGS - i) }, (_, k) => setUpOrg(i + k + 1)))));
const setupSeconds = Math.round((performance.now() - t0) / 100) / 10;

const stats = new Stats();
const until = performance.now() + SECONDS * 1000;
await Promise.all(orgs.flatMap((o) => o.people.map((p) => person(o, p, until, stats))));

const books = await Promise.all(orgs.map(checkBooks));
const endpoints = Object.fromEntries([...stats.by].map(([name, s]) => [name, { requests: s.count, failed: s.failed, p50: pct(s.ms, 50), p95: pct(s.ms, 95), p99: pct(s.ms, 99), max: pct(s.ms, 100) }]));
const reads = [...stats.by].filter(([n]) => n.startsWith('GET')).flatMap(([, s]) => s.ms);
const writes = stats.by.get('POST invoice')?.ms ?? [];
const total = [...stats.by.values()].reduce((s, x) => s + x.count, 0);
const failed = [...stats.by.values()].reduce((s, x) => s + x.failed, 0);
const report = {
  conditions: { api: API, organisations: ORGS, peoplePerOrganisation: USERS, people: ORGS * USERS, requestsPerPersonPerSecond: RATE, seconds: SECONDS, invoicesSeededPerOrganisation: SEED, setupSeconds },
  results: { requests: total, perSecond: Math.round(total / SECONDS), failed, readsP95: pct(reads, 95), writesP95: pct(writes, 95), endpoints },
  budgets: { readsP95Ms: BUDGET.readP95, writesP95Ms: BUDGET.writeP95 },
  books: { organisationsChecked: books.length, problems: books.flatMap((b) => b.problems) },
  failures: stats.failures,
};
const missed = [];
if (report.results.readsP95 !== null && report.results.readsP95 > BUDGET.readP95) missed.push(`reads p95 ${report.results.readsP95} ms > ${BUDGET.readP95} ms`);
if (report.results.writesP95 !== null && report.results.writesP95 > BUDGET.writeP95) missed.push(`posting p95 ${report.results.writesP95} ms > ${BUDGET.writeP95} ms`);
if (failed) missed.push(`${failed} failed requests`);
if (report.books.problems.length) missed.push(...report.books.problems);
if (books.some((b) => !b.hasReceivables)) missed.push('the trial balance has no receivables row to check');
report.passed = missed.length === 0;
report.missed = missed;

console.log(JSON.stringify(report, null, 2));
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
if (args.check && missed.length) {
  console.error(`\nLoad test missed its budgets:\n- ${missed.join('\n- ')}`);
  process.exit(1);
}
