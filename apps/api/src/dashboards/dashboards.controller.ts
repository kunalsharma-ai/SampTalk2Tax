import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { DashboardsService } from './dashboards.service';

// Field formats only; the engine checks what the widgets mean and explains problems in words.
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
const Config = z.object({ widgets: z.array(Widget).max(20) }).strict();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Write the month as YYYY-MM').optional();
const Definition = {
  name: z.string().trim().min(1, 'Give the dashboard a name').max(120, 'Keep the name under 120 characters'),
  description: z.string().trim().max(1000, 'Keep the description under 1000 characters').nullish(),
  config: Config,
};
const CreateBody = z.object(Definition).strict();
const UpdateBody = z.object({ ...Definition, baseVersion: z.number().int().min(1) }).strict();
const PreviewBody = z.object({ config: Config, month }).strict();
const DraftBody = z
  .object({
    request: z.string().trim().min(1, 'Describe the dashboard').max(4000, 'Keep the description under 4000 characters'),
    conversation: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(4000) }).strict()).max(20, 'Start a new draft after 20 messages').default([]),
    month,
  })
  .strict();
const MonthQuery = z.object({ month }).strict();

/**
 * Dashboards of approved metrics. Viewing needs reports.read; building, changing, deleting and
 * drafting with the AI need dashboards.manage. Customer widgets also need sales.read.
 */
@ApiTags('dashboards')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/dashboards')
export class DashboardsController {
  constructor(private readonly svc: DashboardsService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org.id);
  }

  /** Approved metrics, widget kinds and limits, for the builder. */
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

  /** Checks a configuration and works out its figures without saving it. */
  @Post('preview')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(PreviewBody) })
  preview(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(PreviewBody)) b: z.infer<typeof PreviewBody>) {
    return this.svc.preview(org, b.config, b.month);
  }

  /** Drafts a dashboard from a description. Nothing is saved. */
  @Post('ai-draft')
  @HttpCode(200)
  @RequirePermission('dashboards.manage')
  @ApiBody({ schema: openApi(DraftBody) })
  draft(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DraftBody)) b: z.infer<typeof DraftBody>) {
    return this.svc.draft(org, user, b);
  }

  @Post()
  @RequirePermission('dashboards.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.create(org, user, b);
  }

  /** A dashboard with its figures for the month (the last complete month unless given). */
  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(MonthQuery)) q: z.infer<typeof MonthQuery>) {
    return this.svc.get(org, id, q.month);
  }

  @Put(':id')
  @RequirePermission('dashboards.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.svc.update(org, user, id, b);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('dashboards.manage')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.remove(org.id, user, id);
  }
}
