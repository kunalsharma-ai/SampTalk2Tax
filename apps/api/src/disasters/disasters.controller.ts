import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { hasPermission } from '@talk2tax/security';
import type { DisasterShock } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { DisastersService, type SimulationInput } from './disasters.service';

// Field formats only; ranges and meaning are checked by the engine, which explains them in words.
const n = z.string().trim().max(24);
const int = z.number().int();
const month = int.optional();
const contactId = z.string().uuid('Choose from the list');
const Shock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CUSTOMER_DEFAULT'), contactId, writeOffPercent: n, loseFutureSales: z.boolean(), month }).strict(),
  z.object({ kind: z.literal('SUPPLIER_FAILURE'), contactId, disruptionMonths: int, revenueLostPercent: n, replacementPremiumPercent: n, month }).strict(),
  z.object({ kind: z.literal('LIQUIDITY_SHOCK'), frozenCash: n, frozenMonths: int, creditWithdrawn: n, collectionDelayDays: int, delayMonths: int, month }).strict(),
  z.object({ kind: z.literal('OPERATIONAL_DISRUPTION'), revenueLostPercent: n, months: int, recoveryCost: n, insuranceRecovery: n, insuranceMonthsLater: int, month }).strict(),
  z.object({ kind: z.literal('DEMAND_SHOCK'), revenueLostPercent: n, months: int, extraCollectionDays: int, month }).strict(),
]);
const baselineMonths = z.union([z.literal(3), z.literal(6), z.literal(12)]);
const horizonMonths = z.number().int().min(1, 'Choose a horizon from 1 to 60 months').max(60, 'Choose a horizon from 1 to 60 months');
const SimulateBody = z.object({ baselineMonths, horizonMonths, shocks: z.array(Shock).min(1, 'Add at least one shock').max(10, 'At most 10 shocks in a simulation') }).strict();
const SimulationBody = SimulateBody.extend({
  name: z.string().trim().min(1, 'Give the simulation a name').max(120, 'Keep the name under 120 characters'),
  description: z.string().trim().max(1000, 'Keep the description under 1000 characters').nullish(),
}).strict();
const MonthsQuery = z.object({ baselineMonths: z.coerce.number().pipe(baselineMonths).default(6), horizonMonths: z.coerce.number().pipe(horizonMonths).default(12) }).strict();

/** Shocks name customers and suppliers and use their balances, so both ledgers are needed. */
function ledgers(org: OrgContext) {
  if (!hasPermission(org.role, 'sales.read') || !hasPermission(org.role, 'purchases.read')) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Disaster simulation needs access to sales and purchases' });
}

/**
 * Financial disaster simulation. Reading and running need reports.read plus sales.read and
 * purchases.read; saving, changing and deleting simulations, and turning one into a digital-twin
 * scenario, need scenarios.manage. Nothing here posts to the books.
 */
@ApiTags('disaster-simulation')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/disasters')
export class DisastersController {
  constructor(private readonly svc: DisastersService) {}

  @Get('options')
  @RequirePermission('reports.read')
  options(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthsQuery)) q: z.infer<typeof MonthsQuery>) {
    ledgers(org);
    return this.svc.options(org.id, q as { baselineMonths: 3 | 6 | 12; horizonMonths: number });
  }

  /** The standard stress tests, worst first. */
  @Get('stress-tests')
  @RequirePermission('reports.read')
  stress(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthsQuery)) q: z.infer<typeof MonthsQuery>) {
    ledgers(org);
    return this.svc.stress(org.id, q as { baselineMonths: 3 | 6 | 12; horizonMonths: number });
  }

  /** Runs shocks without saving them. */
  @Post('simulate')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(SimulateBody) })
  simulate(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(SimulateBody)) b: z.infer<typeof SimulateBody>) {
    ledgers(org);
    return this.svc.simulate(org.id, { ...b, shocks: b.shocks as DisasterShock[] } as never);
  }

  @Get('simulations')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    ledgers(org);
    return this.svc.list(org.id);
  }

  @Post('simulations')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(SimulationBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SimulationBody)) b: z.infer<typeof SimulationBody>) {
    ledgers(org);
    return this.svc.create(org.id, user, b as SimulationInput);
  }

  @Get('simulations/:id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    ledgers(org);
    return this.svc.get(org.id, id);
  }

  @Put('simulations/:id')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(SimulationBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SimulationBody)) b: z.infer<typeof SimulationBody>) {
    ledgers(org);
    return this.svc.update(org.id, user, id, b as SimulationInput);
  }

  @Delete('simulations/:id')
  @HttpCode(204)
  @RequirePermission('scenarios.manage')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    ledgers(org);
    await this.svc.remove(org.id, user, id);
  }

  /** Saves the shocks as a digital-twin scenario, to take them through the war room. */
  @Post('simulations/:id/scenario')
  @RequirePermission('scenarios.manage')
  toScenario(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    ledgers(org);
    return this.svc.toScenario(org.id, user, id);
  }
}
