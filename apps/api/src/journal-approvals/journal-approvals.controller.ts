import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { JournalApprovalsService } from './journal-approvals.service';

const PolicyBody = z.object({ minAmount: z.string().trim().min(1).max(30), isActive: z.boolean() });
const NoteBody = z.object({ note: z.string().max(1000).nullish() });
const ListQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).default('PENDING') });

/** Approval of manual journals (SEC-036). */
@ApiTags('journal-approvals')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class JournalApprovalsController {
  constructor(private readonly svc: JournalApprovalsService) {}

  @Get('journal-approvals/policy')
  @RequirePermission('journals.read')
  policy(@CurrentOrg() org: OrgContext) {
    return this.svc.policy(org);
  }

  @Put('journal-approvals/policy')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(PolicyBody) })
  setPolicy(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>) {
    return this.svc.setPolicy(org, user.id, body);
  }

  @Get('journal-approvals')
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.svc.list(org, user.id, q.status);
  }

  @Get('journals/:entryId/approval')
  @RequirePermission('journals.read')
  forEntry(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('entryId', ParseUUIDPipe) id: string) {
    return this.svc.forEntry(org, id, user.id);
  }

  @Post('journals/:entryId/approval')
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(NoteBody) })
  request(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('entryId', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.svc.request(org, user.id, id, body.note ?? null);
  }

  @Post('journal-approvals/:requestId/approve')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(NoteBody) })
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('requestId', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.svc.decide(org, user.id, id, 'APPROVED', body.note ?? null);
  }

  @Post('journal-approvals/:requestId/reject')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(NoteBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('requestId', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.svc.decide(org, user.id, id, 'REJECTED', body.note ?? null);
  }

  @Post('journal-approvals/:requestId/withdraw')
  @HttpCode(200)
  @RequirePermission('journals.create')
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('requestId', ParseUUIDPipe) id: string) {
    return this.svc.withdraw(org, user.id, id);
  }
}
