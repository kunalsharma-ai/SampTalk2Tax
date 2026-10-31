import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, openApi, ZodPipe } from '../common/zod';
import { ApprovalsService } from './approvals.service';

const KIND = z.enum(['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT']);
const PolicyBody = z.object({ minAmount: decimalString, requireDifferentApprover: z.boolean().default(true), isActive: z.boolean().default(true) });
const ListQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  documentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const SubmitBody = z.object({ documentId: z.uuid(), note: z.string().trim().max(1000).nullish() });
const ApproveBody = z.object({ note: z.string().trim().max(1000).nullish(), post: z.boolean().default(false), overrideCreditLimit: z.boolean().default(false) });
const RejectBody = z.object({ note: z.string().trim().min(3, 'Say why, so the preparer can fix it').max(1000) });

/** Record-level permissions (sales vs purchases, approvals.decide) are checked in the service. */
@ApiTags('approvals')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('approval-policies')
  @RequirePermission('org.read')
  policies(@CurrentOrg() org: OrgContext) {
    return this.approvals.policies(org);
  }

  @Put('approval-policies/:kind')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(PolicyBody) })
  setPolicy(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('kind', new ZodPipe(KIND)) kind: z.infer<typeof KIND>, @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>) {
    return this.approvals.setPolicy(org, user, kind, body);
  }

  @Get('approvals')
  @RequirePermission('org.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.approvals.list(org, user, q);
  }

  @Get('approvals/for-document/:documentId')
  @RequirePermission('org.read')
  forDocument(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string) {
    return this.approvals.forDocument(org, user, id);
  }

  @Post('approvals')
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(SubmitBody) })
  submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SubmitBody)) body: z.infer<typeof SubmitBody>) {
    return this.approvals.submit(org, user, body);
  }

  @Post('approvals/:requestId/approve')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(ApproveBody) })
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('requestId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ApproveBody)) body: z.infer<typeof ApproveBody>) {
    return this.approvals.approve(org, user, id, body);
  }

  @Post('approvals/:requestId/reject')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(RejectBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('requestId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>) {
    return this.approvals.reject(org, user, id, body.note);
  }

  @Post('approvals/:requestId/withdraw')
  @HttpCode(200)
  @RequirePermission('org.read')
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('requestId', ParseUUIDPipe) id: string) {
    return this.approvals.withdraw(org, user, id);
  }
}
