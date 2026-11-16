import type { PlatformRole } from './decorators';
import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, Tx } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { authSessions, users } from '../db/collections/identity';
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

/** A session just created, with what its audit event records. */
export interface CreatedSession {
  issued: IssuedSession & { refreshToken: string };
  userId: string;
  ipAddress: string | null;
}

export type RevokeReason = 'signed_out' | 'revoked_by_user' | 'signed_out_elsewhere' | 'password_changed' | 'refresh_token_reused' | 'expired' | 'user_inactive' | 'platform_admin';

function unauthorized(code: string, message: string): UnauthorizedException {
  return new UnauthorizedException({ error: code, message });
}

/**
 * Server-side sessions, kept in MongoDB (auth_sessions). Each sign-in creates one; access
 * tokens name it, so revoking it ends access immediately. Refresh tokens rotate on every
 * use; presenting an old one after the grace window revokes the whole session (it was
 * copied). The audit trail is still in PostgreSQL, so each change is recorded there right
 * after it is made.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private clip(meta: ClientMeta) {
    return { userAgent: meta.userAgent?.slice(0, 300) || null, ipAddress: meta.ip?.slice(0, 64) || null };
  }

  /** Creates the session (inside the caller's MongoDB transaction, if any). Record it with auditCreated. */
  async create(userId: string, meta: ClientMeta): Promise<CreatedSession> {
    const { secret, hash } = this.tokens.newSecret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.SESSION_TTL_DAYS * DAY_MS);
    const s = await this.store.collection(authSessions).insertOne({
      userId,
      secretHash: hash,
      previousSecretHash: null,
      rotatedAt: null,
      rotationCount: 0,
      ...this.clip(meta),
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
    });
    const access = await this.tokens.signAccess({ userId, sessionId: s.id });
    return { issued: { ...access, refreshToken: `${s.id}.${secret}`, sessionId: s.id, sessionExpiresAt: expiresAt.toISOString() }, userId, ipAddress: s.ipAddress };
  }

  async auditCreated(tx: Tx, s: CreatedSession): Promise<void> {
    await this.audit.append(tx, { orgId: null, actorId: s.userId, action: 'session.created', entityType: 'session', entityId: s.issued.sessionId, data: { ip: s.ipAddress } });
  }

  /** Removes a session whose sign-in did not complete (its audit record could not be written). */
  async discard(sessionId: string): Promise<void> {
    await this.store.collection(authSessions).deleteOne({ id: sessionId });
  }

  /** Used by the auth guard on every request: the session must exist, be live and belong to the token's user. */
  async validate(claims: AccessClaims) {
    const s = await this.store.collection(authSessions).findById(claims.sessionId);
    if (!s || s.userId !== claims.userId) return { ok: false as const, code: 'UNAUTHENTICATED', message: 'Session not found' };
    if (s.revokedAt) return { ok: false as const, code: 'SESSION_REVOKED', message: 'This session was signed out' };
    if (s.expiresAt <= new Date()) return { ok: false as const, code: 'SESSION_EXPIRED', message: 'This session has expired' };
    const user = await this.store.collection(users).findById(s.userId);
    if (!user || !user.isActive) return { ok: false as const, code: 'UNAUTHENTICATED', message: 'User is not active' };
    return { ok: true as const, user: { id: user.id, email: user.email, name: user.name, platformRole: (user.platformRole as PlatformRole | null) ?? null } };
  }

  async refresh(refreshToken: string, meta: ClientMeta): Promise<IssuedSession> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is not valid');
    const hash = hashSecret(parsed.secret);
    const sessions = this.store.collection(authSessions);
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await sessions.findById(parsed.sessionId);
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
      const user = await this.store.collection(users).findById(s.userId);
      if (!user?.isActive) {
        await this.revokeRow(s.id, s.userId, 'user_inactive', null);
        throw unauthorized('UNAUTHENTICATED', 'User is not active');
      }
      if (matchesCurrent) {
        const next = this.tokens.newSecret();
        // Only the refresh that still sees the current secret rotates it.
        const updated = await sessions.updateOne(
          { id: s.id, secretHash: s.secretHash, revokedAt: null },
          { $set: { previousSecretHash: s.secretHash, secretHash: next.hash, rotatedAt: now, lastUsedAt: now, ...this.clip(meta) }, $inc: { rotationCount: 1 } },
        );
        if (updated.matched === 0) continue; // another refresh won the race; re-read and take the grace path
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
    const s = await this.store.collection(authSessions).findById(parsed.sessionId);
    const hash = hashSecret(parsed.secret);
    if (!s || s.revokedAt || !(sameHash(s.secretHash, hash) || sameHash(s.previousSecretHash, hash))) return;
    await this.revokeRow(s.id, s.userId, 'signed_out', s.userId);
  }

  async signOut(claims: AccessClaims): Promise<void> {
    await this.revokeRow(claims.sessionId, claims.userId, 'signed_out', claims.userId);
  }

  async list(userId: string, currentSessionId: string) {
    const rows = await this.store.collection(authSessions).find(
      { userId, revokedAt: null, expiresAt: { $gt: new Date() } },
      { sort: { lastUsedAt: -1 } },
    );
    const idleMs = this.config.SESSION_IDLE_DAYS * DAY_MS;
    return rows
      .map((r) => {
        const idleEnd = new Date(r.lastUsedAt.getTime() + idleMs);
        return {
          id: r.id,
          userAgent: r.userAgent,
          ipAddress: r.ipAddress,
          expiresAt: (idleEnd < r.expiresAt ? idleEnd : r.expiresAt).toISOString(),
          createdAt: r.createdAt.toISOString(),
          lastUsedAt: r.lastUsedAt.toISOString(),
          current: r.id === currentSessionId,
        };
      })
      .filter((r) => r.current || new Date(r.expiresAt) > new Date());
  }

  async revokeOne(userId: string, sessionId: string): Promise<void> {
    const s = await this.store.collection(authSessions).findById(sessionId);
    // Another user's session id gets the same answer as a missing one.
    if (!s || s.userId !== userId) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Session not found' });
    if (s.revokedAt) return;
    await this.revokeRow(sessionId, userId, 'revoked_by_user', userId);
  }

  /** Ends every session of the user except `keepSessionId`, and records it. Returns how many ended. */
  async revokeOthers(userId: string, keepSessionId: string | null, reason: RevokeReason): Promise<number> {
    const count = await this.revokeOthersInStore(userId, keepSessionId, reason);
    if (count > 0) await this.prisma.$transaction((tx) => this.auditRevokedMany(tx, userId, count, reason));
    return count;
  }

  /** The MongoDB half of revokeOthers, for callers that record it in their own audit transaction. */
  async revokeOthersInStore(userId: string, keepSessionId: string | null, reason: RevokeReason): Promise<number> {
    const res = await this.store.collection(authSessions).updateMany(
      { userId, revokedAt: null, ...(keepSessionId ? { id: { $ne: keepSessionId } } : {}) },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
    return res.modified;
  }

  async auditRevokedMany(tx: Tx, userId: string, count: number, reason: RevokeReason): Promise<void> {
    await this.audit.append(tx, { orgId: null, actorId: userId, action: 'session.revoked_many', entityType: 'user', entityId: userId, data: { count, reason } });
  }

  /** People's last sign-in activity, for platform administration. */
  async activity(userIds: string[]) {
    const now = new Date();
    const rows = await this.store.collection(authSessions).aggregate<{ _id: string; lastUsedAt: Date; open: number }>([
      { $match: { userId: { $in: userIds } } },
      {
        $group: {
          _id: '$userId',
          lastUsedAt: { $max: '$lastUsedAt' },
          open: { $sum: { $cond: [{ $and: [{ $eq: ['$revokedAt', null] }, { $gt: ['$expiresAt', now] }] }, 1, 0] } },
        },
      },
    ]);
    return new Map(rows.map((r) => [r._id, { lastUsedAt: r.lastUsedAt, open: r.open }]));
  }

  /** How many different people used a session since the given moment. */
  async peopleSeenSince(since: Date): Promise<number> {
    return (await this.store.collection(authSessions).distinct('userId', { lastUsedAt: { $gte: since } })).length;
  }

  private async revokeRow(sessionId: string, userId: string, reason: RevokeReason, actorId: string | null, extra: Record<string, unknown> = {}) {
    const res = await this.store.collection(authSessions).updateOne({ id: sessionId, userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
    if (res.modified === 0) return;
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: null,
        actorId,
        action: reason === 'refresh_token_reused' ? 'session.refresh_reuse_detected' : 'session.revoked',
        entityType: 'session',
        entityId: sessionId,
        data: { reason, ...extra },
      }),
    );
  }
}
