import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { hasPermission } from '@talk2tax/security';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { TwinService } from './twin.service';

// Field formats only; ranges and meaning are checked by the engine, which explains them in words.
const n = z.string().trim().max(24);
const month = z.number().int().optional();
const departmentId = z.string().uuid('Choose a department from the list').nullish();
const meta = { id: z.string().max(64).optional(), label: z.string().trim().max(120).nullish(), departmentId };
const Driver = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('REVENUE_GROWTH'), percentPerMonth: n, fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('PRICE_CHANGE'), pricePercent: n, volumePercent: n, fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('CHURN'), percentPerMonth: n, fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('HIRING'), count: z.number().int(), monthlyCostPerHead: n, oneOffCostPerHead: n.optional(), fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('EXPENSE_CHANGE'), target: z.enum(['COST_OF_SALES', 'PAYROLL', 'OPERATING']), percent: n.optional(), monthlyAmount: n.optional(), fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('SUPPLIER_COST'), percent: n, fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('NEW_DEBT'), amount: n, annualRatePercent: n, termMonths: z.number().int(), month, ...meta }).strict(),
  z.object({ kind: z.literal('INVESTMENT'), amount: n, usefulLifeMonths: z.number().int(), month, ...meta }).strict(),
  z.object({ kind: z.literal('EXPANSION'), oneOffCost: n, monthlyCost: n, monthlyRevenue: n, rampMonths: z.number().int(), month, costOfSalesPercent: n.optional(), ...meta }).strict(),
  z.object({ kind: z.literal('CURRENCY'), exposurePercent: n, changePercent: n, fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('INFLATION'), annualPercent: n, ...meta }).strict(),
  z.object({ kind: z.literal('DOWNTURN'), revenuePercent: n, extraCollectionDays: z.number().int(), fromMonth: month, months: z.number().int().optional(), ...meta }).strict(),
  z.object({ kind: z.literal('WORKING_CAPITAL'), collectionDaysChange: z.number().int(), paymentDaysChange: z.number().int(), fromMonth: month, ...meta }).strict(),
  z.object({ kind: z.literal('TAX_RATE'), percent: n, ...meta }).strict(),
  z.object({ kind: z.literal('ONE_OFF'), label: z.string().trim().max(120), amount: n, month, affectsProfit: z.boolean(), id: z.string().max(64).optional(), departmentId }).strict(),
]);
const baselineMonths = z.union([z.literal(3), z.literal(6), z.literal(12)]);
const horizonMonths = z.number().int().min(1, 'Choose a horizon from 1 to 60 months').max(60, 'Choose a horizon from 1 to 60 months');
const SimulateBody = z.object({ baselineMonths, horizonMonths, drivers: z.array(Driver).max(50, 'At most 50 changes in a scenario') }).strict();
const ScenarioBody = SimulateBody.extend({
  name: z.string().trim().min(1, 'Give the scenario a name').max(120, 'Keep the name under 120 characters'),
  description: z.string().trim().max(1000).nullish(),
}).strict();
const DecisionBody = z.object({ note: z.string().trim().max(1000).nullish() }).strict();
const NoteBody = z.object({ body: z.string().trim().min(1, 'Write the note').max(2000, 'Keep notes under 2000 characters'), month: z.number().int().min(1).max(60).nullish(), changeNumber: z.number().int().min(1).max(50).nullish() }).strict();
const ResolveBody = z.object({ resolved: z.boolean() }).strict();
const CompareQuery = z.object({ ids: z.string().min(1) }).strict();
const BaselineQuery = z.object({ baselineMonths: z.coerce.number().pipe(baselineMonths).default(6), horizonMonths: z.coerce.number().pipe(horizonMonths).default(12) }).strict();

/**
 * The financial digital twin: what-if scenarios played forward from the organisation's actual
 * figures. Reading needs reports.read; saving scenarios needs scenarios.manage. Nothing here
 * posts to the books.
 */
@ApiTags('digital-twin')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/twin')
export class TwinController {
  constructor(private readonly svc: TwinService) {}

  @Get('templates')
  @RequirePermission('reports.read')
  templates() {
    return this.svc.templates();
  }

  /** The actual months and the no-change projection. */
  @Get('baseline')
  @RequirePermission('reports.read')
  baseline(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(BaselineQuery)) q: z.infer<typeof BaselineQuery>) {
    return this.svc.baseline(org.id, q as { baselineMonths: 3 | 6 | 12; horizonMonths: number });
  }

  /** Runs changes without saving them (for trying things out). */
  @Post('simulate')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(SimulateBody) })
  simulate(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(SimulateBody)) body: z.infer<typeof SimulateBody>) {
    return this.svc.simulate(org.id, body, { insights: true });
  }

  @Get('compare')
  @RequirePermission('reports.read')
  compare(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(CompareQuery)) q: z.infer<typeof CompareQuery>) {
    const ids = q.ids.split(',').map((x) => x.trim());
    for (const id of ids) if (!/^[0-9a-f-]{36}$/.test(id)) return this.svc.compare(org.id, []);
    return this.svc.compare(org.id, ids);
  }

  @Get('scenarios')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org.id);
  }

  @Post('scenarios')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(ScenarioBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ScenarioBody)) body: z.infer<typeof ScenarioBody>) {
    return this.svc.create(org.id, user, body);
  }

  @Get('scenarios/:id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(org.id, id);
  }

  @Put('scenarios/:id')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(ScenarioBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ScenarioBody)) body: z.infer<typeof ScenarioBody>) {
    return this.svc.update(org.id, user, id, body);
  }

  @Delete('scenarios/:id')
  @RequirePermission('scenarios.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(org.id, user, id);
  }

  @Post('scenarios/:id/versions/:version/restore')
  @HttpCode(200)
  @RequirePermission('scenarios.manage')
  restore(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number) {
    return this.svc.restore(org.id, user, id, version);
  }

  @Post('scenarios/:id/submit')
  @HttpCode(200)
  @RequirePermission('scenarios.manage')
  submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.submit(org.id, user, id);
  }

  @Post('scenarios/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('scenarios.manage')
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.withdraw(org.id, user, id);
  }

  @Post('scenarios/:id/approve')
  @HttpCode(200)
  @RequirePermission('scenarios.approve')
  @ApiBody({ schema: openApi(DecisionBody) })
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DecisionBody)) body: z.infer<typeof DecisionBody>) {
    return this.svc.decide(org.id, user, id, 'APPROVED', body.note ?? null);
  }

  @Post('scenarios/:id/reject')
  @HttpCode(200)
  @RequirePermission('scenarios.approve')
  @ApiBody({ schema: openApi(DecisionBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DecisionBody)) body: z.infer<typeof DecisionBody>) {
    return this.svc.decide(org.id, user, id, 'REJECTED', body.note ?? null);
  }

  @Post('scenarios/:id/reopen')
  @HttpCode(200)
  @RequirePermission('scenarios.manage')
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.reopen(org.id, user, id);
  }

  /** War-room notes: anyone who can read reports can annotate a scenario. */
  @Post('scenarios/:id/notes')
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(NoteBody) })
  addNote(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.svc.addNote(org.id, user, id, body);
  }

  @Put('scenarios/:id/notes/:noteId')
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(ResolveBody) })
  resolveNote(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('noteId', ParseUUIDPipe) noteId: string, @Body(new ZodPipe(ResolveBody)) body: z.infer<typeof ResolveBody>) {
    return this.svc.resolveNote(org.id, user, hasPermission(org.role, 'scenarios.manage'), id, noteId, body.resolved);
  }

  @Delete('scenarios/:id/notes/:noteId')
  @RequirePermission('reports.read')
  deleteNote(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('noteId', ParseUUIDPipe) noteId: string) {
    return this.svc.deleteNote(org.id, user, id, noteId);
  }
}
