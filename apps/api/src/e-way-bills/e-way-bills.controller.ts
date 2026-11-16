import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { EWayBillsService } from './e-way-bills.service';

const amount = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'An amount such as 50000');
const SettingsBody = z
  .object({
    threshold: amount,
    intraStateThreshold: amount.nullable().optional(),
    address1: z.string().trim().min(1).max(120),
    address2: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().min(1).max(50),
    pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'A 6-digit PIN code'),
    goodsUnit: z.string().regex(/^[A-Za-z]{3}$/, 'A 3-letter GST unit code such as NOS'),
  })
  .strict();
const RangeQuery = z.object({ from: isoDate, to: isoDate });
const mode = z.enum(['ROAD', 'RAIL', 'AIR', 'SHIP']);
const Transport = z
  .object({
    mode: mode.nullable(),
    distanceKm: z.number().int().min(1).max(4000),
    vehicleNo: z.string().trim().max(20).nullable().optional(),
    vehicleType: z.enum(['R', 'O']).default('R'),
    transporterId: z.string().trim().toUpperCase().max(15).nullable().optional(),
    transporterName: z.string().trim().max(100).nullable().optional(),
    transDocNo: z.string().trim().max(15).nullable().optional(),
    transDocDate: isoDate.nullable().optional(),
  })
  .strict();
const JsonBody = z.object({ transport: Transport }).strict();
const RecordBody = z
  .object({
    number: z.string().regex(/^[0-9]{12}$/, 'The e-way bill number is 12 digits'),
    generatedAt: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
    transport: Transport,
  })
  .strict();
const VehicleBody = z
  .object({
    updatedAt: z.string().datetime({ offset: true }).optional(),
    mode,
    vehicleNo: z.string().trim().max(20).nullable().optional(),
    transDocNo: z.string().trim().max(15).nullable().optional(),
    transDocDate: isoDate.nullable().optional(),
    fromPlace: z.string().trim().min(1).max(50),
    fromStateCode: z.string().regex(/^[0-9]{2}$/),
    reason: z.enum(['1', '2', '3', '4']),
    remark: z.string().trim().min(1).max(50),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const CancelBody = z
  .object({
    cancelledAt: z.string().datetime({ offset: true }).optional(),
    reason: z.enum(['1', '2', '3', '4']),
    remark: z.string().trim().min(3).max(50),
  })
  .strict();

@ApiTags('e-way-bills')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/e-way-bills')
export class EWayBillsController {
  constructor(private readonly e: EWayBillsService) {}

  @Get('settings')
  @RequirePermission('accounts.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.e.getSettings(org.id);
  }

  /** The value threshold (and a state's own one for movement within it) and the address goods are dispatched from. */
  @Put('settings')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.e.saveSettings(org.id, user, body);
  }

  /** Invoices in the range with whether they need an e-way bill and the e-way bill's state. */
  @Get('documents')
  @RequirePermission('sales.read')
  register(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.e.register(org.id, q.from, q.to);
  }

  @Get('documents/:id')
  @RequirePermission('sales.read')
  document(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.e.getDocument(org.id, id);
  }

  /** The bulk-upload JSON for the portal with these transport details (`version`, `billLists`). */
  @Post('documents/:id/json')
  @HttpCode(200)
  @RequirePermission('sales.read')
  @ApiBody({ schema: openApi(JsonBody) })
  json(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(JsonBody)) body: z.infer<typeof JsonBody>) {
    return this.e.payload(org.id, id, body.transport);
  }

  /** Record the e-way bill the portal generated: number, generation time, validity and the transport details used. */
  @Post('documents/:id/e-way-bill')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(RecordBody) })
  record(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RecordBody)) body: z.infer<typeof RecordBody>) {
    return this.e.record(org.id, user, id, body);
  }

  /** Record a Part B update made on the portal (first vehicle, breakdown, transhipment). */
  @Post('documents/:id/e-way-bill/vehicle')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(VehicleBody) })
  vehicle(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(VehicleBody)) body: z.infer<typeof VehicleBody>) {
    return this.e.updateVehicle(org.id, user, id, body);
  }

  /** Record that the e-way bill was cancelled on the portal, within 24 hours of generation. */
  @Post('documents/:id/e-way-bill/cancel')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(CancelBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CancelBody)) body: z.infer<typeof CancelBody>) {
    return this.e.cancel(org.id, user, id, body);
  }
}
