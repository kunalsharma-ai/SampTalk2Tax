import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-025 against the real API and database: sales revenue from posted invoices and credit notes
 * by where the customer is (Indian states, other countries), drafts and plain journals left out,
 * months checked, reports.read, and isolation. Places never name customers.
 */
const T = today();
const month = T.slice(0, 7);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

const contact = async (body: Record<string, unknown>) =>
  (
    await ctx
      .http()
      .post(`${org.base}/contacts`)
      .set(owner.auth)
      .send({ isCustomer: true, ...body })
      .expect(201)
  ).body.id as string;
const sale = (kind: 'INVOICE' | 'CREDIT_NOTE', contactId: string, amount: string, post = true) =>
  ctx
    .http()
    .post(`${org.base}/sales/documents`)
    .set(owner.auth)
    .send({ kind, contactId, issueDate: T, dueDate: T, post, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] })
    .expect(201);
const get = async (query: Record<string, string> = {}, auth = viewer.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/revenue-globe`).query(query).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Globe Owner');
  viewer = await registerUser(ctx, 'Globe Viewer');
  employee = await registerUser(ctx, 'Globe Employee');
  outsider = await registerUser(ctx, 'Globe Outsider');
  org = await createOrg(ctx, owner, { name: 'Globe Co' });
  for (const [u, role] of [
    [viewer, 'VIEWER'],
    [employee, 'EMPLOYEE'],
  ] as const)
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const mumbai = await contact({ name: 'Mumbai Mart', stateCode: '27' });
  const bengaluru = await contact({ name: 'Bengaluru Books', stateCode: '29' });
  const boston = await contact({ name: 'Boston Labs', countryCode: 'US' });
  await sale('INVOICE', mumbai, '80000.00');
  await sale('INVOICE', bengaluru, '20000.00');
  await sale('INVOICE', boston, '60000.00');
  await sale('CREDIT_NOTE', boston, '10000.00');
  await sale('INVOICE', mumbai, '7777.00', false);
  await ctx
    .http()
    .post(`${org.base}/journals`)
    .set(owner.auth)
    .send({
      date: T,
      post: true,
      memo: 'Cash sale',
      lines: [
        { accountId: org.acc['1120'], debit: '5000.00' },
        { accountId: org.acc['4100'], credit: '5000.00' },
      ],
    })
    .expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('revenue globe', () => {
  it('places this month’s sales by state at home and by country abroad', async () => {
    const r = await get();
    expect(r).toMatchObject({ currency: 'INR', to: month, homeCountry: 'IN', total: '150000.00', home: '100000.00', abroad: '50000.00', abroadShare: '0.3333', countries: 2, customers: 3 });
    expect(r.months).toHaveLength(12);
    expect(r.places.map((p: { key: string; kind: string; name: string; amount: string; share: string }) => [p.key, p.kind, p.name, p.amount, p.share])).toEqual([
      ['IN-27', 'STATE', 'Maharashtra', '80000.00', '0.5333'],
      ['US', 'COUNTRY', 'United States', '50000.00', '0.3333'],
      ['IN-29', 'STATE', 'Karnataka', '20000.00', '0.1333'],
    ]);
    expect(r.places[0].values.at(-1)).toBe('80000.00');
    expect(r.monthTotals.at(-1)).toBe('150000.00');
    expect(JSON.stringify(r)).not.toMatch(/Mumbai Mart|Boston Labs|Bengaluru Books/);
  });

  it('checks the months', async () => {
    expect((await get({ from: '2026-05', to: '2026-01' }, viewer.auth, 422)).error).toBe('INVALID_PERIOD');
    expect((await get({ from: '2023-01', to: '2026-01' }, viewer.auth, 422)).error).toBe('PERIOD_TOO_LONG');
    await get({ to: '2026-13' }, viewer.auth, 400);
    const empty = await get({ from: '2024-01', to: '2024-03' });
    expect(empty).toMatchObject({ places: [], total: '0.00', months: ['2024-01', '2024-02', '2024-03'] });
  });

  it('needs reports.read and stays inside the organisation', async () => {
    await get({}, employee.auth, 403);
    await get({}, outsider.auth, 404);
    const other = await createOrg(ctx, outsider, { name: 'Other Globe Co' });
    const r = (await ctx.http().get(`${other.base}/reports/revenue-globe`).set(outsider.auth).expect(200)).body;
    expect(r).toMatchObject({ places: [], total: '0.00' });
  });
});
