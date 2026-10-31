import { ConflictException, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { hashPassword, passwordPolicyErrors, verifyPassword } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { TokensService } from './tokens.service';

// A real hash of a random string, used so unknown-email logins take as long as real ones.
const DUMMY_HASH_PROMISE = hashPassword('timing-equaliser-' + Math.random().toString(36));

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
  ) {}

  async register(input: { email: string; name: string; password: string }) {
    const errors = passwordPolicyErrors(input.password);
    if (errors.length) throw new UnprocessableEntityException({ error: 'WEAK_PASSWORD', message: errors.join('; ') });
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException({ error: 'EMAIL_TAKEN', message: 'An account with this email already exists' });
    const passwordHash = await hashPassword(input.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, name: input.name.trim(), passwordHash } });
      await this.audit.append(tx, { orgId: null, actorId: u.id, action: 'user.registered', entityType: 'user', entityId: u.id });
      return u;
    });
    return { user: { id: user.id, email: user.email, name: user.name }, ...(await this.tokens.issue(user.id)) };
  }

  async login(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user ? await verifyPassword(input.password, user.passwordHash) : (await verifyPassword(input.password, await DUMMY_HASH_PROMISE), false);
    if (!user || !ok || !user.isActive) {
      throw new UnauthorizedException({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' });
    }
    return { user: { id: user.id, email: user.email, name: user.name }, ...(await this.tokens.issue(user.id)) };
  }
}
