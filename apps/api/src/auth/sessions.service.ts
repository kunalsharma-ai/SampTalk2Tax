import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService, Tx } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { AccessClaims, hashSecret, parseRefreshToken, sameHash, TokensService } from './tokens.service';

const DAY_MS = 86_400_000;
/** Two refreshes racing with the same token inside this window are not treated as theft. */
export const REFRESH_GRACE_MS = 30_000;

export interface ClientMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  /** Null when a refresh fell inside the grace window: keep using the refresh token you have. */
  refreshToken: string | null;
  sessionId: string;
  sessionExpiresAt: string;
}

export type RevokeReason = 'signed_out' | 'revoked_by_user' | 'signed_out_elsewhere' | 'password_changed' | 'refresh_token_reused' | 'expired' | 'user_inactive';

function unauthorized(code: string, message: string): UnauthorizedException {
  return new UnauthorizedException({ error: code, message });
}

/**
 * Server-side sessions. Each sign-in creates one; access tokens name it, so revoking it
 * ends access immediately. Refresh tokens rotate on every use; presenting an old one
 * after the grace window revokes the whole session (it was copied).
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private clip(meta: ClientMeta) {
    return { userAgent: meta.userAgent?.slice(0, 300) || null, ipAddress: meta.ip?.slice(0, 64) || null };
  }

  async create(tx: Tx, userId: string, meta: ClientMeta): Promise<IssuedSession> {
    const { secret, hash } = this.tokens.newSecret();
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_DAYS * DAY_MS);
    const s = await tx.authSession.create({ data: { userId, secretHash: hash, expiresAt, ...this.clip(meta) } });
    await this.audit.append(tx, { orgId: null, actorId: userId, action: 'session.created', entityType: 'session', entityId: s.id, data: { ip: s.ipAddress } });
    return { ...(await this.tokens.signAccess({ userId, sessionId: s.id })), refreshToken: `${s.id}.${secret}`, sessionId: s.id, sessionExpiresAt: expiresAt.toISOString() };
  }

  /** Used by the auth guard on every request: the session must exist, be live and belong to the token's user. */
  async validate(claims: AccessClaims) {
    const s = await this.prisma.authSession.findUnique({
      where: { id: claims.sessionId },
      select: { userId: true, revokedAt: true, expiresAt: true, user: { select: { id: true, email: true, name: true, isActive: true } } },
    });
    if (!s || s.userId !== claims.userId) return { ok: false as const, code: 'UNAUTHENTICATED', message: 'Session not found' };
    if (s.revokedAt) return { ok: false as const, code: 'SESSION_REVOKED', message: 'This session was signed out' };
    if (s.expiresAt <= new Date()) return { ok: false as const, code: 'SESSION_EXPIRED', message: 'This session has expired' };
    if (!s.user.isActive) return { ok: false as const, code: 'UNAUTHENTICATED', message: 'User is not active' };
    return { ok: true as const, user: { id: s.user.id, email: s.user.email, name: s.user.name } };
  }

  async refresh(refreshToken: string, meta: ClientMeta): Promise<IssuedSession> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is not valid');
    const hash = hashSecret(parsed.secret);
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.prisma.authSession.findUnique({ where: { id: parsed.sessionId }, include: { user: { select: { isActive: true } } } });
      if (!s) throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is not valid');
      if (s.revokedAt) throw unauthorized('SESSION_REVOKED', 'This session was signed out');
      const now = new Date();
      const idleLimit = new Date(s.lastUsedAt.getTime() + this.config.SESSION_IDLE_DAYS * DAY_MS);
      const matchesCurrent = sameHash(s.secretHash, hash);
      const matchesPrevious = sameHash(s.previousSecretHash, hash);
      if (!matchesCurrent && !matchesPrevious) {
        // Wrong secret for a real session id: may be a guess or an old, stolen token.
        // Without the secret history we cannot tell, so refuse without revoking.
        throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is not valid');
      }
      if (s.expiresAt <= now || idleLimit <= now) {
        await this.revokeRow(s.id, s.userId, 'expired', null);
        throw unauthorized('SESSION_EXPIRED', 'This session has expired. Sign in again.');
      }
      if (!s.user.isActive) {
        await this.revokeRow(s.id, s.userId, 'user_inactive', null);
        throw unauthorized('UNAUTHENTICATED', 'User is not active');
      }
      if (matchesCurrent) {
        const next = this.tokens.newSecret();
        const updated = await this.prisma.authSession.updateMany({
          where: { id: s.id, secretHash: s.secretHash, revokedAt: null },
          data: { previousSecretHash: s.secretHash, secretHash: next.hash, rotatedAt: now, rotationCount: { increment: 1 }, lastUsedAt: now, ...this.clip(meta) },
        });
        if (updated.count === 0) continue; // another refresh won the race; re-read and take the grace path
        return { ...(await this.tokens.signAccess({ userId: s.userId, sessionId: s.id })), refreshToken: `${s.id}.${next.secret}`, sessionId: s.id, sessionExpiresAt: s.expiresAt.toISOString() };
      }
      // The secret is the one replaced at the last rotation.
      if (s.rotatedAt && now.getTime() - s.rotatedAt.getTime() <= REFRESH_GRACE_MS) {
        return { ...(await this.tokens.signAccess({ userId: s.userId, sessionId: s.id })), refreshToken: null, sessionId: s.id, sessionExpiresAt: s.expiresAt.toISOString() };
      }
      await this.revokeRow(s.id, s.userId, 'refresh_token_reused', null, { rotationCount: s.rotationCount });
      throw unauthorized('REFRESH_TOKEN_REUSED', 'This sign-in was ended because an old refresh token was used again. Sign in again.');
    }
    throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is not valid');
  }

  /** Sign out with a refresh token (works after the access token has expired). Unknown tokens are ignored. */
  async signOutWithRefreshToken(refreshToken: string): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    const s = await this.prisma.authSession.findUnique({ where: { id: parsed.sessionId } });
    const hash = hashSecret(parsed.secret);
    if (!s || s.revokedAt || !(sameHash(s.secretHash, hash) || sameHash(s.previousSecretHash, hash))) return;
    await this.revokeRow(s.id, s.userId, 'signed_out', s.userId);
  }

  async signOut(claims: AccessClaims): Promise<void> {
    await this.revokeRow(claims.sessionId, claims.userId, 'signed_out', claims.userId);
  }

  async list(userId: string, currentSessionId: string) {
    const rows = await this.prisma.authSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
    const idleMs = this.config.SESSION_IDLE_DAYS * DAY_MS;
    return rows
      .map((r) => {
        const idleEnd = new Date(r.lastUsedAt.getTime() + idleMs);
        return { ...r, expiresAt: (idleEnd < r.expiresAt ? idleEnd : r.expiresAt).toISOString(), createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt.toISOString(), current: r.id === currentSessionId };
      })
      .filter((r) => r.current || new Date(r.expiresAt) > new Date());
  }

  async revokeOne(userId: string, sessionId: string): Promise<void> {
    const s = await this.prisma.authSession.findUnique({ where: { id: sessionId }, select: { userId: true, revokedAt: true } });
    // Another user's session id gets the same answer as a missing one.
    if (!s || s.userId !== userId) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Session not found' });
    if (s.revokedAt) return;
    await this.revokeRow(sessionId, userId, 'revoked_by_user', userId);
  }

  /** Ends every session of the user except `keepSessionId`. Returns how many ended. */
  async revokeOthers(tx: Tx | null, userId: string, keepSessionId: string | null, reason: RevokeReason): Promise<number> {
    const run = async (t: Tx) => {
      const res = await t.authSession.updateMany({
        where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      if (res.count > 0) await this.audit.append(t, { orgId: null, actorId: userId, action: 'session.revoked_many', entityType: 'user', entityId: userId, data: { count: res.count, reason } });
      return res.count;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  private async revokeRow(sessionId: string, userId: string, reason: RevokeReason, actorId: string | null, extra: Record<string, unknown> = {}) {
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.authSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
      if (res.count === 0) return;
      await this.audit.append(tx, {
        orgId: null,
        actorId,
        action: reason === 'refresh_token_reused' ? 'session.refresh_reuse_detected' : 'session.revoked',
        entityType: 'session',
        entityId: sessionId,
        data: { reason, ...extra },
      });
    });
  }
}
