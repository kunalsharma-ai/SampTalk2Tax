import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission, RoleName } from '@talk2tax/security';

export const IS_PUBLIC = 'talk2tax:isPublic';
export const PERMISSION = 'talk2tax:permission';
export const PLATFORM_PERMISSION = 'talk2tax:platformPermission';

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route is scoped to the :orgId path parameter and requires this permission in that organization. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** SUPER_ADMIN or SUPPORT for the people who run the service; null for everyone else. */
  platformRole: PlatformRole | null;
}

export type PlatformRole = 'SUPER_ADMIN' | 'SUPPORT';
export type PlatformPermission = 'platform.read' | 'platform.manage';

/** What each platform role may do. SUPPORT looks things up; only SUPER_ADMIN changes anything. */
export const PLATFORM_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  SUPER_ADMIN: ['platform.read', 'platform.manage'],
  SUPPORT: ['platform.read'],
};

/**
 * Platform administration route (v1/admin). Needs a platform role with this permission. It
 * never grants access to any organisation's books: organisation routes still need membership.
 */
export const RequirePlatform = (permission: PlatformPermission) => SetMetadata(PLATFORM_PERMISSION, permission);

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
