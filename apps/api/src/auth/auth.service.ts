import { ConflictException, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { hashPassword, passwordPolicyErrors, verifyPassword } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { PostgresMirrorService, thenInPostgres } from '../db/postgres-mirror.service';
import { LoginThrottleService } from './login-throttle.service';
import { ClientMeta, SessionsService } from './sessions.service';

// A real hash of a random string, used so unknown-email logins take as long as real ones.
const DUMMY_HASH_PROMISE = hashPassword('timing-equaliser-' + Math.random().toString(36));

function weak(password: string) {
  const errors = passwordPolicyErrors(password);
  if (errors.length) throw new UnprocessableEntityException({ error: 'WEAK_PASSWORD', message: errors.join('; ') });
}

const emailTaken = () => new ConflictException({ error: 'EMAIL_TAKEN', message: 'An account with this email already exists' });

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
    private readonly sessions: SessionsService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  async register(input: { email: string; name: string; password: string }, meta: ClientMeta) {
    weak(input.password);
    const email = input.email.trim().toLowerCase();
    if (await this.store.collection(users).exists({ email })) throw emailTaken();
    const passwordHash = await hashPassword(input.password);
    const now = new Date();
    const created = await this.store
      .transaction(async () => {
        const u = await this.store.collection(users).insertOne({
          email,
          name: input.name.trim(),
          passwordHash,
          isActive: true,
          platformRole: null,
          language: 'en',
          numberFormat: 'AUTO',
          dateFormat: 'D_MON_Y',
          timeZone: null,
          createdAt: now,
          updatedAt: now,
        });
        const session = await this.sessions.create(u.id, meta);
        return { u, session };
      })
      .catch((e: unknown) => {
        // Two registrations racing for one address: the unique index decides.
        throw isDuplicateKeyError(e) ? emailTaken() : e;
      });
    const { u, session } = created;
    return thenInPostgres(
      { user: { id: u.id, email: u.email, name: u.name }, ...session.issued },
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.mirror.users([u.id], tx);
          await this.audit.append(tx, { orgId: null, actorId: u.id, action: 'user.registered', entityType: 'user', entityId: u.id });
          await this.sessions.auditCreated(tx, session);
        }),
      () =>
        this.store.transaction(async () => {
          await this.sessions.discard(session.issued.sessionId);
          await this.store.collection(users).deleteOne({ id: u.id });
        }),
    );
  }

  async login(input: { email: string; password: string }, meta: ClientMeta) {
    const email = input.email.trim().toLowerCase();
    await this.throttle.assertNotLocked(email);
    const user = await this.store.collection(users).findOne({ email });
    const ok = user ? await verifyPassword(input.password, user.passwordHash) : (await verifyPassword(input.password, await DUMMY_HASH_PROMISE), false);
    if (!user || !ok || !user.isActive) {
      const lockedNow = await this.throttle.recordFailure(email);
      if (lockedNow && user) {
        await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: null, action: 'user.sign_in_locked', entityType: 'user', entityId: user.id, data: { ip: meta.ip ?? null } }));
      }
      throw new UnauthorizedException({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' });
    }
    await this.throttle.clear(email);
    const session = await this.sessions.create(user.id, meta);
    return thenInPostgres(
      { user: { id: user.id, email: user.email, name: user.name }, ...session.issued },
      () => this.prisma.$transaction((tx) => this.sessions.auditCreated(tx, session)),
      () => this.sessions.discard(session.issued.sessionId),
    );
  }

  /** Changes the password and signs out every other session of the user. */
  async changePassword(userId: string, currentSessionId: string, input: { currentPassword: string; newPassword: string }) {
    const user = await this.store.collection(users).findById(userId);
    if (!user) throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'User not found' });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new UnprocessableEntityException({ error: 'WRONG_PASSWORD', message: 'Current password is incorrect' });
    }
    weak(input.newPassword);
    if (input.newPassword === input.currentPassword) {
      throw new UnprocessableEntityException({ error: 'SAME_PASSWORD', message: 'Choose a password different from the current one' });
    }
    const passwordHash = await hashPassword(input.newPassword);
    const signedOut = await this.store.transaction(async () => {
      await this.store.collection(users).updateOne({ id: userId }, { $set: { passwordHash, updatedAt: new Date() } });
      return this.sessions.revokeOthersInStore(userId, currentSessionId, 'password_changed');
    });
    // The password is changed and the other sessions are ended; the record of it follows.
    await this.prisma.$transaction(async (tx) => {
      await this.mirror.users([userId], tx);
      await this.audit.append(tx, { orgId: null, actorId: userId, action: 'user.password_changed', entityType: 'user', entityId: userId });
      if (signedOut > 0) await this.sessions.auditRevokedMany(tx, userId, signedOut, 'password_changed');
    });
    return { otherSessionsSignedOut: signedOut };
  }
}
