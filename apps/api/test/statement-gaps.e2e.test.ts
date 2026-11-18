import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Missing statement lines (BANK-021) against the real API and database: a statement with a
 * running balance column is checked line by line on preview and import, and the breaks are kept
 * with the import.
 */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let bank: string;
const CSV = [
  'Date,Narration,Amount,Balance',
  '06/11/2026,Power bill,-3000.00,124000.00',
  '05/11/2026,Customer receipt,40000.00,127000.00',
  '03/11/2026,Rent,-25000.00,75000.00',
  '01/11/2026,Opening deposit,100000.00,"1,00,000.00 Cr"',
].join('\n');
const mapping = { date: 0, description: 1, amount: 2, balance: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };
const imp = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'nov.csv', csv: CSV, mapping, ...body });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Gap Owner');
  org = await createOrg(ctx, owner);
  bank = org.acc['1120'];
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('missing statement lines', () => {
  it('finds where the running balance breaks, in a newest-first file', async () => {
    const p = (await imp({ dryRun: true }).expect(201)).body;
    expect(p.balanceCheck).toEqual({
      checked: 4,
      order: 'NEWEST_FIRST',
      breaks: [{ row: 3, previousRow: 4, date: '2026-11-05', previousDate: '2026-11-03', expected: '115000.00', shown: '127000.00', gap: '12000.00' }],
    });
    expect(p.lines.find((l: { row: number }) => l.row === 5).balance).toBe('100000.00');
  });

  it('keeps the breaks with the import', async () => {
    const r = (await imp({}).expect(201)).body;
    expect(r.imported).toBe(true);
    const [i] = (await ctx.http().get(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).expect(200)).body;
    expect(i.balanceBreaks).toEqual([{ row: 3, previousRow: 4, date: '2026-11-05', previousDate: '2026-11-03', gap: '12000.00' }]);
  });

  it('has no balance check without a balance column', async () => {
    const p = (await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'x.csv', csv: 'Date,N,Amt\n10/11/2026,Fee,-10.00\n', mapping: { date: 0, description: 1, amount: 2, dateFormat: 'DD/MM/YYYY', hasHeader: true }, dryRun: true }).expect(201)).body;
    expect(p.balanceCheck).toBeNull();
    expect(p.lines[0].balance).toBeNull();
  });
});
