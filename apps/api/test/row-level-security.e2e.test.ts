import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accounts/accounts.service';
import { PrismaService } from '../src/common/prisma.service';
import { tenantStorage } from '../src/common/tenant-context';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Row-level security is the second isolation layer: these tests bypass the application's
 * own org filters (as a bug would) and check that PostgreSQL still keeps tenants apart.
 */
let ctx: Ctx;
let alice: TestUser;
let bob: TestUser;
let orgA: Awaited<ReturnType<typeof createOrg>>;
let orgB: Awaited<ReturnType<typeof createOrg>>;
beforeAll(async () => {
  ctx = await bootApp();
  alice = await registerUser(ctx, 'Alice');
  bob = await registerUser(ctx, 'Bob');
  orgA = await createOrg(ctx, alice, { name: 'RLS Org A' });
  orgB = await createOrg(ctx, bob, { name: 'RLS Org B' });
  await ctx.http().post(`${orgB.base}/contacts`).set(bob.auth).send({ name: 'B-only customer', isCustomer: true }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

// Prisma queries are lazy: they run when awaited, so await inside the context.
const asTenant = <T>(c: { orgId?: string; userId?: string }, fn: () => Promise<T>) => tenantStorage.run({ ...c }, async () => await fn());

describe('policies on tenant tables', () => {
  it('a query with no org filter sees only the current organisation', async () => {
    const accounts = await asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.account.findMany());
    expect(accounts.length).toBeGreaterThan(10);
    expect(new Set(accounts.map((a) => a.orgId))).toEqual(new Set([orgA.orgId]));
    const contacts = await asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.contact.findMany({ where: { name: 'B-only customer' } }));
    expect(contacts).toEqual([]);
  });

  it('asking for another tenant\'s row by id finds nothing', async () => {
    const bAccount = orgB.acc['1120'];
    const row = await asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.account.findUnique({ where: { id: bAccount } }));
    expect(row).toBeNull();
    const raw = await asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.$queryRaw<unknown[]>`SELECT id FROM accounts WHERE id = ${bAccount}::uuid`);
    expect(raw).toEqual([]);
  });

  it('cannot write rows into, or move rows to, another organisation', async () => {
    await expect(
      asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.contact.create({ data: { orgId: orgB.orgId, name: 'Planted', isCustomer: true } })),
    ).rejects.toThrow(/row-level security/);
    const mine = await asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.contact.create({ data: { orgId: orgA.orgId, name: 'Mine', isCustomer: true } }));
    await expect(asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.contact.update({ where: { id: mine.id }, data: { orgId: orgB.orgId } }))).rejects.toThrow();
    // Updates and deletes aimed at another tenant touch nothing.
    const res = await asTenant({ orgId: orgA.orgId, userId: alice.id }, () => ctx.prisma.contact.updateMany({ where: { orgId: orgB.orgId }, data: { name: 'Hijacked' } }));
    expect(res.count).toBe(0);
  });

  it('with no tenant at all, tenant tables are empty and closed to writes', async () => {
    expect(await asTenant({}, () => ctx.prisma.account.count())).toBe(0);
    expect(await asTenant({}, () => ctx.prisma.organization.count())).toBe(0);
    expect(await asTenant({}, () => ctx.prisma.auditEvent.count())).toBe(0);
    await expect(asTenant({}, () => ctx.prisma.contact.create({ data: { orgId: orgA.orgId, name: 'X', isCustomer: true } }))).rejects.toThrow(/row-level security/);
  });

  it('inside a transaction the settings hold for every statement, and a stray root-client call sees nothing', async () => {
    const out = await asTenant({ orgId: orgA.orgId, userId: alice.id }, () =>
      ctx.prisma.$transaction(async (tx) => ({
        inTx: await tx.account.count(),
        stray: await ctx.prisma.account.count(),
      })),
    );
    expect(out.inTx).toBeGreaterThan(10);
    expect(out.stray).toBe(0);
  });

  it('memberships and organisations: your own across orgs, other members only inside the org', async () => {
    const mine = await asTenant({ userId: bob.id }, () => ctx.prisma.membership.findMany());
    expect(mine.map((m) => m.orgId)).toEqual([orgB.orgId]);
    const orgs = await asTenant({ userId: bob.id }, () => ctx.prisma.organization.findMany());
    expect(orgs.map((o) => o.id)).toEqual([orgB.orgId]);
    // Bob cannot add himself to Alice's organisation even with a hand-written insert.
    await expect(asTenant({ orgId: orgB.orgId, userId: bob.id }, () => ctx.prisma.membership.create({ data: { orgId: orgA.orgId, userId: bob.id, role: 'OWNER' } }))).rejects.toThrow(/row-level security/);
  });

  it('the database enforces it for the table owner as well (FORCE)', async () => {
    const rows = await ctx.prisma.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_name = c.relname AND i.column_name = 'org_id')`;
    expect(rows.length).toBeGreaterThanOrEqual(23);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    // A superuser or BYPASSRLS role would skip every policy (the API warns, and refuses in production).
    const owner = await ctx.prisma.$queryRaw<{ superuser: boolean; bypass: boolean }[]>`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(owner[0]).toEqual({ superuser: false, bypass: false });
  });
});

describe('HTTP requests run with the caller\'s tenant settings', () => {
  it('a service that forgot its org filter still returns only the caller\'s rows', async () => {
    const svc = ctx.app.get(AccountsService);
    const prisma = ctx.app.get(PrismaService);
    const original = svc.list.bind(svc);
    let seen: { settings: unknown; orgIds: string[] } | null = null;
    // Simulate the bug: ignore orgId entirely.
    svc.list = (async () => {
      const [settings] = await prisma.$queryRaw<{ org: string; user_id: string; bypass: string }[]>`
        SELECT current_setting('t2t.org_id', true) AS org, current_setting('t2t.user_id', true) AS user_id, current_setting('t2t.bypass', true) AS bypass`;
      const all = await prisma.account.findMany();
      seen = { settings, orgIds: [...new Set(all.map((a) => a.orgId))] };
      return all;
    }) as typeof svc.list;
    try {
      await ctx.http().get(`${orgA.base}/accounts`).set(alice.auth).expect(200);
    } finally {
      svc.list = original;
    }
    expect(seen!.settings).toEqual({ org: orgA.orgId, user_id: alice.id, bypass: '' });
    expect(seen!.orgIds).toEqual([orgA.orgId]);
  });

  it('public routes run with no tenant', async () => {
    const svc = ctx.app.get(AccountsService);
    expect(svc).toBeTruthy();
    // Registering works (users and the global audit chain are written with scoped system access)…
    const u = await registerUser(ctx, 'Public');
    // …and the audit event exists, though no tenant context can read it.
    const ev = await ctx.prisma.auditEvent.findFirst({ where: { action: 'user.registered', entityId: u.id } });
    expect(ev).toBeTruthy();
    expect(await asTenant({ userId: u.id }, () => ctx.prisma.auditEvent.findFirst({ where: { action: 'user.registered', entityId: u.id } }))).toBeNull();
  });

  it('cross-tenant API probes still answer 404', async () => {
    await ctx.http().get(`${orgB.base}/accounts`).set(alice.auth).expect(404);
    await ctx.http().get(`${orgA.base}/accounts/${orgB.acc['1120']}`).set(alice.auth).expect(404);
    await ctx.http().get(`/v1/orgs/${randomUUID()}`).set(alice.auth).expect(404);
  });
});
