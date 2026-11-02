import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { DeferralsService } from './deferrals.service';

const id = z.string().uuid('Not a schedule id');
const accrualId = z.string().uuid('Not an accrual id');
const runId = z.string().uuid('Not a release run id');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-04');
const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,6})?$/, 'Use an amount like 120000.00');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const ScheduleBody = z
  .object({
    kind: z.enum(['PREPAID_EXPENSE', 'DEFERRED_REVENUE']),
    name: z.string().trim().min(1, 'Give the schedule a name').max(200, 'Keep the name under 200 characters'),
    counterparty: text(200),
    balanceAccountId: z.string().uuid('Choose the balance sheet account'),
    pnlAccountId: z.string().uuid('Choose the account it is released to'),
    amount,
    startDate: date,
    months: z.number().int('Use a whole number of months'),
    method: z.enum(['EVEN', 'DAILY']),
    fundingAccountId: z.string().uuid().nullish(),
    fundingDate: date.nullish(),
  })
  .strict();
const UpdateBody = ScheduleBody.omit({ kind: true, fundingAccountId: true, fundingDate: true });
const EndBody = z.object({ date, accountId: z.string().uuid().nullish(), note: text(500) }).strict();
const RunBody = z.object({ month }).strict();
const MonthQuery = z.object({ month: month.optional() }).strict();
const AccrualBody = z
  .object({
    kind: z.enum(['EXPENSE', 'INCOME']),
    description: z.string().trim().min(1, 'Say what is being accrued').max(200, 'Keep it under 200 characters'),
    counterparty: text(200),
    month,
    pnlAccountId: z.string().uuid('Choose the expense or revenue account'),
    balanceAccountId: z.string().uuid('Choose the accrued liability or accrued income account'),
    amount,
  })
  .strict();
const CancelBody = z.object({ note: z.string().trim().min(5, 'Say why it is being cancelled').max(500, 'Keep it under 500 characters') }).strict();

@ApiTags('deferrals')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/deferrals')
export class DeferralsController {
  constructor(private readonly deferrals: DeferralsService) {}

  /** Every prepaid expense and deferred revenue schedule, with what is released and what is left. */
  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.deferrals.list(org);
  }

  /** Accounts the forms offer, by role. */
  @Get('accounts')
  @RequirePermission('journals.read')
  accounts(@CurrentOrg() org: OrgContext) {
    return this.deferrals.accounts(org);
  }

  /** Release runs, the next month to post, and what posting a month would release. */
  @Get('releases')
  @RequirePermission('journals.read')
  releases(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthQuery)) q: z.infer<typeof MonthQuery>) {
    return this.deferrals.releases(org, q.month);
  }

  /** Post a month's releases as one journal on its last day. */
  @Post('releases/runs')
  @RequirePermission('deferrals.manage')
  @ApiBody({ schema: openApi(RunBody) })
  run(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RunBody)) b: z.infer<typeof RunBody>) {
    return this.deferrals.run(org, user, b.month);
  }

  /** Reverse the latest release run. */
  @Post('releases/runs/:runId/reverse')
  @HttpCode(200)
  @RequirePermission('deferrals.manage')
  reverse(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', new ZodPipe(runId)) r: string) {
    return this.deferrals.reverse(org, user, r);
  }

  /** Month-end accruals, newest first. */
  @Get('accruals')
  @RequirePermission('journals.read')
  accruals(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthQuery)) q: z.infer<typeof MonthQuery>) {
    return this.deferrals.accruals(org, q.month);
  }

  /** Post an accrual on the last day of its month; its reversal is posted on the first day of the next. */
  @Post('accruals')
  @RequirePermission('deferrals.manage')
  @ApiBody({ schema: openApi(AccrualBody) })
  createAccrual(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AccrualBody)) b: z.infer<typeof AccrualBody>) {
    return this.deferrals.createAccrual(org, user, b);
  }

  /** Cancel an accrual that was wrong: both months come back to where they were. */
  @Post('accruals/:id/cancel')
  @HttpCode(200)
  @RequirePermission('deferrals.manage')
  @ApiBody({ schema: openApi(CancelBody) })
  cancelAccrual(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(accrualId)) a: string, @Body(new ZodPipe(CancelBody)) b: z.infer<typeof CancelBody>) {
    return this.deferrals.cancelAccrual(org, user, a, b.note);
  }

  /** Add a schedule; with fundingAccountId, the payment or receipt is posted too. */
  @Post()
  @RequirePermission('deferrals.manage')
  @ApiBody({ schema: openApi(ScheduleBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ScheduleBody)) b: z.infer<typeof ScheduleBody>) {
    return this.deferrals.create(org, user, b);
  }

  @Get(':id')
  @RequirePermission('journals.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) s: string) {
    return this.deferrals.get(org, s);
  }

  /** Change a schedule; its terms only until a release is posted for it. */
  @Put(':id')
  @RequirePermission('deferrals.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) s: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.deferrals.update(org, user, s, b);
  }

  /** End a schedule early; what is left is released in one entry. */
  @Post(':id/end')
  @HttpCode(200)
  @RequirePermission('deferrals.manage')
  @ApiBody({ schema: openApi(EndBody) })
  end(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) s: string, @Body(new ZodPipe(EndBody)) b: z.infer<typeof EndBody>) {
    return this.deferrals.end(org, user, s, b);
  }
}
