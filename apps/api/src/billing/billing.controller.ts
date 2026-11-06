import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, AuthUser, CurrentUser, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { BillingService } from './billing.service';

const RequestBody = z.object({ plan: z.string().regex(/^[A-Z][A-Z0-9_]{1,23}$/), interval: z.enum(['MONTHLY', 'ANNUAL']) }).strict();

/** The organisation's Talk2Tax subscription. Works while the books are read-only, so a plan can always be chosen. */
@ApiTags('subscription')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/subscription')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @RequirePermission('org.read')
  get(@Param('orgId') orgId: string) {
    return this.billing.forOrg(orgId);
  }

  @Post('request')
  @RequirePermission('org.manage')
  @AllowWhenReadOnly()
  @ApiBody({ schema: openApi(RequestBody) })
  request(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RequestBody)) body: z.infer<typeof RequestBody>) {
    return this.billing.request(orgId, user.id, body.plan, body.interval);
  }

  @Delete('request')
  @RequirePermission('org.manage')
  @AllowWhenReadOnly()
  withdraw(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser) {
    return this.billing.withdrawRequest(orgId, user.id);
  }
}
