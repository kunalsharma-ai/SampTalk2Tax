import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { CashFlowService } from './cash-flow.service';

const horizonDays = z.coerce
  .number()
  .int()
  .refine((h) => [30, 60, 90, 180, 365].includes(h), 'The horizon is 30, 60, 90, 180 or 365 days');
/** Money in the organisation's currency: at most 2 decimals. */
const money = z.string().trim().regex(/^\d{1,15}(\.\d{1,2})?$/, 'An amount such as "25000" or "1250.50" (at most 2 decimals)');
const positive = money.refine((s) => Number(s) > 0, 'The amount must be more than zero');
const ForecastQuery = z.object({ horizonDays: horizonDays.default(90), asOf: isoDate.optional() });
const SettingsBody = z.object({ minimumBalance: money }).strict();
const ItemBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    direction: z.enum(['IN', 'OUT']),
    amount: positive,
    frequency: z.enum(['ONCE', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    startDate: isoDate,
    endDate: isoDate.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
const SaveBody = z.object({ horizonDays, asOf: isoDate.optional(), note: z.string().trim().max(500).nullable().optional() }).strict();

@ApiTags('cash-flow')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/cash-flow')
export class CashFlowController {
  constructor(private readonly cash: CashFlowService) {}

  /**
   * The daily cash forecast from today (or, as a backtest, from an earlier day) over the
   * horizon: open invoices and bills at their expected settlement dates, planned items, and
   * a low and high case from customers' and vendors' payment delays.
   */
  @Get('forecast')
  @RequirePermission('reports.read')
  forecast(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ForecastQuery)) q: z.infer<typeof ForecastQuery>) {
    return this.cash.forecast(org.id, q);
  }

  @Get('settings')
  @RequirePermission('reports.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.cash.settings(org.id);
  }

  /** The minimum cash balance the forecast warns about. */
  @Put('settings')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.cash.saveSettings(org.id, user, body);
  }

  /** Planned receipts and payments not in the books yet: rent, salaries, loan instalments, taxes. */
  @Get('items')
  @RequirePermission('reports.read')
  items(@CurrentOrg() org: OrgContext) {
    return this.cash.listItems(org.id);
  }

  @Post('items')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(ItemBody) })
  createItem(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ItemBody)) body: z.infer<typeof ItemBody>) {
    return this.cash.createItem(org.id, user, body);
  }

  @Put('items/:id')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(ItemBody) })
  updateItem(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ItemBody)) body: z.infer<typeof ItemBody>) {
    return this.cash.updateItem(org.id, user, id, body);
  }

  @Delete('items/:id')
  @RequirePermission('budgets.manage')
  deleteItem(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.deleteItem(org.id, user, id);
  }

  /** Saved forecasts and backtests, newest first, each with its accuracy so far. */
  @Get('forecasts')
  @RequirePermission('reports.read')
  saved(@CurrentOrg() org: OrgContext) {
    return this.cash.listSaved(org.id);
  }

  /** Save the forecast as it stands; with an earlier `asOf` it is saved as a backtest. Saved forecasts never change. */
  @Post('forecasts')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(SaveBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SaveBody)) body: z.infer<typeof SaveBody>) {
    return this.cash.save(org.id, user, body);
  }

  @Get('forecasts/:id')
  @RequirePermission('reports.read')
  getSaved(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.getSaved(org.id, id);
  }
}
