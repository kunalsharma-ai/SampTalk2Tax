import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { API_SCOPES, CRM_WEBHOOK_EVENT_NAMES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ApiKeysService } from './api-keys.service';
import { CrmWebhooksService } from './crm-webhooks.service';

const id = z.string().uuid('Not a valid id');
const KeyBody = z
  .object({
    name: z.string().trim().min(1, 'Name the key after the system that will use it').max(100, 'Keep the name under 100 characters'),
    scopes: z.array(z.enum(API_SCOPES)).min(1, 'Choose what the key may do'),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31').nullish(),
  })
  .strict();
const HookBody = z
  .object({
    name: z.string().trim().min(1, 'Name the webhook').max(100, 'Keep the name under 100 characters'),
    url: z.string().trim().min(1, 'Give the address to send events to').max(500, 'Keep the address under 500 characters'),
    events: z.array(z.enum(CRM_WEBHOOK_EVENT_NAMES as [string, ...string[]])).min(1, 'Choose at least one event'),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Connecting an external CRM, set up in the app: API keys for calls in, webhooks for events out. */
@ApiTags('crm-connection')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/crm-connection')
export class CrmConnectionController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly hooks: CrmWebhooksService,
  ) {}

  @Get('keys')
  @RequirePermission('org.manage')
  listKeys(@CurrentOrg() org: OrgContext) {
    return this.keys.list(org.id);
  }

  /** A new key; the key is in this answer only. */
  @Post('keys')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(KeyBody) })
  createKey(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(KeyBody)) b: z.infer<typeof KeyBody>) {
    return this.keys.create(org, user, b);
  }

  @Post('keys/:id/revoke')
  @RequirePermission('org.manage')
  revokeKey(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) keyId: string) {
    return this.keys.revoke(org.id, user, keyId);
  }

  @Get('webhooks')
  @RequirePermission('org.manage')
  listHooks(@CurrentOrg() org: OrgContext) {
    return this.hooks.list(org.id);
  }

  /** A new webhook; its signing secret is in this answer only. */
  @Post('webhooks')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(HookBody) })
  createHook(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(HookBody)) b: z.infer<typeof HookBody>) {
    return this.hooks.create(org.id, user, b as never);
  }

  @Put('webhooks/:id')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(HookBody) })
  updateHook(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) hookId: string, @Body(new ZodPipe(HookBody)) b: z.infer<typeof HookBody>) {
    return this.hooks.update(org.id, user, hookId, b as never);
  }

  @Post('webhooks/:id/rotate-secret')
  @RequirePermission('org.manage')
  rotate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) hookId: string) {
    return this.hooks.rotateSecret(org.id, user, hookId);
  }

  @Delete('webhooks/:id')
  @RequirePermission('org.manage')
  removeHook(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) hookId: string) {
    return this.hooks.remove(org.id, user, hookId);
  }

  /** Sends a test event now and reports the answer. */
  @Post('webhooks/:id/test')
  @RequirePermission('org.manage')
  testHook(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) hookId: string) {
    return this.hooks.test(org.id, user, hookId);
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermission('org.manage')
  deliveries(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) hookId: string) {
    return this.hooks.deliveries(org.id, hookId);
  }

  @Post('webhooks/:id/deliveries/:deliveryId/retry')
  @RequirePermission('org.manage')
  retry(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) hookId: string, @Param('deliveryId', new ZodPipe(id)) deliveryId: string) {
    return this.hooks.retry(org.id, user, hookId, deliveryId);
  }
}
