import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { isSupportedCurrency } from '@talk2tax/accounting-engine';
import { ROLES } from '@talk2tax/security';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { OrganizationsService } from './organizations.service';

const CreateOrgBody = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(300).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, e.g. IN'),
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/).refine(isSupportedCurrency, 'Unsupported currency'),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  chartTemplate: z.enum(['GENERIC_SMB', 'EMPTY']).default('GENERIC_SMB'),
});
const AddMemberBody = z.object({ email: z.email(), role: z.enum(ROLES) });

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('v1/orgs')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  @ApiBody({ schema: openApi(CreateOrgBody) })
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateOrgBody)) body: z.infer<typeof CreateOrgBody>) {
    const org = await this.orgs.create(user.id, body);
    return this.orgs.get(org.id);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.orgs.listForUser(user.id);
  }

  @Get(':orgId')
  @RequirePermission('org.read')
  get(@Param('orgId') orgId: string) {
    return this.orgs.get(orgId);
  }

  @Get(':orgId/members')
  @RequirePermission('members.read')
  members(@Param('orgId') orgId: string) {
    return this.orgs.listMembers(orgId);
  }

  @Post(':orgId/members')
  @RequirePermission('members.manage')
  @ApiBody({ schema: openApi(AddMemberBody) })
  addMember(
    @CurrentUser() user: AuthUser,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(AddMemberBody)) body: z.infer<typeof AddMemberBody>,
  ) {
    return this.orgs.addMember(org.id, { id: user.id, role: org.role }, body.email, body.role);
  }
}
