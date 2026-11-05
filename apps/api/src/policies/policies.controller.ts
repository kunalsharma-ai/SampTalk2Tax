import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { WORKFLOW_TRIGGERS, type PolicyRule, type PolicyTest } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ActionBody, ConditionBody, TriggerParamsBody } from '../workflows/workflows.controller';
import { PoliciesService } from './policies.service';

// Field formats only; the engine checks what the rules and tests mean and explains problems in words.
const Rule = z
  .object({
    name: z.string().max(120),
    trigger: z.enum(WORKFLOW_TRIGGERS),
    triggerParams: TriggerParamsBody.default({}),
    conditions: z.array(ConditionBody).max(20),
    actions: z.array(ActionBody).max(10),
  })
  .strict();
const Test = z
  .object({
    rule: z.number().int(),
    label: z.string().max(200),
    facts: z.record(z.string().max(40), z.string().max(200).nullable()).refine((f) => Object.keys(f).length <= 30, 'At most 30 facts in a test'),
    expect: z.enum(['ACTS', 'DOES_NOT_ACT']),
  })
  .strict();
const Definition = {
  name: z.string().trim().min(1, 'Give the policy a name').max(120, 'Keep the name under 120 characters'),
  statement: z.string().trim().min(1, 'Write the policy in words').max(4000, 'Keep the policy under 4000 characters'),
  rules: z.array(Rule).max(10, 'At most 10 rules in a policy'),
  tests: z.array(Test).max(30, 'At most 30 tests in a policy'),
  note: z.string().trim().max(500).nullish(),
};
const CreateBody = z.object(Definition).strict();
const CheckBody = z.object({ ...Definition, name: z.string().max(120), statement: z.string().max(4000) }).strict();
const UpdateBody = z.object({ ...Definition, baseVersion: z.number().int().min(1) }).strict();
const ApproveBody = z.object({ version: z.number().int().min(1), note: z.string().trim().max(500).nullish() }).strict();
const RetireBody = z.object({ note: z.string().trim().max(500).nullish() }).strict();
const BacktestBody = z.object({ rules: z.array(Rule).min(1, 'Add at least one rule').max(10) }).strict();
const DraftBody = z
  .object({
    statement: z.string().trim().min(1, 'Describe the policy').max(4000, 'Keep the policy under 4000 characters'),
    conversation: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(4000) }).strict()).max(20, 'Start a new draft after 20 messages').default([]),
  })
  .strict();

/**
 * Financial policies. Reading needs reports.read; writing and drafting with the AI need
 * policies.manage; approving (which turns the rules into running workflows) and retiring need
 * workflows.manage, and approval needs someone other than the last editor.
 */
@ApiTags('policies')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/policies')
export class PoliciesController {
  constructor(private readonly svc: PoliciesService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org.id);
  }

  /** Triggers with their facts, operators and roles, for the rule editor. */
  @Get('catalogue')
  @RequirePermission('reports.read')
  catalogue(@CurrentOrg() org: OrgContext) {
    return this.svc.catalogue(org.id);
  }

  @Get('ai-status')
  @RequirePermission('reports.read')
  aiStatus(@CurrentOrg() org: OrgContext) {
    return this.svc.aiStatus(org.id);
  }

  /** Drafts rules and tests from the policy in words. Nothing is saved as a policy. */
  @Post('ai-draft')
  @HttpCode(200)
  @RequirePermission('policies.manage')
  @ApiBody({ schema: openApi(DraftBody) })
  draft(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DraftBody)) b: z.infer<typeof DraftBody>) {
    return this.svc.draft(org.id, user, b);
  }

  /** Runs rules being edited against the last 90 days of events. */
  @Post('backtest')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(BacktestBody) })
  backtest(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(BacktestBody)) b: z.infer<typeof BacktestBody>) {
    return this.svc.backtest(org.id, b.rules as PolicyRule[]);
  }

  /** Checks a policy being edited, and runs its tests, without saving it. */
  @Post('check')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(CheckBody) })
  check(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(CheckBody)) b: z.infer<typeof CheckBody>) {
    return this.svc.check(org.id, { ...b, rules: b.rules as PolicyRule[], tests: b.tests as PolicyTest[] });
  }

  @Post()
  @RequirePermission('policies.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.create(org.id, user, { ...b, rules: b.rules as PolicyRule[], tests: b.tests as PolicyTest[] });
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(org.id, id);
  }

  @Put(':id')
  @RequirePermission('policies.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.svc.update(org.id, user, id, { ...b, rules: b.rules as PolicyRule[], tests: b.tests as PolicyTest[] });
  }

  /** The saved rules against the last 90 days of events. */
  @Get(':id/backtest')
  @RequirePermission('reports.read')
  async savedBacktest(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.svc.get(org.id, id);
    return this.svc.backtest(org.id, p.rules);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('workflows.manage')
  @ApiBody({ schema: openApi(ApproveBody) })
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ApproveBody)) b: z.infer<typeof ApproveBody>) {
    return this.svc.approve(org, user, id, b);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @RequirePermission('workflows.manage')
  @ApiBody({ schema: openApi(RetireBody) })
  retire(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RetireBody)) b: z.infer<typeof RetireBody>) {
    return this.svc.retire(org, user, id, b.note ?? null);
  }
}
