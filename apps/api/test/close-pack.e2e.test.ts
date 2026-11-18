import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * WFLOW-021 the month-end report pack against the real API and database: refused until the month
 * is closed; once closed, a ZIP with the certification and the month's reports as PDFs and a
 * README whose checksums match each file; recorded in the audit trail; the ageing reports only
 * for those who can read sales or purchases; other organisations cannot download it.
 */
const T = today();
const shift = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const lastDay = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let M: string;
let periodId: string;
let P: string;

const binary = (req: ReturnType<ReturnType<Ctx['http']>['get']>) =>
  req.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

/** Entries of a stored ZIP (the pack is written uncompressed). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const n = buf.readUInt16LE(p + 26);
    out.set(buf.subarray(p + 30, p + 30 + n).toString('utf8'), Buffer.from(buf.subarray(p + 30 + n, p + 30 + n + size)));
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
  owner = await registerUser(ctx, 'Pack Owner');
  viewer = await registerUser(ctx, 'Pack Viewer');
  employee = await registerUser(ctx, 'Pack Employee');
  outsider = await registerUser(ctx, 'Pack Outsider');
  org = await createOrg(ctx, owner, { name: 'Report Pack Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Pack Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  M = shift(T.slice(0, 7), -1);
  const fy = fiscalYearForDate(`${M}-01`, 4);
  for (const y of [fy - 1, fy]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
  const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string }[];
  periodId = periods.find((p) => p.startDate === `${M}-01`)!.id;
  P = `${org.base}/close/${periodId}`;
  const journal = (date: string, debit: string, credit: string, amount: string, memo: string) =>
    ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, memo, post: true, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
  await journal(`${M}-03`, '1120', '3100', '400000.00', 'Capital introduced');
  await journal(`${M}-10`, '1120', '4100', '85000.00', 'Cash sales');
  await journal(`${M}-15`, '6200', '1120', '30000.00', 'Office rent');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('the report pack of a closed month', () => {
  it('is refused until the month is closed', async () => {
    await ctx.http().post(`${P}/start`).set(owner.auth).expect(200);
    const r = (await ctx.http().get(`${P}/report-pack`).set(owner.auth).expect(409)).body;
    expect(r).toMatchObject({ error: 'CLOSE_NOT_CLOSED' });
    expect(r.message).toContain('is not closed yet');
  });

  it('holds the certification and the reports, with checksums that match', async () => {
    const closed = (await ctx.http().post(`${P}/close`).set(owner.auth).send({ note: 'Bank reconciled outside the system; earlier months are pre-system.' }).expect(200)).body;
    expect(closed.close.status).toBe('CLOSED');
    const name: string = closed.period.name;

    const res = await binary(ctx.http().get(`${P}/report-pack`).set(owner.auth)).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toContain('close-pack-');
    const zip = res.body as Buffer;
    expect(res.headers['x-report-sha256']).toBe(sha(zip));

    const files = unzip(zip);
    const to = lastDay(M);
    expect([...files.keys()]).toEqual([
      `01-close-certification-${to}.pdf`,
      `02-trial-balance-${to}.pdf`,
      `03-income-statement-${to}.pdf`,
      `04-balance-sheet-${to}.pdf`,
      `05-receivables-ageing-${to}.pdf`,
      `06-payables-ageing-${to}.pdf`,
      'README.txt',
    ]);
    for (const [n, b] of files) if (n.endsWith('.pdf')) expect(b.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const readme = files.get('README.txt')!.toString('utf8');
    expect(readme).toContain(`Report Pack Pvt Ltd: month-end report pack for ${name}`);
    expect(readme).toContain('Closed and certified by Pack Owner');
    for (const [n, b] of files) if (n !== 'README.txt') expect(readme).toContain(`${sha(b)}  ${n}`);

    const cert = pdfText(files.get(`01-close-certification-${to}.pdf`)!);
    expect(cert).toContain(`Month-end close certification: ${name}`);
    expect(cert).toContain('Passed');
    expect(cert).toContain('Accepted warning');
    expect(cert).toContain('Net profit for the month');
    expect(cert).toContain('55,000.00');
    expect(cert).toContain('Bank reconciled outside the system');
    const pl = pdfText(files.get(`03-income-statement-${to}.pdf`)!);
    expect(pl).toContain('85,000.00');
    expect(pl).toContain('30,000.00');

    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=period_close&entityId=${closed.close.id}`).set(owner.auth).expect(200)).body;
    const ev = (audit.items ?? audit).find((e: { action: string }) => e.action === 'close.report_pack_exported');
    expect(ev.data).toMatchObject({ period: name, sha256: sha(zip), fileName: /filename="([^"]+)"/.exec(res.headers['content-disposition'])?.[1] });
    expect(ev.data.files).toHaveLength(7);
    expect(ev.data.files[0]).toEqual({ name: `01-close-certification-${to}.pdf`, sha256: sha(files.get(`01-close-certification-${to}.pdf`)!) });
  });

  it('follows report permissions, and stays inside the organisation', async () => {
    const files = unzip((await binary(ctx.http().get(`${P}/report-pack`).set(viewer.auth)).expect(200)).body as Buffer);
    expect(files.size).toBeGreaterThanOrEqual(5);
    await ctx.http().get(`${P}/report-pack`).set(employee.auth).expect(403);
    await ctx.http().get(`${other.base}/close/${periodId}/report-pack`).set(outsider.auth).expect(404);
    await ctx.http().get(`${org.base}/close/not-a-period/report-pack`).set(owner.auth).expect(400);
  });
});
