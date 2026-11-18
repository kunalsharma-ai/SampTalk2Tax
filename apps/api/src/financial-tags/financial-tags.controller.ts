import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { FinancialTagsService } from './financial-tags.service';

const Value = z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(100), isActive: z.boolean().optional() });
const CreateBody = z.object({ key: z.string().trim().min(1).max(32), label: z.string().trim().min(1).max(60), isActive: z.boolean().optional(), values: z.array(Value).max(500) });
const UpdateBody = CreateBody.omit({ key: true });
const ProfitQuery = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), from: isoDate, to: isoDate });

/** Financial tags (GL-031) such as locations (GL-028): accounts.read sees them, accounts.manage defines them. */
@ApiTags('financial-tags')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class FinancialTagsController {
  constructor(private readonly tags: FinancialTagsService) {}

  @Get('financial-tags')
  @RequirePermission('accounts.read')
  list() {
    return this.tags.list();
  }

  @Post('financial-tags')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.tags.create(org, user.id, body);
  }

  @Put('financial-tags/:tagId')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('tagId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.tags.update(org, user.id, id, body);
  }

  @Get('reports/profit-by-tag')
  @RequirePermission('reports.read')
  profitByTag(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ProfitQuery)) q: z.infer<typeof ProfitQuery>) {
    return this.tags.profitByTag(org, q);
  }
}
