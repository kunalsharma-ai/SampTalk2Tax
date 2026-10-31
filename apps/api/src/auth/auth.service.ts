import { ConflictException, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { hashPassword, passwordPolicyErrors, verifyPassword } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { LoginThrottleService } from './login-throttle.service';
import { ClientMeta, SessionsService } from './sessions.service';

// A real hash of a random string, used so unknown-email logins take as long as real ones.
const DUMMY_HASH_PROMISE = hashPassword('timing-equaliser-' + Math.random().toString(36));

function weak(password: string) {
  const errors = passwordPolicyErrors(password);
  if (errors.length) throw new UnprocessableEntityException({ error: 'WEAK_PASSWORD', message: errors.join('; ') });
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  async register(input: { email: string; name: string; password: string }, meta: ClientMeta) {
    weak(input.password);
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException({ error: 'EMAIL_TAKEN', message: 'An account with this email already exists' });
    const passwordHash = await hashPassword(input.password);
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, name: input.name.trim(), passwordHash } });
      await this.audit.append(tx, { orgId: null, actorId: u.id, action: 'user.registered', entityType: 'user', entityId: u.id });
      const session = await this.sessions.create(tx, u.id, meta);
      return { user: { id: u.id, email: u.email, name: u.name }, ...session };
    });
  }

  async login(input: { email: string; password: string }, meta: ClientMeta) {
    const email = input.email.trim().toLowerCase();
    await this.throttle.assertNotLocked(email);
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user ? await verifyPassword(input.password, user.passwordHash) : (await verifyPassword(input.password, await DUMMY_HASH_PROMISE), false);
    if (!user || !ok || !user.isActive) {
      const lockedNow = await this.throttle.recordFailure(email);
      if (lockedNow && user) {
        await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: null, action: 'user.sign_in_locked', entityType: 'user', entityId: user.id, data: { ip: meta.ip ?? null } }));
      }
      throw new UnauthorizedException({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' });
    }
    await this.throttle.clear(email);
    const session = await this.prisma.$transaction((tx) => this.sessions.create(tx, user.id, meta));
    return { user: { id: user.id, email: user.email, name: user.name }, ...session };
  }

  /** Changes the password and signs out every other session of the user. */
  async changePassword(userId: string, currentSessionId: string, input: { currentPassword: string; newPassword: string }) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new UnprocessableEntityException({ error: 'WRONG_PASSWORD', message: 'Current password is incorrect' });
    }
    weak(input.newPassword);
    if (input.newPassword === input.currentPassword) {
      throw new UnprocessableEntityException({ error: 'SAME_PASSWORD', message: 'Choose a password different from the current one' });
    }
    const passwordHash = await hashPassword(input.newPassword);
    const signedOut = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await this.audit.append(tx, { orgId: null, actorId: userId, action: 'user.password_changed', entityType: 'user', entityId: userId });
      return this.sessions.revokeOthers(tx, userId, currentSessionId, 'password_changed');
    });
    return { otherSessionsSignedOut: signedOut };
  }
}
