import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { RetentionService } from './retention.service';

const SetBody = z.object({ category: z.string().max(40), days: z.number().int('Use a whole number of days').nullable() }).strict();

/** Data retention policies (SEC-020). */
@ApiTags('settings')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  @RequirePermission('audit.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.retention.overview({ orgId: org.id, role: org.role });
  }

  @Put()
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(SetBody) })
  set(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SetBody)) body: z.infer<typeof SetBody>) {
    return this.retention.set({ orgId: org.id, role: org.role }, user, body.category, body.days);
  }

  @Post('run')
  @HttpCode(200)
  @RequirePermission('org.manage')
  run(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.retention.runNow({ orgId: org.id, role: org.role }, user);
  }
}
