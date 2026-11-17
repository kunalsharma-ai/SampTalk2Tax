import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { TaxNoticesService } from './tax-notices.service';

const Details = {
  reference: z.string().trim().min(1).max(100),
  section: z.string().trim().max(60).nullish(),
  subject: z.string().trim().min(1).max(300),
  period: z.string().trim().max(40).nullish(),
  receivedOn: isoDate,
  responseDue: isoDate.nullish(),
  demand: decimalString.nullish(),
  assigneeId: z.uuid().nullish(),
};
const CreateBody = z.object({ authority: z.enum(['GST', 'INCOME_TAX', 'TDS', 'PF', 'ESI', 'PROFESSIONAL_TAX', 'OTHER']), ...Details });
const UpdateBody = z.object(Details);
const NoteBody = z.object({ text: z.string().trim().min(1).max(2000) });
const RespondBody = z.object({ on: isoDate, text: z.string().trim().min(3, 'Say what was sent').max(2000) });
const CloseBody = z.object({ outcome: z.enum(['DROPPED', 'DEMAND_PAID', 'APPEALED', 'OTHER']), text: z.string().trim().min(3, 'Say how it ended').max(2000) });
const ListQuery = z.object({ status: z.enum(['OPEN', 'RESPONDED', 'CLOSED']).optional() });
const FileQuery = z.object({ fileName: z.string().min(1).max(255) });

/** Tax notices (TAX-024): anyone who reads reports sees them; accounts.manage records and works them. */
@ApiTags('tax-notices')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax-notices')
export class TaxNoticesController {
  constructor(private readonly notices: TaxNoticesService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.notices.list(org, q);
  }

  @Get(':noticeId')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('noticeId', ParseUUIDPipe) id: string) {
    return this.notices.get(org, id);
  }

  @Post()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.notices.create(org, user.id, body);
  }

  @Put(':noticeId')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('noticeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.notices.update(org, user.id, id, body);
  }

  @Post(':noticeId/notes')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(NoteBody) })
  note(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('noticeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.notices.note(org, user.id, id, body.text);
  }

  @Post(':noticeId/respond')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(RespondBody) })
  respond(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('noticeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RespondBody)) body: z.infer<typeof RespondBody>) {
    return this.notices.respond(org, user.id, id, body);
  }

  @Post(':noticeId/close')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(CloseBody) })
  close(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('noticeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CloseBody)) body: z.infer<typeof CloseBody>) {
    return this.notices.close(org, user.id, id, body);
  }

  @Post(':noticeId/reopen')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(NoteBody) })
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('noticeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.notices.reopen(org, user.id, id, body.text);
  }

  /** Send the file's bytes as the body (PDF, PNG, JPEG or WebP, up to 5 MB). */
  @Post(':noticeId/files')
  @RequirePermission('accounts.manage')
  @ApiConsumes('application/octet-stream')
  addFile(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('noticeId', ParseUUIDPipe) id: string, @Query(new ZodPipe(FileQuery)) q: z.infer<typeof FileQuery>, @Body() body: unknown) {
    return this.notices.addFile(org, user.id, id, q.fileName, Buffer.isBuffer(body) ? body : Buffer.alloc(0));
  }

  @Get(':noticeId/files/:fileId/content')
  @RequirePermission('reports.read')
  async content(@Param('noticeId', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const f = await this.notices.file(id, fileId);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.sizeBytes));
    res.setHeader('Content-Disposition', `${inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Checksum-SHA256', f.sha256);
    res.end(f.content);
  }
}
