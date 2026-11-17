import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Transfers between the organisation's own bank accounts (BANK-007): detected from statements, recorded as one entry. */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let hdfc: string;
let icici: string;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'YYYY-MM-DD', hasHeader: true };
const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const load = (account: string, rows: string[]) =>
  ctx.http().post(`${org.base}/banking/accounts/${account}/imports`).set(owner.auth).send({ fileName: 'synthetic.csv', csv: ['Date,Description,Reference,Amount', ...rows].join('\n'), mapping }).expect(201);
const suggestions = async (u = owner) => (await ctx.http().get(`${org.base}/banking/transfers/suggestions`).set(u.auth).expect(200)).body.items;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Transfer Owner');
  viewer = await registerUser(ctx, 'Transfer Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  hdfc = org.acc['1120'];
  icici = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1130', name: 'ICICI Savings', type: 'ASSET', subtype: 'BANK' }).expect(201)).body.id;
  await load(hdfc, [`${day(5)},NEFT to ICICI own account,TRF001,-50000.00`, `${day(4)},Customer receipt Synthetic Traders,R-9,12000.00`, `${day(2)},Office rent,RENT-11,-12000.00`]);
  await load(icici, [`${day(4)},NEFT from HDFC,TRF001,50000.00`, `${day(1)},Interest,INT,12000.00`]);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('transfers', () => {
  it('are suggested from unmatched lines in two accounts', async () => {
    const s = await suggestions(viewer);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ amount: '50000.00', days: 1, unique: true, reasons: ['Same amount out and in', '1 day apart', 'Described as a transfer', 'Names the other account'] });
    expect(s[0].out).toMatchObject({ account: '1120 · Operating Bank Account', date: day(5), reference: 'TRF001' });
    expect(s[0].in).toMatchObject({ account: '1130 · ICICI Savings', date: day(4) });
    // Rent out of HDFC and interest into ICICI happen to be the same amount: a weaker suggestion, for a person to judge.
    expect(s[1]).toMatchObject({ amount: '12000.00', days: 1, reasons: ['Same amount out and in', '1 day apart'] });
  });

  it('are recorded as one entry matched to both lines', async () => {
    const s = (await suggestions())[0];
    await ctx.http().post(`${org.base}/banking/transfers`).set(viewer.auth).send({ outLineId: s.out.id, inLineId: s.in.id }).expect(403);
    await ctx.http().post(`${org.base}/banking/transfers`).set(owner.auth).send({ outLineId: s.in.id, inLineId: s.out.id }).expect(422);
    const r = (await ctx.http().post(`${org.base}/banking/transfers`).set(owner.auth).send({ outLineId: s.out.id, inLineId: s.in.id }).expect(201)).body;
    expect(r.out.status).toBe('MATCHED');
    expect(r.in.status).toBe('MATCHED');
    const je = (await ctx.http().get(`${org.base}/journals/${r.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je).toMatchObject({ date: day(5), memo: 'Transfer 1120 Operating Bank Account → 1130 ICICI Savings', status: 'POSTED' });
    expect(je.lines.map((l: { accountId: string; debit: string; credit: string }) => [l.accountId, l.debit, l.credit])).toEqual([[icici, '50000.00', '0.00'], [hdfc, '0.00', '50000.00']]);
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: org.orgId, action: 'bank.transfer_recorded' } })).toBe(1);

    // Recorded once: the lines are matched and no longer suggested.
    expect((await ctx.http().post(`${org.base}/banking/transfers`).set(owner.auth).send({ outLineId: s.out.id, inLineId: s.in.id }).expect(409)).body.error).toBe('ALREADY_MATCHED');
    expect((await suggestions()).map((x: { amount: string }) => x.amount)).toEqual(['12000.00']);
  });

  it('refuses lines that do not make a transfer', async () => {
    const lines = async (a: string) => (await ctx.http().get(`${org.base}/banking/accounts/${a}/lines?status=UNMATCHED`).set(owner.auth).expect(200)).body.lines as { id: string; amount: string; description: string }[];
    const [h, i] = [await lines(hdfc), await lines(icici)];
    const receipt = h.find((l) => l.description.startsWith('Customer'))!;
    const rent = h.find((l) => l.description === 'Office rent')!;
    const r = await ctx.http().post(`${org.base}/banking/transfers`).set(owner.auth).send({ outLineId: rent.id, inLineId: receipt.id }).expect(422);
    expect(r.body.details.issues).toEqual(['A transfer moves money between two different accounts']);
    expect(i).toHaveLength(1);
  });
});
