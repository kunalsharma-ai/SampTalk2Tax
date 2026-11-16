import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, AuthUser, CurrentUser, Public, RequirePermission, RequirePlatform } from '../../auth/decorators';
import { DomainError } from '../../common/errors';
import { openApi, ZodPipe } from '../../common/zod';
import { AppConfig, CONFIG } from '../../config';
import { Provider } from './gateways';
import { PaymentSettingsService } from './payment-settings.service';
import { RenewalsRunnerService } from './renewals-runner.service';
import { SubscriptionPaymentsService } from './subscription-payments.service';

const PlanChoice = z.object({ plan: z.string().regex(/^[A-Z][A-Z0-9_]{1,23}$/), interval: z.enum(['MONTHLY', 'ANNUAL']) }).strict();
const GatewayBody = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['TEST', 'LIVE']),
    currencies: z.array(z.enum(['INR', 'USD'])).max(2),
    keyId: z.string().max(100).nullish(),
    secret: z.string().max(300).nullish(),
    webhookSecret: z.string().max(300).nullish(),
  })
  .strict();
const ProfileBody = z
  .object({
    legalName: z.string().max(200),
    address: z.string().max(500).default(''),
    countryCode: z.string().max(2),
    gstin: z.string().max(15).nullish().transform((v) => v ?? null),
    stateCode: z.string().max(2).nullish().transform((v) => v ?? null),
    email: z.string().max(200).nullish().transform((v) => v ?? null),
    gstRate: z.string().max(6).default('18'),
    sacCode: z.string().max(8).default('998314'),
    invoicePrefix: z.string().max(4).default('T2T'),
  })
  .strict();
const Reference = z.object({ reference: z.string().max(200) }).strict();
const Reason = z.object({ reason: z.string().max(300) }).strict();
const InvoiceFilter = z.object({ filter: z.enum(['all', 'open', 'paid', 'void']).default('all') });

const provider = (p: string): Provider => {
  const up = p.toUpperCase();
  if (up !== 'STRIPE' && up !== 'RAZORPAY') throw new DomainError('NOT_FOUND', 'Unknown payment gateway', 404);
  return up;
};

/** Paying for the organisation's subscription. Works while the books are read-only. */
@ApiTags('subscription')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/subscription')
export class SubscriptionPaymentsController {
  constructor(
    private readonly payments: SubscriptionPaymentsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private returnTo(orgId: string) {
    return `${this.config.APP_URL.replace(/\/$/, '')}/orgs/${orgId}/settings/subscription`;
  }

  @Get('quote')
  @RequirePermission('org.read')
  @AllowWhenReadOnly()
  quote(@Param('orgId') orgId: string, @Query(new ZodPipe(PlanChoice)) q: z.infer<typeof PlanChoice>) {
    return this.payments.quote(orgId, q.plan, q.interval);
  }

  @Post('checkout')
  @RequirePermission('org.manage')
  @AllowWhenReadOnly()
  @ApiBody({ schema: openApi(PlanChoice) })
  checkout(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PlanChoice)) b: z.infer<typeof PlanChoice>) {
    return this.payments.checkout(orgId, user, b.plan, b.interval, this.returnTo(orgId));
  }

  @Get('invoices')
  @RequirePermission('org.read')
  invoices(@Param('orgId') orgId: string) {
    return this.payments.invoices(orgId);
  }

  @Get('invoices/:id')
  @RequirePermission('org.read')
  invoice(@Param('orgId') orgId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.invoice(orgId, id);
  }

  @Post('invoices/:id/pay')
  @RequirePermission('org.manage')
  @AllowWhenReadOnly()
  pay(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.pay(orgId, user, id, this.returnTo(orgId));
  }

  /** Asks the gateway whether the payment went through (also done when the customer comes back). */
  @Post('invoices/:id/check')
  @RequirePermission('org.read')
  @AllowWhenReadOnly()
  @HttpCode(200)
  check(@Param('orgId') orgId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.check(orgId, id);
  }
}

/** Payment gateways, seller details and subscription invoices in Platform administration. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin')
export class PlatformPaymentsController {
  constructor(
    private readonly settings: PaymentSettingsService,
    private readonly payments: SubscriptionPaymentsService,
    private readonly renewals: RenewalsRunnerService,
  ) {}

  @Get('payments')
  @RequirePlatform('platform.read')
  get() {
    return this.settings.gateways();
  }

  @Put('payments/gateways/:provider')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(GatewayBody) })
  save(@CurrentUser() user: AuthUser, @Param('provider') p: string, @Body(new ZodPipe(GatewayBody)) b: z.infer<typeof GatewayBody>) {
    return this.settings.saveGateway(user, provider(p), b);
  }

  @Post('payments/gateways/:provider/test')
  @RequirePlatform('platform.manage')
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser, @Param('provider') p: string) {
    return this.settings.testGateway(user, provider(p));
  }

  @Delete('payments/gateways/:provider')
  @RequirePlatform('platform.manage')
  remove(@CurrentUser() user: AuthUser, @Param('provider') p: string) {
    return this.settings.removeGateway(user, provider(p));
  }

  @Put('payments/profile')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(ProfileBody) })
  profile(@CurrentUser() user: AuthUser, @Body(new ZodPipe(ProfileBody)) b: z.infer<typeof ProfileBody>) {
    return this.settings.saveProfile(user, b);
  }

  @Get('invoices')
  @RequirePlatform('platform.read')
  invoices(@Query(new ZodPipe(InvoiceFilter)) q: z.infer<typeof InvoiceFilter>) {
    return this.payments.allInvoices(q.filter);
  }

  @Post('invoices/:id/mark-paid')
  @RequirePlatform('platform.manage')
  @HttpCode(200)
  @ApiBody({ schema: openApi(Reference) })
  markPaid(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(Reference)) b: z.infer<typeof Reference>) {
    return this.payments.markPaidManually(user, id, b.reference);
  }

  @Post('invoices/:id/void')
  @RequirePlatform('platform.manage')
  @HttpCode(200)
  @ApiBody({ schema: openApi(Reason) })
  void(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(Reason)) b: z.infer<typeof Reason>) {
    return this.payments.voidInvoice(user, id, b.reason);
  }

  @Post('invoices/:id/check')
  @RequirePlatform('platform.manage')
  @HttpCode(200)
  check(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.check(null, id);
  }

  /** Issues due renewals and reminders now, instead of waiting for the next background pass. */
  @Post('billing/run-renewals')
  @RequirePlatform('platform.manage')
  @HttpCode(200)
  run() {
    return this.renewals.tick();
  }
}

/** Signed notices from the payment gateways (no sign-in; the signature is the check). */
@ApiTags('billing')
@Controller('v1/billing/webhooks')
export class PaymentWebhooksController {
  constructor(private readonly payments: SubscriptionPaymentsService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') p: string, @Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.payments.webhook(provider(p), req.rawBody, headers);
  }
}
