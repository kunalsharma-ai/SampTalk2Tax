import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { ExpensesService } from './expenses.service';
import { AllowancesService } from './allowances.service';
import { ExpensePolicyService } from './expense-policy.service';

const Allowance = z.object({
  rateId: z.uuid(),
  /** Kilometres or days. */
  quantity: decimalString,
  from: z.string().trim().max(120).nullish(),
  to: z.string().trim().max(120).nullish(),
  purpose: z.string().trim().max(200).nullish(),
});
/** A receipt line (account and amount), or a mileage / per diem line (allowance; the server works out the amount and account). */
const Line = z
  .object({
    date: isoDate,
    accountId: z.uuid().nullish(),
    merchant: z.string().trim().max(200).nullish(),
    description: z.string().trim().max(500).nullish(),
    amount: decimalString.nullish(),
    taxRateId: z.uuid().nullish(),
    allowance: Allowance.nullish(),
    departmentId: z.uuid().nullish(),
  })
  .refine((l) => !!l.allowance || (!!l.accountId && !!l.amount), 'A line needs a category and an amount, or a mileage or per diem rate');
const RateBody = z.object({ kind: z.enum(['MILEAGE', 'PER_DIEM']), name: z.string().trim().min(1).max(80), rate: decimalString, accountId: z.uuid() });
const RateUpdateBody = z.object({ name: z.string().trim().min(1).max(80), rate: decimalString, accountId: z.uuid(), isActive: z.boolean() });
const PolicyFields = {
  severity: z.enum(['WARN', 'BLOCK']),
  accountId: z.uuid().nullish(),
  amount: decimalString.nullish(),
  days: z.number().int().nullish(),
};
const PolicyRuleBody = z.object({ kind: z.enum(['LINE_MAX', 'DAILY_MAX', 'MONTHLY_MAX', 'CLAIM_MAX', 'RECEIPT_ABOVE', 'MAX_AGE_DAYS']), ...PolicyFields });
const PolicyRuleUpdateBody = z.object({ ...PolicyFields, isActive: z.boolean() });
const ClaimBody = z.object({ title: z.string().trim().min(1).max(200), lines: z.array(Line).min(1).max(100) });
const ListQuery = z.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'REIMBURSED', 'VOID']).optional(),
  mine: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const ApproveBody = z.object({ note: z.string().trim().max(1000).nullish(), date: isoDate.optional() });
const RejectBody = z.object({ note: z.string().trim().min(3, 'Say why, so the claimant can fix it').max(1000) });
const ReimburseBody = z.object({ bankAccountId: z.uuid(), date: isoDate, reference: z.string().trim().max(100).nullish() });
const VoidBody = z.object({ date: isoDate, reason: z.string().trim().min(3).max(500) });

/**
 * Routes need membership only; the service decides per claim (claimants see and change
 * their own claims, expenses.read sees all, approvals.decide approves, expenses.reimburse pays).
 */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-claims')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('options')
  @RequirePermission('org.read')
  options(@CurrentOrg() org: OrgContext) {
    return this.expenses.options(org);
  }

  @Get()
  @RequirePermission('org.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.expenses.list(org, user, q);
  }

  @Get(':claimId')
  @RequirePermission('org.read')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string) {
    return this.expenses.get(org, user, id);
  }

  @Post()
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(ClaimBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ClaimBody)) body: z.infer<typeof ClaimBody>) {
    return this.expenses.create(org, user, body);
  }

  @Put(':claimId')
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(ClaimBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ClaimBody)) body: z.infer<typeof ClaimBody>) {
    return this.expenses.update(org, user, id, body);
  }

  @Delete(':claimId')
  @HttpCode(204)
  @RequirePermission('org.read')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string) {
    await this.expenses.remove(org, user, id);
  }

  @Post(':claimId/submit')
  @HttpCode(200)
  @RequirePermission('org.read')
  submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string) {
    return this.expenses.submit(org, user, id);
  }

  @Post(':claimId/withdraw')
  @HttpCode(200)
  @RequirePermission('org.read')
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string) {
    return this.expenses.withdraw(org, user, id);
  }

  @Post(':claimId/approve')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(ApproveBody) })
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ApproveBody)) body: z.infer<typeof ApproveBody>) {
    return this.expenses.approve(org, user, id, body);
  }

  @Post(':claimId/reject')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(RejectBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>) {
    return this.expenses.reject(org, user, id, body.note);
  }

  @Post(':claimId/reimburse')
  @HttpCode(200)
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(ReimburseBody) })
  reimburse(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReimburseBody)) body: z.infer<typeof ReimburseBody>) {
    return this.expenses.reimburse(org, user, id, body);
  }

  @Post(':claimId/void')
  @HttpCode(200)
  @RequirePermission('journals.reverse')
  @ApiBody({ schema: openApi(VoidBody) })
  void(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('claimId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>) {
    return this.expenses.void(org, user, id, body);
  }
}

/** Mileage and per diem rates (EXP-006, EXP-008). Everyone who claims can read the active ones through the claim options. */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-allowance-rates')
export class AllowanceRatesController {
  constructor(private readonly allowances: AllowancesService) {}

  @Get()
  @RequirePermission('expenses.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.allowances.listRates(org);
  }

  @Post()
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(RateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RateBody)) body: z.infer<typeof RateBody>) {
    return this.allowances.createRate(org, user.id, body);
  }

  @Put(':rateId')
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(RateUpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('rateId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RateUpdateBody)) body: z.infer<typeof RateUpdateBody>) {
    return this.allowances.updateRate(org, user.id, id, body);
  }
}

/** Expense policy rules (EXP-013, EXP-015, EXP-022). Claimants see the active ones through the claim options. */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-policy-rules')
export class ExpensePolicyController {
  constructor(private readonly policy: ExpensePolicyService) {}

  @Get()
  @RequirePermission('expenses.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.policy.list(org);
  }

  @Post()
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(PolicyRuleBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PolicyRuleBody)) body: z.infer<typeof PolicyRuleBody>) {
    return this.policy.create(org, user.id, body);
  }

  @Put(':ruleId')
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(PolicyRuleUpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) id: string, @Body(new ZodPipe(PolicyRuleUpdateBody)) body: z.infer<typeof PolicyRuleUpdateBody>) {
    return this.policy.update(org, user.id, id, body);
  }
}
