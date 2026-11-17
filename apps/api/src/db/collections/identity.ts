import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * People, their signed-in sessions and the failed sign-in counters. All global: a person
 * is not owned by an organisation (memberships link the two).
 */

export interface UserDoc {
  id: string;
  /** Lower-case; unique. */
  email: string;
  name: string;
  passwordHash: string;
  isActive: boolean;
  /** Platform administration: SUPER_ADMIN or SUPPORT; null for everyone else. */
  platformRole: 'SUPER_ADMIN' | 'SUPPORT' | null;
  language: 'en' | 'hi';
  numberFormat: 'AUTO' | 'IN' | 'INTL' | 'EU' | 'SPACE';
  dateFormat: 'D_MON_Y' | 'DMY' | 'MDY' | 'YMD';
  /** IANA time zone; null = the organisation's. */
  timeZone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const users = defineCollection<UserDoc>({
  name: 'users',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['email', 'name', 'passwordHash', 'isActive', 'language', 'numberFormat', 'dateFormat', 'createdAt', 'updatedAt'],
    properties: {
      _id: { bsonType: 'string' },
      email: { bsonType: 'string', minLength: 3 },
      name: { bsonType: 'string' },
      passwordHash: { bsonType: 'string', minLength: 1 },
      isActive: { bsonType: 'bool' },
      platformRole: { enum: [null, 'SUPER_ADMIN', 'SUPPORT'] },
      language: { enum: ['en', 'hi'] },
      numberFormat: { enum: ['AUTO', 'IN', 'INTL', 'EU', 'SPACE'] },
      dateFormat: { enum: ['D_MON_Y', 'DMY', 'MDY', 'YMD'] },
      timeZone: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$' }] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { email: 1 }, name: 'email', unique: true },
    { key: { platformRole: 1 }, name: 'platform_role', partialFilterExpression: { platformRole: { $type: 'string' } } },
  ],
});

/**
 * A signed-in device. The access token names the session, so revoking it ends access at
 * once. The refresh token is `<session id>.<secret>`; only a SHA-256 of the secret is kept.
 */
export interface AuthSessionDoc {
  id: string;
  userId: string;
  secretHash: string;
  /** The secret before the last rotation, accepted for a short grace window. */
  previousSecretHash: string | null;
  rotatedAt: Date | null;
  rotationCount: number;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  /** Hard limit: the session ends here however active it is. */
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export const authSessions = defineCollection<AuthSessionDoc>({
  name: 'auth_sessions',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['userId', 'secretHash', 'rotationCount', 'createdAt', 'lastUsedAt', 'expiresAt'],
    properties: {
      userId: { bsonType: 'string' },
      secretHash: { bsonType: 'string' },
      previousSecretHash: { bsonType: ['string', 'null'] },
      rotatedAt: { bsonType: ['date', 'null'] },
      rotationCount: { bsonType: ['int', 'long'], minimum: 0 },
      userAgent: { bsonType: ['string', 'null'], maxLength: 300 },
      ipAddress: { bsonType: ['string', 'null'], maxLength: 64 },
      createdAt: { bsonType: 'date' },
      lastUsedAt: { bsonType: 'date' },
      expiresAt: { bsonType: 'date' },
      revokedAt: { bsonType: ['date', 'null'] },
      revokedReason: { bsonType: ['string', 'null'] },
    },
  },
  indexes: [
    { key: { userId: 1, revokedAt: 1 }, name: 'user_revoked' },
    { key: { lastUsedAt: 1 }, name: 'last_used' },
  ],
  guards: {
    // Was the auth_sessions_guard trigger.
    beforeInsert(s) {
      if (!(s.expiresAt > s.createdAt)) throw new GuardViolation('A session must expire after it starts');
    },
    afterUpdate(before, after) {
      if (after.userId !== before.userId || after.createdAt.getTime() !== before.createdAt.getTime()) {
        throw new GuardViolation('A session cannot change its user');
      }
      if (before.revokedAt && (after.revokedAt?.getTime() !== before.revokedAt.getTime() || after.secretHash !== before.secretHash)) {
        throw new GuardViolation('A revoked session cannot be used again');
      }
      if (after.expiresAt > before.expiresAt) throw new GuardViolation('A session cannot be extended past its hard expiry');
    },
  },
});

/**
 * Failed sign-in counter per email address (the id), whether or not an account exists, so
 * lockout answers the same way for real and unknown addresses.
 */
export interface LoginThrottleDoc {
  id: string;
  failures: number;
  firstFailureAt: Date;
  lockedUntil: Date | null;
  updatedAt: Date;
}

export const loginThrottles = defineCollection<LoginThrottleDoc>({
  name: 'login_throttles',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['failures', 'firstFailureAt', 'updatedAt'],
    properties: {
      failures: { bsonType: ['int', 'long'], minimum: 0 },
      firstFailureAt: { bsonType: 'date' },
      lockedUntil: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: 'date' },
    },
  },
});
