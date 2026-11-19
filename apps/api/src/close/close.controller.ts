import { Body, Controller, Get, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ClosePackService } from './close-pack.service';
import { CloseService } from './close.service';

const periodId = z.string().uuid('Not a period id');
const id = z.string().uuid('Not an adjusting entry id');
const CloseBody = z.object({ note: z.string().trim().max(2000, 'Keep the note under 2,000 characters').nullish() }).strict();
const ReopenBody = z.object({ reason: z.string().trim().min(10, 'Say why the month is reopened (at least 10 characters)').max(2000, 'Keep the reason under 2,000 characters') }).strict();
const SettingsBody = z.object({ autoStart: z.boolean(), createTasks: z.boolean() }).strict();
const RejectBody = z.object({ note: z.string().trim().max(1000, 'Keep the note under 1,000 characters').nullish() }).strict();

@ApiTags('close')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/close')
export class CloseController {
  constructor(
    private readonly close: CloseService,
    private readonly packs: ClosePackService,
  ) {}

  /** Months up to the current one, newest first, with where each close stands. */
  @Get()
  @RequirePermission('periods.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.close.list(org);
  }

  /** Whether the close starts on its own as each month ends. Declared before :periodId. */
  @Get('settings')
  @RequirePermission('periods.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.close.settings(org);
  }

  @Put('settings')
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  updateSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) b: z.infer<typeof SettingsBody>) {
    return this.close.updateSettings(org, user, b);
  }

  /** One month's close: the checklist, the AI review and its proposed entries, and certifications. */
  @Get(':periodId')
  @RequirePermission('periods.read')
  get(@CurrentOrg() org: OrgContext, @Param('periodId', new ZodPipe(periodId)) p: string) {
    return this.close.get(org, p);
  }

  /**
   * The report pack of a closed month: a ZIP with the close certification and the month's
   * reports as PDFs, and a README listing each file's SHA-256. Recorded in the audit trail.
   */
  @Get(':periodId/report-pack')
  @RequirePermission('reports.read')
  async reportPack(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', new ZodPipe(periodId)) p: string, @Res() res: Response) {
    const file = await this.packs.pack(org, user, p);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Report-SHA256', file.sha256);
    res.end(file.body);
  }

  @Post(':periodId/start')
  @HttpCode(200)
  @RequirePermission('close.manage')
  start(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', new ZodPipe(periodId)) p: string) {
    return this.close.start(org, user, p);
  }

  /** A task for accountants for each open check that has none open yet. */
  @Post(':periodId/tasks')
  @HttpCode(200)
  @RequirePermission('close.manage')
  tasks(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', new ZodPipe(periodId)) p: string) {
    return this.close.createTasks(org, user, p);
  }

  /** Have the AI model review the month and propose adjusting entries. Runs in the background; nothing is posted. */
  @Post(':periodId/reviews')
  @RequirePermission('close.manage')
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', new ZodPipe(periodId)) p: string) {
    return this.close.startReview(org, user, p);
  }

  /** Close the month: blocking checks must pass, open warnings need a note. Locks the period and records a certification. */
  @Post(':periodId/close')
  @HttpCode(200)
  @RequirePermission('periods.lock')
  @ApiBody({ schema: openApi(CloseBody) })
  closeMonth(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', new ZodPipe(periodId)) p: string, @Body(new ZodPipe(CloseBody)) b: z.infer<typeof CloseBody>) {
    return this.close.close(org, user, p, b.note || null);
  }

  @Post(':periodId/reopen')
  @HttpCode(200)
  @RequirePermission('periods.lock')
  @ApiBody({ schema: openApi(ReopenBody) })
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', new ZodPipe(periodId)) p: string, @Body(new ZodPipe(ReopenBody)) b: z.infer<typeof ReopenBody>) {
    return this.close.reopen(org, user, p, b.reason);
  }

  /** Post a proposed adjusting entry (and its reversal, for an accrual). Needs journals.post too. */
  @Post('adjustments/:id/post')
  @HttpCode(200)
  @RequirePermission('close.manage')
  post(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) a: string) {
    return this.close.postAdjustment(org, user, a);
  }

  @Post('adjustments/:id/reject')
  @HttpCode(200)
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(RejectBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) a: string, @Body(new ZodPipe(RejectBody)) b: z.infer<typeof RejectBody>) {
    return this.close.rejectAdjustment(org, user, a, b.note || null);
  }
}
