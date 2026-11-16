import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission, RequireFeature } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { parseExportFormat } from '../report-exports/report-exports.service';
import { ConsolidationService } from './consolidation.service';
import { IntercompanyService } from './intercompany.service';

const name = z.string().trim().min(1, 'Give it a name').max(120, 'Keep the name under 120 characters');
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code such as INR');
const rate = z.string().regex(/^\d{1,12}(\.\d{1,10})?$/, 'Enter a rate such as 83.25');
const side = z.object({ orgId: z.uuid('Choose an organisation'), code: z.string().trim().min(1, 'Choose an account').max(20) }).strict();
const CreateBody = z.object({ name, currency: currency.nullish() }).strict();
const UpdateBody = z.object({ name, currency }).strict();
const MemberBody = z.object({ orgId: z.uuid('Choose an organisation') }).strict();
const OwnershipBody = z.object({ ownershipPercent: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage such as 80 or 66.6667') }).strict();
const code = z.string().trim().min(1).max(20).nullable();
const IcAccountsBody = z.object({ receivable: code, payable: code, revenue: code, expense: code }).strict();
const amount = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Enter an amount such as 25000.00');
const IntercompanyBody = z
  .object({
    kind: z.enum(['CHARGE', 'SETTLEMENT']),
    fromOrgId: z.uuid('Choose the first company'),
    toOrgId: z.uuid('Choose the second company'),
    date: isoDate,
    description: z.string().trim().min(1, 'Describe the transaction').max(200, 'Keep the description under 200 characters'),
    amount,
    toAmount: amount.nullish(),
    fromBankCode: z.string().trim().max(20).nullish(),
    toBankCode: z.string().trim().max(20).nullish(),
  })
  .strict();
const ReverseBody = z.object({ date: isoDate }).strict();
const RateBody = z.object({ memberOrgId: z.uuid(), periodEnd: isoDate, closing: rate, average: rate, historical: rate }).strict();
const RuleBody = z.object({ name, left: side, right: side, isActive: z.boolean().optional() }).strict();
const PeriodQuery = z.object({ from: isoDate, to: isoDate }).strict();
const ExportQuery = PeriodQuery.extend({ format: z.string().optional() }).strict();

/**
 * Consolidation groups owned by this organisation. Setting a group up needs org.manage here;
 * reading the consolidated figures needs reports.read here and in every member.
 */
@ApiTags('consolidation')
@ApiBearerAuth()
@RequireFeature('CONSOLIDATION')
@Controller('v1/orgs/:orgId/consolidation/groups')
export class ConsolidationController {
  constructor(
    private readonly svc: ConsolidationService,
    private readonly ic: IntercompanyService,
  ) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org);
  }

  @Post()
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.svc.create(org, user, body);
  }

  @Get(':groupId')
  @RequirePermission('reports.read')
  detail(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string) {
    return this.svc.detail(org, user.id, id);
  }

  @Put(':groupId')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.svc.update(org, user, id, body);
  }

  @Delete(':groupId')
  @RequirePermission('org.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string) {
    return this.svc.remove(org, user, id);
  }

  @Post(':groupId/members')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(MemberBody) })
  addMember(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Body(new ZodPipe(MemberBody)) body: z.infer<typeof MemberBody>) {
    return this.svc.addMember(org, user, id, body.orgId);
  }

  @Put(':groupId/members/:memberOrgId')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(OwnershipBody) })
  setOwnership(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('groupId', ParseUUIDPipe) id: string,
    @Param('memberOrgId', ParseUUIDPipe) memberOrgId: string,
    @Body(new ZodPipe(OwnershipBody)) body: z.infer<typeof OwnershipBody>,
  ) {
    return this.svc.setOwnership(org, user, id, memberOrgId, body.ownershipPercent);
  }

  @Delete(':groupId/members/:memberOrgId')
  @RequirePermission('org.manage')
  removeMember(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Param('memberOrgId', ParseUUIDPipe) memberOrgId: string) {
    return this.svc.removeMember(org, user, id, memberOrgId);
  }

  @Put(':groupId/rates')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(RateBody) })
  setRate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RateBody)) body: z.infer<typeof RateBody>) {
    return this.svc.setRate(org, user, id, body);
  }

  @Delete(':groupId/rates/:rateId')
  @RequirePermission('org.manage')
  deleteRate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Param('rateId', ParseUUIDPipe) rateId: string) {
    return this.svc.deleteRate(org, user, id, rateId);
  }

  @Post(':groupId/rules')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(RuleBody) })
  addRule(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.svc.addRule(org, user, id, body);
  }

  @Put(':groupId/rules/:ruleId')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(RuleBody) })
  updateRule(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.svc.updateRule(org, user, id, ruleId, body);
  }

  @Delete(':groupId/rules/:ruleId')
  @RequirePermission('org.manage')
  deleteRule(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string) {
    return this.svc.deleteRule(org, user, id, ruleId);
  }

  /** The accounts a company uses for intercompany transactions in this group. */
  @Put(':groupId/members/:memberOrgId/intercompany-accounts')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(IcAccountsBody) })
  setIntercompanyAccounts(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('groupId', ParseUUIDPipe) id: string,
    @Param('memberOrgId', ParseUUIDPipe) memberOrgId: string,
    @Body(new ZodPipe(IcAccountsBody)) body: z.infer<typeof IcAccountsBody>,
  ) {
    return this.svc.setIntercompanyAccounts(org, user, id, memberOrgId, body);
  }

  /** Intercompany transactions the user can see (journals.read in both companies). */
  @Get(':groupId/intercompany')
  @RequirePermission('reports.read')
  listIntercompany(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string) {
    return this.ic.list(org, user.id, id);
  }

  /** Post a charge or settlement in both companies at once (journals.post in both). */
  @Post(':groupId/intercompany')
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(IntercompanyBody) })
  createIntercompany(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Body(new ZodPipe(IntercompanyBody)) body: z.infer<typeof IntercompanyBody>) {
    return this.ic.create(org, user, id, body);
  }

  /** Reverse both entries of an intercompany transaction (journals.reverse in both). */
  @Post(':groupId/intercompany/:txnId/reverse')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(ReverseBody) })
  reverseIntercompany(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('groupId', ParseUUIDPipe) id: string,
    @Param('txnId', ParseUUIDPipe) txnId: string,
    @Body(new ZodPipe(ReverseBody)) body: z.infer<typeof ReverseBody>,
  ) {
    return this.ic.reverse(org, user, id, txnId, body);
  }

  /** The consolidation worksheet with consolidated profit and loss and balance sheet. */
  @Get(':groupId/report')
  @RequirePermission('reports.read')
  report(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('groupId', ParseUUIDPipe) id: string, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    return this.svc.report(org, user.id, id, q);
  }

  /** worksheet, income-statement or balance-sheet as CSV, Excel or PDF. */
  @Get(':groupId/export/:statement')
  @HttpCode(200)
  @RequirePermission('reports.read')
  async download(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('groupId', ParseUUIDPipe) id: string,
    @Param('statement') statement: string,
    @Query(new ZodPipe(ExportQuery)) q: z.infer<typeof ExportQuery>,
    @Res() res: Response,
  ) {
    const format = parseExportFormat(q.format);
    const file = await this.svc.export(org, user, id, statement, format, { from: q.from, to: q.to });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Report-SHA256', file.sha256);
    res.end(file.body);
  }
}
