import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ACCOUNT_TYPES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AccountsService } from './accounts.service';

const code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9.\-]{0,31}$/, 'Code: letters, digits, dot or dash, max 32');
const CreateBody = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.string().max(64).optional(),
  description: z.string().max(1000).optional(),
  parentId: z.uuid().nullable().optional(),
  isPostable: z.boolean().optional(),
});
const UpdateBody = z
  .object({
    code: code.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    subtype: z.string().max(64).nullable().optional(),
    description: z.string().max(1000).nullable().optional(),
    parentId: z.uuid().nullable().optional(),
    isPostable: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
const ListQuery = z.object({
  includeInactive: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  type: z.enum(ACCOUNT_TYPES).optional(),
});

@ApiTags('accounts')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @RequirePermission('accounts.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.accounts.list(org.id, q);
  }

  @Get(':accountId')
  @RequirePermission('accounts.read')
  get(@CurrentOrg() org: OrgContext, @Param('accountId', ParseUUIDPipe) id: string) {
    return this.accounts.get(org.id, id);
  }

  @Post()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.accounts.create(org.id, user.id, body);
  }

  @Patch(':accountId')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ) {
    return this.accounts.update(org.id, user.id, id, body);
  }
}
