import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { DATE_FORMATS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { BankingService } from './banking.service';

const signedDecimal = z.string().regex(/^-?\d{1,18}(\.\d{1,10})?$/, 'Expected a decimal string, e.g. "1250.00" or "-40.00"');
const column = z.number().int().min(0).max(100);
const Mapping = z
  .object({
    date: column,
    description: column,
    reference: column.nullable().optional(),
    amount: column.nullable().optional(),
    moneyIn: column.nullable().optional(),
    moneyOut: column.nullable().optional(),
    dateFormat: z.enum(DATE_FORMATS),
    hasHeader: z.boolean(),
    delimiter: z.enum([',', ';', '\t']).optional(),
    invertAmount: z.boolean().optional(),
  })
  .refine((m) => m.amount != null || m.moneyIn != null || m.moneyOut != null, 'Choose an amount column, or money-in / money-out columns');
const ImportBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(2_500_000),
  mapping: Mapping,
  dryRun: z.boolean().default(false),
});
const LinesQuery = z.object({
  status: z.enum(['UNMATCHED', 'MATCHED', 'EXCLUDED']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
const MatchBody = z.object({ journalLineIds: z.array(z.uuid()).min(1).max(50) });
const UnmatchBody = z.object({ date: isoDate.optional() });
const EntryBody = z.object({ accountId: z.uuid(), description: z.string().trim().max(500).optional() });
const PaymentBody = z.object({
  contactId: z.uuid(),
  memo: z.string().max(1000).optional(),
  allocations: z.array(z.object({ documentId: z.uuid(), amount: decimalString })).max(200).default([]),
});
const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
const ReconcileBody = z.object({ statementDate: isoDate, statementBalance: signedDecimal, openingBalance: signedDecimal.optional() });

@ApiTags('banking')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/banking')
export class BankingController {
  constructor(private readonly banking: BankingService) {}

  @Get('accounts')
  @RequirePermission('banking.read')
  accounts(@CurrentOrg() org: OrgContext) {
    return this.banking.listAccounts(org);
  }

  /** Parses a CSV statement. With dryRun the lines are only previewed (duplicates flagged); otherwise new lines are stored. */
  @Post('accounts/:accountId/imports')
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(ImportBody) })
  importStatement(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>) {
    return this.banking.importStatement(org, user, accountId, body);
  }

  @Get('accounts/:accountId/imports')
  @RequirePermission('banking.read')
  imports(@CurrentOrg() org: OrgContext, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.banking.listImports(org, accountId);
  }

  @Get('accounts/:accountId/lines')
  @RequirePermission('banking.read')
  lines(@CurrentOrg() org: OrgContext, @Param('accountId', ParseUUIDPipe) accountId: string, @Query(new ZodPipe(LinesQuery)) q: z.infer<typeof LinesQuery>) {
    return this.banking.listLines(org, accountId, q);
  }

  @Post('accounts/:accountId/auto-match')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  autoMatch(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.banking.autoMatch(org, user, accountId);
  }

  @Get('accounts/:accountId/reconciliations')
  @RequirePermission('banking.read')
  reconciliations(@CurrentOrg() org: OrgContext, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.banking.listReconciliations(org, accountId);
  }

  @Post('accounts/:accountId/reconciliations/preview')
  @HttpCode(200)
  @RequirePermission('banking.read')
  @ApiBody({ schema: openApi(ReconcileBody) })
  preview(@CurrentOrg() org: OrgContext, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodPipe(ReconcileBody)) body: z.infer<typeof ReconcileBody>) {
    return this.banking.previewReconciliation(org, accountId, body);
  }

  @Post('accounts/:accountId/reconciliations')
  @RequirePermission('banking.reconcile')
  @ApiBody({ schema: openApi(ReconcileBody) })
  reconcile(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodPipe(ReconcileBody)) body: z.infer<typeof ReconcileBody>) {
    return this.banking.completeReconciliation(org, user, accountId, body);
  }

  /** Undoing needs periods.lock as well (owners and admins). */
  @Post('reconciliations/:reconciliationId/undo')
  @HttpCode(200)
  @RequirePermission('banking.reconcile')
  @ApiBody({ schema: openApi(ReasonBody) })
  undo(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('reconciliationId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>) {
    return this.banking.undoReconciliation(org, user, id, body.reason);
  }

  @Get('lines/:lineId')
  @RequirePermission('banking.read')
  line(@CurrentOrg() org: OrgContext, @Param('lineId', ParseUUIDPipe) id: string) {
    return this.banking.getLine(org, id);
  }

  @Get('lines/:lineId/candidates')
  @RequirePermission('banking.read')
  candidates(@CurrentOrg() org: OrgContext, @Param('lineId', ParseUUIDPipe) id: string, @Query(new ZodPipe(z.object({ search: z.string().max(100).optional() }))) q: { search?: string }) {
    return this.banking.candidates(org, id, q);
  }

  @Post('lines/:lineId/match')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(MatchBody) })
  match(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('lineId', ParseUUIDPipe) id: string, @Body(new ZodPipe(MatchBody)) body: z.infer<typeof MatchBody>) {
    return this.banking.match(org, user, id, body.journalLineIds);
  }

  /** Removes the match. An entry that was created from this line is reversed (on its own date unless `date` is given). */
  @Post('lines/:lineId/unmatch')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(UnmatchBody) })
  unmatch(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('lineId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UnmatchBody)) body: z.infer<typeof UnmatchBody>) {
    return this.banking.unmatch(org, user, id, body);
  }

  /** Posts a bank entry against another account (needs journals.post too) and matches it. */
  @Post('lines/:lineId/create-entry')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(EntryBody) })
  createEntry(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('lineId', ParseUUIDPipe) id: string, @Body(new ZodPipe(EntryBody)) body: z.infer<typeof EntryBody>) {
    return this.banking.createEntry(org, user, id, body);
  }

  /** Money in records a customer receipt, money out a vendor payment (needs sales.manage / purchases.manage), then matches it. */
  @Post('lines/:lineId/record-payment')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(PaymentBody) })
  recordPayment(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('lineId', ParseUUIDPipe) id: string, @Body(new ZodPipe(PaymentBody)) body: z.infer<typeof PaymentBody>) {
    return this.banking.recordPayment(org, user, id, body);
  }

  @Post('lines/:lineId/exclude')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  exclude(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('lineId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>) {
    return this.banking.exclude(org, user, id, body.reason);
  }

  @Post('lines/:lineId/include')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  include(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('lineId', ParseUUIDPipe) id: string) {
    return this.banking.include(org, user, id);
  }
}
