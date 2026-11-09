import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission } from '../auth/decorators';
import { Provider } from '../billing/payments/gateways';
import { DomainError } from '../common/errors';
import { decimalString, openApi, ZodPipe } from '../common/zod';
import { PaymentLinksService } from './payment-links.service';

const id = z.string().uuid('Not a valid id');
const provider = (p: string): Provider => {
  const v = p.toUpperCase();
  if (v !== 'STRIPE' && v !== 'RAZORPAY') throw new DomainError('NOT_FOUND', 'Unknown gateway', 404);
  return v;
};
const GatewayBody = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['TEST', 'LIVE']),
    currencies: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)).max(5),
    keyId: z.string().trim().max(100).nullish(),
    secret: z.string().max(300).nullish(),
    webhookSecret: z.string().max(300).nullish(),
    depositAccountId: id.nullish(),
  })
  .strict();
const CreateBody = z.object({ amount: decimalString.nullish() }).strict();
const ListQuery = z.object({ status: z.enum(['OPEN', 'PAID', 'CANCELLED', 'EXPIRED']).optional(), documentId: id.optional() });

@ApiTags('payment links')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class PaymentLinksController {
  constructor(private readonly links: PaymentLinksService) {}

  /** The organisation's own payment gateways for payment links (keys are never returned). */
  @Get('settings/payment-gateways')
  @RequirePermission('org.manage')
  gateways(@CurrentOrg() org: OrgContext) {
    return this.links.gateways(org);
  }

  @Put('settings/payment-gateways/:provider')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(GatewayBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('provider') p: string, @Body(new ZodPipe(GatewayBody)) b: z.infer<typeof GatewayBody>) {
    return this.links.saveGateway(org, user, provider(p), b);
  }

  @Delete('settings/payment-gateways/:provider')
  @RequirePermission('org.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('provider') p: string) {
    return this.links.removeGateway(org, user, provider(p));
  }

  @Post('settings/payment-gateways/:provider/test')
  @HttpCode(200)
  @RequirePermission('org.manage')
  test(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('provider') p: string) {
    return this.links.testGateway(org, user, provider(p));
  }

  /** Payment links, newest first; for one invoice with ?documentId=. */
  @Get('sales/payment-links')
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return q.documentId ? this.links.forInvoice(org, q.documentId) : this.links.list(org, q);
  }

  /** A link for what is owed on a posted invoice (or the amount given). */
  @Post('sales/documents/:documentId/payment-links')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', new ZodPipe(id)) documentId: string, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.links.create(org, user, documentId, b);
  }

  /** Ask the gateway how the link stands; settles it if paid. */
  @Post('sales/payment-links/:id/check')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  check(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) lid: string) {
    return this.links.refresh(org, user, lid);
  }

  @Post('sales/payment-links/:id/cancel')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) lid: string) {
    return this.links.cancel(org, user, lid);
  }
}

/** Signed notices from organisations' gateways (no sign-in; the signature is the check). */
@ApiTags('payment links')
@Controller('v1/payment-links/webhooks')
export class PaymentLinkWebhooksController {
  constructor(private readonly links: PaymentLinksService) {}

  @Public()
  @Post(':orgId/:provider')
  @HttpCode(200)
  receive(@Param('orgId', new ZodPipe(id)) orgId: string, @Param('provider') p: string, @Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.links.webhook(orgId, provider(p), req.rawBody, headers);
  }
}
