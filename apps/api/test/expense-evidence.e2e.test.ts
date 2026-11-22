import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Automated audit evidence for expense claims (EXP-027) against the real API and database: a claim
 * with a receipt, paid and matched on the bank statement is complete; one with no receipt whose
 * payment is missing from a statement that covers it has two gaps; a claim approved outside the
 * policy with a note is noted; an unpaid, a voided and a cash-paid claim have no gaps; the pack
 * lists files with SHA-256 and the hash-chained events; the CSV index; permissions and tenants.
 */
const T = today();
const d = (n: number) => addDays(T, -n);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let ravi: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, { id: string; number: string; reimbursementJournalEntryId?: string | null }> = {};

const E = () => `${org.base}/expense-evidence`;
async function claim(key: string, amount: string, approvedAgo: number, opts: { receipt?: boolean; note?: string } = {}) {
  const x = (await ctx.http().post(`${org.base}/expense-claims`).set(ravi.auth).send({ title: `Trip ${key}`, lines: [{ date: d(approvedAgo + 1), accountId: org.acc['6600'], merchant: 'Synthetic Travels', amount }] }).expect(201)).body;
  if (opts.receipt) await ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${x.id}&fileName=receipt-${key}.pdf`).set(ravi.auth).set('Content-Type', 'application/pdf').send(PDF).expect(201);
  await ctx.http().post(`${org.base}/expense-claims/${x.id}/submit`).set(ravi.auth).send({}).expect(200);
  c[key] = (await ctx.http().post(`${org.base}/expense-claims/${x.id}/approve`).set(approver.auth).send({ date: d(approvedAgo), ...(opts.note ? { note: opts.note } : {}) }).expect(200)).body;
}
const reimburse = async (key: string, ago: number, account = '1120') => {
  c[key] = (await ctx.http().post(`${org.base}/expense-claims/${c[key]!.id}/reimburse`).set(owner.auth).send({ bankAccountId: org.acc[account], date: d(ago) }).expect(200)).body;
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Evidence Owner');
  approver = await registerUser(ctx, 'Anil Approver');
  ravi = await registerUser(ctx, 'Ravi Field');
  viewer = await registerUser(ctx, 'Evidence Viewer');
  outsider = await registerUser(ctx, 'Evidence Outsider');
  org = await createOrg(ctx, owner, { name: 'Evidenced Claims Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Evidence Ltd' });
  for (const [u, role] of [[approver, 'APPROVER'], [ravi, 'EMPLOYEE'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/expense-policy-rules`).set(owner.auth).send({ kind: 'LINE_MAX', severity: 'WARN', amount: '2000' }).expect(201);
  await claim('A', '1200.00', 20, { receipt: true });
  await claim('B', '800.00', 10);
  await claim('C', '2500.00', 12, { receipt: true, note: 'Client dinner agreed in advance' });
  await claim('D', '300.00', 2, { receipt: true });
  await claim('E', '400.00', 30, { receipt: true });
  await claim('F', '150.00', 6, { receipt: true });
  await reimburse('A', 15);
  await reimburse('B', 8);
  await reimburse('C', 9);
  await reimburse('F', 5, '1110');
  await ctx.http().post(`${org.base}/expense-claims/${c.E!.id}/void`).set(owner.auth).send({ date: d(25), reason: 'Claimed twice by mistake' }).expect(200);
  // The statement runs to three days ago: A's payment is on it and matched, B's and C's are not.
  const csv = ['Date,Narration,Ref,Amount', `${dmy(d(15))},NEFT DR RAVI FIELD,UTR1,-1200.00`, `${dmy(d(3))},SMS CHARGES,,-59.00`].join('\n');
  await ctx.http().post(`${org.base}/banking/accounts/${org.acc['1120']}/imports`).set(owner.auth).send({ fileName: 'hdfc.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }).expect(201);
  const lines = (await ctx.http().get(`${org.base}/banking/accounts/${org.acc['1120']}/lines`).set(owner.auth).expect(200)).body.lines as { id: string; amount: string }[];
  const je = (await ctx.http().get(`${org.base}/journals/${c.A!.reimbursementJournalEntryId}`).set(owner.auth).expect(200)).body;
  const bankLine = je.lines.find((l: { accountId: string }) => l.accountId === org.acc['1120']);
  await ctx.http().post(`${org.base}/banking/lines/${lines.find((l) => l.amount === '-1200.00')!.id}/match`).set(owner.auth).send({ journalLineIds: [bankLine.id] }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

type Item = { kind: string; state: string; detail: string };
type Row = { number: string; complete: boolean; gaps: string[]; items: Item[]; files: number; events: number; claimant: string; status: string };

describe('expense audit evidence', () => {
  it('collects the evidence of every claim decided in the period, with the gaps', async () => {
    const r = (await ctx.http().get(E()).set(approver.auth).expect(200)).body;
    expect(r).toMatchObject({ from: d(89), to: T, currency: 'INR', summary: { claims: 6, complete: 4, withGaps: 2, files: 5 } });
    expect(r.summary.gaps).toMatchObject({ RECEIPTS: 1, BANK: 2, POLICY: 0 });
    const by = Object.fromEntries((r.claims as Row[]).map((x) => [x.number, x]));
    const state = (k: string) => Object.fromEntries(by[c[k]!.number]!.items.map((i) => [i.kind, i.state]));
    expect(by[c.A!.number]).toMatchObject({ complete: true, gaps: [], claimant: 'Ravi Field', status: 'REIMBURSED', files: 1 });
    expect(state('A')).toEqual({ RECEIPTS: 'OK', APPROVAL: 'OK', POLICY: 'OK', POSTING: 'OK', PAYMENT: 'OK', BANK: 'OK', AUDIT_TRAIL: 'OK' });
    expect(by[c.B!.number]).toMatchObject({ complete: false, gaps: ['RECEIPTS', 'BANK'] });
    expect(by[c.B!.number]!.items.find((i) => i.kind === 'BANK')!.detail).toBe(`Not matched on the statement, which runs to ${d(3)}`);
    // C: outside the policy with the approver's note is noted; its payment is missing from the statement too.
    expect(state('C')).toMatchObject({ POLICY: 'NOTED', BANK: 'GAP' });
    expect(by[c.C!.number]!.items.find((i) => i.kind === 'POLICY')!.detail).toContain('with the note: "Client dinner agreed in advance"');
    expect(state('D')).toMatchObject({ PAYMENT: 'PENDING', BANK: 'NA' });
    expect(state('E')).toMatchObject({ PAYMENT: 'NA', AUDIT_TRAIL: 'OK' });
    expect(state('F')).toMatchObject({ BANK: 'NA' });
  });

  it('lists only the claims with gaps when asked, and narrows the period', async () => {
    const r = (await ctx.http().get(`${E()}?gapsOnly=true`).set(owner.auth).expect(200)).body;
    expect((r.claims as Row[]).map((x) => x.number).sort()).toEqual([c.B!.number, c.C!.number].sort());
    expect(r.summary.claims).toBe(6);
    const recent = (await ctx.http().get(`${E()}?from=${d(11)}&to=${T}`).set(owner.auth).expect(200)).body;
    expect((recent.claims as Row[]).map((x) => x.number)).toEqual([c.B!.number, c.F!.number, c.D!.number]);
  });

  it("gives one claim's evidence pack with file checksums and the audit events", async () => {
    const p = (await ctx.http().get(`${E()}/${c.A!.id}`).set(approver.auth).expect(200)).body;
    expect(p).toMatchObject({ number: c.A!.number, complete: true, total: '1200.00' });
    expect(p.files).toHaveLength(1);
    expect(p.files[0]).toMatchObject({ fileName: 'receipt-A.pdf' });
    expect(p.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.events.map((e: { action: string }) => e.action)).toEqual(['expense_claim.created', 'expense_claim.submitted', 'expense_claim.approved', 'expense_claim.reimbursed']);
    expect(p.events[2]).toMatchObject({ by: 'Anil Approver' });
    expect(p.events[2].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.items.find((i: Item) => i.kind === 'APPROVAL').detail).toMatch(/^Approved by Anil Approver at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, posted on /);
  });

  it('exports the evidence index as CSV', async () => {
    const x = (await ctx.http().get(`${E()}/export?from=${d(11)}&to=${T}`).set(owner.auth).expect(200)).body;
    expect(x.fileName).toBe(`expense-evidence-${d(11)}-to-${T}.csv`);
    const rows = (x.csv as string).trim().split('\n');
    expect(rows[0]).toBe('Claim,Claimant,Status,Total,Evidence,State,Detail,File,SHA-256');
    // Three claims × seven items, plus the receipt files of D and F.
    expect(rows).toHaveLength(1 + 3 * 7 + 2);
    expect(rows.some((l) => l.startsWith(`${c.B!.number},Ravi Field,REIMBURSED,800.00,Receipts,GAP,No receipt is attached to the claim`))).toBe(true);
    expect(rows.filter((l) => l.includes('Receipt file')).every((l) => /,[0-9a-f]{64}$/.test(l))).toBe(true);
  });

  it('checks permissions, validation and tenants', async () => {
    await ctx.http().get(E()).set(ravi.auth).expect(403);
    await ctx.http().get(E()).set(viewer.auth).expect(403);
    await ctx.http().get(`${E()}?from=${T}&to=${d(5)}`).set(owner.auth).expect(422);
    await ctx.http().get(`${E()}/not-an-id`).set(owner.auth).expect(400);
    await ctx.http().get(E()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/expense-evidence`).set(outsider.auth).expect(200)).body.claims).toEqual([]);
    await ctx.http().get(`${other.base}/expense-evidence/${c.A!.id}`).set(outsider.auth).expect(404);
  });
});
