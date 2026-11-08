import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { PaymentScheduleService, ScheduleOrg } from './payment-schedule.service';

const weekday = z.coerce.number().int().min(0).max(6);
const Query_ = z.object({ weeks: z.coerce.number().int().min(1).max(26).optional(), payWeekday: weekday.optional() });
const PlanBody = z.object({ payDate: isoDate, amount: decimalString.nullish(), note: z.string().trim().max(300).nullish() }).strict();
const AutoBody = z.object({ payWeekday: weekday.nullish(), documentIds: z.array(z.string().uuid()).max(500).optional() }).strict();

/** Payment scheduling (AP-007). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/payment-schedule')
export class PaymentScheduleController {
  constructor(private readonly schedule: PaymentScheduleService) {}

  @Get()
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    return this.schedule.get(this.org(org), q);
  }

  /** Plan every unplanned open bill (or the ones listed) for its suggested date. */
  @Post('auto')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(AutoBody) })
  auto(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AutoBody)) body: z.infer<typeof AutoBody>) {
    return this.schedule.autoPlan(this.org(org), user, body);
  }

  @Put('bills/:documentId')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(PlanBody) })
  plan(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(PlanBody)) body: z.infer<typeof PlanBody>) {
    return this.schedule.plan(this.org(org), user, id, body);
  }

  @Delete('bills/:documentId')
  @RequirePermission('purchases.manage')
  unplan(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string) {
    return this.schedule.unplan(this.org(org), user, id);
  }

  private org(o: OrgContext): ScheduleOrg {
    return { id: o.id, role: o.role, functionalCurrency: o.functionalCurrency };
  }
}
