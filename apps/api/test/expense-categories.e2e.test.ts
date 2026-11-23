import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * EXP-005: expense categories against the real API and database. Finance names the categories
 * employees claim under; a claim line picks a category and takes its account; a category that
 * always needs a receipt blocks submission without one; archived categories cannot be picked.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const NONE = '00000000-0000-4000-8000-000000000000';

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let employee: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const cat: Record<string, string> = {};

const pdf = Buffer.from('%PDF-1.4\n% synthetic hotel folio 2210\n%%EOF\n');
const post = (path: string, user: TestUser, body: object) => ctx.http().post(`${org.base}${path}`).set(user.auth).send(body);
const claim = (lines: object[], who = employee) => post('/expense-claims', who, { title: 'Synthetic sales trip', lines });
const body = (name: string, code: string, extra: object = {}) => ({ name, description: null, accountId: org.acc[code], receipt: 'POLICY', ...extra });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Category Owner');
  accountant = await registerUser(ctx, 'Category Accountant');
  employee = await registerUser(ctx, 'Category Employee');
  approver = await registerUser(ctx, 'Category Approver');
  org = await createOrg(ctx, owner, { name: 'Expense Categories Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [employee, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('keeping the category list', () => {
  it('lets finance add categories, and refuses bad ones', async () => {
    await post('/expense-categories', employee, body('Hotels', '6700')).expect(403);
    await post('/expense-categories', approver, body('Hotels', '6700')).expect(403);
    const hotels = (await post('/expense-categories', accountant, body('Hotels', '6700', { description: 'Rooms booked for work trips; attach the folio.', receipt: 'ALWAYS' })).expect(201)).body;
    expect(hotels).toMatchObject({ name: 'Hotels', account: '6700 · Travel', receipt: 'ALWAYS', isActive: true, usage: { lines: 0, total: '0.00' }, limits: [] });
    cat.Hotels = hotels.id;
    cat.Taxis = (await post('/expense-categories', owner, body('Local  taxis', '6700')).expect(201)).body.id;
    cat.Software = (await post('/expense-categories', owner, body('Software', '6400')).expect(201)).body.id;
    const dup = await post('/expense-categories', owner, body(' hotels ', '6700')).expect(422);
    expect(dup.body.details.issues).toEqual(['There is already an active category called hotels']);
    const notExpense = await post('/expense-categories', owner, body('Cash', '1000')).expect(422);
    expect(notExpense.body.details.issues).toEqual(['Choose an active expense account that can be posted to']);
    await post('/expense-categories', owner, { ...body('Meals', '6700'), receipt: 'SOMETIMES' }).expect(400);
    await post('/expense-categories', owner, body('Meals', '6700', { taxRateId: NONE })).expect(422);
    const list = (await ctx.http().get(`${org.base}/expense-categories`).set(employee.auth).expect(200)).body;
    expect(list.categories.map((c: { name: string }) => c.name)).toEqual(['Hotels', 'Local taxis', 'Software']);
    expect(list.usageDays).toBeNull();
    expect(list.categories[0].usage).toBeUndefined();
  });

  it('shows the policy limits that apply to a category', async () => {
    await post('/expense-policy-rules', owner, { kind: 'LINE_MAX', severity: 'WARN', accountId: org.acc['6700'], amount: '8000' }).expect(201);
    const list = (await ctx.http().get(`${org.base}/expense-categories`).set(accountant.auth).expect(200)).body;
    const hotels = list.categories.find((c: { id: string }) => c.id === cat.Hotels);
    expect(hotels.limits.map((l: { summary: string }) => l.summary)).toEqual(['At most INR 8000.00 per receipt for 6700 · Travel']);
    expect(list.categories.find((c: { id: string }) => c.id === cat.Software).limits).toEqual([]);
  });

  it('offers the categories when claiming, and employees must pick one', async () => {
    const o = (await ctx.http().get(`${org.base}/expense-claims/options`).set(employee.auth).expect(200)).body;
    expect(o.categories.map((c: { name: string }) => c.name)).toEqual(['Hotels', 'Local taxis', 'Software']);
    expect(o.anyAccount).toBe(false);
    expect((await ctx.http().get(`${org.base}/expense-claims/options`).set(owner.auth).expect(200)).body.anyAccount).toBe(true);
    const noCategory = await claim([{ date: T, accountId: org.acc['6700'], amount: '100.00' }]).expect(422);
    expect(noCategory.body.details.issues).toEqual(['Line 1: choose a category']);
    const wrongAccount = await claim([{ date: T, categoryId: cat.Software, accountId: org.acc['6700'], amount: '100.00' }]).expect(422);
    expect(wrongAccount.body.details.issues).toEqual(['Line 1: the account is not the one Software posts to']);
    const missing = await claim([{ date: T, categoryId: NONE, amount: '100.00' }]).expect(422);
    expect(missing.body.details.issues).toEqual(['Line 1: category not found']);
    // Finance may still claim straight to an account.
    await claim([{ date: T, accountId: org.acc['6700'], amount: '100.00' }], owner).expect(201);
  });
});

describe('claiming under a category', () => {
  let claimId: string;

  it('takes the account from the category and keeps the category on the line', async () => {
    const c = (await claim([{ date: T, categoryId: cat.Hotels, merchant: 'Synthetic Inn', amount: '5400.00' }, { date: T, categoryId: cat.Taxis, merchant: 'Synthetic Cabs', amount: '350.00' }]).expect(201)).body;
    claimId = c.id;
    expect(c.lines.map((l: { accountId: string; categoryId: string; category: string }) => [l.accountId, l.categoryId, l.category])).toEqual([
      [org.acc['6700'], cat.Hotels, 'Hotels'],
      [org.acc['6700'], cat.Taxis, 'Local taxis'],
    ]);
    expect(c.policy.map((v: { message: string }) => v.message)).toEqual(['Attach the receipts: Hotels always needs one (line 1) and the claim has none']);
  });

  it('refuses to submit without a receipt for a category that always needs one', async () => {
    const r = await post(`/expense-claims/${claimId}/submit`, employee, {}).expect(422);
    expect(r.body.error).toBe('POLICY_BLOCKED');
    expect(r.body.details.issues).toEqual(['Attach the receipts: Hotels always needs one (line 1) and the claim has none']);
    await ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${claimId}&fileName=folio.pdf`).set(employee.auth).set('Content-Type', 'application/pdf').send(pdf).expect(201);
    await post(`/expense-claims/${claimId}/submit`, employee, {}).expect(200);
    const approved = (await post(`/expense-claims/${claimId}/approve`, approver, {}).expect(200)).body;
    expect(approved.status).toBe('APPROVED');
  });

  it('counts what was claimed in each category', async () => {
    const list = (await ctx.http().get(`${org.base}/expense-categories`).set(owner.auth).expect(200)).body;
    expect(list.usageDays).toBe(90);
    const usage = Object.fromEntries(list.categories.map((c: { name: string; usage: { lines: number; total: string } }) => [c.name, c.usage]));
    expect(usage).toEqual({ Hotels: { lines: 1, total: '5400.00' }, 'Local taxis': { lines: 1, total: '350.00' }, Software: { lines: 0, total: '0.00' } });
  });

  it('archives a category: it can no longer be picked, and old lines keep its name', async () => {
    await post(`/expense-categories/${cat.Taxis}/archive`, employee, {}).expect(403);
    await post(`/expense-categories/${cat.Taxis}/archive`, accountant, {}).expect(200);
    await post(`/expense-categories/${cat.Taxis}/archive`, accountant, {}).expect(409);
    const r = await claim([{ date: T, categoryId: cat.Taxis, amount: '120.00' }]).expect(422);
    expect(r.body.details.issues).toEqual(['Line 1: Local taxis is no longer a category; choose another']);
    expect((await ctx.http().get(`${org.base}/expense-claims/${claimId}`).set(employee.auth).expect(200)).body.lines[1].category).toBe('Local taxis');
    const active = (await ctx.http().get(`${org.base}/expense-categories`).set(owner.auth).expect(200)).body.categories.map((c: { name: string }) => c.name);
    expect(active).toEqual(['Hotels', 'Software']);
    const all = (await ctx.http().get(`${org.base}/expense-categories?all=true`).set(owner.auth).expect(200)).body.categories;
    expect(all.find((c: { id: string }) => c.id === cat.Taxis).isActive).toBe(false);
    // A new active category may take the archived one's name; the archived one then cannot come back.
    const again = (await post('/expense-categories', owner, body('Local taxis', '6700')).expect(201)).body;
    const restore = await post(`/expense-categories/${cat.Taxis}/restore`, owner, {}).expect(422);
    expect(restore.body.details.issues).toEqual(['There is already an active category called Local taxis']);
    await post(`/expense-categories/${again.id}/archive`, owner, {}).expect(200);
    await post(`/expense-categories/${cat.Taxis}/restore`, owner, {}).expect(200);
  });

  it('edits a category, records what changed, and holds old drafts to the new account', async () => {
    const draft = (await claim([{ date: T, categoryId: cat.Software, amount: '999.00' }]).expect(201)).body;
    const r = (await ctx.http().put(`${org.base}/expense-categories/${cat.Software}`).set(accountant.auth).send(body('Software and apps', '6500', { description: 'Subscriptions bought on a personal card.' })).expect(200)).body;
    expect(r).toMatchObject({ name: 'Software and apps', account: '6500 · Marketing', description: 'Subscriptions bought on a personal card.' });
    const blocked = await post(`/expense-claims/${draft.id}/submit`, employee, {}).expect(422);
    expect(blocked.body.details.issues).toEqual(['Line 1: Software and apps now posts to another account; save the claim again']);
    const saved = (await ctx.http().put(`${org.base}/expense-claims/${draft.id}`).set(employee.auth).send({ title: 'Synthetic sales trip', lines: [{ date: T, categoryId: cat.Software, amount: '999.00' }] }).expect(200)).body;
    expect(saved.lines[0].accountId).toBe(org.acc['6500']);
    await post(`/expense-claims/${draft.id}/submit`, employee, {}).expect(200);
    const audits = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'expense_category' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['expense_category.created', 'expense_category.archived', 'expense_category.restored', 'expense_category.updated']));
    const upd = audits.find((a) => a.action === 'expense_category.updated')!;
    expect((upd.data as { changed: Record<string, unknown> }).changed).toEqual({
      name: { from: 'Software', to: 'Software and apps' },
      description: { from: null, to: 'Subscriptions bought on a personal card.' },
      accountId: { from: org.acc['6400'], to: org.acc['6500'] },
    });
  });

  it('keeps categories to their organisation', async () => {
    const other = await createOrg(ctx, owner, { name: 'Other Categories Pvt Ltd' });
    expect((await ctx.http().get(`${other.base}/expense-categories`).set(owner.auth).expect(200)).body.categories).toEqual([]);
    await ctx.http().put(`${other.base}/expense-categories/${cat.Hotels}`).set(owner.auth).send({ name: 'X', accountId: other.acc['6700'], receipt: 'POLICY' }).expect(404);
    const r = await ctx.http().post(`${other.base}/expense-claims`).set(owner.auth).send({ title: 'Synthetic', lines: [{ date: T, categoryId: cat.Hotels, amount: '10.00' }] }).expect(422);
    expect(r.body.details.issues).toEqual(['Line 1: category not found']);
  });
});
