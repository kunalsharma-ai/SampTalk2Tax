import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { CommunicationPolicyService } from './communication-policy.service';

const PolicyBody = z.object({ automationsToContacts: z.enum(['ALLOWED', 'BLOCKED']) }).strict();
const ConsentBody = z.object({ status: z.enum(['OPTED_OUT', 'OPTED_IN']), reason: z.string().trim().min(3, 'Say why, for the record').max(500) }).strict();

/** External communication policy (AR-043): the organisation's policy and contacts' email consent. */
@ApiTags('contacts')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class CommunicationPolicyController {
  constructor(private readonly policy: CommunicationPolicyService) {}

  @Get('communication-policy')
  @RequirePermission('contacts.read')
  get(@CurrentOrg() org: OrgContext) {
    return this.policy.overview(org);
  }

  @Put('communication-policy')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(PolicyBody) })
  set(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>) {
    return this.policy.setPolicy(org, user, body);
  }

  @Get('contacts/:contactId/email-consent')
  @RequirePermission('contacts.read')
  consent(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) id: string) {
    return this.policy.consent(org, id);
  }

  @Post('contacts/:contactId/email-consent')
  @RequirePermission('contacts.manage')
  @ApiBody({ schema: openApi(ConsentBody) })
  record(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ConsentBody)) body: z.infer<typeof ConsentBody>) {
    return this.policy.recordConsent(org, user, id, body);
  }
}
