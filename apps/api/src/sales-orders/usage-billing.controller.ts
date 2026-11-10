import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { METER_CODE_PATTERN, USAGE_PRICING } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { UsageBillingService } from './usage-billing.service';

const id = z.string().uuid('Not a valid id');
const code = z.string().trim().regex(METER_CODE_PATTERN, 'A meter code is letters, digits, dot, dash or underscore, up to 40');
const Meter = z
  .object({
    code,
    name: z.string().trim().min(1, 'Name the usage charge').max(120),
    unit: z.string().trim().min(1, 'Name the unit, such as call or GB').max(30),
    accountId: z.string().uuid('Choose an income account'),
    taxRateId: id.nullish(),
    hsnCode: z.string().trim().max(8).nullish(),
    pricing: z.enum(USAGE_PRICING),
    tiers: z.array(z.object({ upTo: decimalString.nullable(), unitPrice: decimalString }).strict()).min(1, 'Give at least one price').max(20),
    includedQuantity: decimalString.nullish(),
    minimumCharge: decimalString.nullish(),
    active: z.boolean().optional(),
  })
  .strict();
const signed = z.string().regex(/^-?\d{1,18}(\.\d{1,10})?$/, 'Expected a decimal quantity, e.g. "1250" or "-20"');
const Usage = z.object({ meterId: id, date: isoDate, quantity: signed, reference: z.string().trim().max(100).nullish(), note: z.string().trim().max(500).nullish() }).strict();
const ImportBody = z
  .object({ rows: z.array(z.object({ meter: code, date: isoDate, quantity: signed, reference: z.string().trim().max(100).nullish() }).strict()).min(1, 'Nothing to import').max(5000, 'Import at most 5,000 rows at a time') })
  .strict();
const VoidBody = z.object({ reason: z.string().trim().min(3, 'Say why it is voided').max(500) }).strict();
const ListQuery = z.object({ periodNo: z.coerce.number().int().min(1).optional(), all: z.enum(['true', 'false']).optional() });

/** Usage-based billing (AR-012): meters on a contract and the usage recorded against them. */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/contracts/:contractId')
export class UsageBillingController {
  constructor(private readonly svc: UsageBillingService) {}

  @Get('meters')
  @RequirePermission('sales.read')
  meters(@CurrentOrg() org: OrgContext, @Param('contractId', ParseUUIDPipe) cid: string) {
    return this.svc.meters(org, cid);
  }

  @Post('meters')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(Meter) })
  addMeter(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contractId', ParseUUIDPipe) cid: string, @Body(new ZodPipe(Meter)) body: z.infer<typeof Meter>) {
    return this.svc.addMeter(org, user, cid, body);
  }

  @Put('meters/:meterId')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(Meter) })
  updateMeter(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contractId', ParseUUIDPipe) cid: string, @Param('meterId', ParseUUIDPipe) mid: string, @Body(new ZodPipe(Meter)) body: z.infer<typeof Meter>) {
    return this.svc.updateMeter(org, user, cid, mid, body);
  }

  @Delete('meters/:meterId')
  @RequirePermission('sales.manage')
  removeMeter(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contractId', ParseUUIDPipe) cid: string, @Param('meterId', ParseUUIDPipe) mid: string) {
    return this.svc.removeMeter(org, user, cid, mid);
  }

  @Get('usage')
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Param('contractId', ParseUUIDPipe) cid: string, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.svc.list(org, cid, { periodNo: q.periodNo, all: q.all === 'true' });
  }

  /** One reading. A repeated reference on the same meter is not recorded twice. */
  @Post('usage')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(Usage) })
  record(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contractId', ParseUUIDPipe) cid: string, @Body(new ZodPipe(Usage)) body: z.infer<typeof Usage>) {
    return this.svc.record(org, user, cid, body, 'MANUAL');
  }

  /** Many readings by meter code (from a CSV file or another system). All or nothing. */
  @Post('usage/import')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ImportBody) })
  import(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contractId', ParseUUIDPipe) cid: string, @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>) {
    return this.svc.import(org, user, cid, body.rows, 'IMPORT');
  }

  @Post('usage/:usageId/void')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(VoidBody) })
  void(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contractId', ParseUUIDPipe) cid: string, @Param('usageId', ParseUUIDPipe) uid: string, @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>) {
    return this.svc.void(org, user, cid, uid, body.reason);
  }
}
