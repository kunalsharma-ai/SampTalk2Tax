import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { SubscriptionInvoice } from '@talk2tax/database';
import { BillingCurrency, BillingInterval, checkoutPlan, GRACE_DAYS, indianFinancialYear, periodEnd, PlanError, priceFor, subscriptionTax, taxInvoiceNumber, toMinorUnits } from '@talk2tax/accounting-engine';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/decorators';
import { DomainError } from '../../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../../common/prisma.service';
import { BillingService, serializePlan } from '../billing.service';
import { GatewayError, PaymentGateway, PaymentState, Provider, SignatureError } from './gateways';
import { PaymentSettingsService } from './payment-settings.service';

const DAY = 86_400_000;
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** A payment request reference such as PR-7K3QX9MD (no 0/O or 1/I to misread). */
function newReference() {
  const b = randomBytes(8);
  return `PR-${[...b].map((x) => REF_ALPHABET[x % 32]).join('')}`;
}

type InvoiceRow = SubscriptionInvoice & { plan: { code: string; name: string } };

export function serializeInvoice(i: InvoiceRow) {
  return {
    id: i.id,
    orgId: i.orgId,
    reference: i.reference,
    number: i.number,
    kind: i.kind,
    status: i.status,
    plan: { code: i.plan.code, name: i.plan.name },
    billingInterval: i.billingInterval as BillingInterval,
    listPrice: i.listPrice.toFixed(2),
    periodStart: i.periodStart.toISOString(),
    periodEnd: i.periodEnd.toISOString(),
    currency: i.currency,
    subtotal: i.subtotal.toFixed(2),
    taxLines: i.taxLines as { code: string; rate: string; amount: string }[],
    taxTotal: i.taxTotal.toFixed(2),
    total: i.total.toFixed(2),
    taxNote: i.taxNote,
    placeOfSupply: i.placeOfSupply,
    seller: i.seller,
    buyer: i.buyer,
    issuedAt: i.issuedAt.toISOString(),
    dueAt: i.dueAt.toISOString(),
    paidAt: i.paidAt?.toISOString() ?? null,
    voidedAt: i.voidedAt?.toISOString() ?? null,
    voidReason: i.voidReason,
    gateway: i.gateway,
    paymentRef: i.paymentRef,
    checkout: i.status === 'OPEN' && i.checkoutUrl && (!i.checkoutExpiresAt || i.checkoutExpiresAt > new Date()) ? { url: i.checkoutUrl, expiresAt: i.checkoutExpiresAt?.toISOString() ?? null } : null,
  };
}

/**
 * Paying for a subscription online. A checkout issues an unpaid invoice (a payment request) for
 * what the plan change buys (engine checkoutPlan), with tax from the platform's seller details,
 * and sends the customer to the gateway's own payment page. The payment is taken as received
 * only when the gateway says so: by a signed webhook, or when the API asks the gateway for the
 * checkout's state. Either way markPaid runs once, numbers the tax invoice and moves the
 * subscription on. Renewals are issued the same way by the billing runner.
 */
@Injectable()
export class SubscriptionPaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly settings: PaymentSettingsService,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  // ---------------------------------------------------------------------------- what a plan costs

  /** What paying for this plan now would charge, for which period, with tax. Nothing is saved. */
  async quote(orgId: string, planCode: string, interval: BillingInterval, now = new Date()) {
    return this.system(async (tx) => {
      const q = await this.work(tx, orgId, planCode, interval, now, { forQuote: true });
      if (q.plan.kind === 'SCHEDULED') return { kind: 'SCHEDULED' as const, reason: q.plan.reason, plan: serializePlan(q.target, q.currency), interval };
      return {
        kind: q.plan.kind,
        plan: serializePlan(q.target, q.currency),
        interval,
        currency: q.currency,
        periodStart: q.plan.periodStart.toISOString(),
        periodEnd: q.plan.periodEnd.toISOString(),
        subtotal: q.plan.amount.toFixed(2),
        ...(q.tax ?? { lines: [], taxTotal: '0.00', total: q.plan.amount.toFixed(2), note: 'Any tax is added on the invoice', placeOfSupply: null }),
        // Online payment needs a gateway for the currency and the seller details invoices carry.
        payOnline: !!q.tax && !!(await this.settings.forCurrency(q.currency)),
      };
    });
  }

  private async work(tx: Tx, orgId: string, planCode: string, interval: BillingInterval, now: Date, opts: { forQuote?: boolean } = {}) {
    const s = await tx.subscription.findUnique({ where: { orgId }, include: { plan: true } });
    if (!s) throw new DomainError('NO_SUBSCRIPTION', 'This organisation has no subscription', HttpStatus.NOT_FOUND);
    const target = await tx.plan.findUnique({ where: { code: planCode } });
    if (!target || !target.isActive) throw new DomainError('PLAN_NOT_FOUND', 'That plan is not offered', HttpStatus.UNPROCESSABLE_ENTITY);
    const currency = s.currency as BillingCurrency;
    const price = priceFor(serializePlan(target), currency, interval);
    let plan: ReturnType<typeof checkoutPlan>;
    try {
      plan = checkoutPlan({
        status: s.status as 'TRIALING',
        planCode: s.plan.code,
        interval: s.billingInterval as BillingInterval | null,
        price: s.price?.toFixed(2) ?? null,
        trialEndsAt: s.trialEndsAt,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        target: { planCode: target.code, interval, price },
        currency,
        now,
      });
    } catch (e) {
      if (e instanceof PlanError) throw new DomainError('NOT_CHARGED', e.message, HttpStatus.CONFLICT);
      throw e;
    }
    const noProfile = opts.forQuote && !(await tx.platformBillingProfile.findUnique({ where: { id: 1 }, select: { id: true } }));
    const tax = plan.kind === 'SCHEDULED' || noProfile ? null : await this.taxFor(tx, orgId, plan.amount.toFixed(2), currency);
    return { s, target, currency, price, plan, tax: tax?.tax ?? null, parties: tax };
  }

  private async taxFor(tx: Tx, orgId: string, subtotal: string, currency: BillingCurrency) {
    const profile = await tx.platformBillingProfile.findUnique({ where: { id: 1 } });
    if (!profile) throw new DomainError('BILLING_PROFILE_MISSING', 'Talk2Tax has not entered its billing details yet, so invoices cannot be issued. Platform administrators add them under Platform admin → Payments.', HttpStatus.CONFLICT);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, legalName: true, countryCode: true } });
    const gst = await tx.gstRegistration.findUnique({ where: { orgId }, select: { gstin: true, stateCode: true, legalName: true } });
    const tax = subscriptionTax({
      seller: { countryCode: profile.countryCode, gstin: profile.gstin, stateCode: profile.stateCode },
      buyer: { countryCode: org.countryCode, gstin: gst?.gstin ?? null, stateCode: gst?.stateCode ?? null },
      subtotal,
      currency,
      gstRate: profile.gstRate.toFixed(2),
    });
    const seller = { legalName: profile.legalName, address: profile.address, countryCode: profile.countryCode, gstin: profile.gstin, stateCode: profile.stateCode, email: profile.email, sacCode: profile.sacCode };
    const buyer = { name: gst?.legalName || org.legalName || org.name, countryCode: org.countryCode, gstin: gst?.gstin ?? null, stateCode: gst?.stateCode ?? null };
    return { tax, seller, buyer, prefix: profile.invoicePrefix };
  }

  // ------------------------------------------------------------------------------------- checkout

  /**
   * Starts paying for a plan. A cheaper plan or a change of billing is not charged now: it is
   * recorded as the plan for the renewal. Otherwise an invoice is issued (replacing any unpaid
   * one) and the gateway's payment page is returned.
   */
  async checkout(orgId: string, actor: AuthUser, planCode: string, interval: BillingInterval, returnTo: string, now = new Date()) {
    const issued = await this.system(async (tx) => {
      const q = await this.work(tx, orgId, planCode, interval, now);
      if (q.plan.kind === 'SCHEDULED') return { scheduled: q.plan.reason } as const;
      await this.billing.memberFit(tx, orgId, q.target);
      const gateway = await this.settings.forCurrency(q.currency);
      if (!gateway) throw new DomainError('PAYMENTS_NOT_SET_UP', `Online payment in ${q.currency} is not set up yet. Request the plan and Talk2Tax will send payment details, or try again later.`, HttpStatus.CONFLICT);
      const replaced = await this.voidOpen(tx, orgId, actor.id, 'Replaced by a new checkout');
      const inv = await this.issue(tx, orgId, actor.id, {
        kind: q.plan.kind,
        planId: q.target.id,
        interval,
        listPrice: q.price.toFixed(2),
        periodStart: q.plan.periodStart,
        periodEnd: q.plan.periodEnd,
        currency: q.currency,
        subtotal: q.plan.amount.toFixed(2),
        parties: q.parties!,
        dueAt: now,
      });
      return { inv, gateway, replaced };
    });
    if ('scheduled' in issued) {
      const sub = await this.billing.request(orgId, actor.id, planCode, interval);
      return { scheduled: true as const, reason: issued.scheduled, subscription: sub, invoice: null, url: null };
    }
    for (const r of issued.replaced) await this.cancelCheckout(r);
    const inv = await this.startCheckout(issued.inv, issued.gateway, actor, returnTo);
    return { scheduled: false as const, reason: null, subscription: null, invoice: inv, url: inv.checkout!.url };
  }

  /** Pays an unpaid invoice (a renewal, or one whose page was closed): reuses its page while it is open. */
  async pay(orgId: string, actor: AuthUser, invoiceId: string, returnTo: string) {
    const inv = await this.prisma.subscriptionInvoice.findFirst({ where: { id: invoiceId, orgId }, include: { plan: true } });
    if (!inv) throw new DomainError('NOT_FOUND', 'Invoice not found', HttpStatus.NOT_FOUND);
    if (inv.status !== 'OPEN') throw new DomainError('INVOICE_NOT_OPEN', `This invoice is ${inv.status.toLowerCase()}`, HttpStatus.CONFLICT);
    const s = serializeInvoice(inv);
    if (s.checkout) return { invoice: s, url: s.checkout.url };
    const gateway = await this.settings.forCurrency(inv.currency);
    if (!gateway) throw new DomainError('PAYMENTS_NOT_SET_UP', `Online payment in ${inv.currency} is not set up yet`, HttpStatus.CONFLICT);
    const out = await this.startCheckout(inv, gateway, actor, returnTo);
    return { invoice: out, url: out.checkout!.url };
  }

  private async startCheckout(inv: InvoiceRow, gateway: PaymentGateway, actor: AuthUser, returnTo: string) {
    const back = `${returnTo}${returnTo.includes('?') ? '&' : '?'}invoice=${inv.id}`;
    let result;
    try {
      result = await gateway.createCheckout({
        reference: inv.reference,
        invoiceId: inv.id,
        orgId: inv.orgId,
        amountMinor: toMinorUnits(inv.total.toFixed(2), inv.currency as BillingCurrency),
        currency: inv.currency as BillingCurrency,
        description: `Talk2Tax ${inv.plan.name}, ${inv.billingInterval === 'ANNUAL' ? 'annual' : 'monthly'} (${inv.reference})`,
        customerName: (inv.buyer as { name?: string }).name ?? 'Customer',
        customerEmail: actor.email,
        returnUrl: back,
        cancelUrl: `${back}&cancelled=1`,
      });
    } catch (e) {
      if (e instanceof GatewayError) throw new DomainError('GATEWAY_ERROR', `The payment gateway could not start the payment: ${e.message}`, HttpStatus.BAD_GATEWAY);
      throw e;
    }
    const saved = await this.system(async (tx) => {
      const row = await tx.subscriptionInvoice.update({ where: { id: inv.id }, data: { gateway: gateway.provider, checkoutRef: result.ref, checkoutUrl: result.url, checkoutExpiresAt: result.expiresAt }, include: { plan: true } });
      await this.billing.event(tx, inv.orgId, actor.id, 'CHECKOUT_STARTED', { invoice: inv.reference, gateway: gateway.provider, total: inv.total.toFixed(2), currency: inv.currency });
      return row;
    });
    return serializeInvoice(saved);
  }

  private async issue(
    tx: Tx,
    orgId: string,
    actorId: string | null,
    d: { kind: string; planId: string; interval: BillingInterval; listPrice: string; periodStart: Date; periodEnd: Date; currency: BillingCurrency; subtotal: string; parties: NonNullable<Awaited<ReturnType<SubscriptionPaymentsService['taxFor']>>>; dueAt: Date },
  ) {
    const t = d.parties.tax;
    const inv = await tx.subscriptionInvoice.create({
      data: {
        id: randomUUID(),
        orgId,
        reference: newReference(),
        kind: d.kind,
        planId: d.planId,
        billingInterval: d.interval,
        listPrice: d.listPrice,
        periodStart: d.periodStart,
        periodEnd: d.periodEnd,
        currency: d.currency,
        subtotal: d.subtotal,
        taxLines: t.lines,
        taxTotal: t.taxTotal,
        total: t.total,
        taxNote: t.note,
        placeOfSupply: t.placeOfSupply,
        seller: d.parties.seller,
        buyer: d.parties.buyer,
        dueAt: d.dueAt,
        createdBy: actorId,
      },
      include: { plan: true },
    });
    await this.billing.event(tx, orgId, actorId, 'INVOICE_ISSUED', { invoice: inv.reference, kind: d.kind, plan: inv.plan.code, interval: d.interval, total: t.total, currency: d.currency, periodStart: d.periodStart.toISOString(), periodEnd: d.periodEnd.toISOString() });
    return inv;
  }

  private async voidOpen(tx: Tx, orgId: string, actorId: string | null, reason: string) {
    const open = await tx.subscriptionInvoice.findMany({ where: { orgId, status: 'OPEN' } });
    for (const o of open) {
      await tx.subscriptionInvoice.update({ where: { id: o.id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
      await this.billing.event(tx, orgId, actorId, 'INVOICE_VOIDED', { invoice: o.reference, reason });
    }
    return open;
  }

  private async cancelCheckout(inv: SubscriptionInvoice) {
    if (!inv.gateway || inv.gateway === 'MANUAL' || !inv.checkoutRef) return;
    const g = await this.settings.byProvider(inv.gateway as Provider);
    await g?.cancel(inv.checkoutRef).catch(() => undefined);
  }

  // --------------------------------------------------------------------------- confirming payment

  /** Asks the gateway whether an unpaid invoice's checkout has been paid, and records it if so. */
  async check(orgId: string | null, invoiceId: string) {
    const inv = await this.system((tx) => tx.subscriptionInvoice.findFirst({ where: { id: invoiceId, ...(orgId ? { orgId } : {}) }, include: { plan: true } }));
    if (!inv) throw new DomainError('NOT_FOUND', 'Invoice not found', HttpStatus.NOT_FOUND);
    if (inv.status !== 'OPEN' || !inv.checkoutRef || !inv.gateway || inv.gateway === 'MANUAL') return { invoice: serializeInvoice(inv), state: inv.status === 'PAID' ? 'paid' : inv.status === 'VOID' ? 'void' : 'not started' };
    const g = await this.settings.byProvider(inv.gateway as Provider);
    if (!g) throw new DomainError('PAYMENTS_NOT_SET_UP', 'The gateway this invoice was paid through is no longer set up', HttpStatus.CONFLICT);
    let st: PaymentState;
    try {
      st = await g.status(inv.checkoutRef);
    } catch (e) {
      if (e instanceof GatewayError) throw new DomainError('GATEWAY_ERROR', `The payment gateway could not be asked: ${e.message}`, HttpStatus.BAD_GATEWAY);
      throw e;
    }
    if (st.paid) {
      const out = await this.markPaid(inv.id, { gateway: g.provider, paymentId: st.paymentId, amountMinor: st.amountMinor, currency: st.currency, source: 'status check' });
      return { invoice: out.invoice, state: out.applied || out.invoice.status === 'PAID' ? 'paid' : out.problem ?? 'not applied' };
    }
    return { invoice: serializeInvoice(inv), state: st.state };
  }

  /**
   * Records a received payment, once. The amount and currency must match the invoice; a payment
   * for an invoice already paid or voided is kept as an event for staff to refund or apply.
   */
  async markPaid(invoiceId: string, p: { gateway: Provider | 'MANUAL'; paymentId: string | null; amountMinor: number | null; currency: string | null; source: string; actorId?: string | null; reference?: string }, now = new Date()) {
    return this.system(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM subscription_invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const inv = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { plan: true } });
      const actorId = p.actorId ?? null;
      if (inv.status === 'PAID') return { invoice: serializeInvoice(inv), applied: false, problem: null as string | null };
      const expected = toMinorUnits(inv.total.toFixed(2), inv.currency as BillingCurrency);
      if (p.gateway !== 'MANUAL' && (p.amountMinor !== expected || (p.currency ?? '').toUpperCase() !== inv.currency)) {
        await this.billing.event(tx, inv.orgId, actorId, 'PAYMENT_MISMATCH', { invoice: inv.reference, expected: { amountMinor: expected, currency: inv.currency }, received: { amountMinor: p.amountMinor, currency: p.currency }, paymentId: p.paymentId, gateway: p.gateway });
        return { invoice: serializeInvoice(inv), applied: false, problem: 'amount does not match' };
      }
      if (inv.status === 'VOID') {
        await this.billing.event(tx, inv.orgId, actorId, 'PAYMENT_ON_VOID_INVOICE', { invoice: inv.reference, paymentId: p.paymentId, gateway: p.gateway, note: 'Refund it, or apply it by hand' });
        return { invoice: serializeInvoice(inv), applied: false, problem: 'invoice was replaced' };
      }
      const fy = indianFinancialYear(now);
      const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO subscription_invoice_counters (series, last) VALUES (${fy.label}, 1)
        ON CONFLICT (series) DO UPDATE SET last = subscription_invoice_counters.last + 1
        RETURNING last`;
      const prefix = (await tx.platformBillingProfile.findUnique({ where: { id: 1 }, select: { invoicePrefix: true } }))?.invoicePrefix ?? 'T2T';
      const number = taxInvoiceNumber(prefix, fy.label, last!);
      const paymentRef = (p.reference ?? p.paymentId ?? inv.checkoutRef ?? inv.reference).slice(0, 200);
      const paid = await tx.subscriptionInvoice.update({ where: { id: inv.id }, data: { status: 'PAID', number, paidAt: now, paymentRef, ...(p.gateway === 'MANUAL' ? { gateway: 'MANUAL' } : {}) }, include: { plan: true } });
      await this.apply(tx, paid, now);
      await this.billing.event(tx, inv.orgId, actorId, 'PAYMENT_RECEIVED', { invoice: inv.reference, number, total: inv.total.toFixed(2), currency: inv.currency, gateway: p.gateway, paymentId: p.paymentId, source: p.source });
      await this.audit.append(tx, { orgId: inv.orgId, actorId, action: 'subscription.payment_received', entityType: 'subscription_invoice', entityId: inv.id, data: { number, reference: inv.reference, total: inv.total.toFixed(2), currency: inv.currency, gateway: p.gateway, paymentId: p.paymentId, source: p.source } });
      return { invoice: serializeInvoice(paid), applied: true, problem: null };
    });
  }

  /** Moves the subscription on for a paid invoice. */
  private async apply(tx: Tx, inv: InvoiceRow, now: Date) {
    const s = await tx.subscription.findUniqueOrThrow({ where: { orgId: inv.orgId } });
    const clearRequest = s.requestedPlanId === inv.planId && s.requestedInterval === inv.billingInterval ? { requestedPlanId: null, requestedInterval: null, requestedAt: null, requestedBy: null } : {};
    const common = { planId: inv.planId, status: 'ACTIVE', billingInterval: inv.billingInterval, price: inv.listPrice, paymentReference: inv.number, ...clearRequest };
    if (inv.kind === 'UPGRADE') {
      // The period already paid for continues; only the plan (and its price) changes.
      await tx.subscription.update({ where: { orgId: inv.orgId }, data: { ...common, currentPeriodEnd: s.currentPeriodEnd && s.currentPeriodEnd > inv.periodEnd ? s.currentPeriodEnd : inv.periodEnd } });
    } else {
      // A new period, or a renewal. A renewal paid after its grace ran out starts now, so days
      // spent read-only are not charged; otherwise the period is the invoice's.
      const lapsed = inv.kind === 'RENEWAL' && now.getTime() > inv.periodStart.getTime() + GRACE_DAYS * DAY;
      const start = lapsed ? now : inv.periodStart;
      const end = lapsed ? periodEnd(now, inv.billingInterval as BillingInterval) : inv.periodEnd;
      await tx.subscription.update({ where: { orgId: inv.orgId }, data: { ...common, currentPeriodStart: start, currentPeriodEnd: end } });
    }
  }

  /**
   * A webhook from a gateway. Notices without a valid signature are recorded and refused.
   * Each notice is handled once (by its event id); a repeat is acknowledged and ignored.
   */
  async webhook(provider: Provider, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>, now = new Date()) {
    const record = (data: { eventId: string | null; type: string; signatureOk: boolean; outcome: string; invoiceId?: string | null }) =>
      this.system((tx) => tx.paymentWebhookEvent.create({ data: { id: randomUUID(), provider, eventId: data.eventId, type: data.type.slice(0, 100), signatureOk: data.signatureOk, outcome: data.outcome.slice(0, 300), invoiceId: data.invoiceId ?? null } }));
    const g = await this.settings.byProvider(provider);
    if (!g) {
      await record({ eventId: null, type: '', signatureOk: false, outcome: 'Gateway not set up' });
      throw new DomainError('GATEWAY_NOT_SET_UP', 'This gateway is not set up', HttpStatus.NOT_FOUND);
    }
    if (!raw?.length) throw new DomainError('EMPTY_NOTICE', 'The notice has no body', HttpStatus.BAD_REQUEST);
    let notice;
    try {
      notice = g.webhook(raw, headers, now);
    } catch (e) {
      const msg = e instanceof SignatureError ? e.message : `Unreadable notice: ${(e as Error).message}`;
      await record({ eventId: null, type: '', signatureOk: false, outcome: msg });
      this.logger.warn(`Refused a ${provider} webhook: ${msg}`);
      throw new DomainError('SIGNATURE_INVALID', msg, HttpStatus.BAD_REQUEST);
    }
    const seen = await this.system((tx) => tx.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider, eventId: notice.eventId } } }));
    if (seen) return { received: true, duplicate: true };
    const inv = notice.ref ? await this.system((tx) => tx.subscriptionInvoice.findUnique({ where: { gateway_checkoutRef: { gateway: provider, checkoutRef: notice.ref! } } })) : null;
    let outcome = 'Not about a subscription payment';
    if (notice.ref && !inv) outcome = 'No invoice has this checkout';
    else if (inv && notice.payment?.paid) {
      const r = await this.markPaid(inv.id, { gateway: provider, paymentId: notice.payment.paymentId, amountMinor: notice.payment.amountMinor, currency: notice.payment.currency, source: `webhook ${notice.type}` }, now);
      outcome = r.applied ? `Paid: ${r.invoice.number}` : r.problem ? `Not applied: ${r.problem}` : 'Already paid';
    } else if (inv) outcome = `Checkout ${notice.payment?.state ?? 'updated'}`;
    try {
      await record({ eventId: notice.eventId, type: notice.type, signatureOk: true, outcome, invoiceId: inv?.id ?? null });
    } catch {
      // The same notice arrived twice at once: the other copy recorded it.
      return { received: true, duplicate: true };
    }
    return { received: true, duplicate: false, outcome };
  }

  // ---------------------------------------------------------------------------------- reading

  async invoices(orgId: string) {
    const rows = await this.prisma.subscriptionInvoice.findMany({ where: { orgId }, include: { plan: true }, orderBy: { issuedAt: 'desc' }, take: 100 });
    return rows.map(serializeInvoice);
  }

  async invoice(orgId: string, id: string) {
    const r = await this.prisma.subscriptionInvoice.findFirst({ where: { id, orgId }, include: { plan: true } });
    if (!r) throw new DomainError('NOT_FOUND', 'Invoice not found', HttpStatus.NOT_FOUND);
    return serializeInvoice(r);
  }

  // --------------------------------------------------------------------------- platform side

  async allInvoices(filter: 'all' | 'open' | 'paid' | 'void') {
    const rows = await this.system((tx) =>
      tx.subscriptionInvoice.findMany({ where: filter === 'all' ? {} : { status: filter.toUpperCase() }, include: { plan: true, org: { select: { name: true } } }, orderBy: { issuedAt: 'desc' }, take: 300 }),
    );
    const webhooks = await this.system((tx) => tx.paymentWebhookEvent.findMany({ orderBy: { receivedAt: 'desc' }, take: 20 }));
    return {
      invoices: rows.map((r) => ({ ...serializeInvoice(r), organisation: r.org.name })),
      webhooks: webhooks.map((w) => ({ provider: w.provider, type: w.type, signatureOk: w.signatureOk, outcome: w.outcome, receivedAt: w.receivedAt.toISOString() })),
    };
  }

  /** Payment received outside the gateway (bank transfer, cheque): recorded with its reference. */
  async markPaidManually(actor: AuthUser, invoiceId: string, reference: string) {
    if (reference.trim().length < 3) throw new DomainError('PAYMENT_REFERENCE_REQUIRED', 'Enter the payment reference (bank transfer UTR, cheque number)', HttpStatus.UNPROCESSABLE_ENTITY);
    const inv = await this.system((tx) => tx.subscriptionInvoice.findUnique({ where: { id: invoiceId } }));
    if (!inv) throw new DomainError('NOT_FOUND', 'Invoice not found', HttpStatus.NOT_FOUND);
    if (inv.status !== 'OPEN') throw new DomainError('INVOICE_NOT_OPEN', `This invoice is ${inv.status.toLowerCase()}`, HttpStatus.CONFLICT);
    const r = await this.markPaid(invoiceId, { gateway: 'MANUAL', paymentId: null, amountMinor: null, currency: null, source: 'recorded by platform staff', actorId: actor.id, reference: reference.trim() });
    await this.cancelCheckout(inv);
    return r.invoice;
  }

  async voidInvoice(actor: AuthUser, invoiceId: string, reason: string) {
    if (reason.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'Say why the invoice is voided', HttpStatus.UNPROCESSABLE_ENTITY);
    const inv = await this.system(async (tx) => {
      const i = await tx.subscriptionInvoice.findUnique({ where: { id: invoiceId } });
      if (!i) throw new DomainError('NOT_FOUND', 'Invoice not found', HttpStatus.NOT_FOUND);
      if (i.status !== 'OPEN') throw new DomainError('INVOICE_NOT_OPEN', `A ${i.status.toLowerCase()} invoice cannot be voided`, HttpStatus.CONFLICT);
      const v = await tx.subscriptionInvoice.update({ where: { id: i.id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason.trim() }, include: { plan: true } });
      await this.billing.event(tx, i.orgId, actor.id, 'INVOICE_VOIDED', { invoice: i.reference, reason: reason.trim() });
      await this.audit.append(tx, { orgId: i.orgId, actorId: actor.id, action: 'platform.subscription_invoice_voided', entityType: 'subscription_invoice', entityId: i.id, data: { reference: i.reference, reason: reason.trim() } });
      return v;
    });
    await this.cancelCheckout(inv);
    return serializeInvoice(inv);
  }

  // ------------------------------------------------------------------------------------ renewals

  /** Issues the renewal invoice for a subscription whose period ends soon (used by the runner). */
  async issueRenewal(tx: Tx, orgId: string, now: Date) {
    const s = await tx.subscription.findUniqueOrThrow({ where: { orgId }, include: { plan: true, requestedPlan: true } });
    if (s.status !== 'ACTIVE' || !s.currentPeriodEnd || !s.billingInterval) return null;
    const exists = await tx.subscriptionInvoice.findFirst({ where: { orgId, status: { in: ['OPEN', 'PAID'] }, periodStart: { gte: s.currentPeriodEnd } } });
    if (exists) return exists.status === 'OPEN' ? exists : null;
    if (await tx.subscriptionInvoice.findFirst({ where: { orgId, status: 'OPEN' } })) return null;
    const currency = s.currency as BillingCurrency;
    let plan = s.plan;
    let interval = s.billingInterval as BillingInterval;
    if (s.requestedPlan && s.requestedInterval) {
      // A scheduled change takes effect at the renewal, if the organisation fits the plan.
      const fits = await this.billing.memberFit(tx, orgId, s.requestedPlan).then(() => true, () => false);
      if (fits) {
        plan = s.requestedPlan;
        interval = s.requestedInterval as BillingInterval;
      }
    }
    const price = priceFor(serializePlan(plan), currency, interval);
    const parties = await this.taxFor(tx, orgId, price.toFixed(2), currency);
    return this.issue(tx, orgId, null, { kind: 'RENEWAL', planId: plan.id, interval, listPrice: price.toFixed(2), periodStart: s.currentPeriodEnd, periodEnd: periodEnd(s.currentPeriodEnd, interval), currency, subtotal: price.toFixed(2), parties, dueAt: s.currentPeriodEnd > now ? s.currentPeriodEnd : now });
  }
}
