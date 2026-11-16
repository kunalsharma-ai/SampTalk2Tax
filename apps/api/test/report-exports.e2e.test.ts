import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Report exports against the real API and database: every report in CSV, Excel and PDF, the
 * numbers in each file matching the report's own JSON endpoint, CSV formula neutralising,
 * parameter checks, permissions, tenant isolation and the audit trail with the file hash.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let E: string;
const T = today();

const binary = (req: ReturnType<ReturnType<Ctx['http']>['get']>) =>
  req.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

/** Entries of a stored ZIP (the exporter writes uncompressed entries). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const n = buf.readUInt16LE(p + 26);
    out.set(buf.subarray(p + 30, p + 30 + n).toString('utf8'), buf.subarray(p + 30 + n, p + 30 + n + size).toString('utf8'));
    p += 30 + n + size;
  }
  return out;
}

/** The text drawn on a pdfkit page: inflate each content stream and read the hex strings. */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  let text = '';
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = s.indexOf('endstream', start);
    try {
      const body = inflateSync(buf.subarray(start, end)).toString('latin1');
      for (const t of body.matchAll(/<([0-9a-f]+)>/gi)) text += Buffer.from(t[1]!, 'hex').toString('latin1');
      text += '\n';
    } catch {
      // not a deflated stream (fonts, metadata)
    }
  }
  return text;
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Export Owner');
  viewer = await registerUser(ctx, 'Export Viewer');
  employee = await registerUser(ctx, 'Export Employee');
  outsider = await registerUser(ctx, 'Export Outsider');
  org = await createOrg(ctx, owner, { name: 'Ledger & Sons Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Co' });
  E = `${org.base}/reports/export`;
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  const customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: '=HYPERLINK("http://evil.test","Click")', isCustomer: true }).expect(201)).body;
  const supplier = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Granite Supplies', isVendor: true }).expect(201)).body;
  const dept = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code: 'SALES', name: 'Sales team' }).expect(201)).body;
  await ctx
    .http()
    .post(`${org.base}/sales/documents`)
    .set(owner.auth)
    .send({ kind: 'INVOICE', contactId: customer.id, issueDate: T, post: true, lines: [{ accountId: org.acc['4100'], description: 'Consulting', quantity: '1', unitPrice: '1234567.50', departmentId: dept.id }] })
    .expect(201);
  await ctx
    .http()
    .post(`${org.base}/purchases/documents`)
    .set(owner.auth)
    .send({ kind: 'BILL', contactId: supplier.id, issueDate: T, post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '25000.25' }] })
    .expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('report exports', () => {
  it('exports the trial balance as CSV with the same figures as the report', async () => {
    const tb = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${T}`).set(viewer.auth).expect(200)).body;
    const res = await binary(ctx.http().get(`${E}/trial-balance?asOf=${T}&format=csv`).set(viewer.auth)).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="trial-balance-${T}.csv"; filename*=UTF-8''trial-balance-${T}.csv`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const csv = (res.body as Buffer).toString('utf8');
    expect(csv.startsWith('﻿Trial balance\r\nLedger & Sons Pvt Ltd\r\n')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines[4]).toBe('Code,Account,Type,Debit,Credit,Net debit,Net credit');
    for (const r of tb.rows) expect(lines).toContain([r.code, r.name, r.type.charAt(0) + r.type.slice(1).toLowerCase(), r.debit, r.credit, r.netDebit, r.netCredit].join(','));
    expect(lines).toContain(`,Total,,${tb.totals.debit},${tb.totals.credit},${tb.totals.netDebit},${tb.totals.netCredit}`);
    expect(csv).toContain('Debits equal credits.');
    expect(res.headers['x-report-sha256']).toBe(createHash('sha256').update(res.body as Buffer).digest('hex'));
  });

  it('neutralises formulas in names in CSV and keeps them as text in Excel', async () => {
    const csv = (await binary(ctx.http().get(`${E}/receivables-ageing?asOf=${T}&format=csv`).set(viewer.auth)).expect(200)).body.toString('utf8');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""Click"")",`);
    expect(csv).toContain('Customer,Not yet due,1-30 days,31-60 days,61-90 days,Over 90 days,Less unapplied,Balance');
    const xlsx = (await binary(ctx.http().get(`${E}/receivables-ageing?asOf=${T}&format=xlsx`).set(viewer.auth)).expect(200)).body as Buffer;
    const sheet = unzip(xlsx).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://evil.test&quot;');
    expect(sheet).not.toContain('<f>');
  });

  it('exports an Excel workbook with amounts as numbers in lakh format', async () => {
    const res = await binary(ctx.http().get(`${E}/income-statement?from=${T}&to=${T}&format=xlsx`).set(owner.auth)).expect(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain(`profit-and-loss-${T}-to-${T}.xlsx`);
    const files = unzip(res.body as Buffer);
    expect(files.get('xl/workbook.xml')).toContain('name="Profit and loss"');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toMatch(/<c r="C\d+" s="13"><v>1234567.5<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="C\d+" s="2"><v>25000.25<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="C\d+" s="14"><v>1209567.25<\/v><\/c>/); // net profit, bold, lakh band
    expect(files.get('xl/styles.xml')).toContain('##\\,##\\,##0.00');
  });

  it('exports PDFs with the figures, a footer and landscape pages for wide reports', async () => {
    const res = await binary(ctx.http().get(`${E}/balance-sheet?asOf=${T}&format=pdf`).set(viewer.auth)).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    const text = pdfText(pdf);
    expect(text).toContain('Balance sheet');
    expect(text).toContain('Ledger & Sons Pvt Ltd');
    expect(text).toContain('12,34,567.50'); // receivable, lakh grouping
    expect(text).toContain('Total liabilities and equity');
    expect(text).toContain('Page 1 of 1');
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/);
    const ageing = (await binary(ctx.http().get(`${E}/payables-ageing?asOf=${T}&format=pdf`).set(viewer.auth)).expect(200)).body as Buffer;
    expect(ageing.toString('latin1')).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
    expect(pdfText(ageing)).toContain('Granite Supplies');
  });

  it('exports the general ledger and profit by department', async () => {
    const gl = (await binary(ctx.http().get(`${E}/general-ledger?accountId=${org.acc['4100']}&from=${T}&to=${T}&format=csv`).set(viewer.auth)).expect(200)).body.toString('utf8');
    expect(gl).toContain('General ledger: 4100');
    expect(gl).toMatch(new RegExp(`${T},JE-\\d{6},Consulting,,1234567.50,1234567.50`));
    expect(gl).toContain(`${T},,Closing balance,0.00,1234567.50,1234567.50`);
    const pd = (await binary(ctx.http().get(`${E}/profit-by-dimension?type=DEPARTMENT&from=${T}&to=${T}&format=csv`).set(viewer.auth)).expect(200)).body.toString('utf8');
    expect(pd).toContain('Code,Account,SALES,Not assigned,Total');
    expect(pd).toContain(',Net profit,1234567.50,-25000.25,1209567.25');
    expect(pd).toContain(',Margin,100.0,,98.0');
    expect(pd).toContain('SALES: Sales team');
  });

  it('checks the format, the report name and the parameters', async () => {
    expect((await ctx.http().get(`${E}/trial-balance?asOf=${T}&format=docx`).set(owner.auth).expect(400)).body.error).toBe('INVALID_FORMAT');
    expect((await ctx.http().get(`${E}/trial-balance?asOf=${T}`).set(owner.auth).expect(400)).body.error).toBe('INVALID_FORMAT');
    expect((await ctx.http().get(`${E}/cash-book?format=csv`).set(owner.auth).expect(404)).body.error).toBe('NOT_FOUND');
    const bad = (await ctx.http().get(`${E}/trial-balance?asOf=31-10-2026&extra=1&format=csv`).set(owner.auth).expect(400)).body;
    expect(bad.error).toBe('VALIDATION_FAILED');
    expect(bad.details.issues).toEqual(expect.arrayContaining([expect.stringMatching(/^asOf:/), expect.stringMatching(/extra/)]));
    expect((await ctx.http().get(`${E}/income-statement?from=2026-12-01&to=2026-11-01&format=csv`).set(owner.auth).expect(400)).body.error).toBe('INVALID_RANGE');
    await ctx.http().get(`${E}/general-ledger?accountId=${org.acc['4100']}&from=${T}&format=csv`).set(owner.auth).expect(400);
  });

  it('needs reports.read and keeps organisations apart', async () => {
    await ctx.http().get(`${E}/trial-balance?asOf=${T}&format=csv`).set(employee.auth).expect(403);
    await ctx.http().get(`${E}/trial-balance?asOf=${T}&format=csv`).set(outsider.auth).expect(404);
    await ctx.http().get(`${E}/trial-balance?asOf=${T}&format=csv`).expect(401);
    // Another organisation's account cannot be exported through this one.
    const theirs = (await ctx.http().get(`${other.base}/accounts`).set(outsider.auth).expect(200)).body.find((a: { code: string }) => a.code === '4100').id;
    await ctx.http().get(`${E}/general-ledger?accountId=${theirs}&from=${T}&to=${T}&format=csv`).set(owner.auth).expect(404);
  });

  it('records every export in the audit log with the file hash', async () => {
    const res = await binary(ctx.http().get(`${E}/balance-sheet?asOf=${T}&format=xlsx`).set(viewer.auth)).expect(200);
    const events = (await ctx.http().get(`${org.base}/audit-events?entityType=report&limit=50`).set(owner.auth).expect(200)).body;
    const list = Array.isArray(events) ? events : events.items;
    const last = list.find((e: { action: string; data: { sha256: string } }) => e.action === 'report.exported' && e.data.sha256 === res.headers['x-report-sha256']);
    expect(last).toBeTruthy();
    expect(last.data).toMatchObject({ report: 'balance-sheet', format: 'xlsx', params: { asOf: T }, fileName: `balance-sheet-${T}.xlsx`, bytes: (res.body as Buffer).length });
    expect(list.filter((e: { action: string }) => e.action === 'report.exported').length).toBeGreaterThanOrEqual(8);
  });
});
