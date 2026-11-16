import { addMonthsAnchored } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContractsService } from '../src/sales-orders/contracts.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AR-012 usage-based billing against the real API and database: meters on a contract billed in
 * arrears (graduated tiers with an included allowance, per-unit with a minimum), usage recorded by
 * hand and imported (all or nothing, repeated references skipped), voided, priced on the period's
 * invoice next to the fixed lines, frozen once billed, and billed again after the invoice is deleted.
 */
const T = today();
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const periodEnd = plusDays(addMonthsAnchored(T, 1), -1);

let ctx: Ctx;
let svc: ContractsService;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let id: string;
let calls: { id: string };
let storage: { id: string };

const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });
const contract = (extra: Record<string, unknown> = {}) => ({
  contactId: customer.id,
  title: 'Analytics platform',
  frequency: 'MONTHLY',
  timing: 'ARREARS',
  startDate: T,
  endDate: null,
  autoRenew: false,
  noticeDays: 30,
  lines: [{ accountId: org.acc['4100'], description: 'Platform fee', quantity: '1', unitPrice: '5000.00' }],
  ...extra,
});
const meter = (extra: Record<string, unknown> = {}) => ({
  code: 'api_calls',
  name: 'API calls',
  unit: 'calls',
  accountId: org.acc['4100'],
  pricing: 'GRADUATED',
  tiers: [{ upTo: '1000', unitPrice: '2' }, { upTo: '10000', unitPrice: '1.5' }, { upTo: null, unitPrice: '1' }],
  includedQuantity: '500',
  ...extra,
});
const U = () => `${org.base}/sales/contracts/${id}`;

beforeAll(async () => {
  ctx = await bootApp();
  svc = ctx.app.get(ContractsService);
  owner = await registerUser(ctx, 'Usage Owner');
  viewer = await registerUser(ctx, 'Usage Viewer');
  org = await createOrg(ctx, owner, { name: 'Metered Analytics Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Kaveri Retail', isCustomer: true }).expect(201)).body;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('usage-based billing', () => {
  it('adds meters only to contracts billed in arrears, with pricing that can be billed', async () => {
    const adv = (await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(contract({ timing: 'ADVANCE' })).expect(201)).body;
    expect((await ctx.http().post(`${org.base}/sales/contracts/${adv.id}/meters`).set(owner.auth).send(meter()).expect(422)).body.error).toBe('METER_NEEDS_ARREARS');
    id = (await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(contract()).expect(201)).body.id;
    await ctx.http().post(`${U()}/meters`).set(viewer.auth).send(meter()).expect(403);
    const bad = (await ctx.http().post(`${U()}/meters`).set(owner.auth).send(meter({ tiers: [{ upTo: '1000', unitPrice: '2' }, { upTo: '500', unitPrice: '1' }, { upTo: null, unitPrice: '1' }] })).expect(422)).body;
    expect(bad.details.issues).toEqual(['Tier 2: the upper limit must be more than 1000']);
    expect((await ctx.http().post(`${U()}/meters`).set(owner.auth).send(meter({ accountId: org.acc['1120'] })).expect(422)).body.message).toMatch(/income account/);
    await ctx.http().post(`${U()}/meters`).set(owner.auth).send(meter()).expect(201);
    expect((await ctx.http().post(`${U()}/meters`).set(owner.auth).send(meter()).expect(422)).body.message).toBe('This contract already has a meter api_calls');
    const m = (await ctx.http().post(`${U()}/meters`).set(owner.auth).send(meter({ code: 'storage_gb', name: 'Storage', unit: 'GB', pricing: 'PER_UNIT', tiers: [{ upTo: null, unitPrice: '10' }], includedQuantity: '0', minimumCharge: '1000' })).expect(201)).body;
    calls = m.meters.find((x: { code: string }) => x.code === 'api_calls');
    storage = m.meters.find((x: { code: string }) => x.code === 'storage_gb');
    expect(m.meters.map((x: { summary: string }) => x.summary)).toEqual(['Graduated tiers (to 1,000 2, to 10,000 1.5, then 1) per calls after 500 included', '10 per GB, at least 1,000 a period']);
    // A contract with meters stays billed in arrears.
    expect((await ctx.http().put(U()).set(owner.auth).send(contract({ timing: 'ADVANCE' })).expect(422)).body.error).toBe('METER_NEEDS_ARREARS');
  });

  it('records usage on an active contract, once per reference, and imports all or nothing', async () => {
    expect((await ctx.http().post(`${U()}/usage`).set(owner.auth).send({ meterId: calls.id, date: T, quantity: '10' }).expect(422)).body.error).toBe('CONTRACT_NOT_ACTIVE');
    await ctx.http().post(`${U()}/activate`).set(owner.auth).expect(200);
    const one = (await ctx.http().post(`${U()}/usage`).set(owner.auth).send({ meterId: calls.id, date: T, quantity: '7000', reference: 'batch-1' }).expect(201)).body;
    expect(one.duplicate).toBe(false);
    expect((await ctx.http().post(`${U()}/usage`).set(owner.auth).send({ meterId: calls.id, date: T, quantity: '7000', reference: 'batch-1' }).expect(201)).body.duplicate).toBe(true);
    expect((await ctx.http().post(`${U()}/usage`).set(owner.auth).send({ meterId: calls.id, date: plusDays(T, 1), quantity: '1' }).expect(422)).body.message).toBe('Usage cannot be dated in the future');
    expect((await ctx.http().post(`${U()}/usage`).set(owner.auth).send({ meterId: calls.id, date: plusDays(T, -1), quantity: '1' }).expect(422)).body.message).toMatch(/before the contract starts/);
    const bad = (await ctx.http().post(`${U()}/usage/import`).set(owner.auth).send({ rows: [{ meter: 'api_calls', date: T, quantity: '6000', reference: 'batch-2' }, { meter: 'egress', date: T, quantity: '3' }] }).expect(422)).body;
    expect(bad.details.issues).toEqual(['Row 2 (egress): no such meter on this contract']);
    const imp = (await ctx.http().post(`${U()}/usage/import`).set(owner.auth).send({ rows: [{ meter: 'api_calls', date: T, quantity: '6000', reference: 'batch-2' }, { meter: 'api_calls', date: T, quantity: '7000', reference: 'batch-1' }, { meter: 'storage_gb', date: T, quantity: '40' }, { meter: 'storage_gb', date: T, quantity: '25', reference: 'typo' }] }).expect(201)).body;
    expect(imp).toMatchObject({ recorded: 3, duplicates: 1 });
    const typo = imp.usage.find((r: { reference: string }) => r.reference === 'typo');
    await ctx.http().post(`${U()}/usage/${typo.id}/void`).set(owner.auth).send({ reason: 'Counted twice by the exporter' }).expect(201);
    const m = (await ctx.http().get(`${U()}/meters`).set(viewer.auth).expect(200)).body;
    expect(m.currentPeriod).toMatchObject({ periodNo: 1, start: T, end: periodEnd });
    // 13,000 calls less 500 included = 12,500: 1,000 × 2 + 9,000 × 1.5 + 2,500 × 1. Storage 40 GB × 10, topped up to 1,000.
    expect(m.meters.map((x: { usedThisPeriod: string; estimate: string }) => [x.usedThisPeriod, x.estimate])).toEqual([['13000', '18000.00'], ['40', '1000.00']]);
  });

  it('prices the usage on the period invoice next to the fixed lines, then freezes it', async () => {
    expect(await svc.runAll(plusDays(periodEnd, -1), [org.orgId])).toMatchObject({ billed: 0 });
    expect(await svc.runAll(periodEnd, [org.orgId])).toMatchObject({ billed: 1 });
    const c = (await ctx.http().get(U()).set(owner.auth).expect(200)).body;
    const inv = (await ctx.http().get(`${org.base}/sales/documents/${c.periods[0].invoice.id}`).set(owner.auth).expect(200)).body;
    expect(inv.lines.map((l: { description: string; quantity: string; unitPrice: string }) => [l.description.split(':')[0], Number(l.quantity), Number(l.unitPrice)])).toEqual([
      ['Platform fee', 1, 5000],
      ['API calls, ' + inv.lines[1].description.split(', ')[1].split(':')[0], 1000, 2],
      ['API calls', 9000, 1.5],
      ['API calls', 2500, 1],
      ['Storage, ' + inv.lines[4].description.split(', ')[1].split(':')[0], 40, 10],
      ['Storage', 1, 600],
    ]);
    expect(Number(inv.subtotal)).toBe(24000);
    const billed = (await ctx.http().get(`${U()}/usage?periodNo=1`).set(owner.auth).expect(200)).body;
    expect(billed).toHaveLength(3);
    expect(billed.every((r: { documentId: string }) => r.documentId === inv.id)).toBe(true);
    // The period is closed to new usage; corrections go into the current period.
    expect((await ctx.http().post(`${U()}/usage`).set(owner.auth).send({ meterId: calls.id, date: T, quantity: '5' }).expect(422)).body.message).toMatch(/already billed; record the usage as an adjustment/);
    expect((await ctx.http().post(`${U()}/usage/${billed[0].id}/void`).set(owner.auth).send({ reason: 'Wrong' }).expect(422)).body.error).toBe('USAGE_BILLED');
    await expect(raw(`UPDATE usage_records SET quantity = 1 WHERE id = '${billed[0].id}'`)).rejects.toThrow(/does not change/);
    await expect(raw(`DELETE FROM usage_records WHERE id = '${billed[0].id}'`)).rejects.toThrow(/never deleted/);
    expect((await ctx.http().delete(`${U()}/meters/${calls.id}`).set(owner.auth).expect(422)).body.error).toBe('METER_HAS_USAGE');
  });

  it('bills the same usage again after the invoice is deleted', async () => {
    const c = (await ctx.http().get(U()).set(owner.auth).expect(200)).body;
    await ctx.http().delete(`${org.base}/sales/documents/${c.periods[0].invoice.id}`).set(owner.auth).expect(204);
    const again = (await ctx.http().post(`${U()}/periods/1/bill-again`).set(owner.auth).expect(201)).body;
    const inv = (await ctx.http().get(`${org.base}/sales/documents/${again.documentId}`).set(owner.auth).expect(200)).body;
    expect(Number(inv.subtotal)).toBe(24000);
    expect((await ctx.http().get(`${U()}/usage?periodNo=1`).set(owner.auth).expect(200)).body.every((r: { documentId: string }) => r.documentId === inv.id)).toBe(true);
    // Switching a meter off stops it billing; the audit trail has every step.
    const off = (await ctx.http().put(`${U()}/meters/${storage.id}`).set(owner.auth).send({ code: 'storage_gb', name: 'Storage', unit: 'GB', accountId: org.acc['4100'], pricing: 'PER_UNIT', tiers: [{ upTo: null, unitPrice: '10' }], minimumCharge: '1000', active: false }).expect(200)).body;
    expect(off.meters.find((x: { code: string }) => x.code === 'storage_gb')).toMatchObject({ active: false, estimate: null });
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'sales_contract', entityId: id }, select: { action: true } });
    expect(new Set(audit.map((a) => a.action))).toEqual(new Set(['sales_contract.created', 'contract_meter.created', 'sales_contract.activated', 'usage.recorded', 'usage.imported', 'usage.voided', 'sales_contract.billed', 'contract_meter.updated']));
  });
});
