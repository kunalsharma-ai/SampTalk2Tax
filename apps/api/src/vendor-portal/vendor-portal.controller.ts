import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { PORTAL_EXPIRY_DAYS, VENDOR_SUBMISSION_STATUSES } from '@talk2tax/accounting-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission } from '../auth/decorators';
import { AuthRateLimit } from '../auth/rate-limit';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { VendorPortalService } from './vendor-portal.service';

const LinkBody = z
  .object({
    expiresInDays: z.union([z.literal(PORTAL_EXPIRY_DAYS[0]), z.literal(PORTAL_EXPIRY_DAYS[1]), z.literal(PORTAL_EXPIRY_DAYS[2]), z.literal(PORTAL_EXPIRY_DAYS[3]), z.null()], { message: 'Choose 30, 90, 180 or 365 days, or no expiry' }),
    note: z.string().trim().max(200).nullish(),
  })
  .strict();
const ListQuery = z.object({ status: z.enum(VENDOR_SUBMISSION_STATUSES).optional(), contactId: z.uuid().optional() });
const RecordBody = z.object({ documentId: z.uuid() }).strict();
const RejectBody = z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(500) }).strict();
const SubmitBody = z
  .object({
    invoiceNumber: z.string().max(60),
    invoiceDate: z.string().max(10),
    amount: z.string().max(20),
    currency: z.string().max(3),
    purchaseOrderId: z.uuid().nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
const FileQuery = z.object({ fileName: z.string().min(1).max(255) });
const StatementQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() });
const token = z.string().max(100);
const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

/** Staff side of the vendor portal (AP-013): links made for a vendor. */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/contacts/:contactId/vendor-portal-links')
export class VendorPortalLinksController {
  constructor(private readonly svc: VendorPortalService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) contactId: string) {
    return this.svc.links(org, contactId);
  }

  @Post()
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(LinkBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) contactId: string, @Body(new ZodPipe(LinkBody)) body: z.infer<typeof LinkBody>) {
    return this.svc.createLink(org, user, contactId, body);
  }

  @Post(':linkId/revoke')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  revoke(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) contactId: string, @Param('linkId', ParseUUIDPipe) linkId: string) {
    return this.svc.revokeLink(org, user, contactId, linkId);
  }
}

/** Staff side: invoices vendors sent through the portal, to record as a bill or turn down. */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/vendor-invoices')
export class VendorInvoicesController {
  constructor(private readonly svc: VendorPortalService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.svc.submissions(org, q);
  }

  @Get(':id/file')
  @RequirePermission('purchases.read')
  async file(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const f = await this.svc.submissionFile(org, id);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.sizeBytes));
    res.setHeader('Content-Disposition', `${inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Checksum-SHA256', f.sha256);
    res.end(f.content);
  }

  @Get(':id/bills')
  @RequirePermission('purchases.read')
  bills(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.billChoices(org, id);
  }

  @Post(':id/record')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(RecordBody) })
  record(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RecordBody)) body: z.infer<typeof RecordBody>) {
    return this.svc.record(org, user, id, body.documentId);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(RejectBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>) {
    return this.svc.reject(org, user, id, body.reason);
  }
}

/** The vendor portal itself: no sign-in, the link's secret is the check. Limited per IP like sign-in. */
@ApiTags('vendor portal')
@Controller('v1/vendor-portal/:token')
export class VendorPortalController {
  constructor(private readonly svc: VendorPortalService) {}

  @Public()
  @AuthRateLimit()
  @Get()
  overview(@Param('token', new ZodPipe(token)) t: string, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.overview(t);
  }

  @Public()
  @AuthRateLimit()
  @Get('statement')
  statement(@Param('token', new ZodPipe(token)) t: string, @Query(new ZodPipe(StatementQuery)) q: z.infer<typeof StatementQuery>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.statement(t, q);
  }

  @Public()
  @AuthRateLimit()
  @Post('invoices')
  @ApiBody({ schema: openApi(SubmitBody) })
  submit(@Param('token', new ZodPipe(token)) t: string, @Body(new ZodPipe(SubmitBody)) body: z.infer<typeof SubmitBody>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.submit(t, body);
  }

  @Public()
  @AuthRateLimit()
  @Put('invoices/:id/file')
  @ApiConsumes('application/pdf', 'image/png', 'image/jpeg', 'image/webp')
  addFile(@Param('token', new ZodPipe(token)) t: string, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(FileQuery)) q: z.infer<typeof FileQuery>, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.addFile(t, id, q.fileName, Buffer.isBuffer(body) ? body : Buffer.alloc(0));
  }
}
