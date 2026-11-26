#!/usr/bin/env node
/**
 * Large transaction volumes (PERF-002) against a running API: one organisation is filled with a
 * year of posted invoices and bills, then the reports people open most (and the header search,
 * PERF-012) are timed
 * one after another, several times each, and checked against the "reports at volume" budget in
 * perf/budgets.json. The books are checked afterwards: the trial balance balances and receivables
 * equal what was invoiced.
 *
 *   node scripts/volume-test.mjs [--api http://localhost:4000] [--invoices 5000] [--bills 1000]
 *                                [--customers 200] [--runs 10] [--check] [--out report.json]
 *
 * Seeding uses several members of the organisation in parallel, each inside the API's per-person
 * rate limit. Amounts are seeded deterministically from the invoice number.
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
const INVOICES = Number(args.invoices ?? 5000);
const BILLS = Number(args.bills ?? Math.round(INVOICES / 5));
const CUSTOMERS = Number(args.customers ?? 200);
const RUNS = Number(args.runs ?? 10);
const SEEDERS = 8;
const PER_SEEDER_PER_SECOND = 8; // under the default 600 a minute per person
const BUDGETS = JSON.parse(readFileSync(new URL('../perf/budgets.json', import.meta.url), 'utf8')).budgets;
const LIMIT = BUDGETS.find((b) => b.key === 'reports-at-volume-p95').limitMs;
const SEARCH_LIMIT = BUDGETS.find((b) => b.key === 'search-at-volume-p95').limitMs;
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const yearStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;
const DAYS = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${yearStart}T00:00:00Z`)) / 86_400_000)); // not money
const dayOf = (n) => new Date(Date.parse(`${yearStart}T00:00:00Z`) + (n % (DAYS + 1)) * 86_400_000).toISOString().slice(0, 10); // not money

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
async function register(name) {
  const email = `volume-${randomUUID()}@example.test`;
  const r = await must('POST', '/v1/auth/register', null, { email, name, password: 'volume-test-very-long-password' });
  return { email, token: r.accessToken, id: r.user.id };
}
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
/** Runs jobs with `workers` in parallel, each worker at most `perSecond` jobs a second. */
async function paced(jobs, workers, perSecond, run) {
  let next = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const t0 = performance.now();
        await run(w, job);
        const wait = 1000 / perSecond - (performance.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }),
  );
}

// ------------------------------------------------------------ seed
const started = performance.now();
const owner = await register('Volume Owner');
const org = await must('POST', '/v1/orgs', owner.token, { name: 'Volume Test Pvt Ltd', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 });
const base = `/v1/orgs/${org.id}`;
const acc = Object.fromEntries((await must('GET', `${base}/accounts`, owner.token)).map((a) => [a.code, a.id]));
const seeders = [owner];
for (let i = 1; i < SEEDERS; i++) {
  const p = await register(`Volume Accountant ${i}`);
  await must('POST', `${base}/members`, owner.token, { email: p.email, role: 'ACCOUNTANT' });
  seeders.push(p);
}
const customers = [];
for (let i = 0; i < CUSTOMERS; i++) customers.push((await must('POST', `${base}/contacts`, owner.token, { name: `Volume Customer ${String(i + 1).padStart(4, '0')}`, isCustomer: true })).id);
const vendors = [];
for (let i = 0; i < 20; i++) vendors.push((await must('POST', `${base}/contacts`, owner.token, { name: `Volume Vendor ${i + 1}`, isVendor: true })).id);

let invoiced = 0n; // paise
const invoices = [];
await paced(
  Array.from({ length: INVOICES }, (_, n) => n),
  seeders,
  PER_SEEDER_PER_SECOND,
  async (p, n) => {
    const paise = 50_000 + ((n * 7919) % 5_000_000);
    const unitPrice = `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
    const issueDate = dayOf(n);
    const r = await must('POST', `${base}/sales/documents`, p.token, {
      kind: 'INVOICE',
      contactId: customers[n % CUSTOMERS],
      issueDate,
      dueDate: issueDate,
      post: true,
      lines: [{ accountId: acc['4100'], quantity: '1', unitPrice }],
    });
    invoiced += BigInt(paise);
    invoices.push({ id: r.id, contactId: customers[n % CUSTOMERS], total: unitPrice, issueDate });
  },
);
await paced(
  Array.from({ length: BILLS }, (_, n) => n),
  seeders,
  PER_SEEDER_PER_SECOND,
  async (p, n) => {
    const issueDate = dayOf(n * 3);
    await must('POST', `${base}/purchases/documents`, p.token, {
      kind: 'BILL',
      contactId: vendors[n % 20],
      issueDate,
      dueDate: issueDate,
      reference: `VB-${n}`,
      post: true,
      lines: [{ accountId: acc['6400'], quantity: '1', unitPrice: `${1000 + (n % 500)}.00` }],
    });
  },
);
const seededIn = Math.round((performance.now() - started) / 1000);

// ------------------------------------------------------------ time the reports
const REPORTS = [
  ['Dashboard', `${base}/reports/dashboard?asOf=${today}`],
  ['Trial balance', `${base}/reports/trial-balance?asOf=${today}`],
  ['Income statement', `${base}/reports/income-statement?from=${yearStart}&to=${today}`],
  ['Balance sheet', `${base}/reports/balance-sheet?asOf=${today}`],
  ['Receivables ageing', `${base}/sales/ageing?asOf=${today}`],
  ['Invoice list', `${base}/sales/documents?kind=INVOICE`],
];
const results = [];
for (const [name, path] of REPORTS) {
  await must('GET', path, owner.token); // warm-up
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await call('GET', path, owner.token);
    if (r.status !== 200) throw new Error(`${name} answered ${r.status}`);
    ms.push(Math.round(r.ms));
  }
  results.push({ name, p95: pct(ms, 95), median: pct(ms, 50), samples: ms });
}

// ------------------------------------------------------------ time the header search (PERF-012)
// Terms that match every invoice, a few numbers, one customer, one bill reference, and nothing.
const SEARCHES = [
  ['Search: every invoice', 'INV'],
  ['Search: part of a number', '012'],
  ['Search: a customer', 'customer 0042'],
  ['Search: a bill reference', 'vb-17'],
  ['Search: nothing matches', 'no such record'],
];
const searches = [];
for (const [name, term] of SEARCHES) {
  const path = `${base}/graph/search?q=${encodeURIComponent(term)}`;
  const found = await must('GET', path, owner.token); // warm-up
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await call('GET', path, owner.token);
    if (r.status !== 200) throw new Error(`${name} answered ${r.status}`);
    ms.push(Math.round(r.ms));
  }
  searches.push({ name, found: Array.isArray(found) ? found.length : 0, p95: pct(ms, 95), median: pct(ms, 50), samples: ms });
}

// ------------------------------------------------------------ check the books
const tb = await must('GET', `${base}/reports/trial-balance?asOf=${today}`, owner.token);
const ageing = await must('GET', `${base}/sales/ageing?asOf=${today}`, owner.token);
const invoicedText = `${invoiced / 100n}.${String(invoiced % 100n).padStart(2, '0')}`;
// The report holds only what this script worked out (yes or no, and its own total), never text
// the API sent back, since it is written to a file; a difference is printed instead.
const books = { trialBalanceBalances: tb.totalDebit === tb.totalCredit, invoiced: invoicedText, receivablesMatch: ageing.totals.balance === invoicedText };

const missed = results.filter((r) => r.p95 > LIMIT).map((r) => `${r.name} p95 ${r.p95} ms > ${LIMIT} ms`);
missed.push(...searches.filter((r) => r.p95 > SEARCH_LIMIT).map((r) => `${r.name} p95 ${r.p95} ms > ${SEARCH_LIMIT} ms`));
if (searches[0].found === 0 || searches[2].found === 0 || searches[4].found !== 0) missed.push('the search did not find what it should');
if (!books.trialBalanceBalances) missed.push('the trial balance does not balance');
if (!books.receivablesMatch) {
  missed.push(`receivables differ from invoiced ${books.invoiced}`);
  console.error(`Receivables in the ageing: ${ageing.totals.balance}`);
}
const report = {
  conditions: { api: API, invoices: INVOICES, bills: BILLS, customers: CUSTOMERS, runs: RUNS, seededInSeconds: seededIn },
  budgetMs: LIMIT,
  results,
  searchBudgetMs: SEARCH_LIMIT,
  searches,
  books,
  passed: missed.length === 0,
  missed,
};
console.log(JSON.stringify(report, null, 2));
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
if (args.check && missed.length) process.exit(1);
