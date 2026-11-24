import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { RegulatoryChangesService } from './regulatory-changes.service';

const Key = z.string().regex(/^[A-Z0-9-]{3,80}$/, 'Unknown change');
const Ack = z.object({ note: z.string().trim().max(1000).default('') }).strict();

/** Regulatory change monitoring (TAX-046). */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/regulatory-changes')
export class RegulatoryChangesController {
  constructor(private readonly s: RegulatoryChangesService) {}

  /** Known law changes for the organisation's country, the built-in rules with when they were checked, and scheduled rate changes. */
  @Get()
  @RequirePermission('reports.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.s.overview(org);
  }

  /** Records that the organisation has dealt with a change, with a note on how. */
  @Post(':key/dealt-with')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(Ack) })
  acknowledge(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('key', new ZodPipe(Key)) key: string, @Body(new ZodPipe(Ack)) b: z.infer<typeof Ack>) {
    return this.s.acknowledge(org, user, key, b.note);
  }
}
