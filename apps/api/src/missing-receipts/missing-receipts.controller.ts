import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { MissingReceiptsService } from './missing-receipts.service';

const ReportQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }).strict();
const AskBody = z.object({ note: z.string().trim().max(500).nullish() }).strict();

/** Missing receipt detection on expense claims (EXP-021). */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class MissingReceiptsController {
  constructor(private readonly missing: MissingReceiptsService) {}

  @Get('expense-claims-missing-receipts')
  @RequirePermission('expenses.read')
  report(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>) {
    return this.missing.report(org, q.days);
  }

  @Post('expense-claims/:claimId/receipt-requests')
  @RequirePermission('expenses.reimburse')
  @HttpCode(201)
  @ApiBody({ schema: openApi(AskBody) })
  ask(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string, @Body(new ZodPipe(AskBody)) b: z.infer<typeof AskBody>) {
    return this.missing.ask(org, user, id, b.note ?? null);
  }

  @Get('expense-claims/:claimId/receipt-requests')
  @RequirePermission('expenses.submit')
  requests(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string) {
    return this.missing.requests(org, user, id);
  }
}
