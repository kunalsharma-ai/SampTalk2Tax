import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mirrorRows } from '../src/common/prisma.service';
import { tenantStorage } from '../src/common/tenant-context';
import { allowInTx } from '../src/db/guards/allow';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Customer portal (AR-030) against the real API and database: staff make, list and revoke
 * private links for a customer; the customer opens the portal without signing in and sees only
 * their own posted invoices, balances, receipts, payment links and statement, and can open an
 * invoice; revoked, expired and made-up links are refused; nothing about the secret is stored.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let otherCustomer: { id: string };
let token: string;
let linkId: string;
const ids: Record<string, string> = {};
const L = (c = customer.id) => `${org.base}/contacts/${c}/portal-links`;
const portal = (t = token, path = '') => ctx.http().get(`/v1/portal/${t}${path}`);
const T = today();
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
async function invoice(contactId: string, amount: string, issueDate: string, post = true) {
  const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate, dueDate: addDays(issueDate, 15), lines: [{ accountId: org.acc['4100'], description: 'Consulting', quantity: '1', unitPrice: amount }] }).expect(201)).body;
  if (post) return (await ctx.http().post(`${org.base}/sales/documents/${d.id}/post`).set(owner.auth).send({}).expect(200)).body;
  return d;
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Portal Owner');
  viewer = await registerUser(ctx, 'Portal Viewer');
  outsider = await registerUser(ctx, 'Portal Outsider');
  org = await createOrg(ctx, owner, { name: 'Bright Ledger Services' });
  other = await createOrg(ctx, outsider, { name: 'Elsewhere Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Sunrise Hotels', isCustomer: true, gstin: null }).expect(201)).body;
  otherCustomer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Moonlight Cafes', isCustomer: true }).expect(201)).body;
  const old = await invoice(customer.id, '10000.00', addDays(T, -40));
  ids.old = old.id;
  ids.oldNo = old.number;
  const recent = await invoice(customer.id, '6000.00', T);
  ids.recent = recent.id;
  ids.draft = (await invoice(customer.id, '999.00', T, false)).id;
  ids.others = (await invoice(otherCustomer.id, '7777.00', T)).id;
  // 4,000 received against the old invoice.
  await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer.id, date: T, bankAccountId: org.acc['1120'], amount: '4000.00', reference: 'NEFT 8812', allocations: [{ documentId: old.id, amount: '4000.00' }] }).expect(201);
  // An open payment link on the recent invoice.
  const [{ id: me }] = await ctx.prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM users WHERE email = $1`, owner.email);
  await raw(`INSERT INTO payment_links (id, org_id, number, document_id, provider, gateway_ref, url, currency, amount, created_by_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, 1, $2::uuid, 'RAZORPAY', $4, 'https://rzp.example.test/pay/' || $4, 'INR', 6000, $3::uuid, now())`, org.orgId, recent.id, me, `plink_${recent.id.slice(0, 8)}`);
  ids.plink = `plink_${recent.id.slice(0, 8)}`;
  // Written past the API, so MongoDB is brought in step by hand.
  await tenantStorage.run({ bypass: true }, () => mirrorRows(ctx.prisma, 'PaymentLink', { documentId: recent.id }));
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('customer portal links', () => {
  it('makes a link for a customer and shows its secret only once', async () => {
    await ctx.http().post(L()).set(viewer.auth).send({ expiresInDays: 90 }).expect(403);
    await ctx.http().post(L()).set(owner.auth).send({ expiresInDays: 45 }).expect(400);
    await ctx.http().post(L()).set(outsider.auth).send({ expiresInDays: 90 }).expect(404);
    const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Paper Supplier', isVendor: true }).expect(201)).body;
    await ctx.http().post(L(vendor.id)).set(owner.auth).send({ expiresInDays: 90 }).expect(404);
    const r = (await ctx.http().post(L()).set(owner.auth).send({ expiresInDays: 90, note: 'Sent to accounts@sunrise' }).expect(201)).body;
    expect(r.token).toMatch(/^t2tp_[A-Za-z0-9]{40}$/);
    expect(r.path).toBe(`/portal/${r.token}`);
    expect(r.prefix).toBe(r.token.slice(5, 13));
    token = r.token;
    linkId = r.id;
    const list = (await ctx.http().get(L()).set(viewer.auth).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: linkId, prefix: r.prefix, note: 'Sent to accounts@sunrise', state: 'ACTIVE', createdBy: 'Portal Owner', viewCount: 0, lastSeenAt: null });
    expect(JSON.stringify(list)).not.toContain(token);
    // Neither the table nor the audit trail holds the secret.
    const rows = await ctx.prisma.$queryRawUnsafe<{ token_hash: string }[]>(`SELECT token_hash FROM customer_portal_links WHERE id = $1::uuid`, linkId).catch(() => []);
    for (const x of rows) expect(x.token_hash).not.toContain(token.slice(5));
    const audit = await ctx.prisma.$queryRawUnsafe<{ data: unknown }[]>(`SELECT data FROM audit_events WHERE entity_id = $1::uuid`, linkId).catch(() => []);
    expect(JSON.stringify(audit)).not.toContain(token.slice(5));
  });
});

describe('the portal, without signing in', () => {
  it('shows the customer their own posted invoices, balance, receipts and payment link', async () => {
    const p = (await portal().expect(200)).body;
    expect(p.from).toMatchObject({ name: 'Bright Ledger Services' });
    expect(p.customer.name).toBe('Sunrise Hotels');
    expect(p.balances).toEqual([{ currency: 'INR', owed: '12000.00', overdue: '6000.00', credits: '0.00', balance: '12000.00' }]);
    expect(p.invoices.map((i: { id: string }) => i.id).sort()).toEqual([ids.old, ids.recent].sort());
    const old = p.invoices.find((i: { id: string }) => i.id === ids.old);
    expect(old).toMatchObject({ number: ids.oldNo, total: '10000.00', open: '6000.00', state: 'OVERDUE', daysOverdue: 25, payLink: null });
    expect(p.invoices.find((i: { id: string }) => i.id === ids.recent)).toMatchObject({ state: 'OPEN', open: '6000.00', payLink: { reference: 'PL-0001', url: `https://rzp.example.test/pay/${ids.plink}` } });
    expect(p.receipts).toEqual([expect.objectContaining({ date: T, amount: '4000.00', currency: 'INR', reference: 'NEFT 8812', status: 'POSTED' })]);
    expect(JSON.stringify(p)).not.toContain('Moonlight');
    expect(JSON.stringify(p)).not.toContain('7777');
    const list = (await ctx.http().get(L()).set(owner.auth).expect(200)).body;
    expect(list[0].viewCount).toBe(1);
    expect(list[0].lastSeenAt).not.toBeNull();
  });

  it('gives the statement with a running balance', async () => {
    const s = (await portal(token, `/statement?from=${addDays(T, -60)}&to=${T}`).expect(200)).body;
    expect(s).toMatchObject({ currency: 'INR', openingBalance: '0.00', closingBalance: '12000.00' });
    expect(s.lines.map((l: { kind: string; balance: string }) => [l.kind, l.balance])).toEqual([['INVOICE', '10000.00'], ['INVOICE', '16000.00'], ['RECEIPT', '12000.00']]);
    expect(s.lines.find((l: { kind: string }) => l.kind === 'RECEIPT').id).toBeNull();
    await portal(token, `/statement?from=${T}&to=${addDays(T, -1)}`).expect(422);
  });

  it('opens one of the customer\'s invoices, and nothing else', async () => {
    const r = await portal(token, `/documents/${ids.old}`).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toMatch(/sandbox/);
    expect(r.text).toContain(ids.oldNo);
    expect(r.text).toContain('Sunrise Hotels');
    await portal(token, `/documents/${ids.draft}`).expect(404);
    await portal(token, `/documents/${ids.others}`).expect(404);
  });

  it('refuses made-up, revoked and expired links', async () => {
    expect((await portal('t2tp_' + 'A'.repeat(40)).expect(404)).body).toMatchObject({ error: 'PORTAL_LINK_INVALID', message: 'This link is not valid. Ask the business that sent it for a new one.' });
    await portal('nonsense').expect(404);
    await ctx.http().post(`${L()}/${linkId}/revoke`).set(viewer.auth).expect(403);
    const after = (await ctx.http().post(`${L()}/${linkId}/revoke`).set(owner.auth).expect(201)).body;
    expect(after[0]).toMatchObject({ state: 'REVOKED', revokedBy: 'Portal Owner' });
    await ctx.http().post(`${L()}/${linkId}/revoke`).set(owner.auth).expect(409);
    expect((await portal().expect(404)).body.message).toBe('Bright Ledger Services has withdrawn this link. Ask them for a new one.');
    await portal(token, `/documents/${ids.old}`).expect(404);
    const fresh = (await ctx.http().post(L()).set(owner.auth).send({ expiresInDays: 30 }).expect(201)).body;
    await portal(fresh.token).expect(200);
    // The guards are off for this, as time passing would not need them.
    await allowInTx('guards_off', async () => {
      await raw(`ALTER TABLE customer_portal_links DISABLE TRIGGER customer_portal_links_guard`);
      await raw(`UPDATE customer_portal_links SET created_at = now() - interval '40 days', expires_at = now() - interval '1 day' WHERE id = $1::uuid`, fresh.id);
      await raw(`ALTER TABLE customer_portal_links ENABLE TRIGGER customer_portal_links_guard`);
    });
    await allowInTx('guards_off', () => tenantStorage.run({ bypass: true }, () => mirrorRows(ctx.prisma, 'CustomerPortalLink', { id: fresh.id })));
    expect((await portal(fresh.token).expect(404)).body.message).toBe('This link from Bright Ledger Services has expired. Ask them for a new one.');
    expect((await ctx.http().get(L()).set(owner.auth).expect(200)).body.map((l: { state: string }) => l.state).sort()).toEqual(['EXPIRED', 'REVOKED']);
  });

  it('keeps links: never deleted, secret and expiry fixed, revoked for good', async () => {
    await expect(raw(`DELETE FROM customer_portal_links WHERE id = $1::uuid`, linkId)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE customer_portal_links SET expires_at = NULL WHERE id = $1::uuid`, linkId)).rejects.toThrow(/keeps its customer, secret and expiry/);
    await expect(raw(`UPDATE customer_portal_links SET revoked_at = NULL, revoked_by_id = NULL WHERE id = $1::uuid`, linkId)).rejects.toThrow(/stays revoked/);
    // Another organisation's members cannot see the links.
    await ctx.http().get(L()).set(outsider.auth).expect(404);
    expect(other.orgId).not.toBe(org.orgId);
  });
});
