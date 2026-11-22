import { addDays, formatDateText } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Reconciliation exception analysis (BANK-020) against the real API and database: an imported
 * statement and entries in the books that do not match, grouped into a fee taken off, two cheques
 * banked together, a payment returned by the bank, a reversed entry, bank charges, money not in the
 * books, a stale cheque, one outstanding and one in transit; ageing, one account, excluding a line,
 * checks on the query, permissions and tenant isolation.
 */
const T = today();
const d = (n: number) => addDays(T, -n);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let bank: string;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };
type Item = { id: string; date: string; amount: string; text: string; entryId?: string | null };
type Exc = { kind: string; label: string; action: string; statement: Item[]; book: Item[]; amount: string; difference: string | null; age: number; detail: string };
type Acc = { account: { id: string; code: string; name: string; currency: string }; lastStatementDate: string | null; since: string | null; unmatched: { statement: number; book: number }; summary: { kind: string; count: number; amount: string }[]; ageing: { statement: { label: string; count: number; amount: string }[]; book: { label: string; count: number; amount: string }[] }; exceptions: Exc[] };
type Res = { asOf: string; summary: { accounts: number; accountsWithExceptions: number; exceptions: number; needsAction: number; byKind: Record<string, number> }; accounts: Acc[] };
const get = async (query = '', user = owner) => (await ctx.http().get(`${org.base}/banking/reconciliation-exceptions${query}`).set(user.auth).expect(200)).body as Res;
const journal = (lines: unknown[], date: string, memo: string) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, memo, post: true, lines }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Recon Owner');
  viewer = await registerUser(ctx, 'Recon Viewer');
  outsider = await registerUser(ctx, 'Recon Outsider');
  org = await createOrg(ctx, owner, { name: 'Reconciling Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Recon Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  bank = org.acc['1120']!;
  const csv = [
    'Date,Narration,Ref,Amount',
    `${dmy(d(60))},NEFT CR WALK IN CUSTOMER,UTR1,5000.00`,
    `${dmy(d(20))},NEFT CR HARBOUR CAFE,UTR2,9950.00`,
    `${dmy(d(15))},CHQ DEP 100201,,3000.00`,
    `${dmy(d(15))},CHQ DEP 100202,,2000.00`,
    `${dmy(d(12))},RTGS DR TEAK SUPPLIES,UTR3,-7000.00`,
    `${dmy(d(11))},RTGS RETURN TEAK SUPPLIES,UTR4,7000.00`,
    `${dmy(d(5))},SMS CHARGES QTR,,-59.00`,
    `${dmy(d(3))},NEFT CR UNKNOWN,UTR5,1200.00`,
  ].join('\n');
  await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'recon.csv', csv, mapping }).expect(201);
  await journal([{ accountId: bank, debit: '10000.00' }, { accountId: org.acc['4900'], credit: '10000.00' }], d(21), 'Receipt Harbour Cafe');
  await journal([{ accountId: bank, debit: '5000.00' }, { accountId: org.acc['4900'], credit: '5000.00' }], d(16), 'Two cheques banked');
  await journal([{ accountId: org.acc['6200'], debit: '4000.00' }, { accountId: bank, credit: '4000.00' }], d(50), 'Cheque 000777 to landlord');
  await journal([{ accountId: org.acc['6600'], debit: '1500.00' }, { accountId: bank, credit: '1500.00' }], d(20), 'Cheque 000778 to auditor');
  const wrong = (await journal([{ accountId: bank, debit: '600.00' }, { accountId: org.acc['4900'], credit: '600.00' }], d(8), 'Posted by mistake')).body;
  await ctx.http().post(`${org.base}/journals/${wrong.id}/reverse`).set(owner.auth).send({ date: d(7) }).expect(201);
  await journal([{ accountId: bank, debit: '800.00' }, { accountId: org.acc['4900'], credit: '800.00' }], d(1), 'Cash deposit');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('reconciliation exceptions', () => {
  it('explains every unmatched item and what to do about it', async () => {
    const r = await get('', viewer);
    expect(r.asOf).toBe(T);
    const a = r.accounts.find((x) => x.account.id === bank)!;
    expect(a).toMatchObject({ account: { name: 'Operating Bank Account', currency: 'INR' }, lastStatementDate: d(3), since: d(60), unmatched: { statement: 8, book: 7 } });
    expect(a.exceptions.map((e) => e.kind)).toEqual(['AMOUNT_DIFFERS', 'SPLIT', 'REVERSED', 'REVERSED', 'BANK_CHARGES', 'NOT_IN_BOOKS', 'NOT_IN_BOOKS', 'STALE', 'IN_TRANSIT', 'OUTSTANDING']);
    const [fee, split, revS, revB, charge, oldIn, newIn, stale, transit, outstanding] = a.exceptions as [Exc, Exc, Exc, Exc, Exc, Exc, Exc, Exc, Exc, Exc];
    expect(fee).toMatchObject({ amount: '9950.00', difference: '-50.00', detail: 'The bank shows 9950.00 and the books 10000.00: 50.00 less at the bank', action: expect.stringContaining('book the difference') });
    expect(fee.book[0]!.text).toContain('Receipt Harbour Cafe');
    expect(fee.book[0]!.entryId).toEqual(expect.any(String));
    expect(split.statement.map((s) => s.amount).sort()).toEqual(['2000.00', '3000.00']);
    expect(split).toMatchObject({ amount: '5000.00', detail: '2 statement lines add up to one entry of 5000.00' });
    expect(revS.statement.map((s) => s.amount)).toEqual(['-7000.00', '7000.00']);
    expect(revS).toMatchObject({ amount: '7000.00', detail: `7000.00 in and out again on the statement, ${formatDateText(d(12))} and ${formatDateText(d(11))}` });
    expect(revB.book.map((s) => s.amount)).toEqual(['600.00', '-600.00']);
    expect(charge).toMatchObject({ amount: '-59.00', label: 'Bank charges or interest' });
    expect(oldIn).toMatchObject({ amount: '5000.00', age: 60, detail: 'Money in at the bank 60 days ago with nothing in the books' });
    expect(newIn).toMatchObject({ amount: '1200.00', age: 3 });
    expect(stale).toMatchObject({ amount: '-4000.00', detail: '47 days older than the latest statement line and still on no statement' });
    expect(transit).toMatchObject({ amount: '800.00', detail: `Dated after the latest statement line (${formatDateText(d(3))})` });
    expect(outstanding).toMatchObject({ amount: '-1500.00', detail: '17 days older than the latest statement line' });
    expect(a.ageing.statement.map((b) => b.count)).toEqual([2, 5, 1, 0]);
    expect(a.ageing.book.map((b) => b.count)).toEqual([2, 4, 1, 0]);
    expect(a.summary.find((s) => s.kind === 'NOT_IN_BOOKS')).toMatchObject({ count: 2, amount: '6200.00' });
    expect(r.summary).toMatchObject({ accountsWithExceptions: 1, exceptions: 10, needsAction: 9, byKind: { AMOUNT_DIFFERS: 1, SPLIT: 1, REVERSED: 2, BANK_CHARGES: 1, NOT_IN_BOOKS: 2, STALE: 1, IN_TRANSIT: 1, OUTSTANDING: 1 } });
    expect(r.accounts[0]!.account.id).toBe(bank);
  });

  it('looks at one account, and drops a line once it is excluded', async () => {
    const one = await get(`?accountId=${bank}`);
    expect(one.accounts).toHaveLength(1);
    const charge = one.accounts[0]!.exceptions.find((e) => e.kind === 'BANK_CHARGES')!;
    await ctx.http().post(`${org.base}/banking/lines/${charge.statement[0]!.id}/exclude`).set(owner.auth).send({ reason: 'Booked with the quarterly charges' }).expect(200);
    const after = await get(`?accountId=${bank}`);
    expect(after.accounts[0]!.exceptions.some((e) => e.kind === 'BANK_CHARGES')).toBe(false);
    expect(after.summary.exceptions).toBe(9);
  });

  it('checks the query', async () => {
    await ctx.http().get(`${org.base}/banking/reconciliation-exceptions?accountId=nope`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/banking/reconciliation-exceptions?other=1`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/banking/reconciliation-exceptions?accountId=00000000-0000-4000-8000-000000000000`).set(owner.auth).expect(404);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/banking/reconciliation-exceptions`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/banking/reconciliation-exceptions?accountId=${bank}`).set(outsider.auth).expect(404);
    const mine = (await ctx.http().get(`${other.base}/banking/reconciliation-exceptions`).set(outsider.auth).expect(200)).body as Res;
    expect(mine.summary.exceptions).toBe(0);
  });
});
