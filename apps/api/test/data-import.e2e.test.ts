import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Data import (UX-009 to UX-012): a chart of accounts, customers, vendors and opening balances
 * from CSV. A preview writes nothing; an import with a problem is refused whole; a clean import
 * creates each row through the same rules as the screens, skips what is already there, and is
 * recorded in the audit trail. Real API and database.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let fyStart: string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Import Owner');
  viewer = await registerUser(ctx, 'Import Viewer');
  org = await createOrg(ctx, owner, { name: 'Import Test Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { startDate: string }[];
  fyStart = periods.map((p) => p.startDate).sort()[0]!;
});
afterAll(async () => {
  await ctx?.app.close();
});

const accounts = async () => (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { id: string; code: string; name: string; type: string; subtype: string | null; parentId: string | null; isPostable: boolean }[];

describe('data import', () => {
  it('lists what can be imported, with columns, a template and what this role may import', async () => {
    const o = (await ctx.http().get(`${org.base}/imports`).set(viewer.auth).expect(200)).body as { kinds: { kind: string; allowed: boolean; template: string; columns: { label: string }[] }[] };
    expect(o.kinds.map((k) => k.kind)).toEqual(['accounts', 'customers', 'vendors', 'opening-balances']);
    expect(o.kinds.every((k) => !k.allowed)).toBe(true);
    expect(o.kinds[0]!.template.split('\n')[0]).toBe(o.kinds[0]!.columns.map((c) => c.label).join(','));
    const mine = (await ctx.http().get(`${org.base}/imports`).set(owner.auth).expect(200)).body as { kinds: { allowed: boolean }[] };
    expect(mine.kinds.every((k) => k.allowed)).toBe(true);
  });

  it('previews a chart of accounts without writing, then imports it parents first and skips codes already there', async () => {
    const before = await accounts();
    const existing = before.find((a) => a.code === '1120')!;
    const csv = ['Account code,Account name,Type,Subtype,Parent code,Header', 'X910,Cloud hosting,Expense,Operating expense,X900,No', 'X900,Technology,Expense,,,Yes', `${existing.code},Renamed bank,Asset,Bank,,No`].join('\n');
    const plan = (await ctx.http().post(`${org.base}/imports/accounts/preview`).set(owner.auth).send({ csv }).expect(200)).body;
    expect(plan.issues).toEqual([]);
    expect(plan.summary).toEqual({ rows: 3, create: 2, skip: 1, problems: 0 });
    expect((await accounts()).length).toBe(before.length);

    const r = (await ctx.http().post(`${org.base}/imports/accounts`).set(owner.auth).send({ csv }).expect(201)).body;
    expect(r).toMatchObject({ kind: 'accounts', created: 2, skipped: 1, failed: [] });
    const after = await accounts();
    const header = after.find((a) => a.code === 'X900')!;
    const child = after.find((a) => a.code === 'X910')!;
    expect(header).toMatchObject({ type: 'EXPENSE', isPostable: false, parentId: null });
    expect(child).toMatchObject({ type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentId: header.id, isPostable: true });
    expect(after.find((a) => a.code === '1120')!.name).toBe(existing.name);
  });

  it('refuses the whole file while a row has a problem, and creates nothing', async () => {
    const before = await accounts();
    const csv = 'Code,Name,Type\nX920,Domains,Expense\nX930,,Expense';
    const r = (await ctx.http().post(`${org.base}/imports/accounts`).set(owner.auth).send({ csv }).expect(422)).body;
    expect(r.error).toBe('IMPORT_HAS_PROBLEMS');
    expect(r.details.plan.issues).toEqual([{ row: 3, column: 'Name', message: 'Name is empty.' }]);
    expect((await accounts()).length).toBe(before.length);
  });

  it('imports customers and vendors with GST details, checking GSTINs and skipping names already there', async () => {
    const bad = (await ctx.http().post(`${org.base}/imports/customers/preview`).set(owner.auth).send({ csv: 'Name,GSTIN\nWrong Co,27AAPFU0939F1ZX' }).expect(200)).body;
    expect(bad.issues[0]).toMatchObject({ row: 2, column: 'GSTIN' });

    const customers = ['Customer name,Email,GSTIN,PIN code,Payment terms (days),Credit limit', 'Asha Traders,accounts@asha.example,27AAPFU0939F1ZV,411001,45,"5,00,000"', 'Kiran Stores,,,,,'].join('\n');
    const c = (await ctx.http().post(`${org.base}/imports/customers`).set(owner.auth).send({ csv: customers }).expect(201)).body;
    expect(c).toMatchObject({ created: 2, skipped: 0, failed: [] });
    const again = (await ctx.http().post(`${org.base}/imports/customers`).set(owner.auth).send({ csv: customers }).expect(201)).body;
    expect(again).toMatchObject({ created: 0, skipped: 2 });

    const v = (await ctx.http().post(`${org.base}/imports/vendors`).set(owner.auth).send({ csv: 'Vendor name;PAN;State code\nBharat Supplies;AAPFB1234C;29' }).expect(201)).body;
    expect(v).toMatchObject({ created: 1, failed: [] });

    const list = (await ctx.http().get(`${org.base}/contacts`).set(owner.auth).expect(200)).body as { name: string; gstin: string | null; stateCode: string | null; pan: string | null; isCustomer: boolean; isVendor: boolean; paymentTermsDays: number; creditLimit: string | null }[];
    expect(list.find((x) => x.name === 'Asha Traders')).toMatchObject({ gstin: '27AAPFU0939F1ZV', stateCode: '27', pan: 'AAPFU0939F', isCustomer: true, isVendor: false, paymentTermsDays: 45, creditLimit: '500000.00' });
    expect(list.find((x) => x.name === 'Kiran Stores')).toMatchObject({ paymentTermsDays: 30 });
    expect(list.find((x) => x.name === 'Bharat Supplies')).toMatchObject({ isVendor: true, isCustomer: false, stateCode: '29', pan: 'AAPFB1234C' });
  });

  it('imports opening balances by account code as one OPENING journal', async () => {
    const csv = ['Account code,Account name,Debit,Credit', '1120,Bank,"2,50,000.00",', '1510,Equipment,800000,', '3100,Share capital,,1000000'].join('\n');
    const plan = (await ctx.http().post(`${org.base}/imports/opening-balances/preview`).set(owner.auth).send({ csv }).expect(200)).body;
    expect(plan.totals).toEqual({ debit: '1050000.00', credit: '1000000.00', difference: '50000.00' });
    await ctx.http().post(`${org.base}/imports/opening-balances`).set(owner.auth).send({ csv }).expect(422);

    const r = (await ctx.http().post(`${org.base}/imports/opening-balances`).set(owner.auth).send({ csv, date: fyStart }).expect(201)).body;
    expect(r).toMatchObject({ created: 3, failed: [] });
    expect(r.journalId).toEqual(expect.any(String));
    const ob = (await ctx.http().get(`${org.base}/opening-balances`).set(owner.auth).expect(200)).body;
    expect(ob.current.balances.map((b: { accountCode: string; debit: string; credit: string }) => [b.accountCode, b.debit, b.credit])).toEqual([
      ['1120', '250000.00', '0.00'],
      ['1510', '800000.00', '0.00'],
      ['3100', '0.00', '1000000.00'],
    ]);
    expect(ob.current.difference).toEqual({ debit: '0.00', credit: '50000.00' });

    const control = (await ctx.http().post(`${org.base}/imports/opening-balances/preview`).set(owner.auth).send({ csv: 'Code,Debit\n1200,100' }).expect(200)).body;
    expect(control.issues[0].message).toMatch(/is not an account that takes an opening balance/);
  });

  it('refuses a role without the permission, and records each import in the audit trail', async () => {
    const r = (await ctx.http().post(`${org.base}/imports/customers`).set(viewer.auth).send({ csv: 'Name\nNope Ltd' }).expect(403)).body;
    expect(r.message).toMatch(/cannot import customers/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=data_import&entityId=${org.orgId}`).set(owner.auth).expect(200)).body as { items?: { action: string; data: { kind: string } }[] } | { action: string; data: { kind: string } }[];
    const items = Array.isArray(audit) ? audit : (audit.items ?? []);
    expect(items.filter((i) => i.action === 'data_import.completed').map((i) => i.data.kind).sort()).toEqual(['accounts', 'customers', 'customers', 'opening-balances', 'vendors']);
  });
});
