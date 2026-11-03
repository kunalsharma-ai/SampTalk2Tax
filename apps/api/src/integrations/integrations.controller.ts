import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { IntegrationsService, kindFromPath } from './integrations.service';

const AiBody = z
  .object({
    apiKey: z.string().trim().min(20, 'That does not look like a full API key').max(500).nullish(),
    model: z.string().trim().regex(/^[a-z0-9][a-z0-9.\-]{2,63}$/, 'Choose a Claude model'),
    enabled: z.boolean(),
  })
  .strict();
const host = z
  .string()
  .trim()
  .min(1, 'Enter the mail server')
  .max(253)
  .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^[0-9a-fA-F:.]+$/, 'Enter a host name such as smtp.example.com');
const EmailBody = z
  .object({
    host,
    port: z.number().int().min(1).max(65535),
    security: z.enum(['TLS', 'STARTTLS', 'NONE']),
    username: z.string().trim().max(200).nullish(),
    password: z.string().max(500).nullish(),
    clearPassword: z.boolean().optional(),
    fromAddress: z.string().trim().email('Enter the sender email address').max(254),
    fromName: z.string().trim().max(100).regex(/^[^\r\n<>"]*$/, 'The sender name cannot contain quotes or angle brackets').nullish(),
    replyTo: z.string().trim().email('Enter a valid reply-to address').max(254).nullish().or(z.literal('')),
    enabled: z.boolean(),
  })
  .strict();

/**
 * Integrations an organisation sets up in the app instead of on the server: a Claude API key
 * and model for the AI features, and a mail server for email. Owners and admins (org.manage)
 * can see and change them; secrets are write-only.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/integrations')
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  @Get()
  @RequirePermission('org.manage')
  view(@CurrentOrg() org: OrgContext) {
    return this.svc.view(org.id);
  }

  @Put('ai')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(AiBody) })
  saveAi(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AiBody)) body: z.infer<typeof AiBody>) {
    return this.svc.saveAi(org.id, user, body);
  }

  @Put('email')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(EmailBody) })
  saveEmail(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(EmailBody)) body: z.infer<typeof EmailBody>) {
    return this.svc.saveEmail(org.id, user, { ...body, replyTo: body.replyTo || null });
  }

  @Post(':kind/test')
  @HttpCode(200)
  @RequirePermission('org.manage')
  test(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('kind') kind: string) {
    return this.svc.test(org.id, user, kindFromPath(kind));
  }

  @Delete(':kind')
  @RequirePermission('org.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('kind') kind: string) {
    return this.svc.remove(org.id, user, kindFromPath(kind));
  }
}
