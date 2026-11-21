import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { FINDING_SEVERITIES, FINDING_STATUSES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AuditFindingsService } from './audit-findings.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const RaiseBody = z
  .object({
    title: z.string().trim().max(140, 'Keep the title under 140 characters').optional(),
    description: z.string().trim().max(2000, 'Keep the description under 2000 characters').optional(),
    severity: z.enum(FINDING_SEVERITIES),
    ownerId: z.uuid(),
    plan: z.string().trim().min(10, 'Say how it will be fixed, in at least 10 characters').max(2000, 'Keep the plan under 2000 characters'),
    dueDate: isoDate.optional(),
    testId: z.uuid().optional(),
  })
  .strict();
const ProgressBody = z.object({ status: z.enum(['IN_PROGRESS', 'READY_FOR_REVIEW']), note: z.string().max(1000, 'Keep the note under 1000 characters') }).strict();
const CloseBody = z.object({ note: z.string().max(1000, 'Keep the note under 1000 characters') }).strict();
const ListQuery = z.object({ status: z.enum(FINDING_STATUSES).optional() }).strict();

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/audit-findings')
export class AuditFindingsController {
  constructor(private readonly findings: AuditFindingsService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.findings.list(org, user, q);
  }

  /** Raises a finding by hand or from a failed control test. */
  @Post()
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(RaiseBody) })
  raise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RaiseBody)) body: z.infer<typeof RaiseBody>) {
    return this.findings.raise(org, user, body);
  }

  @Get(':id')
  @RequirePermission('audit.read')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.findings.get(org, user, id);
  }

  /** The remediation owner records progress: in progress, or ready for review. */
  @Post(':id/progress')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(ProgressBody) })
  progress(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ProgressBody)) body: z.infer<typeof ProgressBody>) {
    return this.findings.progress(org, user, id, body);
  }

  /** Someone other than the remediation owner closes it once it is ready for review. */
  @Post(':id/close')
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(CloseBody) })
  close(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CloseBody)) body: z.infer<typeof CloseBody>) {
    return this.findings.close(org, user, id, body.note);
  }
}
