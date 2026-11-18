import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { DepositsService } from './deposits.service';

const id = z.string().uuid('Not a deposit id');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01');
const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,6})?$/, 'Use an amount like 100000.00');
const rate = z.string().trim().regex(/^\d{1,2}(\.\d{1,4})?$/, 'Give the annual rate as a percentage like 7.25');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const account = (message: string) => z.string().uuid(message);
const DepositBody = z
  .object({
    name: z.string().trim().min(1, 'Give the deposit a name').max(200, 'Keep the name under 200 characters'),
    institution: z.string().trim().min(1, 'Give the bank or institution').max(200, 'Keep it under 200 characters'),
    institutionRef: text(60),
    principal: amount,
    annualRate: rate,
    compounding: z.enum(['SIMPLE', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY']),
    startDate: date,
    maturityDate: date,
    bankAccountId: account('Choose the bank account the money comes from'),
    depositAccountId: account('Choose the deposit account'),
    accruedInterestAccountId: account('Choose the account for interest earned but not yet paid'),
    interestIncomeAccountId: account('Choose the interest income account'),
  })
  .strict();
const AccrueBody = z.object({ date }).strict();
const CloseBody = z
  .object({ date, received: amount, tds: amount, tdsAccountId: z.string().uuid().nullish(), bankAccountId: z.string().uuid().nullish(), note: text(500) })
  .strict();
const ReverseBody = z.object({ date, reason: z.string().trim().min(1, 'Say why it is being reversed').max(500, 'Keep it under 500 characters') }).strict();

@ApiTags('deposits')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/deposits')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  /** Every deposit with principal, interest accrued, maturity value and what matures soon. */
  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.deposits.list(org);
  }

  /** Accounts the forms offer, by role. */
  @Get('accounts')
  @RequirePermission('journals.read')
  accounts() {
    return this.deposits.accountChoices();
  }

  /** One deposit: terms, interest to date, maturity value and every posting. */
  @Get(':id')
  @RequirePermission('journals.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) depositId: string) {
    return this.deposits.get(org, depositId);
  }

  /** Place a deposit: posts Dr deposit, Cr bank. */
  @Post()
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(DepositBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DepositBody)) b: z.infer<typeof DepositBody>) {
    return this.deposits.create(org, user.id, b);
  }

  /** Accrue the interest earned on every open deposit up to a date. */
  @Post('accrue')
  @HttpCode(200)
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(AccrueBody) })
  accrueAll(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AccrueBody)) b: z.infer<typeof AccrueBody>) {
    return this.deposits.accrueAll(org, user.id, b);
  }

  /** Accrue the interest earned on one deposit up to a date. */
  @Post(':id/accrue')
  @HttpCode(200)
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(AccrueBody) })
  accrue(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) depositId: string, @Body(new ZodPipe(AccrueBody)) b: z.infer<typeof AccrueBody>) {
    return this.deposits.accrue(org, user.id, depositId, b);
  }

  /** Close a deposit at maturity or early, with what the bank paid and the tax it deducted. */
  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(CloseBody) })
  close(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) depositId: string, @Body(new ZodPipe(CloseBody)) b: z.infer<typeof CloseBody>) {
    return this.deposits.close(org, user.id, depositId, b);
  }

  /** Reverse the latest posting (closing, accrual, or the placement itself). */
  @Post(':id/reverse')
  @HttpCode(200)
  @RequirePermission('loans.manage')
  @ApiBody({ schema: openApi(ReverseBody) })
  reverse(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) depositId: string, @Body(new ZodPipe(ReverseBody)) b: z.infer<typeof ReverseBody>) {
    return this.deposits.reverseLatest(org, user.id, depositId, b);
  }
}
