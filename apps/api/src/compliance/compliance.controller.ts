import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { ComplianceService } from './compliance.service';

const SettingsBody = z.object({ gstReturnFrequency: z.enum(['MONTHLY', 'QUARTERLY']), advanceTaxFrom: isoDate.nullable() }).strict();
const CalendarQuery = z.object({ from: isoDate, to: isoDate });
const FilingBody = z
  .object({
    key: z.string().regex(/^[A-Z0-9_]+:[A-Za-z0-9 -]+$/, 'An obligation key such as GSTR3B:2026-10').max(60),
    filedOn: isoDate,
    reference: z.string().trim().min(1).max(100),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
const VoidBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

@ApiTags('compliance')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/compliance')
export class ComplianceController {
  constructor(private readonly c: ComplianceService) {}

  @Get('settings')
  @RequirePermission('reports.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.c.getSettings(org.id);
  }

  /** GST return frequency (monthly or QRMP) and whether advance tax instalments are tracked, from when. */
  @Put('settings')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.c.saveSettings(org.id, user, body);
  }

  /** Returns and payments due between `from` and `to`, with their status from the books and filing records, plus anything still overdue from before. */
  @Get('calendar')
  @RequirePermission('reports.read')
  calendar(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(CalendarQuery)) q: z.infer<typeof CalendarQuery>) {
    return this.c.calendar(org.id, q.from, q.to);
  }

  @Get('filings')
  @RequirePermission('reports.read')
  filings(@CurrentOrg() org: OrgContext) {
    return this.c.listFilings(org.id);
  }

  /** Mark a return filed with its acknowledgement (ARN, token or challan). Payments are settled by records instead. */
  @Post('filings')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(FilingBody) })
  file(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(FilingBody)) body: z.infer<typeof FilingBody>) {
    return this.c.markFiled(org.id, user, body);
  }

  @Post('filings/:id/void')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(VoidBody) })
  voidFiling(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>) {
    return this.c.voidFiling(org.id, user, id, body);
  }
}
