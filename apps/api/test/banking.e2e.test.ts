import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Bank statement import, matching and reconciliation against a real database.
 * Dates are relative to today so the test stays inside the current fiscal year.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let bank: string;
let invoiceId: string;
let customerId: string;
let depositLineId: string; // ledger line of the manual cash deposit

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - (10 - n) * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };

const rows = () => [
  'Date,Narration,Ref,Amount',
  `${dmy(day(1))},NEFT HARBOUR CAFE INV-000001,UTR001,"11,800.00"`,
  `${dmy(day(2))},RENT OCTOBER,,-25000.00`,
  `${dmy(day(3))},CASH DEPOSIT BRANCH,,2000.00`,
  `${dmy(day(3))},BANK CHARGES,,(500.00)`,
];

function journal(lines: unknown[], date = day(0), memo = 'Test journal') {
  return ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, memo, post: true, lines });
}

async function lines(status?: string) {
  const q = status ? `?status=${status}` : '';
  return (await ctx.http().get(`${org.base}/banking/accounts/${bank}/lines${q}`).set(owner.auth).expect(200)).body.lines as {
    id: string;
    description: string;
    amount: string;
    status: string;
    reconciled: boolean;
    matches: { origin: string; entryId: string; source: string; payment: { number: string } | null }[];
    suggestion: { journalLineId: string; unique: boolean } | null;
  }[];
}
const lineBy = async (text: string) => (await lines()).find((l) => l.description.includes(text))!;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  accountant = await registerUser(ctx, 'Accountant');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  bank = org.acc['1120'];
  // Opening balance before statements are imported.
  await journal([{ accountId: bank, debit: '100000.00' }, { accountId: org.acc['3100'], credit: '100000.00' }], day(0), 'Opening balance').expect(201);
  // A cash deposit already in the books, and a cheque that has not cleared yet.
  const dep = (await journal([{ accountId: bank, debit: '2000.00' }, { accountId: org.acc['4900'], credit: '2000.00' }], day(3), 'Cash deposit').expect(201)).body;
  depositLineId = dep.lines.find((l: { accountId: string }) => l.accountId === bank).id;
  await journal([{ accountId: org.acc['6600'], debit: '3000.00' }, { accountId: bank, credit: '3000.00' }], day(4), 'Cheque 000123 to auditor').expect(201);
  customerId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Harbour Cafe', isCustomer: true }).expect(201)).body.id;
  invoiceId = (
    await ctx
      .http()
      .post(`${org.base}/sales/documents`)
      .set(owner.auth)
      .send({ kind: 'INVOICE', contactId: customerId, issueDate: day(0), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '11800.00' }] })
      .expect(201)
  ).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('statement import', () => {
  it('lists bank and cash accounts with their ledger balance', async () => {
    const accounts = (await ctx.http().get(`${org.base}/banking/accounts`).set(owner.auth).expect(200)).body;
    expect(accounts.map((a: { code: string }) => a.code)).toEqual(['1110', '1120']);
    expect(accounts[1]).toMatchObject({ ledgerBalance: '99000.00', statementLines: 0, lastReconciled: null });
  });

  it('previews without storing, then imports, and skips lines already imported', async () => {
    const preview = (await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'oct.csv', csv: rows().join('\n'), mapping, dryRun: true }).expect(201)).body;
    expect(preview).toMatchObject({ imported: false, newCount: 4, duplicateCount: 0, moneyIn: '13800.00', moneyOut: '25500.00' });
    expect(await lines()).toHaveLength(0);

    const first = (await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'oct.csv', csv: rows().slice(0, 4).join('\n'), mapping }).expect(201)).body;
    expect(first).toMatchObject({ imported: true, newCount: 3 });
    // The full file overlaps the first one: only the new line is added.
    const second = (await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'oct-full.csv', csv: rows().join('\n'), mapping }).expect(201)).body;
    expect(second).toMatchObject({ newCount: 1, duplicateCount: 3 });
    expect(second.lines.filter((l: { duplicate: boolean }) => l.duplicate)).toHaveLength(3);
    const again = await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'oct-full.csv', csv: rows().join('\n'), mapping }).expect(409);
    expect(again.body.error).toBe('NOTHING_NEW');
    expect(await lines()).toHaveLength(4);
    const imports = (await ctx.http().get(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).expect(200)).body;
    expect(imports.map((i: { lineCount: number }) => i.lineCount)).toEqual([1, 3]);
  });

  it('reports every unreadable row instead of importing part of a file', async () => {
    const res = await ctx
      .http()
      .post(`${org.base}/banking/accounts/${bank}/imports`)
      .set(owner.auth)
      .send({ fileName: 'bad.csv', csv: `h\n31/02/2026,x,,1\n${dmy(day(5))},,,1\n${dmy(day(5))},ok,,1.234\n`, mapping })
      .expect(422);
    expect(res.body.error).toBe('STATEMENT_INVALID');
    expect(res.body.details.issues).toHaveLength(3);
    await ctx.http().post(`${org.base}/banking/accounts/${org.acc['4100']}/imports`).set(owner.auth).send({ fileName: 'x.csv', csv: rows().join('\n'), mapping }).expect(422);
  });
});

describe('matching', () => {
  it('suggests and auto-matches only unambiguous pairs', async () => {
    const deposit = await lineBy('CASH DEPOSIT');
    expect(deposit.suggestion).toMatchObject({ journalLineId: depositLineId, unique: true });
    const res = (await ctx.http().post(`${org.base}/banking/accounts/${bank}/auto-match`).set(owner.auth).expect(200)).body;
    expect(res.matched).toBe(1);
    expect((await lineBy('CASH DEPOSIT')).status).toBe('MATCHED');
  });

  it('refuses a match whose amounts differ or that uses another account', async () => {
    const rent = await lineBy('RENT');
    const other = (await journal([{ accountId: org.acc['6200'], debit: '24000.00' }, { accountId: bank, credit: '24000.00' }], day(2), 'Wrong rent').expect(201)).body;
    const wrongLine = other.lines.find((l: { accountId: string }) => l.accountId === bank).id;
    const expenseLine = other.lines.find((l: { accountId: string }) => l.accountId !== bank).id;
    const a = await ctx.http().post(`${org.base}/banking/lines/${rent.id}/match`).set(owner.auth).send({ journalLineIds: [wrongLine] }).expect(422);
    expect(a.body.message).toContain('add up to -24000.00, not -25000.00');
    const b = await ctx.http().post(`${org.base}/banking/lines/${rent.id}/match`).set(owner.auth).send({ journalLineIds: [expenseLine] }).expect(422);
    expect(b.body.message).toContain('on this bank account');
    // Undo the wrong journal so the ledger stays as the scenario expects.
    await ctx.http().post(`${org.base}/journals/${other.id}/reverse`).set(owner.auth).send({ date: day(2) }).expect(201);
  });

  it('records a customer receipt from money in, settling the invoice', async () => {
    const line = await lineBy('HARBOUR');
    const res = (
      await ctx
        .http()
        .post(`${org.base}/banking/lines/${line.id}/record-payment`)
        .set(owner.auth)
        .send({ contactId: customerId, allocations: [{ documentId: invoiceId, amount: '11800.00' }] })
        .expect(200)
    ).body;
    expect(res.status).toBe('MATCHED');
    expect(res.matches[0]).toMatchObject({ origin: 'CREATED_PAYMENT', source: 'PAYMENT', payment: { number: 'RCPT-000001' } });
    const inv = (await ctx.http().get(`${org.base}/sales/documents/${invoiceId}`).set(owner.auth).expect(200)).body;
    expect(inv.amountDue).toBe('0.00');
  });

  it('posts a bank entry for money out, but never to the receivables account', async () => {
    const rent = await lineBy('RENT');
    const bad = await ctx.http().post(`${org.base}/banking/lines/${rent.id}/create-entry`).set(owner.auth).send({ accountId: org.acc['1200'] }).expect(422);
    expect(bad.body.error).toBe('CONTROL_ACCOUNT');
    const res = (await ctx.http().post(`${org.base}/banking/lines/${rent.id}/create-entry`).set(owner.auth).send({ accountId: org.acc['6200'] }).expect(200)).body;
    expect(res.matches[0]).toMatchObject({ origin: 'CREATED_ENTRY', source: 'BANK', amount: '-25000.00' });
    // Bank entries are system entries: not reversible from the journals screen.
    const rev = await ctx.http().post(`${org.base}/journals/${res.matches[0].entryId}/reverse`).set(owner.auth).send({ date: day(2) }).expect(409);
    expect(rev.body.error).toBe('SYSTEM_ENTRY');
  });

  it('will not reverse a matched manual journal until it is unmatched', async () => {
    const dep = (await ctx.http().get(`${org.base}/journals?status=POSTED&limit=50`).set(owner.auth).expect(200)).body.items.find((e: { memo: string }) => e.memo === 'Cash deposit');
    const res = await ctx.http().post(`${org.base}/journals/${dep.id}/reverse`).set(owner.auth).send({ date: day(3) }).expect(409);
    expect(res.body.error).toBe('BANK_MATCHED');
  });

  it('unmatching a created entry reverses it; the line can then be booked again', async () => {
    const rent = await lineBy('RENT');
    const entryId = rent.matches[0].entryId;
    const res = (await ctx.http().post(`${org.base}/banking/lines/${rent.id}/unmatch`).set(owner.auth).send({}).expect(200)).body;
    expect(res.line.status).toBe('UNMATCHED');
    expect(res.reversedEntryIds).toHaveLength(1);
    const original = (await ctx.http().get(`${org.base}/journals/${entryId}`).set(owner.auth).expect(200)).body;
    expect(original.status).toBe('POSTED');
    await ctx.http().post(`${org.base}/banking/lines/${rent.id}/create-entry`).set(accountant.auth).send({ accountId: org.acc['6200'], description: 'Office rent' }).expect(200);
  });

  it('books bank charges, then a stray line is excluded with a reason', async () => {
    const charges = await lineBy('BANK CHARGES');
    await ctx.http().post(`${org.base}/banking/lines/${charges.id}/create-entry`).set(owner.auth).send({ accountId: org.acc['6900'] }).expect(200);
    await ctx
      .http()
      .post(`${org.base}/banking/accounts/${bank}/imports`)
      .set(owner.auth)
      .send({ fileName: 'stray.csv', csv: `h\n${dmy(day(5))},CARD TXN REVERSED SAME DAY,,-999.00\n`, mapping })
      .expect(201);
    const stray = await lineBy('CARD TXN');
    await ctx.http().post(`${org.base}/banking/lines/${stray.id}/exclude`).set(owner.auth).send({ reason: '' }).expect(400);
    await ctx.http().post(`${org.base}/banking/lines/${stray.id}/exclude`).set(owner.auth).send({ reason: 'Bank shows it reversed on the next line of the PDF' }).expect(200);
    await ctx.http().post(`${org.base}/banking/lines/${stray.id}/create-entry`).set(owner.auth).send({ accountId: org.acc['6900'] }).expect(409);
  });

  it('matches a ledger line to only one statement line, even under concurrency', async () => {
    const extra = [`h`, `${dmy(day(6))},TRANSFER A,,-700.00`, `${dmy(day(6))},TRANSFER B,,-700.00`].join('\n');
    await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'race.csv', csv: extra, mapping }).expect(201);
    const je = (await journal([{ accountId: org.acc['1110'], debit: '700.00' }, { accountId: bank, credit: '700.00' }], day(6), 'Cash withdrawal').expect(201)).body;
    const jl = je.lines.find((l: { accountId: string }) => l.accountId === bank).id;
    const [a, b] = [await lineBy('TRANSFER A'), await lineBy('TRANSFER B')];
    const results = await Promise.all([a, b].map((l) => ctx.http().post(`${org.base}/banking/lines/${l.id}/match`).set(owner.auth).send({ journalLineIds: [jl] })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 200)!;
    expect([409, 422]).toContain(loser.status);
    // Leave the test data balanced for the reconciliation: exclude the line that lost.
    const unmatched = [await lineBy('TRANSFER A'), await lineBy('TRANSFER B')].find((l) => l.status === 'UNMATCHED')!;
    await ctx.http().post(`${org.base}/banking/lines/${unmatched.id}/exclude`).set(owner.auth).send({ reason: 'Duplicate of the other transfer line' }).expect(200);
  });

  it('enforces matching rules in the database as well', async () => {
    const stray = await lineBy('CARD TXN');
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM bank_statement_lines WHERE id = '${stray.id}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE bank_statement_lines SET amount = 1 WHERE id = '${stray.id}'`)).rejects.toThrow(/cannot be changed/);
    // Marking a line MATCHED without matching ledger lines fails at commit.
    await expect(
      ctx.prisma.$executeRawUnsafe(`UPDATE bank_statement_lines SET status = 'MATCHED', excluded_reason = NULL WHERE id = '${stray.id}'`),
    ).rejects.toThrow(/does not equal its matched ledger lines/);
  });
});

describe('reconciliation', () => {
  // Statement: 100,000 opening + 11,800 − 25,000 + 2,000 − 500 − 700 = 87,600 (excluded lines do not count).
  // Ledger: 100,000 + 2,000 − 3,000 + 11,800 − 25,000 − 500 − 700 = 84,600, with the 3,000 cheque uncleared.
  const asOf = () => today();

  it('previews the figures and explains why it does not reconcile yet', async () => {
    const res = (
      await ctx.http().post(`${org.base}/banking/accounts/${bank}/reconciliations/preview`).set(owner.auth).send({ statementDate: asOf(), statementBalance: '87000.00', openingBalance: '100000.00' }).expect(200)
    ).body;
    expect(res).toMatchObject({ firstReconciliation: true, startDate: day(1), computedStatementBalance: '87600.00', ledgerBalance: '84600.00', uncleared: '-3000.00', canComplete: false });
    expect(res.unclearedLines.map((l: { memo: string }) => l.memo)).toEqual(['Cheque 000123 to auditor']);
    expect(res.issues[0]).toContain('difference -600.00');
    await ctx.http().post(`${org.base}/banking/accounts/${bank}/reconciliations`).set(owner.auth).send({ statementDate: asOf(), statementBalance: '87000.00', openingBalance: '100000.00' }).expect(422);
  });

  it('completes when the ledger less uncleared items equals the statement, and freezes the lines', async () => {
    const res = (
      await ctx.http().post(`${org.base}/banking/accounts/${bank}/reconciliations`).set(accountant.auth).send({ statementDate: asOf(), statementBalance: '87600.00', openingBalance: '100000.00' }).expect(201)
    ).body;
    expect(res).toMatchObject({ status: 'COMPLETED', statementBalance: '87600.00', ledgerBalance: '84600.00', uncleared: '-3000.00', lines: 7 });
    const all = await lines();
    expect(all.every((l) => l.reconciled)).toBe(true);
    const deposit = await lineBy('CASH DEPOSIT');
    expect((await ctx.http().post(`${org.base}/banking/lines/${deposit.id}/unmatch`).set(owner.auth).send({}).expect(409)).body.error).toBe('LINE_RECONCILED');
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE bank_matches SET removed_at = now() WHERE statement_line_id = '${deposit.id}'`)).rejects.toThrow(/reconciled/);
    const late = await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'late.csv', csv: `h\n${dmy(day(2))},LATE LINE,,-1.00\n`, mapping }).expect(409);
    expect(late.body.error).toBe('PERIOD_RECONCILED');
    const accounts = (await ctx.http().get(`${org.base}/banking/accounts`).set(owner.auth).expect(200)).body;
    expect(accounts[1].lastReconciled).toEqual({ date: asOf(), statementBalance: '87600.00' });
  });

  it('only owners and admins undo a reconciliation, which keeps its record', async () => {
    const [rec] = (await ctx.http().get(`${org.base}/banking/accounts/${bank}/reconciliations`).set(owner.auth).expect(200)).body;
    await ctx.http().post(`${org.base}/banking/reconciliations/${rec.id}/undo`).set(accountant.auth).send({ reason: 'Wrong statement' }).expect(403);
    const undone = (await ctx.http().post(`${org.base}/banking/reconciliations/${rec.id}/undo`).set(owner.auth).send({ reason: 'Statement balance re-checked' }).expect(200)).body;
    expect(undone.status).toBe('UNDONE');
    await ctx.http().post(`${org.base}/banking/reconciliations/${rec.id}/undo`).set(owner.auth).send({ reason: 'Again' }).expect(409);
    expect((await lines()).some((l) => l.reconciled)).toBe(false);
    const history = (await ctx.http().get(`${org.base}/banking/accounts/${bank}/reconciliations`).set(owner.auth).expect(200)).body;
    expect(history).toHaveLength(1);
    const audit = (await ctx.http().get(`${org.base}/audit-events?limit=100`).set(owner.auth).expect(200)).body;
    const actions = (audit.items ?? audit).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['bank.statement_imported', 'bank.line_matched', 'bank.line_unmatched', 'bank.reconciled', 'bank.reconciliation_undone']));
  });
});

describe('roles and tenants', () => {
  it('lets a viewer read bank lines but change nothing', async () => {
    const viewer = await registerUser(ctx, 'Viewer');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    await ctx.http().get(`${org.base}/banking/accounts/${bank}/lines`).set(viewer.auth).expect(200);
    await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(viewer.auth).send({ fileName: 'x.csv', csv: rows().join('\n'), mapping, dryRun: true }).expect(403);
    const stray = await lineBy('CARD TXN');
    await ctx.http().post(`${org.base}/banking/lines/${stray.id}/include`).set(viewer.auth).expect(403);
  });

  it("never exposes another tenant's bank lines or accepts its ledger lines", async () => {
    const other = await registerUser(ctx, 'Other');
    const otherOrg = await createOrg(ctx, other);
    const stray = await lineBy('CARD TXN');
    await ctx.http().get(`${otherOrg.base}/banking/lines/${stray.id}`).set(other.auth).expect(404);
    await ctx.http().get(`${org.base}/banking/lines/${stray.id}`).set(other.auth).expect(404);
    await ctx.http().post(`${otherOrg.base}/banking/accounts/${bank}/imports`).set(other.auth).send({ fileName: 'x.csv', csv: rows().join('\n'), mapping, dryRun: true }).expect(404);
    // Include the stray line, then try to match it with a ledger line from the other organisation.
    await ctx.http().post(`${org.base}/banking/lines/${stray.id}/include`).set(owner.auth).expect(200);
    const theirs = (
      await ctx
        .http()
        .post(`${otherOrg.base}/journals`)
        .set(other.auth)
        .send({ date: day(5), post: true, lines: [{ accountId: otherOrg.acc['6900'], debit: '999.00' }, { accountId: otherOrg.acc['1120'], credit: '999.00' }] })
        .expect(201)
    ).body;
    const theirLine = theirs.lines.find((l: { accountId: string }) => l.accountId === otherOrg.acc['1120']).id;
    const res = await ctx.http().post(`${org.base}/banking/lines/${stray.id}/match`).set(owner.auth).send({ journalLineIds: [theirLine] }).expect(422);
    expect(res.body.message).toContain('not found');
  });
});
