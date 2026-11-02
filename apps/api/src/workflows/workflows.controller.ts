import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ASSIGNABLE_ROLES, SCHEDULE_FREQUENCIES, WORKFLOW_TRIGGERS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { WorkflowsService } from './workflows.service';

const id = z.string().uuid('Not a workflow id');
const runId = z.string().uuid('Not a run id');
const position = z.coerce.number().int().min(0).max(20);

const ConditionBody = z.object({ fact: z.string().max(40), op: z.string().max(20), value: z.union([z.string().max(200), z.array(z.string().max(40)).max(20)]).optional() }).strict();
const ActionBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('CREATE_TASK'),
      title: z.string().max(200),
      description: z.string().max(2000).optional(),
      assignTo: z.union([z.object({ role: z.enum(ASSIGNABLE_ROLES) }).strict(), z.object({ userId: z.string().uuid('Choose a member') }).strict()]),
      dueInDays: z.number().int().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('WEBHOOK'), url: z.string().max(500) }).strict(),
  z
    .object({
      type: z.literal('SEND_EMAIL'),
      to: z.union([z.object({ role: z.enum(ASSIGNABLE_ROLES) }).strict(), z.object({ userId: z.string().uuid('Choose a member') }).strict(), z.object({ contact: z.literal(true) }).strict()]),
      subject: z.string().max(300),
      body: z.string().max(6000),
    })
    .strict(),
]);
/** Settings of a schedule trigger; the rules engine checks which apply to which trigger. */
const TriggerParamsBody = z
  .object({
    frequency: z.enum(SCHEDULE_FREQUENCIES).optional(),
    time: z.string().max(5).optional(),
    weekday: z.number().int().optional(),
    dayOfMonth: z.number().int().optional(),
    days: z.number().optional(),
  })
  .strict();
const Definition = {
  name: z.string().trim().min(1, 'Give the workflow a name').max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  trigger: z.enum(WORKFLOW_TRIGGERS),
  triggerParams: TriggerParamsBody.default({}),
  conditions: z.array(ConditionBody).max(20),
  actions: z.array(ActionBody).max(10),
};
const CreateBody = z.object(Definition).strict();
const UpdateBody = z.object({ ...Definition, baseVersion: z.number().int().min(1), note: z.string().trim().max(500).nullable().optional() }).strict();
const TestBody = z.object({ eventId: z.string().regex(/^\d{1,18}$/, 'Not an event id').optional(), sendWebhooks: z.boolean().default(false) }).strict();
const RunsQuery = z.object({
  status: z.enum(['SKIPPED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TEST']).optional(),
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags('workflows')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  /** Triggers with their facts and settings, condition operators, roles and members a task or email can go to, and whether email is set up. */
  @Get('workflows/catalogue')
  @RequirePermission('workflows.manage')
  catalogue(@CurrentOrg() org: OrgContext) {
    return this.workflows.catalogue(org.id);
  }

  @Get('workflows')
  @RequirePermission('workflows.manage')
  list(@CurrentOrg() org: OrgContext) {
    return this.workflows.list(org.id);
  }

  /** A new workflow starts off. Turn it on when it has been tested. */
  @Post('workflows')
  @RequirePermission('workflows.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.workflows.create(org, user, body as never);
  }

  @Get('workflows/:workflowId')
  @RequirePermission('workflows.manage')
  get(@CurrentOrg() org: OrgContext, @Param('workflowId', new ZodPipe(id)) workflowId: string) {
    return this.workflows.get(org.id, workflowId);
  }

  /** Saves a change. A change to what the workflow does makes a new version. */
  @Put('workflows/:workflowId')
  @RequirePermission('workflows.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('workflowId', new ZodPipe(id)) workflowId: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.workflows.update(org, user, workflowId, body as never);
  }

  @Post('workflows/:workflowId/turn-on')
  @HttpCode(200)
  @RequirePermission('workflows.manage')
  turnOn(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('workflowId', new ZodPipe(id)) workflowId: string) {
    return this.workflows.setEnabled(org, user, workflowId, true);
  }

  @Post('workflows/:workflowId/turn-off')
  @HttpCode(200)
  @RequirePermission('workflows.manage')
  turnOff(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('workflowId', new ZodPipe(id)) workflowId: string) {
    return this.workflows.setEnabled(org, user, workflowId, false);
  }

  /** A new signing secret for this workflow's webhooks. The old one stops working at once. */
  @Post('workflows/:workflowId/rotate-secret')
  @HttpCode(200)
  @RequirePermission('workflows.manage')
  rotate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('workflowId', new ZodPipe(id)) workflowId: string) {
    return this.workflows.rotateSecret(org, user, workflowId);
  }

  /** A dry run on the latest real event (or the one given). Creates nothing; sends test webhooks only when asked. */
  @Post('workflows/:workflowId/test')
  @HttpCode(200)
  @RequirePermission('workflows.manage')
  @ApiBody({ schema: openApi(TestBody) })
  test(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('workflowId', new ZodPipe(id)) workflowId: string, @Body(new ZodPipe(TestBody)) body: z.infer<typeof TestBody>) {
    return this.workflows.test(org, user, workflowId, body);
  }

  @Get('workflows/:workflowId/runs')
  @RequirePermission('workflows.manage')
  runs(@CurrentOrg() org: OrgContext, @Param('workflowId', new ZodPipe(id)) workflowId: string, @Query(new ZodPipe(RunsQuery)) q: z.infer<typeof RunsQuery>) {
    return this.workflows.runs(org.id, workflowId, q);
  }

  @Get('workflow-runs/:runId')
  @RequirePermission('workflows.manage')
  run(@CurrentOrg() org: OrgContext, @Param('runId', new ZodPipe(runId)) id: string) {
    return this.workflows.run(org.id, id);
  }

  /** Sends a failed webhook again, now. */
  @Post('workflow-runs/:runId/actions/:position/retry')
  @HttpCode(200)
  @RequirePermission('workflows.manage')
  retry(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', new ZodPipe(runId)) id: string, @Param('position', new ZodPipe(position)) pos: number) {
    return this.workflows.retry(org, user, id, pos);
  }
}
