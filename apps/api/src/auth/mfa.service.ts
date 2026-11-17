import { HttpStatus, Inject, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, totpUri, verifyTotp, verifyPassword } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { MFA_CHALLENGE_MAX_ATTEMPTS, mfaChallenges, UserMfaDoc, userMfa, users } from '../db/collections/identity';
import { SecretBox } from '../integrations/secret-box';
import { ClientMeta } from './sessions.service';
import { hashSecret, parseRefreshToken, sameHash, TokensService } from './tokens.service';

/** How long the code step of a sign-in waits after the password was accepted. */
export const MFA_CHALLENGE_TTL_SECONDS = 300;
const ISSUER = 'Talk2Tax';

export interface MfaStatus {
  enabled: boolean;
  /** Set up started (code shown) but not confirmed yet. */
  pending: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

const wrongCode = () => new UnprocessableEntityException({ error: 'MFA_CODE_INVALID', message: 'That code is not right. Type the 6-digit code your authenticator app shows now, or one of your recovery codes.' });
const wrongPassword = () => new UnprocessableEntityException({ error: 'WRONG_PASSWORD', message: 'Current password is incorrect' });

/**
 * Two-step sign-in with an authenticator app (TOTP, RFC 6238) and single-use recovery codes
 * (SEC-005). Everything lives in MongoDB: `user_mfa` holds the sealed secret, `mfa_challenges`
 * the sign-ins waiting for a code. Every change is in the audit trail.
 */
@Injectable()
export class MfaService {
  private readonly box: SecretBox;

  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokensService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.box = new SecretBox({ encryptionKey: config.INTEGRATIONS_ENCRYPTION_KEY, jwtSecret: config.JWT_SECRET });
  }

  private record(actorId: string, action: string, data?: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId, action, entityType: 'user', entityId: actorId, data }));
  }

  async isActive(userId: string): Promise<boolean> {
    return (await this.store.collection(userMfa).exists({ id: userId, status: 'ACTIVE' })) as boolean;
  }

  async status(userId: string): Promise<MfaStatus> {
    const m = await this.store.collection(userMfa).findById(userId);
    return {
      enabled: m?.status === 'ACTIVE',
      pending: m?.status === 'PENDING',
      enabledAt: m?.enabledAt?.toISOString() ?? null,
      recoveryCodesLeft: m?.status === 'ACTIVE' ? m.recoveryCodes.filter((c) => !c.usedAt).length : 0,
    };
  }

  private async passwordOk(userId: string, password: string) {
    const u = await this.store.collection(users).findById(userId);
    if (!u) throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'User not found' });
    if (!(await verifyPassword(password, u.passwordHash))) throw wrongPassword();
    return u;
  }

  private secretOf(m: UserMfaDoc): string {
    const s = this.box.open(m.secretCipher, m.keyId);
    // The server's key changed since the secret was sealed: the app's codes can no longer be checked.
    if (s === null) throw new DomainError('MFA_KEY_CHANGED', 'The server key that protects your authenticator changed, so its codes cannot be checked. Use a recovery code, then set two-step sign-in up again.', HttpStatus.CONFLICT);
    return s;
  }

  /**
   * Step 1 of turning it on: a new secret for the app to scan. Asks for the password, since
   * whoever holds the secret can make codes. Starting again replaces an unconfirmed secret.
   */
  async startSetup(userId: string, password: string) {
    const u = await this.passwordOk(userId, password);
    const existing = await this.store.collection(userMfa).findById(userId);
    if (existing?.status === 'ACTIVE') throw new DomainError('MFA_ALREADY_ON', 'Two-step sign-in is already on. Turn it off first to move it to another app.', HttpStatus.CONFLICT);
    const secret = newTotpSecret();
    const sealed = this.box.seal(secret);
    const now = new Date();
    await this.store.transaction(async () => {
      if (existing) await this.store.collection(userMfa).deleteOne({ id: userId });
      await this.store.collection(userMfa).insertOne({ id: userId, status: 'PENDING', secretCipher: sealed.cipher, keyId: sealed.keyId, lastStep: null, recoveryCodes: [], enabledAt: null, createdAt: now, updatedAt: now });
    });
    return { secret, otpauthUri: totpUri({ secret, account: u.email, issuer: ISSUER }), issuer: ISSUER, account: u.email };
  }

  /** Step 2: the person types a code from the app. It turns on, and the recovery codes are shown once. */
  async confirmSetup(userId: string, code: string) {
    const m = await this.store.collection(userMfa).findById(userId);
    if (!m || m.status !== 'PENDING') throw new DomainError('MFA_NOT_STARTED', m ? 'Two-step sign-in is already on.' : 'Start setting up two-step sign-in first.', HttpStatus.CONFLICT);
    const step = verifyTotp(this.secretOf(m), code);
    if (step === null) throw wrongCode();
    const codes = newRecoveryCodes();
    const now = new Date();
    const res = await this.store.collection(userMfa).updateOne(
      { id: userId, status: 'PENDING', secretCipher: m.secretCipher },
      { $set: { status: 'ACTIVE', enabledAt: now, lastStep: step, recoveryCodes: codes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null })), updatedAt: now } },
    );
    if (!res.matched) throw new DomainError('MFA_NOT_STARTED', 'Setting up was started again elsewhere; scan the new code.', HttpStatus.CONFLICT);
    await this.record(userId, 'user.mfa_enabled', { method: 'TOTP', recoveryCodes: codes.length });
    return { recoveryCodes: codes, status: await this.status(userId) };
  }

  /** Turning it off needs the password and a current code (or a recovery code). */
  async disable(userId: string, password: string, code: string) {
    await this.passwordOk(userId, password);
    const m = await this.store.collection(userMfa).findById(userId);
    if (!m) throw new DomainError('MFA_OFF', 'Two-step sign-in is not on.', HttpStatus.CONFLICT);
    if (m.status === 'ACTIVE') await this.useCode(m, code);
    await this.store.collection(userMfa).deleteOne({ id: userId });
    if (m.status === 'ACTIVE') await this.record(userId, 'user.mfa_disabled', {});
    return this.status(userId);
  }

  /** New recovery codes replace every old one, used or not. */
  async regenerateRecoveryCodes(userId: string, code: string) {
    const m = await this.store.collection(userMfa).findById(userId);
    if (!m || m.status !== 'ACTIVE') throw new DomainError('MFA_OFF', 'Two-step sign-in is not on.', HttpStatus.CONFLICT);
    const how = await this.useCode(m, code, { app: true, recovery: false });
    const codes = newRecoveryCodes();
    await this.store.collection(userMfa).updateOne({ id: userId }, { $set: { recoveryCodes: codes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null })), updatedAt: new Date() } });
    await this.record(userId, 'user.mfa_recovery_codes_replaced', { via: how, recoveryCodes: codes.length });
    return { recoveryCodes: codes, status: await this.status(userId) };
  }

  /**
   * Accepts an app code (once per time step) or an unused recovery code (once ever), recording
   * the use atomically so two requests cannot both spend it.
   */
  private async useCode(m: UserMfaDoc, raw: string, allow = { app: true, recovery: true }): Promise<'APP' | 'RECOVERY_CODE'> {
    const code = raw.trim();
    const now = new Date();
    if (allow.app && /^\d{3}\s?\d{3}$/.test(code)) {
      const step = verifyTotp(this.secretOf(m), code, { afterStep: m.lastStep });
      if (step === null) throw wrongCode();
      const res = await this.store.collection(userMfa).updateOne({ id: m.id, $or: [{ lastStep: null }, { lastStep: { $lt: step } }] }, { $set: { lastStep: step, updatedAt: now } });
      if (!res.matched) throw wrongCode();
      return 'APP';
    }
    if (allow.recovery) {
      const hash = hashRecoveryCode(code);
      const i = m.recoveryCodes.findIndex((c) => c.hash === hash && !c.usedAt);
      if (i >= 0) {
        const res = await this.store.collection(userMfa).updateOne({ id: m.id, [`recoveryCodes.${i}.hash`]: hash, [`recoveryCodes.${i}.usedAt`]: null }, { $set: { [`recoveryCodes.${i}.usedAt`]: now, updatedAt: now } });
        if (res.matched) {
          const left = m.recoveryCodes.filter((c) => !c.usedAt).length - 1;
          await this.record(m.id, 'user.mfa_recovery_code_used', { recoveryCodesLeft: left });
          return 'RECOVERY_CODE';
        }
      }
    }
    throw wrongCode();
  }

  /** After a right password: a challenge token the client sends back with the code. */
  async challenge(userId: string, meta: ClientMeta) {
    const { secret, hash } = this.tokens.newSecret();
    const now = new Date();
    const c = await this.store.collection(mfaChallenges).insertOne({
      userId,
      secretHash: hash,
      attempts: 0,
      expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_SECONDS * 1000),
      usedAt: null,
      ipAddress: meta.ip?.slice(0, 64) || null,
      userAgent: meta.userAgent?.slice(0, 300) || null,
      createdAt: now,
    });
    return { mfaRequired: true as const, challengeToken: `${c.id}.${secret}`, expiresIn: MFA_CHALLENGE_TTL_SECONDS };
  }

  /** The code step of a sign-in. Returns the user whose sign-in may finish, or refuses. */
  async completeChallenge(token: string, code: string): Promise<{ userId: string; via: 'APP' | 'RECOVERY_CODE' }> {
    const expired = () => new UnauthorizedException({ error: 'MFA_CHALLENGE_EXPIRED', message: 'This sign-in took too long or had too many wrong codes. Sign in again.' });
    const parsed = parseRefreshToken(token);
    if (!parsed) throw expired();
    const c = await this.store.collection(mfaChallenges).findById(parsed.sessionId);
    if (!c || !sameHash(c.secretHash, hashSecret(parsed.secret)) || c.usedAt || c.expiresAt <= new Date() || c.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) throw expired();
    const m = await this.store.collection(userMfa).findById(c.userId);
    const user = await this.store.collection(users).findById(c.userId);
    if (!m || m.status !== 'ACTIVE' || !user?.isActive) throw expired();
    try {
      const via = await this.useCode(m, code);
      const res = await this.store.collection(mfaChallenges).updateOne({ id: c.id, usedAt: null }, { $set: { usedAt: new Date() } });
      if (!res.matched) throw expired();
      return { userId: c.userId, via };
    } catch (e) {
      if (e instanceof UnprocessableEntityException) {
        const after = await this.store.collection(mfaChallenges).findOneAndUpdate({ id: c.id, usedAt: null, attempts: { $lt: MFA_CHALLENGE_MAX_ATTEMPTS } }, { $inc: { attempts: 1 } });
        if (!after || after.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) {
          await this.record(c.userId, 'user.mfa_challenge_failed', { attempts: MFA_CHALLENGE_MAX_ATTEMPTS, ip: c.ipAddress });
          throw expired();
        }
      }
      throw e;
    }
  }
}
