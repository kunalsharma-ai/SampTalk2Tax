import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { FORM_1099_KINDS, W9_CLASSIFICATIONS } from '@talk2tax/tax-engine';
import { UsReportingService } from './us-reporting.service';

const Year = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() }).strict();
const Profile = z
  .object({
    classification: z.enum(W9_CLASSIFICATIONS),
    tinType: z.enum(['SSN', 'EIN']),
    tinLast4: z
      .string()
      .regex(/^[0-9]{4}$/, 'Enter only the last four digits')
      .nullable()
      .optional(),
    w9ReceivedOn: isoDate.nullable().optional(),
    formKind: z.enum(FORM_1099_KINDS),
    isAttorney: z.boolean().optional(),
  })
  .strict();

/** US federal (1099) and state (sales tax return) reporting (TAX-029). */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/us-reporting')
export class UsReportingController {
  constructor(private readonly s: UsReportingService) {}

  /** The 1099s due for a calendar year's vendor payments and the state sales tax returns for the year (this year by default). */
  @Get()
  @RequirePermission('reports.read')
  overview(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Year)) q: z.infer<typeof Year>) {
    return this.s.overview(org, q);
  }

  /** The 1099 rows as CSV text; the export is kept in the audit trail. */
  @Get('1099/export')
  @RequirePermission('reports.read')
  exportCsv(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(Year)) q: z.infer<typeof Year>) {
    return this.s.exportCsv(org, user, q);
  }

  /** Records what a vendor's W-9 says. Only the last four digits of the taxpayer number are accepted. */
  @Put('vendors/:contactId')
  @RequirePermission('accounts.manage')
  saveProfile(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) contactId: string, @Body(new ZodPipe(Profile)) body: z.infer<typeof Profile>) {
    return this.s.saveProfile(org, user, contactId, body);
  }

  @Delete('vendors/:contactId')
  @RequirePermission('accounts.manage')
  removeProfile(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) contactId: string) {
    return this.s.removeProfile(org, user, contactId);
  }
}
