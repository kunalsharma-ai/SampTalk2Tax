import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Receipt-to-transaction matching (EXP-019) against the real API and database: an employee uploads
 * receipts for spending on the company account, finance matches the sure ones in one go, picks
 * between two equal bank lines by hand, and sees the money paid out that still has no receipt.
 */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
type Line = { id: string; date: string; amount: string; description: string };
type Receipt = { id: string; reference: string; merchant: string; status: string; files: { fileName: string }[]; matchedLine: Line | null; suggestion: { line: Line; score: number; confidence: string; reasons: string[]; alternatives: number } | null; history: { action: string; note: string }[] };
type List = { canMatch: boolean; summary: { unmatched: number; matched: number; discarded: number; sure: number }; items: Receipt[] };
type Missing = { lines: number; withReceipt: number; totals: { currency: string; amount: string }[]; items: (Line & { suggestion: { receipt: { reference: string }; confidence: string } | null })[] };
const list = async (user = owner) => (await ctx.http().get(`${org.base}/expense-receipts`).set(user.auth).expect(200)).body as List;
const add = async (user: TestUser, merchant: string, date: string, amount: string, file = true) => {
  const r = (await ctx.http().post(`${org.base}/expense-receipts`).set(user.auth).send({ merchant, date, amount }).expect(201)).body as Receipt;
  if (file) await ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_RECEIPT&entityId=${r.id}&fileName=${encodeURIComponent(merchant)}.pdf`).set(user.auth).set('content-type', 'application/pdf').send(pdf(merchant)).expect(201);
  return r;
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Receipt Owner');
  employee = await registerUser(ctx, 'Receipt Employee');
  viewer = await registerUser(ctx, 'Receipt Viewer');
  outsider = await registerUser(ctx, 'Receipt Outsider');
  org = await createOrg(ctx, owner, { name: 'Receipt Matching Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Receipts Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const bank = org.acc['1120']!;
  const csv = [
    'Date,Narration,Ref,Amount',
    `${dmy(addDays(T, -5))},POS 4412 BLUE TOKAI MUMBAI,,-1180.00`,
    `${dmy(addDays(T, -4))},UPI DR 99881 CITY CABS,,-650.00`,
    `${dmy(addDays(T, -3))},UPI DR 7766,U1,-2500.00`,
    `${dmy(addDays(T, -3))},UPI DR 5544,U2,-2500.00`,
    `${dmy(addDays(T, -2))},NEFT CR CUSTOMER,,5000.00`,
    `${dmy(addDays(T, -1))},POS OFFICE MART,,-999.00`,
  ].join('\n');
  await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'nov.csv', csv, mapping }).expect(201);
});
afterAll(async () => ctx?.app.close());

describe('receipt-to-transaction matching', () => {
  it('suggests the bank line for each receipt, matches the sure ones and lists what has no receipt', async () => {
    const coffee = await add(employee, 'Blue Tokai Coffee', addDays(T, -6), '1180.00');
    await add(employee, 'City Cabs', addDays(T, -4), '650');
    const paper = await add(employee, 'Stationery', addDays(T, -3), '2500.00');
    await add(owner, 'Office Mart', addDays(T, -1), '999.00', false);

    const mine = await list(employee);
    expect(mine.canMatch).toBe(false);
    expect(mine.items.map((i) => i.merchant).sort()).toEqual(['Blue Tokai Coffee', 'City Cabs', 'Stationery']);
    expect(mine.items.every((i) => i.suggestion === null)).toBe(true);

    const all = await list();
    expect(all.canMatch).toBe(true);
    const by = (m: string) => all.items.find((i) => i.merchant === m)!;
    expect(by('Blue Tokai Coffee').suggestion).toMatchObject({ score: 90, confidence: 'HIGH', line: { description: 'POS 4412 BLUE TOKAI MUMBAI', amount: '-1180.00' } });
    expect(by('City Cabs').suggestion).toMatchObject({ score: 100, confidence: 'HIGH' });
    expect(by('Stationery').suggestion).toMatchObject({ confidence: 'MEDIUM', alternatives: 1 });
    expect(by('Office Mart').suggestion).toMatchObject({ confidence: 'HIGH', line: { description: 'POS OFFICE MART' } });
    // Office Mart has no file yet, so it is not counted as sure to match.
    expect(all.summary).toEqual({ unmatched: 4, matched: 0, discarded: 0, sure: 2 });

    // No file: cannot match.
    const mart = by('Office Mart');
    expect((await ctx.http().post(`${org.base}/expense-receipts/${mart.id}/match`).set(owner.auth).send({ statementLineId: mart.suggestion!.line.id }).expect(409)).body.error).toBe('NO_FILE');

    expect((await ctx.http().post(`${org.base}/expense-receipts/match-sure`).set(owner.auth).expect(201)).body).toEqual({ matched: 2 });
    const after = await list();
    expect(after.summary).toMatchObject({ unmatched: 2, matched: 2, sure: 0 });
    const matchedCoffee = after.items.find((i) => i.id === coffee.id)!;
    expect(matchedCoffee).toMatchObject({ status: 'MATCHED', matchedLine: { description: 'POS 4412 BLUE TOKAI MUMBAI' } });
    expect(matchedCoffee.history.map((h) => h.action)).toEqual(['UPLOADED', 'MATCHED']);
    expect(matchedCoffee.history[1]!.note).toMatch(/90\/100: Same amount; 1 day apart/);

    const missing = (await ctx.http().get(`${org.base}/expense-receipts/missing`).query({ days: 30 }).set(viewer.auth).expect(200)).body as Missing;
    expect(missing).toMatchObject({ lines: 5, withReceipt: 2, totals: [{ currency: 'INR', amount: '5999.00' }] });
    expect(missing.items.map((i) => i.description)).toEqual(['POS OFFICE MART', 'UPI DR 5544', 'UPI DR 7766']);
    expect(missing.items[0]!.suggestion?.receipt.reference).toBe('RC-004');
    // Two equal payments: the stationery receipt is suggested for one of them, not both.
    const equal = missing.items.slice(1);
    expect(equal.map((i) => i.suggestion?.receipt.reference ?? null).sort()).toEqual([paper.reference, null].sort());

    // Finance picks the other equal line by hand.
    const second = equal.find((i) => i.suggestion === null)!;
    const m = (await ctx.http().post(`${org.base}/expense-receipts/${paper.id}/match`).set(owner.auth).send({ statementLineId: second.id }).expect(201)).body as Receipt;
    expect(m).toMatchObject({ status: 'MATCHED', matchedLine: { id: second.id } });
    const left = (await ctx.http().get(`${org.base}/expense-receipts/missing`).query({ days: 30 }).set(owner.auth).expect(200)).body as Missing;
    expect(left.items.map((i) => i.description)).toEqual(['POS OFFICE MART', equal.find((i) => i.suggestion !== null)!.description]);
  });

  it('keeps matches one to one, money out only, and receipts as a record', async () => {
    const all = await list();
    const coffee = all.items.find((i) => i.merchant === 'Blue Tokai Coffee')!;
    const extra = await add(employee, 'Blue Tokai Again', addDays(T, -5), '1180.00');
    expect((await ctx.http().post(`${org.base}/expense-receipts/${extra.id}/match`).set(owner.auth).send({ statementLineId: coffee.matchedLine!.id }).expect(409)).body.error).toBe('LINE_HAS_RECEIPT');
    const credit = ((await ctx.http().get(`${org.base}/banking/accounts/${org.acc['1120']}/lines`).set(owner.auth).expect(200)).body.lines as { id: string; description: string }[]).find((l) => l.description === 'NEFT CR CUSTOMER')!;
    expect((await ctx.http().post(`${org.base}/expense-receipts/${extra.id}/match`).set(owner.auth).send({ statementLineId: credit.id }).expect(422)).body.error).toBe('NOT_MONEY_OUT');
    // Matched receipts' files are fixed until unmatched.
    expect((await ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_RECEIPT&entityId=${coffee.id}&fileName=x.pdf`).set(employee.auth).set('content-type', 'application/pdf').send(pdf('late')).expect(409)).body.error).toBe('RECEIPT_NOT_OPEN');
    const un = (await ctx.http().post(`${org.base}/expense-receipts/${coffee.id}/unmatch`).set(owner.auth).send({ reason: 'Wrong outlet' }).expect(201)).body as Receipt;
    expect(un).toMatchObject({ status: 'UNMATCHED', matchedLine: null });
    expect(un.history.at(-1)).toMatchObject({ action: 'UNMATCHED', note: 'Wrong outlet' });
    // The employee discards their duplicate upload; it stays as a record.
    const d = (await ctx.http().post(`${org.base}/expense-receipts/${extra.id}/discard`).set(employee.auth).send({ reason: 'Uploaded twice' }).expect(201)).body as Receipt;
    expect(d.status).toBe('DISCARDED');
    expect((await ctx.http().post(`${org.base}/expense-receipts/${extra.id}/discard`).set(employee.auth).send({ reason: 'Again' }).expect(409)).body.error).toBe('NOT_UNMATCHED');
    expect((await list()).summary.discarded).toBe(1);
  });

  it('checks input, permissions and organisation', async () => {
    expect((await ctx.http().post(`${org.base}/expense-receipts`).set(employee.auth).send({ merchant: 'Later', date: addDays(T, 2), amount: '10' }).expect(422)).body.error).toBe('FUTURE_DATE');
    await ctx.http().post(`${org.base}/expense-receipts`).set(employee.auth).send({ merchant: 'Bad', date: T, amount: '10.123' }).expect(400);
    const mine = (await list(employee)).items[0]!;
    await ctx.http().post(`${org.base}/expense-receipts/${mine.id}/match`).set(employee.auth).send({ statementLineId: mine.id }).expect(403);
    await ctx.http().post(`${org.base}/expense-receipts/match-sure`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/expense-receipts/missing`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/expense-receipts`).set(viewer.auth).expect(403);
    // An employee does not see someone else's receipt.
    const ownerReceipt = (await list()).items.find((i) => i.merchant === 'Office Mart')!;
    await ctx.http().get(`${org.base}/expense-receipts/${ownerReceipt.id}`).set(employee.auth).expect(404);
    await ctx.http().get(`${org.base}/attachments?entityType=EXPENSE_RECEIPT&entityId=${ownerReceipt.id}`).set(employee.auth).expect(404);
    await ctx.http().get(`${other.base}/expense-receipts/${ownerReceipt.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/expense-receipts`).set(outsider.auth).expect(200)).body.items).toEqual([]);
  });
});
