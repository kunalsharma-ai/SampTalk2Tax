import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma.service';
import { tenantStorage } from '../src/common/tenant-context';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Large transaction volumes (PERF-002). The full-size measurement is scripts/volume-test.mjs (CI
 * step "Volume test"); these tests hold the changes it needed: many postings into one organisation
 * at the same moment all succeed, reads fetch only the fields asked for, the latest audit event is
 * found without reading the whole trail, and the shared tables are indexed by organisation.
 */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: string;
let prisma: PrismaService;
const T = today();
const asSystem = <R>(fn: () => Promise<R>) => tenantStorage.run({ bypass: true }, fn);

beforeAll(async () => {
  ctx = await bootApp();
  prisma = ctx.app.get(PrismaService);
  owner = await registerUser(ctx, 'Volume Owner');
  org = await createOrg(ctx, owner, { name: 'Large Volumes Pvt Ltd' });
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Busy Customer', isCustomer: true }).expect(201)).body.id;
}, 60_000);
afterAll(async () => {
  await ctx?.app.close();
});

const invoice = (amount: string) =>
  ctx
    .http()
    .post(`${org.base}/sales/documents`)
    .set(owner.auth)
    .send({ kind: 'INVOICE', contactId: customer, issueDate: T, dueDate: T, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] });

describe('many postings into one organisation at once', () => {
  it('posts every invoice, with unique unbroken numbers, and the receivables agree', async () => {
    const amounts = Array.from({ length: 30 }, (_, i) => `${100 + i}.50`);
    const results = await Promise.all(amounts.map((a) => invoice(a)));
    expect(results.map((r) => r.status)).toEqual(amounts.map(() => 201));
    const numbers = results.map((r) => Number(String(r.body.number).replace(/\D/g, ''))).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(30);
    expect(numbers[29]! - numbers[0]!).toBe(29);
    const ageing = (await ctx.http().get(`${org.base}/sales/ageing?asOf=${T}`).set(owner.auth).expect(200)).body as { totals: { balance: string } };
    const expected = amounts.reduce((t, a) => t + Math.round(Number(a) * 100), 0); // not money: a check total in paise
    expect(Math.round(Number(ageing.totals.balance) * 100)).toBe(expected); // not money
  }, 120_000);
});

describe('reads', () => {
  it('a select returns exactly the fields asked for, with the relations it names', async () => {
    const rows = await asSystem(() =>
      prisma.document.findMany({ where: { orgId: org.orgId, kind: 'INVOICE' }, select: { id: true, number: true, total: true, contact: { select: { name: true } } }, orderBy: { number: 'asc' } }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(30);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['contact', 'id', 'number', 'total']);
      expect(r.contact).toEqual({ name: 'Busy Customer' });
      expect(r.total.toFixed(2)).toMatch(/^1\d\d\.50$/);
    }
    // The same rows read in full carry the lines and every other field.
    const full = await asSystem(() => prisma.document.findFirstOrThrow({ where: { id: rows[0]!.id }, include: { lines: true } }));
    expect(full.number).toBe(rows[0]!.number);
    expect(full.lines.length).toBe(1);
    expect(full.contactId).toBe(customer);
  });

  it('the latest audit event of an organisation is the largest id, as a full read finds it', async () => {
    const events = await asSystem(() => prisma.auditEvent.findMany({ where: { orgId: org.orgId }, select: { id: true, createdAt: true } }));
    expect(events.length).toBeGreaterThan(30);
    const maxId = events.reduce((m, e) => (e.id > m ? e.id : m), 0n);
    const minAt = events.reduce((m, e) => (e.createdAt < m ? e.createdAt : m), events[0]!.createdAt);
    const fast = await asSystem(() => prisma.auditEvent.aggregate({ where: { orgId: org.orgId }, _max: { id: true } }));
    expect(fast._max.id).toBe(maxId);
    const first = await asSystem(() => prisma.auditEvent.aggregate({ where: { orgId: org.orgId }, _min: { createdAt: true } }));
    expect(first._min.createdAt?.getTime()).toBe(minAt.getTime());
    // Several aggregates at once still read the rows and agree.
    const both = await asSystem(() => prisma.auditEvent.aggregate({ where: { orgId: org.orgId }, _max: { id: true }, _count: true }));
    expect(both._max.id).toBe(maxId);
    expect(both._count).toBe(events.length);
    const none = await asSystem(() => prisma.auditEvent.aggregate({ where: { orgId: '00000000-0000-4000-8000-000000000000' }, _max: { id: true } }));
    expect(none._max.id).toBeNull();
  });
});

describe('indexes', () => {
  it('the shared tables are indexed by organisation, and the audit trail by date, record and action', async () => {
    const keys = async (name: string) => (await ctx.db.collection(name).indexes()).map((i) => JSON.stringify(i.key));
    const audit = await keys('audit_events');
    expect(audit).toEqual(expect.arrayContaining(['{"orgId":1,"idNumber":1}', '{"orgId":1,"createdAt":1}', '{"orgId":1,"entityType":1,"entityId":1}', '{"action":1,"createdAt":1}']));
    expect(await keys('error_events')).toContain('{"orgId":1,"idNumber":1}');
    expect(await keys('security_alerts')).toContain('{"orgId":1}');
    const plan = await ctx.db.collection('audit_events').find({ orgId: org.orgId }).sort({ idNumber: -1 }).limit(1).explain();
    expect(JSON.stringify(plan)).not.toContain('COLLSCAN');
  });
});
