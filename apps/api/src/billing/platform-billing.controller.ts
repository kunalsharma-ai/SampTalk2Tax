import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { PLAN_FEATURES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePlatform } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { PlatformBillingService } from './platform-billing.service';

const Price = z.object({ monthly: z.string(), annual: z.string() }).strict();
const Limit = z.number().int().nullable();
const PlanBody = z
  .object({
    name: z.string().max(60),
    description: z.string().max(300).default(''),
    prices: z.object({ INR: Price, USD: Price }).strict(),
    limits: z.object({ members: Limit, aiCreditsPerMonth: Limit, documentUploadsPerMonth: Limit }).strict(),
    features: z.array(z.enum(PLAN_FEATURES)).max(10),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();
const Activate = z.object({ plan: z.string().regex(/^[A-Z][A-Z0-9_]{1,23}$/).optional(), interval: z.enum(['MONTHLY', 'ANNUAL']).optional(), paymentReference: z.string().max(200) }).strict();
const Extend = z.object({ days: z.number().int().min(1).max(90) }).strict();
const Reason = z.object({ reason: z.string().max(500) }).strict();
const Filter = z.object({ filter: z.enum(['all', 'requested', 'trial', 'active', 'read_only']).default('all') });

/** Plans and subscriptions in Platform administration. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin')
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get('plans')
  @RequirePlatform('platform.read')
  plans() {
    return this.billing.plans();
  }

  @Put('plans/:code')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(PlanBody) })
  savePlan(@CurrentUser() user: AuthUser, @Param('code') code: string, @Body(new ZodPipe(PlanBody)) body: z.infer<typeof PlanBody>) {
    return this.billing.savePlan(user, { ...body, code });
  }

  @Get('subscriptions')
  @RequirePlatform('platform.read')
  subscriptions(@Query(new ZodPipe(Filter)) q: z.infer<typeof Filter>) {
    return this.billing.subscriptions(q.filter);
  }

  @Post('subscriptions/:orgId/activate')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Activate) })
  activate(@CurrentUser() user: AuthUser, @Param('orgId', new ParseUUIDPipe()) orgId: string, @Body(new ZodPipe(Activate)) body: z.infer<typeof Activate>) {
    return this.billing.activate(user, orgId, body);
  }

  @Post('subscriptions/:orgId/extend-trial')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Extend) })
  extend(@CurrentUser() user: AuthUser, @Param('orgId', new ParseUUIDPipe()) orgId: string, @Body(new ZodPipe(Extend)) body: z.infer<typeof Extend>) {
    return this.billing.extendTrial(user, orgId, body.days);
  }

  @Post('subscriptions/:orgId/cancel')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Reason) })
  cancel(@CurrentUser() user: AuthUser, @Param('orgId', new ParseUUIDPipe()) orgId: string, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.billing.cancel(user, orgId, body.reason);
  }

  @Post('subscriptions/:orgId/complimentary')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Reason) })
  complimentary(@CurrentUser() user: AuthUser, @Param('orgId', new ParseUUIDPipe()) orgId: string, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.billing.complimentary(user, orgId, body.reason);
  }
}
