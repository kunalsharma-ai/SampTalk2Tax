import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ReportDesignerService } from './report-designer.service';

// Field formats only; the engine checks what the sections mean and explains problems in words.
const Widget = z
  .object({
    type: z.string().max(20),
    title: z.string().max(200),
    size: z.string().max(10).optional(),
    metric: z.string().max(40).optional(),
    metrics: z.array(z.string().max(40)).max(20).optional(),
    compare: z.string().max(30).optional(),
    months: z.number().optional(),
    count: z.number().optional(),
  })
  .strict();
const Section = z.object({ type: z.string().max(20), text: z.string().max(5000).optional(), instruction: z.string().max(1000).optional(), widget: Widget.optional() }).strict();
const Layout = z.object({ sections: z.array(Section).max(40) }).strict();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Write the month as YYYY-MM').optional();
const Design = {
  name: z.string().trim().min(1, 'Give the report a name').max(120, 'Keep the name under 120 characters'),
  description: z.string().trim().max(1000).nullish(),
  layout: Layout,
};
const CreateBody = z.object(Design).strict();
const UpdateBody = z.object({ ...Design, baseVersion: z.number().int().min(1) }).strict();
const PreviewBody = z.object({ layout: Layout, month }).strict();
const DraftBody = z
  .object({
    request: z.string().trim().min(1, 'Describe the report').max(4000, 'Keep the instructions under 4000 characters'),
    conversation: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(4000) }).strict()).max(20, 'Start a new draft after 20 messages').default([]),
    month,
  })
  .strict();
const RunBody = z.object({ month, writeCommentary: z.boolean().default(true), title: z.string().trim().max(200).nullish() }).strict();
const Version = z.object({ baseVersion: z.number().int().min(1) }).strict();
const CommentaryBody = z.object({ section: z.number().int().min(0), text: z.string().max(4000, 'Keep the commentary under 4000 characters'), baseVersion: z.number().int().min(1) }).strict();

/**
 * The report designer. Reading needs reports.read; designing, producing reports, writing
 * commentary (by hand or with the AI) and finalising need reports.design. Customer figures also
 * need sales.read when a report is produced.
 */
@ApiTags('report-designer')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/report-designer')
export class ReportDesignerController {
  constructor(private readonly svc: ReportDesignerService) {}

  @Get('catalogue')
  @RequirePermission('reports.read')
  catalogue() {
    return this.svc.catalogue();
  }

  @Get('ai-status')
  @RequirePermission('reports.read')
  aiStatus(@CurrentOrg() org: OrgContext) {
    return this.svc.aiStatus(org.id);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(PreviewBody) })
  preview(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(PreviewBody)) b: z.infer<typeof PreviewBody>) {
    return this.svc.preview(org, b.layout, b.month);
  }

  /** Drafts a report layout from instructions. Nothing is saved. */
  @Post('ai-draft')
  @HttpCode(200)
  @RequirePermission('reports.design')
  @ApiBody({ schema: openApi(DraftBody) })
  draft(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DraftBody)) b: z.infer<typeof DraftBody>) {
    return this.svc.draftDesign(org, user, b);
  }

  @Get('designs')
  @RequirePermission('reports.read')
  designs(@CurrentOrg() org: OrgContext) {
    return this.svc.listDesigns(org.id);
  }

  @Post('designs')
  @RequirePermission('reports.design')
  @ApiBody({ schema: openApi(CreateBody) })
  createDesign(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.createDesign(org.id, user, b);
  }

  @Get('designs/:id')
  @RequirePermission('reports.read')
  design(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getDesign(org.id, id);
  }

  @Put('designs/:id')
  @RequirePermission('reports.design')
  @ApiBody({ schema: openApi(UpdateBody) })
  updateDesign(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.svc.updateDesign(org.id, user, id, b);
  }

  @Delete('designs/:id')
  @HttpCode(204)
  @RequirePermission('reports.design')
  async removeDesign(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.removeDesign(org.id, user, id);
  }

  /** Produces a report for a month, with the AI writing the commentary unless asked not to. */
  @Post('designs/:id/reports')
  @RequirePermission('reports.design')
  @ApiBody({ schema: openApi(RunBody) })
  produce(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RunBody)) b: z.infer<typeof RunBody>) {
    return this.svc.createRun(org, user, id, b);
  }

  @Get('reports/:id')
  @RequirePermission('reports.read')
  report(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getRun(org.id, id);
  }

  @Put('reports/:id/commentary')
  @RequirePermission('reports.design')
  @ApiBody({ schema: openApi(CommentaryBody) })
  commentary(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CommentaryBody)) b: z.infer<typeof CommentaryBody>) {
    return this.svc.editCommentary(org.id, user, id, b);
  }

  @Post('reports/:id/write-commentary')
  @HttpCode(200)
  @RequirePermission('reports.design')
  @ApiBody({ schema: openApi(Version) })
  rewrite(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Version)) b: z.infer<typeof Version>) {
    return this.svc.rewriteCommentary(org, user, id, b.baseVersion);
  }

  @Post('reports/:id/finalise')
  @HttpCode(200)
  @RequirePermission('reports.design')
  @ApiBody({ schema: openApi(Version) })
  finalise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Version)) b: z.infer<typeof Version>) {
    return this.svc.finalise(org.id, user, id, b.baseVersion);
  }

  @Delete('reports/:id')
  @HttpCode(204)
  @RequirePermission('reports.design')
  async removeReport(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.removeRun(org.id, user, id);
  }
}
