import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { ReverseChargeService } from './reverse-charge.service';

const MonthQuery = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Give the month as YYYY-MM').optional() }).strict();
const IssueBody = z.object({ issuedOn: isoDate.optional() }).strict();

/** Reverse charge (TAX-032): the month's register, possibly missed reverse charge, and self-invoices. */
@ApiTags('gst')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/gst/reverse-charge')
export class ReverseChargeController {
  constructor(private readonly s: ReverseChargeService) {}

  @Get()
  @RequirePermission('reports.read')
  month(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthQuery)) q: z.infer<typeof MonthQuery>) {
    return this.s.month(org, q.period);
  }

  @Get(':documentId/self-invoice')
  @RequirePermission('reports.read')
  selfInvoice(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) id: string) {
    return this.s.selfInvoice(org, id);
  }

  /** Issue the self-invoice for a reverse-charge bill from a supplier who is not registered. */
  @Post(':documentId/self-invoice')
  @HttpCode(201)
  @RequirePermission('accounts.manage')
  @ApiBody(openApi(IssueBody))
  issue(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(IssueBody)) body: z.infer<typeof IssueBody>) {
    return this.s.issue(org, user, id, body.issuedOn);
  }
}
