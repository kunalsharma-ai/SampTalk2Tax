import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { YearEndService } from './year-end.service';

const CloseBody = z.object({ retainedEarningsAccountId: z.string().uuid('Choose the retained earnings account'), memo: z.string().trim().max(400).nullish() }).strict();
const ReopenBody = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) }).strict();
const PreviewQuery = z.object({ retainedEarningsAccountId: z.string().uuid().optional() });

/** Year-end close of revenue and expense accounts to retained earnings (GL-011). */
@ApiTags('periods')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/year-end')
export class YearEndController {
  constructor(private readonly yearEnd: YearEndService) {}

  /** Each fiscal year: its profit, what is left to close, and its status; and every close made. */
  @Get()
  @RequirePermission('periods.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.yearEnd.overview(org);
  }

  /** The closing journal closing the year now would post. */
  @Get(':fiscalYear/preview')
  @RequirePermission('periods.read')
  preview(@CurrentOrg() org: OrgContext, @Param('fiscalYear', ParseIntPipe) fiscalYear: number, @Query(new ZodPipe(PreviewQuery)) q: z.infer<typeof PreviewQuery>) {
    return this.yearEnd.preview(org, fiscalYear, q.retainedEarningsAccountId);
  }

  @Post(':fiscalYear/close')
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(CloseBody) })
  close(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('fiscalYear', ParseIntPipe) fiscalYear: number, @Body(new ZodPipe(CloseBody)) body: z.infer<typeof CloseBody>) {
    return this.yearEnd.close(org, user, fiscalYear, body);
  }

  /** Reverse every close of the year still in force. */
  @Post(':fiscalYear/reopen')
  @HttpCode(200)
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(ReopenBody) })
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('fiscalYear', ParseIntPipe) fiscalYear: number, @Body(new ZodPipe(ReopenBody)) body: z.infer<typeof ReopenBody>) {
    return this.yearEnd.reopen(org, user, fiscalYear, body);
  }
}
