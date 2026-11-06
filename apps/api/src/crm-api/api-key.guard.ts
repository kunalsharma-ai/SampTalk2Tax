import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiScope } from '@talk2tax/accounting-engine';
import { enterApiKey, enterOrg, enterUser } from '../common/tenant-context';
import { MaintenanceService } from '../operations/maintenance.service';
import { ApiKeysService } from './api-keys.service';

export const API_SCOPE = 'talk2tax:apiScope';
/** The scope a CRM API route needs. */
export const RequireScope = (scope: ApiScope) => SetMetadata(API_SCOPE, scope);

/**
 * Authenticates the CRM API (/v1/crm-api) by API key instead of a person's session, then acts as
 * the key's creator in the key's organisation, limited to the route's scope.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly keys: ApiKeysService,
    private readonly maintenance: MaintenanceService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const scope = this.reflector.getAllAndOverride<ApiScope | undefined>(API_SCOPE, [ctx.getHandler(), ctx.getClass()]);
    if (!scope) throw new HttpException({ error: 'FORBIDDEN', message: 'Route has no scope declared' }, HttpStatus.FORBIDDEN);
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (write) {
      const refusal = await this.maintenance.refusal();
      if (refusal) throw new HttpException({ error: 'MAINTENANCE', message: refusal.message }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const caller = await this.keys.authenticate(req.headers['authorization'], scope, write);
    enterUser(caller.user.id);
    enterOrg(caller.org.id);
    enterApiKey({ id: caller.keyId, prefix: caller.prefix });
    req.user = caller.user;
    req.org = caller.org;
    req.apiKey = caller;
    return true;
  }
}
