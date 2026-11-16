import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ASSIGNABLE_ROLES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { TasksService } from './tasks.service';

const id = z.string().uuid('Not a task id');
const ListQuery = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['OPEN', 'DONE', 'CANCELLED', 'ALL']).default('OPEN'),
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');
const CreateBody = z
  .object({
    title: z.string().trim().min(1, 'Give the task a title').max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    assignTo: z.union([z.object({ role: z.enum(ASSIGNABLE_ROLES) }).strict(), z.object({ userId: z.string().uuid('Choose a member') }).strict()]),
    dueDate: isoDate.nullable().default(null),
  })
  .strict();
const CloseBody = z.object({ note: z.string().trim().max(1000).nullable().optional() }).strict();

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** Tasks for me and my role (scope=mine), or every task (scope=all, owners and admins). */
  @Get()
  @RequirePermission('tasks.use')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.tasks.list(org, user, q);
  }

  @Get('count')
  @RequirePermission('tasks.use')
  count(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.tasks.count(org, user);
  }

  @Post()
  @RequirePermission('tasks.use')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.tasks.create(org, user, body);
  }

  @Get(':taskId')
  @RequirePermission('tasks.use')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('taskId', new ZodPipe(id)) taskId: string) {
    return this.tasks.get(org, user, taskId);
  }

  @Post(':taskId/complete')
  @HttpCode(200)
  @RequirePermission('tasks.use')
  @ApiBody({ schema: openApi(CloseBody) })
  complete(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('taskId', new ZodPipe(id)) taskId: string, @Body(new ZodPipe(CloseBody)) body: z.infer<typeof CloseBody>) {
    return this.tasks.close(org, user, taskId, 'DONE', body.note || null);
  }

  @Post(':taskId/cancel')
  @HttpCode(200)
  @RequirePermission('tasks.use')
  @ApiBody({ schema: openApi(CloseBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('taskId', new ZodPipe(id)) taskId: string, @Body(new ZodPipe(CloseBody)) body: z.infer<typeof CloseBody>) {
    return this.tasks.close(org, user, taskId, 'CANCELLED', body.note || null);
  }
}
