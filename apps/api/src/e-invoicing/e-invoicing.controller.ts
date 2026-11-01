import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { EInvoicingService } from './e-invoicing.service';

const SettingsBody = z
  .object({
    applicableFrom: isoDate,
    aatoTenCroreOrMore: z.boolean(),
    tradeName: z.string().trim().min(3).max(100).nullable().optional(),
    address1: z.string().trim().min(1).max(100),
    address2: z.string().trim().max(100).nullable().optional(),
    city: z.string().trim().min(3).max(50),
    pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'A 6-digit PIN code'),
    goodsUnit: z.string().regex(/^[A-Za-z]{3}$/, 'A 3-letter GST unit code such as NOS'),
    irpPublicKey: z.string().max(5000).nullable().optional(),
  })
  .strict();
const RangeQuery = z.object({ from: isoDate, to: isoDate });
const BulkBody = z.object({ documentIds: z.array(z.string().uuid()).min(1).max(100) }).strict();
const ImportBody = z.object({ response: z.record(z.string(), z.unknown()) }).strict();
const CancelBody = z
  .object({
    cancelledAt: z.string().datetime({ offset: true }).optional(),
    reason: z.enum(['1', '2', '3', '4']),
    remark: z.string().trim().min(3).max(100),
  })
  .strict();

@ApiTags('e-invoicing')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/e-invoicing')
export class EInvoicingController {
  constructor(private readonly e: EInvoicingService) {}

  @Get('settings')
  @RequirePermission('accounts.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.e.getSettings(org.id);
  }

  /** The seller details printed on every e-invoice, when e-invoicing applies, whether the 30-day limit applies, and optionally the IRP public key for verifying signatures. */
  @Put('settings')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.e.saveSettings(org.id, user, body);
  }

  /** Invoices and credit notes in the range with their e-invoice state. */
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

  /** The INV-01 (schema 1.1) JSON to upload to the IRP. */
  @Get('documents/:id/json')
  @RequirePermission('sales.read')
  json(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.e.payload(org.id, id);
  }

  /** JSON for several documents, as one array; documents that are not ready are listed in `skipped`. */
  @Post('bulk-json')
  @HttpCode(200)
  @RequirePermission('sales.read')
  @ApiBody({ schema: openApi(BulkBody) })
  bulk(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(BulkBody)) body: z.infer<typeof BulkBody>) {
    return this.e.bulkPayload(org.id, body.documentIds);
  }

  /** Record the IRN from the IRP's response (Irn, AckNo, AckDt, SignedInvoice, SignedQRCode), after checking it is for this document. */
  @Post('documents/:id/irn')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ImportBody) })
  importIrn(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>) {
    return this.e.importResponse(org.id, user, id, body.response);
  }

  /** Record that the IRN was cancelled on the IRP, within 24 hours of its acknowledgement. */
  @Post('documents/:id/irn/cancel')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(CancelBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CancelBody)) body: z.infer<typeof CancelBody>) {
    return this.e.cancel(org.id, user, id, body);
  }
}
