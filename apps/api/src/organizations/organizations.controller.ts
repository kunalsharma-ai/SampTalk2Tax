import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { isSupportedCurrency } from '@talk2tax/accounting-engine';
import { ROLES } from '@talk2tax/security';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { InvitationsService } from './invitations.service';
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
const InviteBody = z.object({ email: z.email().max(254), role: z.enum(ROLES) });
const RoleBody = z.object({ role: z.enum(ROLES) });
const TimeZoneBody = z.object({ timeZone: z.string().trim().min(1).max(64) }).strict();

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('v1/orgs')
export class OrganizationsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly invitations: InvitationsService,
  ) {}

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

  /** The time zone moments are shown in (display only; business dates follow the country module). */
  @Put(':orgId/time-zone')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(TimeZoneBody) })
  setTimeZone(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(TimeZoneBody)) body: z.infer<typeof TimeZoneBody>) {
    return this.orgs.setTimeZone(orgId, user.id, body.timeZone);
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

  @Put(':orgId/members/:userId')
  @RequirePermission('members.manage')
  @ApiBody({ schema: openApi(RoleBody) })
  changeRole(@CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext, @Param('userId', new ParseUUIDPipe()) userId: string, @Body(new ZodPipe(RoleBody)) body: z.infer<typeof RoleBody>) {
    return this.invitations.changeRole(org.id, { id: user.id, role: org.role }, userId, body.role);
  }

  @Delete(':orgId/members/:userId')
  @RequirePermission('members.manage')
  @HttpCode(204)
  async removeMember(@CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext, @Param('userId', new ParseUUIDPipe()) userId: string) {
    await this.invitations.remove(org.id, { id: user.id, role: org.role }, userId);
  }

  @Get(':orgId/invitations')
  @RequirePermission('members.read')
  listInvitations(@CurrentOrg() org: OrgContext) {
    return this.invitations.list(org.id);
  }

  /** Returns the link token once; only its hash is stored. */
  @Post(':orgId/invitations')
  @RequirePermission('members.manage')
  @ApiBody({ schema: openApi(InviteBody) })
  invite(@CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext, @Body(new ZodPipe(InviteBody)) body: z.infer<typeof InviteBody>) {
    return this.invitations.create(org.id, { id: user.id, role: org.role }, body);
  }

  @Post(':orgId/invitations/:id/renew')
  @RequirePermission('members.manage')
  @HttpCode(200)
  renewInvitation(@CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.invitations.renew(org.id, { id: user.id, role: org.role }, id);
  }

  @Post(':orgId/invitations/:id/revoke')
  @RequirePermission('members.manage')
  @HttpCode(200)
  revokeInvitation(@CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.invitations.revoke(org.id, { id: user.id, role: org.role }, id);
  }
}

/** The invitee's side: they are signed in but not yet a member, so these routes have no :orgId. */
@ApiTags('organizations')
@ApiBearerAuth()
@Controller('v1/invitations')
export class InvitationLinksController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get(':token')
  preview(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    return this.invitations.preview(token, user);
  }

  @Post(':token/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    return this.invitations.accept(token, user);
  }
}
