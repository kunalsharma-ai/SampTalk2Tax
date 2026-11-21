import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { EVIDENCE_STATUSES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AuditEvidenceService } from './audit-evidence.service';

const CreateBody = z
  .object({
    engagementId: z.uuid(),
    title: z.string().trim().min(3, 'Say what evidence is needed').max(200, 'Keep the title under 200 characters'),
    details: z.string().trim().max(2000, 'Keep the details under 2000 characters'),
    ownerId: z.uuid(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  })
  .strict();
const SubmitBody = z.object({ note: z.string().max(1000, 'Keep the note under 1000 characters') }).strict();
const ReviewBody = z.object({ decision: z.enum(['ACCEPT', 'RETURN']), note: z.string().max(1000, 'Keep the note under 1000 characters') }).strict();
const ListQuery = z.object({ engagementId: z.uuid().optional(), status: z.enum(EVIDENCE_STATUSES).optional() }).strict();

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/audit-evidence')
export class AuditEvidenceController {
  constructor(private readonly evidence: AuditEvidenceService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.evidence.list(user, q);
  }

  /** The engagement lead asks a member for evidence. */
  @Post()
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.evidence.create(org, user, body);
  }

  @Get(':id')
  @RequirePermission('audit.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.evidence.get(user, id);
  }

  /** Submits the files attached to the request (upload them with entityType AUDIT_EVIDENCE). */
  @Post(':id/submit')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(SubmitBody) })
  submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SubmitBody)) body: z.infer<typeof SubmitBody>) {
    return this.evidence.submit(org, user, id, body.note);
  }

  @Post(':id/review')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.evidence.review(org, user, id, body.decision, body.note);
  }
}
