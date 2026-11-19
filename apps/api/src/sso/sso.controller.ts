import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission } from '../auth/decorators';
import { AuthRateLimit } from '../auth/rate-limit';
import { openApi, ZodPipe } from '../common/zod';
import { AUTO_JOIN_ROLES, SsoService } from './sso.service';

const SaveBody = z
  .object({
    issuer: z.string().trim().min(1, 'Enter the issuer URL').max(500),
    clientId: z.string().trim().min(1, 'Enter the client ID').max(255),
    clientSecret: z.string().max(2000).optional(),
    enabled: z.boolean(),
    enforced: z.boolean(),
    autoJoinRole: z.enum(AUTO_JOIN_ROLES).nullable(),
  })
  .strict();
const DomainBody = z.object({ domain: z.string().max(253) }).strict();
const StartBody = z.object({ email: z.string().max(254), binding: z.string().min(22).max(100) }).strict();
const FinishBody = z
  .object({
    state: z.string().min(1).max(64),
    binding: z.string().min(22).max(100),
    code: z.string().max(4096).optional(),
    error: z.string().max(200).optional(),
    errorDescription: z.string().max(1000).optional(),
  })
  .strict();

function meta(req: Request) {
  const ua = req.headers['user-agent'];
  const device = req.headers['x-t2t-device'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null, deviceKey: typeof device === 'string' ? device : null };
}

/** An organisation's single sign-on settings (SEC-006/007). */
@ApiTags('settings')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sso')
export class SsoSettingsController {
  constructor(private readonly sso: SsoService) {}

  @Get()
  @RequirePermission('audit.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.sso.overview({ orgId: org.id, role: org.role });
  }

  @Put()
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(SaveBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SaveBody)) body: z.infer<typeof SaveBody>) {
    return this.sso.save({ orgId: org.id, role: org.role }, user, body);
  }

  @Delete()
  @RequirePermission('org.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.sso.remove({ orgId: org.id, role: org.role }, user);
  }

  @Post('domains')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(DomainBody) })
  addDomain(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DomainBody)) body: z.infer<typeof DomainBody>) {
    return this.sso.addDomain({ orgId: org.id, role: org.role }, user, body.domain);
  }

  @Post('domains/:id/verify')
  @HttpCode(200)
  @RequirePermission('org.manage')
  verifyDomain(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sso.verifyDomain({ orgId: org.id, role: org.role }, user, id);
  }

  @Delete('domains/:id')
  @RequirePermission('org.manage')
  removeDomain(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sso.removeDomain({ orgId: org.id, role: org.role }, user, id);
  }
}

/** Signing in with single sign-on (SEC-006): start, then finish with what the provider sent back. */
@ApiTags('auth')
@Controller('v1/auth/sso')
export class SsoSignInController {
  constructor(private readonly sso: SsoService) {}

  @Public()
  @AuthRateLimit()
  @Post('start')
  @HttpCode(200)
  @ApiBody({ schema: openApi(StartBody) })
  start(@Body(new ZodPipe(StartBody)) body: z.infer<typeof StartBody>) {
    return this.sso.start(body.email, body.binding);
  }

  @Public()
  @AuthRateLimit()
  @Post('finish')
  @HttpCode(200)
  @ApiBody({ schema: openApi(FinishBody) })
  finish(@Body(new ZodPipe(FinishBody)) body: z.infer<typeof FinishBody>, @Req() req: Request) {
    return this.sso.finish(body, meta(req));
  }
}
