import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { PlatformPaymentGateway } from '@talk2tax/database';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/decorators';
import { DomainError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AppConfig, CONFIG } from '../../config';
import { SecretBox, secretHint } from '../../integrations/secret-box';
import { GatewayCreds, GatewayError, PaymentGateway, Provider, RazorpayGateway, StripeGateway } from './gateways';

export interface GatewayInput {
  enabled: boolean;
  mode: 'TEST' | 'LIVE';
  currencies: ('INR' | 'USD')[];
  keyId?: string | null;
  secret?: string | null;
  webhookSecret?: string | null;
}

export interface ProfileInput {
  legalName: string;
  address: string;
  countryCode: string;
  gstin: string | null;
  stateCode: string | null;
  email: string | null;
  gstRate: string;
  sacCode: string;
  invoicePrefix: string;
}

const PROVIDER_NAME: Record<Provider, string> = { STRIPE: 'Stripe', RAZORPAY: 'Razorpay' };
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * The platform's payment gateways and seller details, set up by a super admin in Platform
 * administration → Payments. Keys are sealed (AES-256-GCM) before they are stored and never
 * returned; only their last four characters are shown.
 */
@Injectable()
export class PaymentSettingsService {
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox({ encryptionKey: config.INTEGRATIONS_ENCRYPTION_KEY, jwtSecret: config.JWT_SECRET });
  }

  webhookUrl(p: Provider) {
    return `${this.config.APP_URL.replace(/\/$/, '')}/api/webhooks/payments/${p.toLowerCase()}`;
  }

  private open(cipher: string | null, keyId: string | null) {
    return cipher && keyId ? this.box.open(cipher, keyId) : null;
  }

  private creds(r: PlatformPaymentGateway): GatewayCreds | null {
    const secret = this.open(r.secretCipher, r.secretKeyId);
    if (!secret) return null;
    return { keyId: r.keyId, secret, webhookSecret: this.open(r.webhookCipher, r.webhookKeyId) };
  }

  private client(provider: Provider, creds: GatewayCreds): PaymentGateway {
    const ms = this.config.PAYMENTS_TIMEOUT_SECONDS * 1000;
    return provider === 'STRIPE' ? new StripeGateway(creds, this.config.PAYMENTS_STRIPE_API_URL, ms) : new RazorpayGateway(creds, this.config.PAYMENTS_RAZORPAY_API_URL, ms);
  }

  private card(provider: Provider, r: PlatformPaymentGateway | undefined) {
    const unreadable = !!r && ((!!r.secretCipher && this.open(r.secretCipher, r.secretKeyId) === null) || (!!r.webhookCipher && this.open(r.webhookCipher, r.webhookKeyId) === null));
    return {
      provider,
      name: PROVIDER_NAME[provider],
      configured: !!r?.secretCipher,
      enabled: !!r?.enabled,
      mode: (r?.mode ?? 'TEST') as 'TEST' | 'LIVE',
      currencies: r?.currencies ?? [],
      keyId: r?.keyId ?? null,
      secretHint: r?.secretHint ?? null,
      webhookHint: r?.webhookHint ?? null,
      needsReentry: unreadable,
      lastTest: r?.lastTestAt ? { at: r.lastTestAt.toISOString(), ok: !!r.lastTestOk, message: r.lastTestMessage ?? '' } : null,
      webhookUrl: this.webhookUrl(provider),
      webhookEvents: provider === 'STRIPE' ? ['checkout.session.completed', 'checkout.session.async_payment_succeeded'] : ['payment_link.paid'],
      updatedAt: r?.updatedAt.toISOString() ?? null,
    };
  }

  async gateways() {
    const rows = await this.prisma.platformPaymentGateway.findMany();
    return { gateways: (['RAZORPAY', 'STRIPE'] as Provider[]).map((p) => this.card(p, rows.find((r) => r.provider === p))), profile: await this.profile() };
  }

  async saveGateway(actor: AuthUser, provider: Provider, input: GatewayInput) {
    const before = await this.prisma.platformPaymentGateway.findUnique({ where: { provider } });
    const problems: string[] = [];
    const secret = input.secret?.trim() || null;
    const webhookSecret = input.webhookSecret?.trim() || null;
    const keyId = provider === 'RAZORPAY' ? (input.keyId?.trim() || before?.keyId || null) : null;
    const live = input.mode === 'LIVE';
    if (provider === 'STRIPE' && secret && !new RegExp(`^(sk|rk)_${live ? 'live' : 'test'}_[A-Za-z0-9]{8,}$`).test(secret)) problems.push(`A Stripe ${live ? 'live' : 'test'} secret key starts with sk_${live ? 'live' : 'test'}_ (or rk_${live ? 'live' : 'test'}_ for a restricted key)`);
    if (provider === 'STRIPE' && webhookSecret && !/^whsec_[A-Za-z0-9]{8,}$/.test(webhookSecret)) problems.push('A Stripe signing secret starts with whsec_');
    if (provider === 'RAZORPAY' && keyId && !new RegExp(`^rzp_${live ? 'live' : 'test'}_[A-Za-z0-9]{6,}$`).test(keyId)) problems.push(`A Razorpay ${live ? 'live' : 'test'} key id starts with rzp_${live ? 'live' : 'test'}_`);
    if (provider === 'RAZORPAY' && webhookSecret && webhookSecret.length < 8) problems.push('The Razorpay webhook secret is at least 8 characters');
    if (provider === 'RAZORPAY' && !keyId) problems.push('Enter the Razorpay key id');
    if (!secret && !before?.secretCipher) problems.push(`Enter the ${provider === 'STRIPE' ? 'secret key' : 'key secret'}`);
    if (input.enabled && !webhookSecret && !before?.webhookCipher) problems.push(`Enter the ${provider === 'STRIPE' ? 'webhook signing secret' : 'webhook secret'}: payments are confirmed by the gateway's signed notices`);
    if (input.enabled && !input.currencies.length) problems.push('Choose at least one currency this gateway takes');
    if (before && before.mode !== input.mode && !secret) problems.push('Enter the key again when switching between test and live mode');
    if (problems.length) throw new DomainError('GATEWAY_INVALID', problems[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues: problems });
    if (input.enabled) {
      const others = await this.prisma.platformPaymentGateway.findMany({ where: { enabled: true, provider: { not: provider } } });
      const clash = others.find((o) => o.currencies.some((c) => input.currencies.includes(c as 'INR' | 'USD')));
      if (clash) throw new DomainError('GATEWAY_CURRENCY_TAKEN', `${PROVIDER_NAME[clash.provider as Provider]} already takes ${clash.currencies.filter((c) => input.currencies.includes(c as 'INR' | 'USD')).join(' and ')} payments. Each currency is paid through one gateway.`, HttpStatus.CONFLICT);
    }
    const sealed = secret ? this.box.seal(secret) : null;
    const wh = webhookSecret ? this.box.seal(webhookSecret) : null;
    const data = {
      enabled: input.enabled,
      mode: input.mode,
      currencies: [...new Set(input.currencies)].sort(),
      keyId,
      ...(sealed ? { secretCipher: sealed.cipher, secretKeyId: sealed.keyId, secretHint: secretHint(secret!) } : {}),
      ...(wh ? { webhookCipher: wh.cipher, webhookKeyId: wh.keyId, webhookHint: secretHint(webhookSecret!) } : {}),
      ...(sealed || keyId !== before?.keyId ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
      updatedBy: actor.id,
    };
    await this.prisma.$transaction(async (tx) => {
      // Not an upsert: Postgres checks the row to be inserted (without the stored keys) before it sees the conflict.
      if (before) await tx.platformPaymentGateway.update({ where: { provider }, data });
      else await tx.platformPaymentGateway.create({ data: { provider, ...data } });
      await this.audit.append(tx, {
        orgId: null,
        actorId: actor.id,
        action: 'platform.payment_gateway_saved',
        entityType: 'payment_gateway',
        entityId: provider,
        data: { provider, enabled: data.enabled, mode: data.mode, currencies: data.currencies, keyId, secretChanged: !!sealed, webhookSecretChanged: !!wh },
      });
    });
    return this.gateways();
  }

  async removeGateway(actor: AuthUser, provider: Provider) {
    const before = await this.prisma.platformPaymentGateway.findUnique({ where: { provider } });
    if (!before) throw new DomainError('NOT_FOUND', `${PROVIDER_NAME[provider]} is not set up`, HttpStatus.NOT_FOUND);
    await this.prisma.$transaction(async (tx) => {
      await tx.platformPaymentGateway.delete({ where: { provider } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.payment_gateway_removed', entityType: 'payment_gateway', entityId: provider, data: { provider } });
    });
    return this.gateways();
  }

  /** Calls the gateway with the stored key and records the answer. */
  async testGateway(actor: AuthUser, provider: Provider) {
    const r = await this.prisma.platformPaymentGateway.findUnique({ where: { provider } });
    if (!r?.secretCipher) throw new DomainError('NOT_FOUND', `${PROVIDER_NAME[provider]} is not set up`, HttpStatus.NOT_FOUND);
    const creds = this.creds(r);
    let ok = false;
    let message: string;
    if (!creds) message = 'The stored key cannot be read (the server’s encryption key changed). Enter it again.';
    else {
      try {
        message = await this.client(provider, creds).test();
        ok = true;
      } catch (e) {
        message = e instanceof GatewayError ? `${PROVIDER_NAME[provider]} refused: ${e.message}` : `Could not check: ${(e as Error).message}`;
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.platformPaymentGateway.update({ where: { provider }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.payment_gateway_tested', entityType: 'payment_gateway', entityId: provider, data: { provider, ok, message: message.slice(0, 500) } });
    });
    return { ok, message };
  }

  /** The enabled gateway that takes this currency, ready to call; null when none is set up. */
  async forCurrency(currency: string): Promise<PaymentGateway | null> {
    const r = await this.prisma.platformPaymentGateway.findFirst({ where: { enabled: true, currencies: { has: currency } } });
    const creds = r ? this.creds(r) : null;
    return r && creds ? this.client(r.provider as Provider, creds) : null;
  }

  /** A gateway by name, enabled or not (to check a checkout made before it was turned off). */
  async byProvider(provider: Provider): Promise<PaymentGateway | null> {
    const r = await this.prisma.platformPaymentGateway.findUnique({ where: { provider } });
    const creds = r ? this.creds(r) : null;
    return r && creds ? this.client(provider, creds) : null;
  }

  // ------------------------------------------------------------------------------ seller details

  async profile() {
    const p = await this.prisma.platformBillingProfile.findUnique({ where: { id: 1 } });
    return p
      ? { legalName: p.legalName, address: p.address, countryCode: p.countryCode, gstin: p.gstin, stateCode: p.stateCode, email: p.email, gstRate: p.gstRate.toFixed(2).replace(/\.00$/, ''), sacCode: p.sacCode, invoicePrefix: p.invoicePrefix, updatedAt: p.updatedAt.toISOString() }
      : null;
  }

  async saveProfile(actor: AuthUser, input: ProfileInput) {
    const gstin = input.gstin?.trim().toUpperCase() || null;
    const country = input.countryCode.trim().toUpperCase();
    const problems: string[] = [];
    if (!input.legalName.trim()) problems.push('Enter the legal name printed on invoices');
    if (!/^[A-Z]{2}$/.test(country)) problems.push('The country is a two-letter code such as IN');
    if (gstin && country !== 'IN') problems.push('A GSTIN is only for a supplier in India');
    if (gstin && !GSTIN.test(gstin)) problems.push('The GSTIN is 15 characters, such as 27AAPFU0939F1ZV');
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(input.gstRate) || Number(input.gstRate) > 28) problems.push('The GST rate is from 0 to 28');
    if (!/^\d{4,8}$/.test(input.sacCode)) problems.push('The SAC code is 4 to 8 digits');
    if (!/^[A-Z0-9]{1,4}$/.test(input.invoicePrefix)) problems.push('The invoice prefix is 1-4 capital letters or digits');
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) problems.push('The billing email is not an email address');
    if (problems.length) throw new DomainError('PROFILE_INVALID', problems[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues: problems });
    const data = {
      legalName: input.legalName.trim(),
      address: input.address.trim(),
      countryCode: country,
      gstin,
      stateCode: gstin ? gstin.slice(0, 2) : null,
      email: input.email?.trim() || null,
      gstRate: input.gstRate,
      sacCode: input.sacCode,
      invoicePrefix: input.invoicePrefix,
      updatedBy: actor.id,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.platformBillingProfile.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.billing_profile_saved', entityType: 'billing_profile', entityId: '1', data: { ...data, updatedBy: undefined } });
    });
    return this.gateways();
  }
}
