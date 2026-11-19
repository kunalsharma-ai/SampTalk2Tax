import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { currentTimeZone } from '../common/tenant-context';
import { openApi, ZodPipe } from '../common/zod';
import { AccessRulesService, BINDABLE_ROLES } from './access-rules.service';

const minute = z.number().int().min(0).max(1440).nullable();
const RuleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    roles: z.array(z.enum(BINDABLE_ROLES)).max(BINDABLE_ROLES.length).default([]),
    userIds: z.array(z.uuid()).max(200).default([]),
    appliesTo: z.enum(['ALL', 'CHANGES']).default('ALL'),
    networks: z.array(z.string().trim().min(2).max(64)).max(50).default([]),
    days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    startMinute: minute.default(null),
    endMinute: minute.default(null),
    active: z.boolean().default(true),
  })
  .strict();

/** Access rules (SEC-004): network and time conditions on roles and people, on top of their role. */
@ApiTags('organizations')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/access-rules')
export class AccessRulesController {
  constructor(private readonly rules: AccessRulesService) {}

  private you(req: Request, org: OrgContext, user: AuthUser) {
    return { userId: user.id, role: org.role, ip: req.ip ?? null, at: new Date(), timeZone: currentTimeZone() ?? 'Asia/Kolkata' };
  }

  @Get()
  @RequirePermission('members.read')
  list(@Req() req: Request, @CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.rules.list(org.id, this.you(req, org, user));
  }

  @Post()
  @RequirePermission('members.manage')
  @ApiBody({ schema: openApi(RuleBody) })
  create(@Req() req: Request, @CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.rules.create(org.id, this.you(req, org, user), body);
  }

  @Put(':ruleId')
  @RequirePermission('members.manage')
  @ApiBody({ schema: openApi(RuleBody) })
  update(@Req() req: Request, @CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.rules.update(org.id, this.you(req, org, user), id, body);
  }

  @Delete(':ruleId')
  @RequirePermission('members.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) id: string) {
    return this.rules.remove(org.id, user.id, id);
  }
}
