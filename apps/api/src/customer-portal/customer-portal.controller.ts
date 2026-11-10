import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { INVOICE_PAGE_CSP, PORTAL_EXPIRY_DAYS } from '@talk2tax/accounting-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission } from '../auth/decorators';
import { AuthRateLimit } from '../auth/rate-limit';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { CustomerPortalService } from './customer-portal.service';

const CreateBody = z
  .object({
    expiresInDays: z.union([z.literal(PORTAL_EXPIRY_DAYS[0]), z.literal(PORTAL_EXPIRY_DAYS[1]), z.literal(PORTAL_EXPIRY_DAYS[2]), z.literal(PORTAL_EXPIRY_DAYS[3]), z.null()], { message: 'Choose 30, 90, 180 or 365 days, or no expiry' }),
    note: z.string().trim().max(200).nullish(),
  })
  .strict();
const StatementQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() });
const token = z.string().max(100);

/** Staff side of the customer portal (AR-030): links made for a customer. */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/contacts/:contactId/portal-links')
export class CustomerPortalLinksController {
  constructor(private readonly svc: CustomerPortalService) {}

  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) contactId: string) {
    return this.svc.list(org, contactId);
  }

  @Post()
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) contactId: string, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.svc.create(org, user, contactId, body);
  }

  @Post(':linkId/revoke')
  @RequirePermission('sales.manage')
  revoke(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) contactId: string, @Param('linkId', ParseUUIDPipe) linkId: string) {
    return this.svc.revoke(org, user, contactId, linkId);
  }
}

/** The customer portal itself: no sign-in, the link's secret is the check. Limited per IP like sign-in. */
@ApiTags('customer portal')
@Controller('v1/portal/:token')
export class CustomerPortalController {
  constructor(private readonly svc: CustomerPortalService) {}

  @Public()
  @AuthRateLimit()
  @Get()
  overview(@Param('token', new ZodPipe(token)) t: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.svc.overview(t);
  }

  @Public()
  @AuthRateLimit()
  @Get('statement')
  statement(@Param('token', new ZodPipe(token)) t: string, @Query(new ZodPipe(StatementQuery)) q: z.infer<typeof StatementQuery>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'private, no-store');
    return this.svc.statement(t, q);
  }

  /** An invoice or credit note as one self-contained HTML page (no script, nothing loaded from the network). */
  @Public()
  @AuthRateLimit()
  @Get('documents/:documentId')
  async document(@Param('token', new ZodPipe(token)) t: string, @Param('documentId', ParseUUIDPipe) id: string, @Query('download') download: string | undefined, @Res() res: Response) {
    const out = await this.svc.documentHtml(t, id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', `${INVOICE_PAGE_CSP}; sandbox allow-modals`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Disposition', `${download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
    res.end(out.html);
  }
}
