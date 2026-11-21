import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { AUDITOR_LINK_DAYS } from '@talk2tax/accounting-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission } from '../auth/decorators';
import { AuthRateLimit } from '../auth/rate-limit';
import { openApi, ZodPipe } from '../common/zod';
import { AuditorPortalService } from './auditor-portal.service';

const LinkBody = z
  .object({
    auditorName: z.string().trim().min(2, 'Name the auditor').max(120, 'Keep the name under 120 characters'),
    firm: z.string().trim().max(120, 'Keep the firm under 120 characters').nullish(),
    expiresInDays: z.number().int().refine((d) => (AUDITOR_LINK_DAYS as readonly number[]).includes(d), `Choose ${AUDITOR_LINK_DAYS.join(', ')} days`),
  })
  .strict();
const token = z.string().max(100);
const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

/** Staff side of the auditor portal (AUDIT-002): links made for an engagement. */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/audit-engagements/:engagementId/auditor-links')
export class AuditorLinksController {
  constructor(private readonly svc: AuditorPortalService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@Param('engagementId', ParseUUIDPipe) engagementId: string) {
    return this.svc.links(engagementId);
  }

  /** Owners and admins give an external auditor a read-only link; the secret is shown once. */
  @Post()
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(LinkBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('engagementId', ParseUUIDPipe) engagementId: string, @Body(new ZodPipe(LinkBody)) body: z.infer<typeof LinkBody>) {
    return this.svc.createLink(org, user, engagementId, body);
  }

  @Post(':linkId/revoke')
  @RequirePermission('org.manage')
  revoke(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('engagementId', ParseUUIDPipe) engagementId: string, @Param('linkId', ParseUUIDPipe) linkId: string) {
    return this.svc.revokeLink(org, user, engagementId, linkId);
  }
}

/** The auditor portal itself: no sign-in, the link's secret is the check. Limited per IP like sign-in. */
@ApiTags('auditor portal')
@Controller('v1/auditor-portal/:token')
export class AuditorPortalController {
  constructor(private readonly svc: AuditorPortalService) {}

  @Public()
  @AuthRateLimit()
  @Get()
  overview(@Param('token', new ZodPipe(token)) t: string, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.overview(t);
  }

  @Public()
  @AuthRateLimit()
  @Get('files/:attachmentId')
  async file(@Param('token', new ZodPipe(token)) t: string, @Param('attachmentId', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.svc.file(t, id);
    noStore(res);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.content.length));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(f.content);
  }
}
