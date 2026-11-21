import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ENGAGEMENT_STATUSES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AuditEngagementsService } from './audit-engagements.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const CreateBody = z
  .object({
    name: z.string().trim().min(1, 'Name the engagement').max(120, 'Keep the name under 120 characters'),
    objective: z.string().trim().min(10, 'Say what the audit sets out to check, in at least 10 characters').max(2000, 'Keep the objective under 2000 characters'),
    scopeFrom: isoDate,
    scopeTo: isoDate,
    leadId: z.uuid(),
    reviewerId: z.uuid(),
  })
  .strict();
const StepBody = z.object({ title: z.string().trim().min(3, 'Name the step').max(200, 'Keep the step under 200 characters'), assigneeId: z.uuid() }).strict();
const DoBody = z.object({ work: z.string().max(4000, 'Keep the work under 4000 characters') }).strict();
const ReviewBody = z.object({ decision: z.enum(['SIGN_OFF', 'REOPEN']), note: z.string().max(1000, 'Keep the note under 1000 characters') }).strict();
const LinkBody = z.object({ kind: z.enum(['SAMPLE', 'FINDING']), id: z.uuid() }).strict();
const MoveBody = z.object({ status: z.enum(ENGAGEMENT_STATUSES), note: z.string().max(4000, 'Keep the note under 4000 characters') }).strict();

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/audit-engagements')
export class AuditEngagementsController {
  constructor(private readonly engagements: AuditEngagementsService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@CurrentUser() user: AuthUser) {
    return this.engagements.list(user);
  }

  @Post()
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.engagements.create(org, user, body);
  }

  @Get(':id')
  @RequirePermission('audit.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.engagements.get(user, id);
  }

  /** Samples and findings not linked to the engagement yet. */
  @Get(':id/linkable')
  @RequirePermission('audit.read')
  linkable(@Param('id', ParseUUIDPipe) id: string) {
    return this.engagements.linkable(id);
  }

  @Post(':id/steps')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(StepBody) })
  addStep(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(StepBody)) body: z.infer<typeof StepBody>) {
    return this.engagements.addStep(org, user, id, body);
  }

  @Post(':id/steps/:stepId/done')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(DoBody) })
  doStep(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('stepId', ParseUUIDPipe) stepId: string, @Body(new ZodPipe(DoBody)) body: z.infer<typeof DoBody>) {
    return this.engagements.doStep(org, user, id, stepId, body.work);
  }

  @Post(':id/steps/:stepId/review')
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(ReviewBody) })
  reviewStep(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('stepId', ParseUUIDPipe) stepId: string, @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.engagements.reviewStep(org, user, id, stepId, body.decision, body.note);
  }

  @Post(':id/links')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(LinkBody) })
  link(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(LinkBody)) body: z.infer<typeof LinkBody>) {
    return this.engagements.link(org, user, id, body);
  }

  @Post(':id/move')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(MoveBody) })
  move(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(MoveBody)) body: z.infer<typeof MoveBody>) {
    return this.engagements.move(org, user, id, body);
  }
}
