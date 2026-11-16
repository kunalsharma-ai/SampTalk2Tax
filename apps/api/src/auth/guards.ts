import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, Permission, RoleName } from '@talk2tax/security';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { enterOrg, enterUser } from '../common/tenant-context';
import { RegionsService } from '../regions/regions.service';
import { IS_PUBLIC, PERMISSION } from './decorators';
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

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    const orgId: string | undefined = req.params?.orgId;
    if (orgId !== undefined) {
      if (!z.uuid().safeParse(orgId).success) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Organization not found' });
      const membership = await this.prisma.membership.findUnique({
        where: { orgId_userId: { orgId, userId: user.id } },
        include: { org: { select: { functionalCurrency: true, fiscalYearStartMonth: true, dataRegion: true } } },
      });
      // Non-members get 404, not 403, so organization ids cannot be probed.
      if (!membership) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Organization not found' });
      // An organisation is served only in the region its data lives in.
      this.regions.assertHere(membership.org.dataRegion);
      const role = membership.role as RoleName;
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
}
