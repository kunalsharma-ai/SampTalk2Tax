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
  /** The known device this session was signed in from; null for sessions from before devices were kept. */
  deviceId?: string | null;
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
      deviceId: { bsonType: ['string', 'null'] },
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

/**
 * A person's two-step sign-in (SEC-005): an authenticator-app secret, sealed with the server's
 * key, and single-use recovery codes kept only as hashes. The id is the user's id. PENDING
 * while the person has scanned the code but not yet typed one back; ACTIVE after.
 */
export interface UserMfaDoc {
  id: string;
  status: 'PENDING' | 'ACTIVE';
  secretCipher: string;
  /** Which server key sealed the secret (SecretBox.keyId). */
  keyId: string;
  /** The last time step a code was accepted for, so a code works once. */
  lastStep: number | null;
  recoveryCodes: { hash: string; usedAt: Date | null }[];
  enabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const userMfa = defineCollection<UserMfaDoc>({
  name: 'user_mfa',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['status', 'secretCipher', 'keyId', 'recoveryCodes', 'createdAt', 'updatedAt'],
    properties: {
      _id: { bsonType: 'string' },
      status: { enum: ['PENDING', 'ACTIVE'] },
      secretCipher: { bsonType: 'string', minLength: 1 },
      keyId: { bsonType: 'string', minLength: 1 },
      lastStep: { bsonType: ['int', 'long', 'null'] },
      recoveryCodes: {
        bsonType: 'array',
        maxItems: 20,
        items: { bsonType: 'object', required: ['hash', 'usedAt'], properties: { hash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' }, usedAt: { bsonType: ['date', 'null'] } } },
      },
      enabledAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  guards: {
    beforeInsert(m) {
      if (m.status !== 'PENDING' || m.enabledAt !== null) throw new GuardViolation('Two-step sign-in starts pending, until a code from the app is typed back');
    },
    afterUpdate(before, after) {
      if ((after.status === 'ACTIVE') !== (after.enabledAt !== null)) throw new GuardViolation('Active two-step sign-in records when it was turned on, and only then');
      // Re-sealing the same secret under a new encryption key (SEC-013) changes the cipher and the key id together.
      if (before.status === 'ACTIVE' && ((after.secretCipher !== before.secretCipher && after.keyId === before.keyId) || after.status !== 'ACTIVE')) {
        throw new GuardViolation('An active authenticator cannot be swapped in place; turn two-step sign-in off first');
      }
      if (before.lastStep !== null && (after.lastStep === null || after.lastStep < before.lastStep)) throw new GuardViolation('A used code cannot be made usable again');
    },
  },
});

/**
 * The second step of a sign-in: the password was right and the person has two-step sign-in, so
 * a short-lived challenge waits for a code. The token is `<id>.<secret>`; only a SHA-256 of the
 * secret is kept. Five wrong codes end the challenge. MongoDB removes expired ones (TTL index).
 */
export interface MfaChallengeDoc {
  id: string;
  userId: string;
  secretHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

export const mfaChallenges = defineCollection<MfaChallengeDoc>({
  name: 'mfa_challenges',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['userId', 'secretHash', 'attempts', 'expiresAt', 'createdAt'],
    properties: {
      userId: { bsonType: 'string' },
      secretHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      attempts: { bsonType: ['int', 'long'], minimum: 0, maximum: MFA_CHALLENGE_MAX_ATTEMPTS },
      expiresAt: { bsonType: 'date' },
      usedAt: { bsonType: ['date', 'null'] },
      ipAddress: { bsonType: ['string', 'null'], maxLength: 64 },
      userAgent: { bsonType: ['string', 'null'], maxLength: 300 },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { userId: 1 }, name: 'user' },
    { key: { expiresAt: 1 }, name: 'expires', expireAfterSeconds: 0 },
  ],
  guards: {
    afterUpdate(before, after) {
      if (after.userId !== before.userId || after.secretHash !== before.secretHash || after.expiresAt.getTime() !== before.expiresAt.getTime()) throw new GuardViolation('A sign-in challenge cannot be changed');
      if (before.usedAt) throw new GuardViolation('A sign-in challenge is used once');
      if (after.attempts < before.attempts) throw new GuardViolation('Wrong codes cannot be forgotten');
    },
  },
});

/**
 * The browsers a person has signed in from (SEC-009). The web app keeps a random device key in a
 * long-lived httpOnly cookie and sends it on sign-in; only its SHA-256 is kept here. Signing in
 * from a key not seen before, once the person has another device, sends them an alert. A device
 * can be trusted for 30 days, when signing in there skips the two-step code.
 */
export interface KnownDeviceDoc {
  id: string;
  userId: string;
  keyHash: string;
  /** "Chrome on Windows", from the browser's user agent when first seen. */
  label: string;
  userAgent: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastIp: string | null;
  /** Signing in here skips the two-step code until then; null when not trusted. */
  trustedUntil: Date | null;
}

export const knownDevices = defineCollection<KnownDeviceDoc>({
  name: 'known_devices',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['userId', 'keyHash', 'label', 'firstSeenAt', 'lastSeenAt'],
    properties: {
      userId: { bsonType: 'string' },
      keyHash: { bsonType: 'string', minLength: 64, maxLength: 64 },
      label: { bsonType: 'string', maxLength: 120 },
      userAgent: { bsonType: ['string', 'null'], maxLength: 300 },
      firstSeenAt: { bsonType: 'date' },
      lastSeenAt: { bsonType: 'date' },
      lastIp: { bsonType: ['string', 'null'], maxLength: 64 },
      trustedUntil: { bsonType: ['date', 'null'] },
    },
  },
  indexes: [{ key: { userId: 1, keyHash: 1 }, name: 'user_key', unique: true }],
  guards: {
    afterUpdate(before, after) {
      if (after.userId !== before.userId || after.keyHash !== before.keyHash) throw new GuardViolation('A device keeps its person and key');
    },
  },
});
