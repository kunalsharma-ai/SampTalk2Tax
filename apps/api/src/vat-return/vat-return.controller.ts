import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { VAT_STAGGERS, VAT_TREATMENTS } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { VatReturnService } from './vat-return.service';

const Settings = z
  .object({
    vrn: z.string().trim().min(9, 'Enter the VAT registration number').max(20),
    registeredFrom: isoDate,
    stagger: z.enum(VAT_STAGGERS),
    untaxedTreatment: z.enum(VAT_TREATMENTS).default('OUTSIDE_SCOPE'),
    treatments: z.array(z.object({ taxRateId: z.string().uuid('Not a valid tax rate'), treatment: z.enum(VAT_TREATMENTS) }).strict()).max(200).default([]),
  })
  .strict();
const PeriodQuery = z.object({ periodEnd: isoDate }).strict();
const Record_ = z
  .object({
    periodEnd: isoDate,
    submittedOn: isoDate,
    reference: z.string().trim().max(100).nullish(),
    /** The net tax as the person saw it (UK box 5, Singapore box 8); refused if the return has changed since. */
    net: z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'An amount with up to 2 decimals').optional(),
  })
  .strict();

@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/vat')
export class VatReturnController {
  constructor(private readonly s: VatReturnService) {}

  /** The VAT or GST registration, return cycle and the treatment of each tax rate. */
  @Get('settings')
  @RequirePermission('reports.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.s.settings(org);
  }

  @Put('settings')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(Settings) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(Settings)) b: z.infer<typeof Settings>) {
    return this.s.saveSettings(org, user, b);
  }

  /** The recent VAT periods on the stagger, each open, due, overdue or submitted. */
  @Get('periods')
  @RequirePermission('reports.read')
  periods(@CurrentOrg() org: OrgContext) {
    return this.s.periods(org);
  }

  /** The nine boxes for a period with the figures behind them, corrections of earlier returns and other entries on the VAT accounts. */
  @Get('return')
  @RequirePermission('reports.read')
  vatReturn(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    return this.s.vatReturn(org, q.periodEnd);
  }

  /** The same return as CSV text; the export is kept in the audit trail. */
  @Get('return/export')
  @RequirePermission('reports.read')
  exportCsv(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    return this.s.exportCsv(org, user, q.periodEnd);
  }

  /** Records that the period's return was submitted to the tax authority; its figures are then kept as submitted. */
  @Post('returns')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(Record_) })
  record(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(Record_)) b: z.infer<typeof Record_>) {
    return this.s.record(org, user, b);
  }
}
