import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AttachmentsService } from './attachments.service';

const ENTITIES = ['DOCUMENT', 'PAYMENT', 'JOURNAL_ENTRY', 'BANK_STATEMENT_LINE', 'EXPENSE_CLAIM', 'CUSTOMER_ONBOARDING'] as const;
const ListQuery = z.object({
  entityType: z.enum(ENTITIES),
  entityId: z.uuid(),
  includeRemoved: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
const UploadQuery = z.object({ entityType: z.enum(ENTITIES), entityId: z.uuid(), fileName: z.string().min(1).max(255) });
const RemoveBody = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * Record-level permissions are checked in the service (who may see a bill's files is
 * decided by purchases.read, a journal's by journals.read, and so on); the route only
 * requires membership.
 */
@ApiTags('attachments')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  @RequirePermission('org.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.attachments.list(org, user, q.entityType, q.entityId, q.includeRemoved);
  }

  /** Send the file's bytes as the body (Content-Type: application/pdf, image/png, image/jpeg, image/webp or application/octet-stream). */
  @Post()
  @RequirePermission('org.read')
  @ApiConsumes('application/octet-stream')
  upload(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(UploadQuery)) q: z.infer<typeof UploadQuery>, @Body() body: unknown) {
    return this.attachments.upload(org, user, { ...q, content: Buffer.isBuffer(body) ? body : Buffer.alloc(0) });
  }

  @Get(':attachmentId/content')
  @RequirePermission('org.read')
  async content(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('attachmentId', ParseUUIDPipe) id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const a = await this.attachments.content(org, user, id);
    res.setHeader('Content-Type', a.contentType);
    res.setHeader('Content-Length', String(a.sizeBytes));
    res.setHeader('Content-Disposition', `${inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Checksum-SHA256', a.sha256);
    res.end(Buffer.from(a.content));
  }

  @Post(':attachmentId/remove')
  @HttpCode(200)
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(RemoveBody) })
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('attachmentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RemoveBody)) body: z.infer<typeof RemoveBody>) {
    return this.attachments.remove(org, user, id, body.reason);
  }
}
