import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FlagKey } from '@talk2tax/accounting-engine';
import type { Permission, RoleName } from '@talk2tax/security';

export const IS_PUBLIC = 'talk2tax:isPublic';
export const PERMISSION = 'talk2tax:permission';
export const PLATFORM_PERMISSION = 'talk2tax:platformPermission';
export const PLAN_FEATURE = 'talk2tax:planFeature';
export const ALLOW_READ_ONLY = 'talk2tax:allowWhenReadOnly';
export const FEATURE_FLAG = 'talk2tax:featureFlag';

/** The route belongs to a module behind a feature flag: refused with 403 FEATURE_OFF while the flag is off for the organisation. */
export const RequireFlag = (flag: FlagKey) => SetMetadata(FEATURE_FLAG, flag);

/**
 * The route changes something in a module the organisation's plan must include (AI, PAYROLL,
 * MULTI_CURRENCY, CONSOLIDATION). Reads are never refused: past records stay visible after a downgrade.
 */
export const RequireFeature = (feature: 'AI' | 'PAYROLL' | 'MULTI_CURRENCY' | 'CONSOLIDATION') => SetMetadata(PLAN_FEATURE, feature);

/** The route works while the books are read-only (a lapsed plan or a suspension): choosing a plan. */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_READ_ONLY, true);

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
export type PlatformPermission = 'platform.read' | 'platform.manage' | 'platform.support';

/** What each platform role may do. SUPPORT looks things up; only SUPER_ADMIN changes anything. */
export const PLATFORM_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  SUPER_ADMIN: ['platform.read', 'platform.manage', 'platform.support'],
  SUPPORT: ['platform.read', 'platform.support'],
};

/**
 * Platform administration route (v1/admin). Needs a platform role with this permission. It
 * never grants access to any organisation's books: organisation routes still need membership.
 */
export const RequirePlatform = (permission: PlatformPermission) => SetMetadata(PLATFORM_PERMISSION, permission);

export interface OrgContext {
  id: string;
  role: RoleName;
  /** Set when a person who runs Talk2Tax is reading the books under the organisation's support access grant. */
  viaSupport?: { grantId: string; expiresAt: Date };
  functionalCurrency: string;
  fiscalYearStartMonth: number;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const CurrentOrg = createParamDecorator((_: unknown, ctx: ExecutionContext): OrgContext => ctx.switchToHttp().getRequest().org);
/** The id of the signed-in session (from the access token). */
export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().sessionId);
