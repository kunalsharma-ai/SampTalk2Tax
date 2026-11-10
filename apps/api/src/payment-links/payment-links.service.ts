import { HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { amountToMinor, D, linkAmountIssues, linkExpired, minorToAmount, minorUnits, paymentLinkRef, type PaymentLinkStatus } from '@talk2tax/accounting-engine';
import type { OrgPaymentGateway, PaymentLink } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { GatewayCreds, GatewayError, PaymentGateway, PaymentState, Provider, RazorpayGateway, SignatureError, StripeGateway } from '../billing/payments/gateways';
import { todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, useOrgInTx, withSystemAccess } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { SecretBox, secretHint } from '../integrations/secret-box';
import { DocumentsService } from '../ledgers/documents.service';

export interface LinkOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
type Actor = { id: string };
export interface OrgGatewayInput {
  enabled: boolean;
  mode: 'TEST' | 'LIVE';
  currencies: string[];
  keyId?: string | null;
  secret?: string | null;
  webhookSecret?: string | null;
  depositAccountId?: string | null;
}

const NAME: Record<Provider, string> = { STRIPE: 'Stripe', RAZORPAY: 'Razorpay' };
/** The currencies a link can be made in (the gateway clients send these). */
export const LINK_CURRENCIES = ['INR', 'USD'] as const;

/**
 * Payment links on invoices (AR-018), paid through the organisation's own Stripe or Razorpay
 * account, set up in the app (keys sealed with the integrations key). The customer pays on the
 * gateway's page; card and UPI details never reach Talk2Tax. A link is settled only when the
 * gateway says it is paid, by a signed webhook or when someone checks it: an ordinary receipt is
 * then recorded into the chosen deposit account and applied to the invoice.
 */
@Injectable()
export class PaymentLinksService {
  private readonly box: SecretBox;
  private readonly logger = new Logger('PaymentLinks');

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox({ encryptionKey: config.INTEGRATIONS_ENCRYPTION_KEY, jwtSecret: config.JWT_SECRET });
  }

  private invalid(message: string, code = 'PAYMENT_LINK_INVALID', status = HttpStatus.UNPROCESSABLE_ENTITY, details?: unknown): never {
    throw new DomainError(code, message, status, details);
  }

  webhookUrl(orgId: string, p: Provider) {
    return `${this.config.APP_URL.replace(/\/$/, '')}/api/webhooks/collect/${orgId}/${p.toLowerCase()}`;
  }

  private open(cipher: string | null, keyId: string | null) {
    return cipher && keyId ? this.box.open(cipher, keyId) : null;
  }

  private creds(r: OrgPaymentGateway): GatewayCreds | null {
    const secret = this.open(r.secretCipher, r.secretKeyId);
    return secret ? { keyId: r.keyId, secret, webhookSecret: this.open(r.webhookCipher, r.webhookKeyId) } : null;
  }

  private client(provider: Provider, creds: GatewayCreds): PaymentGateway {
    const ms = this.config.PAYMENTS_TIMEOUT_SECONDS * 1000;
    return provider === 'STRIPE' ? new StripeGateway(creds, this.config.PAYMENTS_STRIPE_API_URL, ms) : new RazorpayGateway(creds, this.config.PAYMENTS_RAZORPAY_API_URL, ms);
  }

  // ----------------------------------------------------------------------------- gateway settings

  private card(orgId: string, provider: Provider, r: OrgPaymentGateway | undefined, accounts: { id: string; code: string; name: string }[]) {
    const unreadable = !!r && ((!!r.secretCipher && this.open(r.secretCipher, r.secretKeyId) === null) || (!!r.webhookCipher && this.open(r.webhookCipher, r.webhookKeyId) === null));
    return {
      provider,
      name: NAME[provider],
      configured: !!r?.secretCipher,
      enabled: !!r?.enabled,
      mode: (r?.mode ?? 'TEST') as 'TEST' | 'LIVE',
      currencies: r?.currencies ?? [],
      keyId: r?.keyId ?? null,
      secretHint: r?.secretHint ?? null,
      webhookHint: r?.webhookHint ?? null,
      depositAccount: r?.depositAccountId ? (accounts.find((a) => a.id === r.depositAccountId) ?? null) : null,
      needsReentry: unreadable,
      lastTest: r?.lastTestAt ? { at: r.lastTestAt.toISOString(), ok: !!r.lastTestOk, message: r.lastTestMessage ?? '' } : null,
      webhookUrl: this.webhookUrl(orgId, provider),
      webhookEvents: provider === 'STRIPE' ? ['checkout.session.completed', 'checkout.session.async_payment_succeeded'] : ['payment_link.paid'],
      updatedAt: r?.updatedAt.toISOString() ?? null,
    };
  }

  async gateways(org: LinkOrg) {
    const [rows, accounts, notices] = await Promise.all([
      this.prisma.orgPaymentGateway.findMany({ where: { orgId: org.id } }),
      this.prisma.account.findMany({ where: { orgId: org.id, subtype: { in: ['BANK', 'CASH'] }, isPostable: true }, select: { id: true, code: true, name: true, isActive: true }, orderBy: { code: 'asc' } }),
      this.prisma.paymentLinkNotice.findMany({ where: { orgId: org.id }, orderBy: { receivedAt: 'desc' }, take: 10 }),
    ]);
    return {
      gateways: (['RAZORPAY', 'STRIPE'] as Provider[]).map((p) => this.card(org.id, p, rows.find((r) => r.provider === p), accounts)),
      depositAccounts: accounts.filter((a) => a.isActive).map(({ isActive: _a, ...a }) => a),
      currencies: LINK_CURRENCIES,
      notices: notices.map((n) => ({ provider: n.provider, type: n.type, signatureOk: n.signatureOk, outcome: n.outcome, receivedAt: n.receivedAt.toISOString() })),
      can: { manage: hasPermission(org.role, 'org.manage') },
    };
  }

  async saveGateway(org: LinkOrg, actor: Actor, provider: Provider, input: OrgGatewayInput) {
    const before = await this.prisma.orgPaymentGateway.findUnique({ where: { orgId_provider: { orgId: org.id, provider } } });
    const problems: string[] = [];
    const secret = input.secret?.trim() || null;
    const webhookSecret = input.webhookSecret?.trim() || null;
    const keyId = provider === 'RAZORPAY' ? input.keyId?.trim() || before?.keyId || null : null;
    const live = input.mode === 'LIVE';
    const currencies = [...new Set(input.currencies)].sort();
    if (provider === 'STRIPE' && secret && !new RegExp(`^(sk|rk)_${live ? 'live' : 'test'}_[A-Za-z0-9]{8,}$`).test(secret)) problems.push(`A Stripe ${live ? 'live' : 'test'} secret key starts with sk_${live ? 'live' : 'test'}_ (or rk_${live ? 'live' : 'test'}_ for a restricted key)`);
    if (provider === 'STRIPE' && webhookSecret && !/^whsec_[A-Za-z0-9]{8,}$/.test(webhookSecret)) problems.push('A Stripe signing secret starts with whsec_');
    if (provider === 'RAZORPAY' && keyId && !new RegExp(`^rzp_${live ? 'live' : 'test'}_[A-Za-z0-9]{6,}$`).test(keyId)) problems.push(`A Razorpay ${live ? 'live' : 'test'} key id starts with rzp_${live ? 'live' : 'test'}_`);
    if (provider === 'RAZORPAY' && webhookSecret && webhookSecret.length < 8) problems.push('The Razorpay webhook secret is at least 8 characters');
    if (provider === 'RAZORPAY' && !keyId) problems.push('Enter the Razorpay key id');
    if (!secret && !before?.secretCipher) problems.push(`Enter the ${provider === 'STRIPE' ? 'secret key' : 'key secret'}`);
    if (before && before.mode !== input.mode && !secret) problems.push('Enter the key again when switching between test and live mode');
    if (currencies.some((c) => !(LINK_CURRENCIES as readonly string[]).includes(c))) problems.push(`Payment links can be made in ${LINK_CURRENCIES.join(' and ')}`);
    if (input.enabled) {
      if (!webhookSecret && !before?.webhookCipher) problems.push(`Enter the ${provider === 'STRIPE' ? 'webhook signing secret' : 'webhook secret'}: payments are confirmed by the gateway's signed notices`);
      if (!currencies.length) problems.push('Choose at least one currency this gateway takes');
      if (!input.depositAccountId) problems.push('Choose the bank account the gateway pays out to');
    }
    if (input.depositAccountId) {
      const a = await this.prisma.account.findFirst({ where: { id: input.depositAccountId, orgId: org.id } });
      if (!a || !a.isActive || !a.isPostable || !['BANK', 'CASH'].includes(a.subtype ?? '')) problems.push('Choose an active bank account of this organisation');
    }
    if (problems.length) this.invalid(problems[0]!, 'GATEWAY_INVALID', HttpStatus.UNPROCESSABLE_ENTITY, { issues: problems });
    if (input.enabled) {
      const others = await this.prisma.orgPaymentGateway.findMany({ where: { orgId: org.id, enabled: true, provider: { not: provider } } });
      const clash = others.find((o) => o.currencies.some((c) => currencies.includes(c)));
      if (clash) this.invalid(`${NAME[clash.provider as Provider]} already takes ${clash.currencies.filter((c) => currencies.includes(c)).join(' and ')} payments. Each currency is paid through one gateway.`, 'GATEWAY_CURRENCY_TAKEN', HttpStatus.CONFLICT);
    }
    const sealed = secret ? this.box.seal(secret) : null;
    const wh = webhookSecret ? this.box.seal(webhookSecret) : null;
    const data = {
      enabled: input.enabled,
      mode: input.mode,
      currencies,
      keyId,
      depositAccountId: input.depositAccountId ?? before?.depositAccountId ?? null,
      ...(sealed ? { secretCipher: sealed.cipher, secretKeyId: sealed.keyId, secretHint: secretHint(secret!) } : {}),
      ...(wh ? { webhookCipher: wh.cipher, webhookKeyId: wh.keyId, webhookHint: secretHint(webhookSecret!) } : {}),
      ...(sealed || keyId !== before?.keyId ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
      updatedById: actor.id,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.orgPaymentGateway.upsert({ where: { orgId_provider: { orgId: org.id, provider } }, create: { orgId: org.id, provider, ...data }, update: data });
      // Secrets never go into the audit trail; only that they changed.
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_gateway.saved', entityType: 'payment_gateway', entityId: provider, data: { provider, enabled: input.enabled, mode: input.mode, currencies, secretChanged: !!sealed, webhookSecretChanged: !!wh, depositAccountId: data.depositAccountId } });
    });
    return this.gateways(org);
  }

  async removeGateway(org: LinkOrg, actor: Actor, provider: Provider) {
    await this.prisma.$transaction(async (tx) => {
      const open = await tx.paymentLink.count({ where: { orgId: org.id, provider, status: 'OPEN' } });
      if (open) this.invalid(`${open} open payment ${open === 1 ? 'link uses' : 'links use'} ${NAME[provider]}; cancel ${open === 1 ? 'it' : 'them'} first`, 'GATEWAY_IN_USE', HttpStatus.CONFLICT);
      await tx.orgPaymentGateway.deleteMany({ where: { orgId: org.id, provider } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_gateway.removed', entityType: 'payment_gateway', entityId: provider, data: { provider } });
    });
    return this.gateways(org);
  }

  async testGateway(org: LinkOrg, actor: Actor, provider: Provider) {
    const r = await this.prisma.orgPaymentGateway.findUnique({ where: { orgId_provider: { orgId: org.id, provider } } });
    if (!r?.secretCipher) throw new NotFoundException({ error: 'NOT_FOUND', message: `${NAME[provider]} is not set up` });
    const creds = this.creds(r);
    let ok = false;
    let message: string;
    if (!creds) message = 'The stored key cannot be read (the server’s encryption key changed). Enter it again.';
    else {
      try {
        message = await this.client(provider, creds).test();
        ok = true;
      } catch (e) {
        message = e instanceof GatewayError ? `${NAME[provider]} refused: ${e.message}` : `Could not check: ${(e as Error).message}`;
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.orgPaymentGateway.update({ where: { id: r.id }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_gateway.tested', entityType: 'payment_gateway', entityId: provider, data: { provider, ok, message: message.slice(0, 500) } });
    });
    return { ok, message };
  }

  private async gatewayRow(db: Tx | PrismaService, orgId: string, provider: Provider) {
    const r = await db.orgPaymentGateway.findUnique({ where: { orgId_provider: { orgId, provider } } });
    const creds = r ? this.creds(r) : null;
    return r && creds ? { row: r, gateway: this.client(provider, creds) } : null;
  }

  // ---------------------------------------------------------------------------------- links

  private out(org: LinkOrg, l: PaymentLink, extra: { invoice?: { id: string; number: string | null } | null; receipt?: { id: string; number: string } | null } = {}, now = new Date()) {
    const scale = minorUnits(l.currency);
    const status = (linkExpired(l.status as PaymentLinkStatus, l.expiresAt, now) ? 'EXPIRED' : l.status) as PaymentLinkStatus;
    return {
      id: l.id,
      reference: paymentLinkRef(l.number),
      documentId: l.documentId,
      provider: l.provider,
      url: l.url,
      currency: l.currency,
      amount: new D(l.amount.toString()).toFixed(scale),
      status,
      expiresAt: l.expiresAt?.toISOString() ?? null,
      paidAt: l.paidAt?.toISOString() ?? null,
      paidAmount: l.paidAmount ? new D(l.paidAmount.toString()).toFixed(scale) : null,
      gatewayPaymentId: l.gatewayPaymentId,
      settledBy: l.settledBy,
      cancelledAt: l.cancelledAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
      ...extra,
    };
  }

  private async withRefs(org: LinkOrg, links: PaymentLink[]) {
    const [docs, pays] = await Promise.all([
      links.length ? this.prisma.document.findMany({ where: { orgId: org.id, id: { in: [...new Set(links.map((l) => l.documentId))] } }, select: { id: true, number: true } }) : [],
      links.some((l) => l.paymentId) ? this.prisma.payment.findMany({ where: { orgId: org.id, id: { in: links.flatMap((l) => (l.paymentId ? [l.paymentId] : [])) } }, select: { id: true, number: true } }) : [],
    ]);
    return links.map((l) => this.out(org, l, { invoice: docs.find((d) => d.id === l.documentId) ?? null, receipt: pays.find((p) => p.id === l.paymentId) ?? null }));
  }

  /** Links on one invoice (newest first), and whether a new one can be made. */
  async forInvoice(org: LinkOrg, documentId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id } });
    if (!doc) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    const [links, gw] = await Promise.all([
      this.prisma.paymentLink.findMany({ where: { orgId: org.id, documentId }, orderBy: { number: 'desc' } }),
      this.prisma.orgPaymentGateway.findFirst({ where: { orgId: org.id, enabled: true, currencies: { has: doc.currency } } }),
    ]);
    const outstanding = await this.outstanding(this.prisma, doc.id, doc.total.toString());
    return {
      links: await this.withRefs(org, links),
      outstanding: outstanding.toFixed(minorUnits(doc.currency)),
      currency: doc.currency,
      gateway: gw ? { provider: gw.provider, name: NAME[gw.provider as Provider], mode: gw.mode } : null,
      can: { manage: hasPermission(org.role, 'sales.manage'), setUp: hasPermission(org.role, 'org.manage') },
    };
  }

  async list(org: LinkOrg, f: { status?: PaymentLinkStatus }) {
    const links = await this.prisma.paymentLink.findMany({ where: { orgId: org.id, ...(f.status && f.status !== 'EXPIRED' ? { status: f.status } : {}) }, orderBy: { number: 'desc' }, take: 300 });
    const out = await this.withRefs(org, links);
    return { links: f.status ? out.filter((l) => l.status === f.status) : out };
  }

  private async outstanding(db: Tx | PrismaService, documentId: string, total: string) {
    const used = await db.allocation.aggregate({ where: { targetId: documentId, removedOn: null }, _sum: { amount: true } });
    return new D(total).minus(used._sum.amount?.toString() ?? '0');
  }

  /** Make a link for what is owed on a posted invoice (or part of it). */
  async create(org: LinkOrg, actor: Actor, documentId: string, input: { amount?: string | null }) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id }, include: { contact: { select: { name: true, email: true } } } });
    if (!doc || doc.kind !== 'INVOICE') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    if (doc.status !== 'POSTED') this.invalid('Post the invoice before sending a payment link', 'INVOICE_NOT_POSTED');
    if (!(LINK_CURRENCIES as readonly string[]).includes(doc.currency)) this.invalid(`Payment links can be made in ${LINK_CURRENCIES.join(' and ')}; this invoice is in ${doc.currency}`, 'LINK_CURRENCY');
    const row = await this.prisma.orgPaymentGateway.findFirst({ where: { orgId: org.id, enabled: true, currencies: { has: doc.currency } } });
    if (!row) this.invalid(`Set up a payment gateway that takes ${doc.currency} in Settings → Payment gateways first`, 'GATEWAY_NOT_SET_UP');
    const creds = this.creds(row);
    if (!creds) this.invalid(`The ${NAME[row.provider as Provider]} key cannot be read; enter it again in Settings → Payment gateways`, 'GATEWAY_KEY_UNREADABLE');
    const outstanding = await this.outstanding(this.prisma, doc.id, doc.total.toString());
    const amount = input.amount?.trim() || outstanding.toFixed(minorUnits(doc.currency));
    const issues = linkAmountIssues(amount, outstanding.toFixed(), doc.currency);
    if (issues.length) this.invalid(issues[0]!, 'PAYMENT_LINK_INVALID', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const existing = await this.prisma.paymentLink.findFirst({ where: { orgId: org.id, documentId, status: 'OPEN' } });
    if (existing && !linkExpired('OPEN', existing.expiresAt, new Date())) this.invalid(`${paymentLinkRef(existing.number)} is still open for this invoice; cancel it to make a new one`, 'PAYMENT_LINK_OPEN', HttpStatus.CONFLICT);
    if (existing) await this.prisma.paymentLink.update({ where: { id: existing.id }, data: { status: 'EXPIRED' } });
    const provider = row.provider as Provider;
    const number = await this.prisma.$transaction(async (tx) => {
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'payment_link', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
        RETURNING value`;
      return value;
    });
    const back = `${this.config.APP_URL.replace(/\/$/, '')}/paid?ref=${encodeURIComponent(paymentLinkRef(number))}`;
    let checkout;
    try {
      checkout = await this.client(provider, creds).createCheckout({
        reference: `${paymentLinkRef(number)} ${doc.number}`.replace(/\s+/g, '-'),
        invoiceId: doc.id,
        orgId: org.id,
        amountMinor: amountToMinor(amount, doc.currency),
        currency: doc.currency as 'INR' | 'USD',
        description: `Invoice ${doc.number}`,
        customerName: doc.contact.name,
        customerEmail: doc.contact.email,
        returnUrl: back,
        cancelUrl: back,
      });
    } catch (e) {
      this.invalid(e instanceof GatewayError ? `${NAME[provider]} refused the link: ${e.message}` : `Could not reach ${NAME[provider]}: ${(e as Error).message}`, 'GATEWAY_ERROR', HttpStatus.BAD_GATEWAY);
    }
    const link = await this.prisma.$transaction(async (tx) => {
      const l = await tx.paymentLink.create({
        data: { orgId: org.id, number, documentId, provider, gatewayRef: checkout.ref, url: checkout.url, currency: doc.currency, amount: new D(amount).toFixed(), expiresAt: checkout.expiresAt, createdById: actor.id },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_link.created', entityType: 'payment_link', entityId: l.id, data: { reference: paymentLinkRef(number), documentId, invoice: doc.number, provider, amount, currency: doc.currency } });
      return l;
    });
    return (await this.withRefs(org, [link]))[0]!;
  }

  private async load(orgId: string, id: string) {
    const l = await this.prisma.paymentLink.findFirst({ where: { id, orgId } });
    if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment link not found' });
    return l;
  }

  /** Ask the gateway how the link stands; a paid one is settled, an ended one closed. */
  async refresh(org: LinkOrg, actor: Actor, id: string) {
    const l = await this.load(org.id, id);
    if (l.status === 'OPEN') {
      const g = await this.gatewayRow(this.prisma, org.id, l.provider as Provider);
      if (!g) this.invalid(`${NAME[l.provider as Provider]} is no longer set up for this organisation`, 'GATEWAY_NOT_SET_UP');
      let state: PaymentState;
      try {
        state = await g.gateway.status(l.gatewayRef);
      } catch (e) {
        this.invalid(e instanceof GatewayError ? `${NAME[l.provider as Provider]} refused: ${e.message}` : `Could not reach ${NAME[l.provider as Provider]}: ${(e as Error).message}`, 'GATEWAY_ERROR', HttpStatus.BAD_GATEWAY);
      }
      if (state.paid) {
        const r = await this.settle(org.id, l.id, state, `checked by ${actor.id}`);
        if (r.problem) this.invalid(r.problem, 'PAYMENT_LINK_NOT_SETTLED');
      } else if (['expired', 'cancelled'].includes(state.state)) {
        await this.prisma.$transaction(async (tx) => {
          await tx.paymentLink.update({ where: { id: l.id }, data: state.state === 'cancelled' ? { status: 'CANCELLED', cancelledAt: new Date() } : { status: 'EXPIRED' } });
          await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_link.ended', entityType: 'payment_link', entityId: l.id, data: { reference: paymentLinkRef(l.number), state: state.state } });
        });
      }
    }
    return (await this.withRefs(org, [await this.load(org.id, id)]))[0]!;
  }

  async cancel(org: LinkOrg, actor: Actor, id: string) {
    const l = await this.load(org.id, id);
    if (l.status !== 'OPEN') this.invalid(`This payment link is ${l.status.toLowerCase()}`, 'PAYMENT_LINK_ENDED');
    const g = await this.gatewayRow(this.prisma, org.id, l.provider as Provider);
    if (g) {
      // A link paid in the meantime is settled instead of cancelled.
      const state = await g.gateway.status(l.gatewayRef).catch(() => null);
      if (state?.paid) {
        await this.settle(org.id, l.id, state, `checked by ${actor.id}`);
        return (await this.withRefs(org, [await this.load(org.id, id)]))[0]!;
      }
      await g.gateway.cancel(l.gatewayRef);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentLink.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_link.cancelled', entityType: 'payment_link', entityId: id, data: { reference: paymentLinkRef(l.number) } });
    });
    return (await this.withRefs(org, [await this.load(org.id, id)]))[0]!;
  }

  /**
   * Settle a link the gateway says is paid: an ordinary receipt for what was paid, into the
   * gateway's deposit account, applied to the invoice up to what is still owed (any rest stays on
   * account as the customer's credit). Runs once; a second call finds the link already paid.
   */
  private async settle(orgId: string, linkId: string, state: PaymentState, source: string): Promise<{ settled: boolean; problem?: string; receipt?: string }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // A webhook arrives without a signed-in organisation. The ledger's deferred checks run at
        // commit, after system access is switched off, so the transaction is pointed at the org.
        await useOrgInTx(tx, orgId);
        return withSystemAccess(tx, async () => {
          await tx.$queryRaw`SELECT id FROM payment_links WHERE id = ${linkId}::uuid FOR UPDATE`;
          const l = await tx.paymentLink.findUniqueOrThrow({ where: { id: linkId } });
          if (l.status === 'PAID') return { settled: false };
          if (state.currency && state.currency.toUpperCase() !== l.currency) return { settled: false, problem: `Paid in ${state.currency.toUpperCase()}, not ${l.currency}` };
          const paid = state.amountMinor != null ? minorToAmount(state.amountMinor, l.currency) : new D(l.amount.toString()).toFixed(minorUnits(l.currency));
          if (new D(paid).lte(0)) return { settled: false, problem: 'The gateway reports no amount paid' };
          const gw = await tx.orgPaymentGateway.findUnique({ where: { orgId_provider: { orgId, provider: l.provider } } });
          if (!gw?.depositAccountId) return { settled: false, problem: 'No deposit account is set for this gateway' };
          const doc = await tx.document.findUniqueOrThrow({ where: { id: l.documentId } });
          const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, functionalCurrency: true } });
          const owed = doc.status === 'POSTED' ? await this.outstanding(tx, doc.id, doc.total.toString()) : new D(0);
          const apply = D.min(owed, paid);
          const p = await this.documents.recordPaymentInTx(tx, { id: org.id, role: 'OWNER', functionalCurrency: org.functionalCurrency }, { id: l.createdById }, 'SALES', {
            contactId: doc.contactId,
            date: todayIso(),
            bankAccountId: gw.depositAccountId,
            amount: paid,
            currency: l.currency,
            reference: (state.paymentId ?? paymentLinkRef(l.number)).slice(0, 100),
            memo: `${NAME[l.provider as Provider]} payment link ${paymentLinkRef(l.number)} for ${doc.number}`,
            allocations: apply.gt(0) ? [{ documentId: doc.id, amount: apply.toFixed() }] : [],
          });
          await tx.paymentLink.update({ where: { id: l.id }, data: { status: 'PAID', paidAt: new Date(), paidAmount: paid, gatewayPaymentId: state.paymentId, paymentId: p.id, settledBy: source.slice(0, 100) } });
          await this.audit.append(tx, { orgId, actorId: l.createdById, action: 'payment_link.paid', entityType: 'payment_link', entityId: l.id, data: { reference: paymentLinkRef(l.number), invoice: doc.number, paid, applied: apply.toFixed(), receiptId: p.id, gatewayPaymentId: state.paymentId, source } });
          return { settled: true, receipt: p.number };
        });
      });
    } catch (e) {
      // For example the period of today's date is locked: the link stays open and can be checked again.
      const msg = e instanceof DomainError ? e.message : (e as Error).message;
      this.logger.warn(`Could not settle payment link ${linkId}: ${msg}`);
      return { settled: false, problem: `Paid at the gateway, but the receipt could not be recorded: ${msg}` };
    }
  }

  /** A signed notice from an organisation's gateway. Unsigned or unknown notices are recorded and refused. */
  async webhook(orgId: string, provider: Provider, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>, now = new Date()) {
    const system = <T>(fn: (tx: Tx) => Promise<T>) => this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
    const orgExists = await system((tx) => tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }));
    if (!orgExists) throw new DomainError('NOT_FOUND', 'Not found', HttpStatus.NOT_FOUND);
    const record = (d: { eventId: string | null; type: string; signatureOk: boolean; outcome: string; linkId?: string | null }) =>
      system((tx) => tx.paymentLinkNotice.create({ data: { id: randomUUID(), orgId, provider, eventId: d.eventId, type: d.type.slice(0, 100), signatureOk: d.signatureOk, outcome: d.outcome.slice(0, 300), linkId: d.linkId ?? null } }));
    const g = await system((tx) => this.gatewayRow(tx, orgId, provider));
    if (!g) {
      await record({ eventId: null, type: '', signatureOk: false, outcome: 'Gateway not set up' });
      throw new DomainError('GATEWAY_NOT_SET_UP', 'This gateway is not set up', HttpStatus.NOT_FOUND);
    }
    if (!raw?.length) throw new DomainError('EMPTY_NOTICE', 'The notice has no body', HttpStatus.BAD_REQUEST);
    let notice;
    try {
      notice = g.gateway.webhook(raw, headers, now);
    } catch (e) {
      const msg = e instanceof SignatureError ? e.message : `Unreadable notice: ${(e as Error).message}`;
      await record({ eventId: null, type: '', signatureOk: false, outcome: msg });
      throw new DomainError('SIGNATURE_INVALID', msg, HttpStatus.BAD_REQUEST);
    }
    const seen = await system((tx) => tx.paymentLinkNotice.findUnique({ where: { orgId_provider_eventId: { orgId, provider, eventId: notice.eventId } } }));
    if (seen) return { received: true, duplicate: true };
    const link = notice.ref ? await system((tx) => tx.paymentLink.findFirst({ where: { orgId, provider, gatewayRef: notice.ref! } })) : null;
    let outcome = 'Not about a payment link';
    if (notice.ref && !link) outcome = 'No payment link has this checkout';
    else if (link && notice.payment?.paid) {
      const r = await this.settle(orgId, link.id, notice.payment, `webhook ${notice.type}`);
      outcome = r.settled ? `Paid: ${paymentLinkRef(link.number)}, receipt ${r.receipt}` : r.problem ? `Not settled: ${r.problem}` : 'Already paid';
    } else if (link) outcome = `Link ${notice.payment?.state ?? 'updated'}`;
    try {
      await record({ eventId: notice.eventId, type: notice.type, signatureOk: true, outcome, linkId: link?.id ?? null });
    } catch {
      return { received: true, duplicate: true };
    }
    return { received: true, duplicate: false, outcome };
  }
}
