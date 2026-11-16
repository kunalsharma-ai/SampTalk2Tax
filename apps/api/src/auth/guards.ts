import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, Permission, RoleName } from '@talk2tax/security';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { enterOrg, enterUser } from '../common/tenant-context';
import { RegionsService } from '../regions/regions.service';
import { accessOf } from '../billing/limits';
import { SupportAccessService } from '../support/support-access.service';
import { ALLOW_READ_ONLY, IS_PUBLIC, PERMISSION, PLAN_FEATURE, PLATFORM_PERMISSION, PLATFORM_PERMISSIONS, PlatformPermission, PlatformRole } from './decorators';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';

/** Global guard: authenticates the bearer token, then enforces tenant membership and permission. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly regions: RegionsService,
    private readonly supportAccess: SupportAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'Missing bearer token' });
    const claims = await this.tokens.verifyAccess(token);
    // TOKEN_EXPIRED tells a client to refresh; the other codes mean "sign in again".
    if (!claims) throw new UnauthorizedException({ error: 'TOKEN_EXPIRED', message: 'Invalid or expired access token' });
    const session = await this.sessions.validate(claims);
    if (!session.ok) throw new UnauthorizedException({ error: session.code, message: session.message });
    const user = session.user;
    req.user = user;
    enterUser(user.id);
    req.sessionId = claims.sessionId;

    const platform = this.reflector.getAllAndOverride<PlatformPermission | undefined>(PLATFORM_PERMISSION, targets);
    if (platform) {
      // Platform administration: a platform role, and never an organisation's books.
      if (!user.platformRole || !PLATFORM_PERMISSIONS[user.platformRole].includes(platform)) {
        throw new ForbiddenException({ error: 'FORBIDDEN', message: user.platformRole ? `Your platform role (${user.platformRole}) does not have ${platform}` : 'Only the people who run Talk2Tax can open platform administration' });
      }
      return true;
    }

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    const orgId: string | undefined = req.params?.orgId;
    if (orgId !== undefined) {
      if (!z.uuid().safeParse(orgId).success) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Organization not found' });
      const membership = await this.prisma.membership.findUnique({
        where: { orgId_userId: { orgId, userId: user.id } },
        include: { org: { select: { functionalCurrency: true, fiscalYearStartMonth: true, dataRegion: true, suspendedAt: true, suspendedReason: true, subscription: { select: { status: true, trialEndsAt: true, currentPeriodEnd: true, plan: { select: { name: true, features: true } } } } } } },
      });
      // Non-members get 404, not 403, so organization ids cannot be probed. The one exception
      // is support staff while the organisation has granted support access: read-only, logged.
      if (!membership) return this.viaSupport(req, user, orgId, permission);
      // An organisation is served only in the region its data lives in.
      this.regions.assertHere(membership.org.dataRegion);
      const role = membership.role as RoleName;
      const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const allowReadOnly = this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY, targets) === true;
      // A suspended organisation stays readable to its members, but nothing in it can change.
      if (membership.org.suspendedAt && writes && !allowReadOnly) {
        throw new HttpException({ error: 'ORG_SUSPENDED', message: `This organisation is suspended: ${membership.org.suspendedReason}. Its records can be read and exported but not changed.` }, HttpStatus.LOCKED);
      }
      // A trial or plan that has run out keeps every record readable; changes wait for a plan.
      const sub = membership.org.subscription;
      if (sub && writes && !allowReadOnly) {
        const access = accessOf(sub);
        if (access.level === 'READ_ONLY') {
          const why = access.state === 'TRIAL_ENDED' ? 'The free trial has ended' : access.state === 'CANCELLED' ? 'The subscription was cancelled' : 'The subscription has lapsed';
          throw new HttpException({ error: 'PLAN_REQUIRED', message: `${why}. Your records can be read and exported; choose a plan under Settings → Subscription to make changes again.`, state: access.state }, HttpStatus.PAYMENT_REQUIRED);
        }
        const feature = this.reflector.getAllAndOverride<string | undefined>(PLAN_FEATURE, targets);
        if (feature && !sub.plan.features.includes(feature)) {
          throw new ForbiddenException({ error: 'FEATURE_NOT_IN_PLAN', message: `The ${sub.plan.name} plan does not include this module. Choose a plan that does under Settings → Subscription.`, feature });
        }
      }
      if (!permission) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Route has no permission declared' });
      if (!hasPermission(role, permission)) {
        throw new ForbiddenException({ error: 'FORBIDDEN', message: `Your role (${role}) does not have ${permission}` });
      }
      enterOrg(orgId);
      req.org = {
        id: orgId,
        role,
        functionalCurrency: membership.org.functionalCurrency,
        fiscalYearStartMonth: membership.org.fiscalYearStartMonth,
      };
    } else if (permission) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Organization-scoped route is missing :orgId' });
    }
    return true;
  }

  /** Support staff reading an organisation's books under its grant: VIEWER rights, reads only, every request logged. */
  private async viaSupport(req: any, user: { id: string; platformRole: PlatformRole | null }, orgId: string, permission: Permission | undefined): Promise<boolean> {
    const notFound = new NotFoundException({ error: 'NOT_FOUND', message: 'Organization not found' });
    if (!user.platformRole || !PLATFORM_PERMISSIONS[user.platformRole].includes('platform.support')) throw notFound;
    const access = await this.supportAccess.activeGrant(orgId);
    if (!access) throw notFound;
    this.regions.assertHere(access.org.dataRegion);
    if (!['GET', 'HEAD'].includes(req.method)) {
      throw new ForbiddenException({ error: 'SUPPORT_READ_ONLY', message: 'Support access is read-only: nothing in this organisation can be changed by support.' });
    }
    const role: RoleName = 'VIEWER';
    if (!permission) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Route has no permission declared' });
    if (!hasPermission(role, permission)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `Support access has viewer rights only, which do not include ${permission}` });
    }
    enterOrg(orgId);
    await this.supportAccess.logView(access.grant.id, orgId, user.id, String(req.originalUrl ?? req.url ?? ''));
    req.org = {
      id: orgId,
      role,
      functionalCurrency: access.org.functionalCurrency,
      fiscalYearStartMonth: access.org.fiscalYearStartMonth,
      viaSupport: { grantId: access.grant.id, expiresAt: access.grant.expiresAt },
    };
    return true;
  }
}
