import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { RECURRING_FREQUENCIES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { BillOrg, RecurringBillsService } from './recurring-bills.service';

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const Line = z
  .object({
    accountId: z.string().uuid('Choose an account'),
    description: text(500),
    quantity: decimalString,
    unitPrice: decimalString,
    taxRateId: z.string().uuid().nullish(),
    hsnCode: z.string().trim().max(8).nullish(),
    departmentId: z.string().uuid().nullish(),
    projectId: z.string().uuid().nullish(),
  })
  .strict();
const Body_ = z
  .object({
    name: z.string().trim().min(1, 'Give the recurring bill a name').max(120),
    contactId: z.string().uuid('Choose the vendor'),
    reference: text(100),
    memo: text(1000),
    placeOfSupply: z.string().regex(/^\d{2}$/).nullish(),
    reverseCharge: z.boolean().default(false),
    withholdingSectionId: z.string().uuid().nullish(),
    dueDays: z.number().int().min(0, 'Use 0 or more days').max(365, 'Use at most 365 days').nullish(),
    frequency: z.enum(RECURRING_FREQUENCIES),
    startDate: isoDate,
    endDate: isoDate.nullish(),
    monthEnd: z.boolean().default(false),
    postMode: z.enum(['DRAFT', 'POST']).default('DRAFT'),
    lines: z.array(Line).min(1, 'A bill needs at least one line').max(200),
  })
  .strict();
const ResumeBody = z.object({ skipMissed: z.boolean().default(false) }).strict();
const ListQuery = z.object({ view: z.enum(['active', 'paused', 'ended', 'all']).optional() });

/** Recurring bills (AP-005). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/recurring-bills')
export class RecurringBillsController {
  constructor(private readonly bills: RecurringBillsService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.bills.list(this.org(org), q.view);
  }

  /** Make every run that has fallen due, for every recurring bill of the organisation (the runner also does this). */
  @Post('run-due')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  runDueAll(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.bills.runOrg(this.org(org), user);
  }

  @Post()
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(Body_) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(Body_)) body: z.infer<typeof Body_>) {
    return this.bills.create(this.org(org), user, body);
  }

  @Get(':id')
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.get(this.org(org), id);
  }

  @Put(':id')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(Body_) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Body_)) body: z.infer<typeof Body_>) {
    return this.bills.update(this.org(org), user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.bills.remove(this.org(org), user, id);
  }

  @Post(':id/run-due')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  runNow(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.runNow(this.org(org), user, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  pause(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.setStatus(this.org(org), user, id, 'pause');
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ResumeBody) })
  resume(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ResumeBody)) body: z.infer<typeof ResumeBody>) {
    return this.bills.setStatus(this.org(org), user, id, 'resume', body);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  end(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.setStatus(this.org(org), user, id, 'end');
  }

  private org(o: OrgContext): BillOrg {
    return { id: o.id, role: o.role, functionalCurrency: o.functionalCurrency, fiscalYearStartMonth: o.fiscalYearStartMonth };
  }
}
