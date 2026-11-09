import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPaymentsStandIn, type PaymentsStandIn } from '../../../test-support/payments-stand-in.mjs';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AR-018 payment links against the real API and database, with the real Razorpay and Stripe
 * client code talking to the local stand-in: an organisation's own gateway keys (sealed, tested),
 * a link on a posted invoice, payment confirmed by a signed notice or by checking, the receipt it
 * records and the invoice it settles, cancelling, permissions, tenant isolation and the guards.
 */
const T = today();
const RZP = { keyId: 'rzp_test_standin12', secret: 'standin-razorpay-secret', webhook: 'standin-webhook-secret' };
const STRIPE = { secret: 'sk_test_standin12345', webhook: 'whsec_standin12345' };

let ctx: Ctx;
let gw: PaymentsStandIn;
let api: string;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };

const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });
const invoice = async (amount: string, opts: { post?: boolean; currency?: string } = {}) => {
  const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: T, ...(opts.currency ? { currency: opts.currency, exchangeRate: '83' } : {}), lines: [{ accountId: org.acc['4100'], description: 'Consulting', quantity: '1', unitPrice: amount }] }).expect(201)).body;
  if (opts.post === false) return d;
  return (await ctx.http().post(`${org.base}/sales/documents/${d.id}/post`).set(owner.auth).send({}).expect(200)).body;
};
const G = () => `${org.base}/settings/payment-gateways`;
const links = (docId: string) => `${org.base}/sales/documents/${docId}/payment-links`;

beforeAll(async () => {
  gw = await startPaymentsStandIn(0);
  ctx = await bootApp({ PAYMENTS_STRIPE_API_URL: gw.url, PAYMENTS_RAZORPAY_API_URL: gw.url, BILLING_RUNNER_INTERVAL_SECONDS: '0' });
  await ctx.app.listen(0, '127.0.0.1');
  api = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  owner = await registerUser(ctx, 'Links Owner');
  viewer = await registerUser(ctx, 'Links Viewer');
  outsider = await registerUser(ctx, 'Links Outsider');
  org = await createOrg(ctx, owner, { name: 'Link Paying Consultants LLP' });
  other = await createOrg(ctx, outsider, { name: 'Other Links Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Kapoor Retail', email: 'accounts@kapoor.test', isCustomer: true }).expect(201)).body;
  gw.webhooks.RAZORPAY = { url: `${api}/v1/payment-links/webhooks/${org.orgId}/razorpay`, secret: RZP.webhook };
  gw.webhooks.STRIPE = { url: `${api}/v1/payment-links/webhooks/${org.orgId}/stripe`, secret: STRIPE.webhook };
});
afterAll(async () => {
  await ctx.app.close();
  await gw.close();
});

describe('payment gateways of an organisation', () => {
  it('are set up by an owner with sealed keys, a deposit account and the currencies they take', async () => {
    const before = (await ctx.http().get(G()).set(owner.auth).expect(200)).body;
    expect(before.gateways.map((g: { provider: string; configured: boolean }) => [g.provider, g.configured])).toEqual([['RAZORPAY', false], ['STRIPE', false]]);
    expect(before.depositAccounts.length).toBeGreaterThan(0);
    await ctx.http().get(G()).set(viewer.auth).expect(403);

    // No link can be made before a gateway is set up.
    const i = await invoice('1000');
    expect((await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(422)).body.error).toBe('GATEWAY_NOT_SET_UP');

    const noDeposit = await ctx.http().put(`${G()}/razorpay`).set(owner.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR'], keyId: RZP.keyId, secret: RZP.secret, webhookSecret: RZP.webhook }).expect(422);
    expect(noDeposit.body.message).toBe('Choose the bank account the gateway pays out to');
    const liveKey = await ctx.http().put(`${G()}/razorpay`).set(owner.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR'], keyId: 'rzp_live_abcdef', secret: RZP.secret, webhookSecret: RZP.webhook, depositAccountId: org.acc['1120'] }).expect(422);
    expect(liveKey.body.message).toMatch(/rzp_test_/);
    const saved = (await ctx.http().put(`${G()}/razorpay`).set(owner.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR'], keyId: RZP.keyId, secret: RZP.secret, webhookSecret: RZP.webhook, depositAccountId: org.acc['1120'] }).expect(200)).body;
    const rzp = saved.gateways.find((g: { provider: string }) => g.provider === 'RAZORPAY');
    expect(rzp).toMatchObject({ enabled: true, currencies: ['INR'], secretHint: '…cret', webhookUrl: `http://localhost:3000/api/webhooks/collect/${org.orgId}/razorpay` });
    expect(JSON.stringify(saved)).not.toContain(RZP.secret);
    const row = await ctx.prisma.orgPaymentGateway.findFirstOrThrow({ where: { orgId: org.orgId, provider: 'RAZORPAY' } });
    expect(row.secretCipher).not.toContain(RZP.secret);
    expect((await ctx.http().post(`${G()}/razorpay/test`).set(owner.auth).expect(200)).body.ok).toBe(true);

    // Each currency goes through one gateway.
    const clash = await ctx.http().put(`${G()}/stripe`).set(owner.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR', 'USD'], secret: STRIPE.secret, webhookSecret: STRIPE.webhook, depositAccountId: org.acc['1120'] }).expect(409);
    expect(clash.body.error).toBe('GATEWAY_CURRENCY_TAKEN');
    await ctx.http().put(`${G()}/stripe`).set(owner.auth).send({ enabled: true, mode: 'TEST', currencies: ['USD'], secret: STRIPE.secret, webhookSecret: STRIPE.webhook, depositAccountId: org.acc['1120'] }).expect(200);

    // Secrets never reach the audit trail.
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'payment_gateway.saved' } });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.map((a) => a.data))).not.toContain(RZP.secret);
    expect(JSON.stringify(audit.map((a) => a.data))).not.toContain(STRIPE.secret);
  });
});

describe('payment links', () => {
  it('are made for what is owed on a posted invoice, one open link at a time', async () => {
    const draft = await invoice('500', { post: false });
    expect((await ctx.http().post(links(draft.id)).set(owner.auth).send({}).expect(422)).body.error).toBe('INVOICE_NOT_POSTED');
    const i = await invoice('2500');
    await ctx.http().post(links(i.id)).set(viewer.auth).send({}).expect(403);
    expect((await ctx.http().post(links(i.id)).set(owner.auth).send({ amount: '2500.01' }).expect(422)).body.error).toBe('PAYMENT_LINK_INVALID');
    const l = (await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(201)).body;
    expect(l).toMatchObject({ provider: 'RAZORPAY', currency: 'INR', amount: '2500.00', status: 'OPEN', invoice: { number: i.number } });
    expect(l.reference).toMatch(/^PL-\d{4}$/);
    expect(l.url).toContain(gw.url);
    const sent = [...gw.links.values()].at(-1)!;
    expect(sent).toMatchObject({ amount: 250000, currency: 'INR' });
    expect(sent.callback_url).toBe(`http://localhost:3000/paid?ref=${l.reference}`);
    expect((await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(409)).body.error).toBe('PAYMENT_LINK_OPEN');
    const view = (await ctx.http().get(`${org.base}/sales/payment-links?documentId=${i.id}`).set(viewer.auth).expect(200)).body;
    expect(view).toMatchObject({ outstanding: '2500.00', currency: 'INR', gateway: { provider: 'RAZORPAY' }, can: { manage: false } });
    expect(view.links.map((x: { id: string }) => x.id)).toEqual([l.id]);
  });

  it('are settled by the gateway’s signed notice: a receipt into the deposit account pays the invoice', async () => {
    const i = await invoice('4000');
    const l = (await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(201)).body;
    const ref = [...gw.links.values()].at(-1)!.id;
    await gw.pay(ref);
    const after = (await ctx.http().get(`${org.base}/sales/payment-links?documentId=${i.id}`).set(owner.auth).expect(200)).body;
    expect(after.links[0]).toMatchObject({ id: l.id, status: 'PAID', paidAmount: '4000.00', settledBy: 'webhook payment_link.paid' });
    expect(after.outstanding).toBe('0.00');
    expect(after.links[0].receipt.number).toBeTruthy();
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${i.id}`).set(owner.auth).expect(200)).body;
    expect(doc.amountDue).toBe('0.00');
    const pay = await ctx.prisma.payment.findFirstOrThrow({ where: { orgId: org.orgId, id: after.links[0].receipt.id } });
    expect(pay.bankAccountId).toBe(org.acc['1120']);
    expect(pay.amount.toString()).toBe('4000');

    // The same notice again changes nothing; a forged one is refused and recorded.
    const last = gw.sent.at(-1)!;
    expect(last.status).toBe(200);
    const forged = await fetch(`${api}/v1/payment-links/webhooks/${org.orgId}/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'bad', 'x-razorpay-event-id': 'evt_forged' }, body: '{"event":"payment_link.paid"}' });
    expect(forged.status).toBe(400);
    const gws = (await ctx.http().get(G()).set(owner.auth).expect(200)).body;
    expect(gws.notices[0]).toMatchObject({ provider: 'RAZORPAY', signatureOk: false });
    expect(gws.notices.some((n: { outcome: string }) => n.outcome.startsWith(`Paid: ${l.reference}`))).toBe(true);
    expect(await ctx.prisma.payment.count({ where: { orgId: org.orgId, id: after.links[0].receipt.id } })).toBe(1);
  });

  it('can be part of what is owed and are settled by checking when no notice arrives', async () => {
    const i = await invoice('3000');
    const l = (await ctx.http().post(links(i.id)).set(owner.auth).send({ amount: '1000' }).expect(201)).body;
    expect(l.amount).toBe('1000.00');
    await gw.pay([...gw.links.values()].at(-1)!.id, { webhook: false });
    const checked = (await ctx.http().post(`${org.base}/sales/payment-links/${l.id}/check`).set(owner.auth).expect(200)).body;
    expect(checked).toMatchObject({ status: 'PAID', paidAmount: '1000.00' });
    expect(checked.settledBy).toMatch(/^checked by /);
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${i.id}`).set(owner.auth).expect(200)).body;
    expect(doc.amountDue).toBe('2000.00');
    // The rest can have its own link.
    const next = (await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(201)).body;
    expect(next.amount).toBe('2000.00');
  });

  it('are cancelled at the gateway, and a link paid meanwhile is settled instead', async () => {
    const i = await invoice('1500');
    const a = (await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(201)).body;
    const ca = (await ctx.http().post(`${org.base}/sales/payment-links/${a.id}/cancel`).set(owner.auth).expect(200)).body;
    expect(ca.status).toBe('CANCELLED');
    expect([...gw.links.values()].at(-1)!.status).toBe('cancelled');
    expect((await ctx.http().post(`${org.base}/sales/payment-links/${a.id}/cancel`).set(owner.auth).expect(422)).body.error).toBe('PAYMENT_LINK_ENDED');
    const b = (await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(201)).body;
    await gw.pay([...gw.links.values()].at(-1)!.id, { webhook: false });
    const cb = (await ctx.http().post(`${org.base}/sales/payment-links/${b.id}/cancel`).set(owner.auth).expect(200)).body;
    expect(cb.status).toBe('PAID');
    // A gateway with open links cannot be removed.
    const c = await invoice('700');
    await ctx.http().post(links(c.id)).set(owner.auth).send({}).expect(201);
    expect((await ctx.http().delete(`${G()}/razorpay`).set(owner.auth).expect(409)).body.error).toBe('GATEWAY_IN_USE');
  });

  it('in dollars go through Stripe and are settled by its signed notice', async () => {
    const i = await invoice('120', { currency: 'USD' });
    const l = (await ctx.http().post(links(i.id)).set(owner.auth).send({}).expect(201)).body;
    expect(l).toMatchObject({ provider: 'STRIPE', currency: 'USD', amount: '120.00' });
    // A receipt in dollars needs the day's rate; without one the link stays open and says why.
    await gw.pay([...gw.sessions.values()].at(-1)!.id);
    expect(gw.sent.at(-1)!.body).toContain('There is no USD rate on or before');
    expect((await ctx.http().get(`${org.base}/sales/payment-links?documentId=${i.id}`).set(owner.auth).expect(200)).body.links[0].status).toBe('OPEN');
    await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: T, rate: '84' }).expect(200);
    await ctx.http().post(`${org.base}/sales/payment-links/${l.id}/check`).set(owner.auth).expect(200);
    const after = (await ctx.http().get(`${org.base}/sales/payment-links?documentId=${i.id}`).set(owner.auth).expect(200)).body;
    expect(after.links[0]).toMatchObject({ status: 'PAID', paidAmount: '120.00' });
    expect(after.outstanding).toBe('0.00');
  });

  it('are listed by status and kept private to the organisation', async () => {
    const all = (await ctx.http().get(`${org.base}/sales/payment-links`).set(owner.auth).expect(200)).body.links;
    const paid = (await ctx.http().get(`${org.base}/sales/payment-links?status=PAID`).set(owner.auth).expect(200)).body.links;
    expect(paid.length).toBeGreaterThanOrEqual(4);
    expect(paid.every((x: { status: string }) => x.status === 'PAID')).toBe(true);
    expect(all.length).toBeGreaterThan(paid.length);
    await ctx.http().get(`${org.base}/sales/payment-links`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/sales/payment-links`).set(outsider.auth).expect(200)).body.links).toEqual([]);
    await ctx.http().post(`${other.base}/sales/payment-links/${all[0].id}/check`).set(outsider.auth).expect(404);
    // A notice for another organisation's gateway URL is refused: it has no gateway.
    const r = await fetch(`${api}/v1/payment-links/webhooks/${other.orgId}/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(404);
  });

  it('are guarded in the database: never deleted, and a settled link stays as it was', async () => {
    const paid = await ctx.prisma.paymentLink.findFirstOrThrow({ where: { orgId: org.orgId, status: 'PAID' } });
    await expect(raw(`DELETE FROM payment_links WHERE id = '${paid.id}'`)).rejects.toThrow(/payment link/);
    await expect(raw(`UPDATE payment_links SET status = 'OPEN' WHERE id = '${paid.id}'`)).rejects.toThrow(/payment link/);
    await expect(raw(`UPDATE payment_links SET amount = amount + 1 WHERE id = '${paid.id}'`)).rejects.toThrow(/payment link/);
    const open = await ctx.prisma.paymentLink.findFirstOrThrow({ where: { orgId: org.orgId, status: 'OPEN' } });
    await expect(raw(`INSERT INTO payment_links (id, org_id, number, document_id, provider, gateway_ref, url, currency, amount, status, created_by_id) SELECT gen_random_uuid(), org_id, 9999, document_id, provider, 'dup', url, currency, 1, 'OPEN', created_by_id FROM payment_links WHERE id = '${open.id}'`)).rejects.toThrow();
  });
});
