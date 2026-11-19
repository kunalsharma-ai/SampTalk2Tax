import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, lastDayOf } from '@talk2tax/accounting-engine';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Automated journal suggestions (GL-036) against the real API and database: a rent journal typed
 * in each of the last three months but missing in the last one, and utilities costs needing an
 * accrual; accepting saves a draft journal, dismissing needs a reason, both are recorded once and
 * audited, readers cannot act on them, and another organisation sees nothing.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
const T = today();
const M = addMonths(T.slice(0, 7), -1);
const E = [-3, -2, -1].map((i) => addMonths(M, i));
// A fiscal year starting five months back covers the three earlier months and today.
const fyStart = Number(addMonths(T.slice(0, 7), -5).slice(5, 7));
const S = () => `${org.base}/journal-suggestions`;

type Suggestion = { key: string; kind: string; title: string; date: string; total: string; memo: string; history: { month: string; amount: string }[]; lines: { accountCode: string; debit: string; credit: string }[] };
const list = async (who = owner, month = M) => (await ctx.http().get(`${S()}?month=${month}`).set(who.auth).expect(200)).body as { suggestions: Suggestion[]; notes: string[]; decisions: { key: string; action: string; reason: string | null; journal: { id: string; status: string } | null }[] };
const post = (o: Org, date: string, debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${o.base}/journals`).set(owner.auth).send({ date, post: true, memo, lines: [{ accountId: o.acc[debit], debit: amount }, { accountId: o.acc[credit], credit: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Suggestions Owner');
  viewer = await registerUser(ctx, 'Suggestions Viewer');
  outsider = await registerUser(ctx, 'Suggestions Outsider');
  org = await createOrg(ctx, owner, { name: 'Suggest Co', fiscalYearStartMonth: fyStart });
  other = await createOrg(ctx, outsider, { name: 'Other Co', fiscalYearStartMonth: fyStart });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await post(org, `${E[0]}-01`, '1120', '3100', '500000.00', 'Capital');
  for (const m of E) await post(org, `${m}-05`, '6200', '1120', '50000.00', 'Office rent');
  await post(org, `${E[0]}-20`, '6300', '1120', '3000.00', 'Power');
  await post(org, `${E[1]}-20`, '6300', '1110', '3500.00', 'Power, paid in cash');
  await post(org, `${E[2]}-20`, '6300', '1120', '4100.00', 'Power');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('journal suggestions', () => {
  it('suggest the missed rent and an accrual for utilities', async () => {
    const r = await list();
    expect(r.notes).toEqual([]);
    expect(r.suggestions.map((s) => `${s.kind} ${s.title} ${s.date} ${s.total}`)).toEqual([`REPEAT Office rent ${M}-05 50000.00`, `ACCRUAL Accrue Utilities ${lastDayOf(M)} 3533.33`]);
    const [rent, power] = r.suggestions;
    expect(rent!.lines.map((l) => `${l.accountCode} ${l.debit || '-'} ${l.credit || '-'}`)).toEqual(['6200 50000.00 -', '1120 - 50000.00']);
    expect(power!.lines.map((l) => `${l.accountCode} ${l.debit || '-'} ${l.credit || '-'}`)).toEqual(['6300 3533.33 -', '2200 - 3533.33']);
    expect(power!.history.map((h) => h.amount)).toEqual(['3000.00', '3500.00', '4100.00']);
    // Readers see them; other organisations do not.
    expect((await list(viewer)).suggestions).toHaveLength(2);
    await ctx.http().get(`${S()}?month=${M}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/journal-suggestions?month=${M}`).set(outsider.auth).expect(200)).body.suggestions).toEqual([]);
    await ctx.http().get(`${S()}?month=2026-13`).set(owner.auth).expect(400);
    expect((await list(owner, addMonths(T.slice(0, 7), 1))).notes).toEqual(['Suggestions are made for this month or earlier ones.']);
  });

  it('accept one as a draft journal, once', async () => {
    const { suggestions } = await list();
    const power = suggestions.find((s) => s.kind === 'ACCRUAL')!;
    await ctx.http().post(`${S()}/accept`).set(viewer.auth).send({ month: M, key: power.key }).expect(403);
    const j = (await ctx.http().post(`${S()}/accept`).set(owner.auth).send({ month: M, key: power.key }).expect(201)).body;
    expect(j).toMatchObject({ status: 'DRAFT', type: 'ADJUSTING', date: lastDayOf(M), memo: power.memo, reference: `Accrual ${M}` });
    expect(j.lines.map((l: { accountCode: string; debit: string; credit: string }) => `${l.accountCode} ${l.debit} ${l.credit}`)).toEqual([expect.stringMatching(/^6300 3533\.33\d* 0/), expect.stringMatching(/^2200 0[.0]* 3533\.33/)]);
    expect(j.totalDebit).toMatch(/^3533\.33/);
    const after = await list();
    expect(after.suggestions.map((s) => s.kind)).toEqual(['REPEAT']);
    expect(after.decisions).toEqual([expect.objectContaining({ key: power.key, action: 'ACCEPTED', journal: expect.objectContaining({ id: j.id, status: 'DRAFT' }) })]);
    expect((await ctx.http().post(`${S()}/accept`).set(owner.auth).send({ month: M, key: power.key }).expect(409)).body.error).toMatch(/SUGGESTION_(GONE|DECIDED)/);
    await ctx.http().post(`${S()}/accept`).set(owner.auth).send({ month: M, key: 'REPEAT:nothing' }).expect(409);
  });

  it('dismiss one with a reason, and keep it out of the month', async () => {
    const rent = (await list()).suggestions[0]!;
    await ctx.http().post(`${S()}/dismiss`).set(owner.auth).send({ month: M, key: rent.key, reason: 'x' }).expect(422);
    const r = (await ctx.http().post(`${S()}/dismiss`).set(owner.auth).send({ month: M, key: rent.key, reason: 'Rent paid quarterly from now on' }).expect(200)).body;
    expect(r.suggestions).toEqual([]);
    expect(r.decisions.map((d: { action: string; reason: string | null }) => `${d.action} ${d.reason ?? ''}`.trim())).toEqual(['DISMISSED Rent paid quarterly from now on', 'ACCEPTED']);
    await ctx.http().post(`${S()}/dismiss`).set(owner.auth).send({ month: M, key: rent.key, reason: 'Again please' }).expect(409);
  });

  it('are audited, and decisions never change', async () => {
    const audit = (await ctx.http().get(`${org.base}/audit-events?limit=200`).set(owner.auth).expect(200)).body;
    const actions = (Array.isArray(audit) ? audit : audit.items).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['journal_suggestion.accepted', 'journal_suggestion.dismissed', 'journal.draft_created']));
    const db = ctx.app.get((await import('../src/common/prisma.service')).PrismaService);
    const d = await db.journalSuggestionDecision.findFirst({ where: { orgId: org.orgId, action: 'DISMISSED' } });
    await expect(db.journalSuggestionDecision.update({ where: { id: d!.id }, data: { reason: 'Changed' } })).rejects.toThrow();
    await expect(db.journalSuggestionDecision.delete({ where: { id: d!.id } })).rejects.toThrow();
  });
});
