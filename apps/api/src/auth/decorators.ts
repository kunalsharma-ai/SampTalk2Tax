import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission, RoleName } from '@talk2tax/security';

export const IS_PUBLIC = 'talk2tax:isPublic';
export const PERMISSION = 'talk2tax:permission';

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route is scoped to the :orgId path parameter and requires this permission in that organization. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface OrgContext {
  id: string;
  role: RoleName;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const CurrentOrg = createParamDecorator((_: unknown, ctx: ExecutionContext): OrgContext => ctx.switchToHttp().getRequest().org);
/** The id of the signed-in session (from the access token). */
export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().sessionId);
