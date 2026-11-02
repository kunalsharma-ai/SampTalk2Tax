import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { LoansService } from './loans.service';

const id = z.string().uuid('Not a loan id');
const eventId = z.string().uuid('Not a loan entry id');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01');
const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,6})?$/, 'Use an amount like 120000.00');
const rate = z.string().trim().regex(/^\d{1,2}(\.\d{1,4})?$/, 'Give the annual rate as a percentage like 9.25');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const name = z.string().trim().min(1, 'Give the loan a name').max(200, 'Keep the name under 200 characters');
const LoanBody = z
  .object({
    name,
    lender: text(200),
    accountNumber: text(60),
    method: z.enum(['EMI', 'EQUAL_PRINCIPAL']),
    principal: amount,
    annualRate: rate,
    months: z.number().int('Use a whole number of months'),
    disbursementDate: date,
    firstDueDate: date,
    liabilityAccountId: z.string().uuid('Choose the loan account'),
    interestAccountId: z.string().uuid('Choose the interest account'),
    bankAccountId: z.string().uuid('Choose the bank account'),
    recordDisbursement: z.boolean(),
    notes: text(1000),
  })
  .strict();
const UpdateBody = z.object({ name, lender: text(200), accountNumber: text(60), bankAccountId: z.string().uuid('Choose the bank account'), notes: text(1000) }).strict();
const RepaymentBody = z.object({ date, bankAccountId: z.string().uuid().nullish(), principal: amount.nullish(), interest: amount.nullish(), note: text(500) }).strict();
const PrepaymentBody = z
  .object({ date, amount, mode: z.enum(['REDUCE_TENURE', 'REDUCE_INSTALLMENT']), charges: amount.nullish(), chargesAccountId: z.string().uuid().nullish(), bankAccountId: z.string().uuid().nullish(), note: text(500) })
  .strict();
const RateBody = z.object({ date, annualRate: rate, mode: z.enum(['KEEP_INSTALLMENT', 'KEEP_TENURE']), note: text(500) }).strict();

@ApiTags('loans')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/loans')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  /** Every loan with what is owed, the next installment and anything overdue. */
  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.loans.list(org);
  }

  /** Cash and bank balances, borrowings, net cash, installments due, and the ledger check. */
  @Get('treasury')
  @RequirePermission('journals.read')
  treasury(@CurrentOrg() org: OrgContext) {
    return this.loans.treasury(org);
  }

  /** Accounts the forms offer, by role. */
  @Get('accounts')
  @RequirePermission('journals.read')
  accounts(@CurrentOrg() org: OrgContext) {
    return this.loans.accounts(org);
  }

  /** One loan: terms, entries, installments paid and the schedule still to pay. */
  @Get(':id')
  @RequirePermission('journals.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) loanId: string) {
    return this.loans.get(org, loanId);
  }

  /** Add a loan, optionally posting the money received. */
  @Post()
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(LoanBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(LoanBody)) b: z.infer<typeof LoanBody>) {
    return this.loans.create(org, user, b);
  }

  /** Change a loan's name, lender, account number, usual bank account or notes. Its terms change only through entries. */
  @Put(':id')
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) loanId: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.loans.update(org, user, loanId, b);
  }

  /** Record the next installment, as scheduled or as the lender charged it. */
  @Post(':id/repayments')
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(RepaymentBody) })
  repay(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) loanId: string, @Body(new ZodPipe(RepaymentBody)) b: z.infer<typeof RepaymentBody>) {
    return this.loans.repay(org, user, loanId, b);
  }

  /** Pay off part or all of the principal early, shortening the term or lowering the installment. */
  @Post(':id/prepayments')
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(PrepaymentBody) })
  prepay(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) loanId: string, @Body(new ZodPipe(PrepaymentBody)) b: z.infer<typeof PrepaymentBody>) {
    return this.loans.prepay(org, user, loanId, b);
  }

  /** A new interest rate from the next installment, keeping the installment or the term. */
  @Post(':id/rate-changes')
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(RateBody) })
  changeRate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) loanId: string, @Body(new ZodPipe(RateBody)) b: z.infer<typeof RateBody>) {
    return this.loans.changeRate(org, user, loanId, b);
  }

  /** Reverse the latest entry on the loan. */
  @Post(':id/events/:eventId/reverse')
  @HttpCode(200)
  @RequirePermission('loans.manage')
  reverse(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) loanId: string, @Param('eventId', new ZodPipe(eventId)) e: string) {
    return this.loans.reverseEvent(org, user, loanId, e);
  }
}
