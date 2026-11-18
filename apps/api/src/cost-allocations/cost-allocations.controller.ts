import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { CostAllocationsService } from './cost-allocations.service';

const RuleBody = z.object({
  name: z.string().max(100),
  accountIds: z.array(z.string().uuid()).max(100),
  sourceDepartmentId: z.string().uuid().nullable(),
  targets: z.array(z.object({ departmentId: z.string().uuid(), percent: z.string().trim().max(20) })).max(50),
  isActive: z.boolean().optional(),
});
const Period = z.object({ from: isoDate, to: isoDate });

/** Cost allocation (GL-024): reports.read sees it, accounts.manage writes rules, close.manage runs them. */
@ApiTags('cost-allocations')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/cost-allocations')
export class CostAllocationsController {
  constructor(private readonly svc: CostAllocationsService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org);
  }

  @Post('rules')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(RuleBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.svc.create(org, user.id, body);
  }

  @Put('rules/:ruleId')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(RuleBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.svc.update(org, user.id, id, body);
  }

  @Get('rules/:ruleId/preview')
  @RequirePermission('reports.read')
  preview(@CurrentOrg() org: OrgContext, @Param('ruleId', ParseUUIDPipe) id: string, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.svc.preview(org, id, q.from, q.to);
  }

  @Post('rules/:ruleId/run')
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(Period) })
  run(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Period)) body: z.infer<typeof Period>) {
    return this.svc.run(org, user.id, id, body.from, body.to);
  }

  @Post('runs/:runId/reverse')
  @RequirePermission('close.manage')
  reverse(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) id: string) {
    return this.svc.reverse(org, user.id, id);
  }
}
