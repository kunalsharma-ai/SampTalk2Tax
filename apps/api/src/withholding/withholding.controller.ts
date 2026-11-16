import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { WithholdingService } from './withholding.service';

const pct = z.string().regex(/^\d{1,3}(\.\d{1,6})?$/, 'Percentage as a decimal string, e.g. "10" or "0.1"');
const kind = z.enum(['TDS', 'TCS']);
const SettingsBody = z
  .object({
    tan: z.string().trim().min(1).max(10),
    accounts: z.object({ tdsPayableAccountId: z.uuid(), tcsPayableAccountId: z.uuid() }).optional(),
  })
  .strict();
const SectionBody = z.union([
  z.object({ template: z.string().max(40) }).strict(),
  z
    .object({
      kind,
      code: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(200),
      rate: pct,
      rateIndividualHuf: pct.nullable().optional(),
      rateNoPan: pct,
      singleThreshold: decimalString.nullable().optional(),
      aggregateThreshold: decimalString.nullable().optional(),
      thresholdWindow: z.enum(['TAX_YEAR', 'MONTH']),
      thresholdBasis: z.enum(['WHOLE', 'EXCESS']),
      validFrom: isoDate,
      source: z.string().max(300).nullable().optional(),
    })
    .strict(),
]);
const SectionUpdate = z.object({ name: z.string().trim().min(1).max(200).optional(), isActive: z.boolean().optional() }).strict();
const PreviewBody = z.object({ documentKind: z.enum(['BILL', 'INVOICE']), contactId: z.uuid(), sectionId: z.uuid(), issueDate: isoDate, amount: decimalString, documentId: z.uuid().optional() }).strict();
const RegisterQuery = z.object({ kind, from: isoDate, to: isoDate });
const DepositBody = z
  .object({
    kind,
    depositDate: isoDate,
    bankAccountId: z.uuid(),
    challanReference: z.string().trim().min(1).max(100),
    documentIds: z.array(z.uuid()).min(1).max(500),
    interestAmount: decimalString.optional(),
    interestAccountId: z.uuid().nullable().optional(),
    memo: z.string().max(1000).nullable().optional(),
  })
  .strict();
const VoidBody = z.object({ date: isoDate.optional(), reason: z.string().trim().min(3).max(500) }).strict();

@ApiTags('withholding')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/withholding')
export class WithholdingController {
  constructor(private readonly w: WithholdingService) {}

  @Get('settings')
  @RequirePermission('accounts.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.w.getSettings(org.id);
  }

  /** TAN and the TDS/TCS payable accounts. Without `accounts`, accounts 2320 TDS payable and 2321 TCS payable are created (or reused). */
  @Put('settings')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.w.saveSettings(org.id, user, body);
  }

  /** TDS provisions from the Income-tax Act 2025 s.393(1) table, as starting points for sections. */
  @Get('templates')
  @RequirePermission('accounts.read')
  templates() {
    return this.w.templates();
  }

  @Get('sections')
  @RequirePermission('contacts.read')
  sections(@CurrentOrg() org: OrgContext, @Query('includeInactive') includeInactive?: string) {
    return this.w.listSections(org.id, includeInactive === 'true');
  }

  /** Create a section from a template (`{ template: code }`) or from its own rule. Rates and thresholds cannot change afterwards. */
  @Post('sections')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(SectionBody) })
  createSection(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SectionBody)) body: z.infer<typeof SectionBody>) {
    return this.w.createSection(org.id, user, body);
  }

  @Patch('sections/:sectionId')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(SectionUpdate) })
  updateSection(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('sectionId', ParseUUIDPipe) id: string, @Body(new ZodPipe(SectionUpdate)) body: z.infer<typeof SectionUpdate>) {
    return this.w.updateSection(org.id, user, id, body);
  }

  /** The tax a document would carry now, given the contact's posted documents. The document form shows this before saving. */
  @Post('preview')
  @RequirePermission('contacts.read')
  @ApiBody({ schema: openApi(PreviewBody) })
  preview(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(PreviewBody)) body: z.infer<typeof PreviewBody>) {
    return this.w.preview(org.id, body);
  }

  @Get('register')
  @RequirePermission('reports.read')
  register(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(RegisterQuery)) q: z.infer<typeof RegisterQuery>) {
    if (q.from > q.to) throw new BadRequestException({ error: 'INVALID_RANGE', message: '"from" must be on or before "to"' });
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 366) throw new BadRequestException({ error: 'INVALID_RANGE', message: 'A register period can be at most a year' });
    return this.w.register(org, q.kind, q.from, q.to);
  }

  @Get('deposits')
  @RequirePermission('reports.read')
  deposits(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(z.object({ kind }))) q: { kind: 'TDS' | 'TCS' }) {
    return this.w.listDeposits(org, q.kind);
  }

  /** Record a challan: Dr TDS/TCS payable (and interest), Cr bank, covering the listed documents' withheld tax. */
  @Post('deposits')
  @RequirePermission('journals.post')
  @ApiBody({ schema: openApi(DepositBody) })
  createDeposit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DepositBody)) body: z.infer<typeof DepositBody>) {
    return this.w.createDeposit(org, user, body);
  }

  @Post('deposits/:depositId/void')
  @HttpCode(200)
  @RequirePermission('journals.reverse')
  @ApiBody({ schema: openApi(VoidBody) })
  voidDeposit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('depositId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>) {
    return this.w.voidDeposit(org, user, id, { date: body.date ?? todayIso(), reason: body.reason });
  }
}
