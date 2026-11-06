import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { CustomerInsightsService } from './customer-insights.service';

const HoldBody = z.object({ hold: z.boolean(), reason: z.string().trim().max(500, 'Keep the reason under 500 characters').nullish() }).strict();

/** Customer 360: profitability, lifetime value, payment behaviour and credit risk. */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/customers')
export class CustomerInsightsController {
  constructor(private readonly insights: CustomerInsightsService) {}

  /** Every customer with history, ranked by lifetime value. */
  @Get('insights')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.insights.list(org);
  }

  @Get(':contactId/insights')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) id: string) {
    return this.insights.get(org, id);
  }

  /** Put a customer on credit hold (no invoice to them posts) or lift it. */
  @Put(':contactId/credit-hold')
  @RequirePermission('contacts.manage')
  @ApiBody({ schema: openApi(HoldBody) })
  hold(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) id: string, @Body(new ZodPipe(HoldBody)) b: z.infer<typeof HoldBody>) {
    return this.insights.setCreditHold(org, user, id, b);
  }
}
