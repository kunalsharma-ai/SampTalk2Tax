import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { API_SCOPES, formatApiKey, parseApiKey, type ApiScope } from '@talk2tax/accounting-engine';
import { hasPermission, type Permission, type RoleName } from '@talk2tax/security';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService, withSystemAccess } from '../common/prisma.service';
import { RegionsService } from '../regions/regions.service';
import { accessOf } from '../billing/limits';

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Random characters from an alphabet, without bias (rejection sampling). */
function randomChars(n: number, alphabet: string) {
  let out = '';
  const limit = 256 - (256 % alphabet.length);
  while (out.length < n) for (const b of randomBytes(n * 2)) if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
  return out;
}

/** What each scope lets a key do, as the permission its creator's role must still have. */
export const SCOPE_PERMISSION: Record<ApiScope, Permission> = { 'crm.read': 'sales.read', 'crm.write': 'crm.manage' };

export interface ApiKeyCaller {
  keyId: string;
  prefix: string;
  scopes: ApiScope[];
  org: { id: string; role: RoleName; functionalCurrency: string; fiscalYearStartMonth: number };
  user: { id: string; email: string; name: string; platformRole: null };
}

type Actor = { id: string };

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly regions: RegionsService,
  ) {}

  private view(k: { id: string; name: string; prefix: string; scopes: string[]; createdAt: Date; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null }, users: Map<string, string>, createdById: string, revokedById: string | null) {
    const now = Date.now();
    const status = k.revokedAt ? 'REVOKED' : k.expiresAt && k.expiresAt.getTime() <= now ? 'EXPIRED' : 'ACTIVE';
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      hint: `t2t_${k.prefix}_…`,
      scopes: k.scopes,
      status,
      createdBy: users.get(createdById) ?? null,
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt?.toISOString() ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      revokedBy: revokedById ? (users.get(revokedById) ?? null) : null,
    };
  }

  async list(orgId: string) {
    const keys = await this.prisma.apiKey.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' } });
    const ids = [...new Set(keys.flatMap((k) => [k.createdById, k.revokedById].filter((x): x is string => !!x)))];
    const users = new Map((ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
    return { keys: keys.map((k) => this.view(k, users, k.createdById, k.revokedById)), scopes: API_SCOPES };
  }

  /** A new key. The key itself is returned only here; afterwards only its prefix is known. */
  async create(org: { id: string; role: RoleName }, actor: Actor, input: { name: string; scopes: ApiScope[]; expiresAt?: string | null }) {
    const scopes = [...new Set(input.scopes)].sort() as ApiScope[];
    for (const s of scopes) {
      if (!hasPermission(org.role, SCOPE_PERMISSION[s])) throw new DomainError('API_KEY_SCOPE', `Your role cannot give a key "${s}": it needs ${SCOPE_PERMISSION[s]}`, HttpStatus.FORBIDDEN);
    }
    const expiresAt = input.expiresAt ? new Date(`${input.expiresAt}T23:59:59+05:30`) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new DomainError('API_KEY_EXPIRY', 'Choose an expiry date in the future', HttpStatus.UNPROCESSABLE_ENTITY);
    const prefix = randomChars(8, LOWER);
    const key = formatApiKey(prefix, randomChars(40, ALPHANUM));
    const row = await this.prisma.$transaction(async (tx) => {
      const k = await tx.apiKey.create({ data: { orgId: org.id, name: input.name.trim(), prefix, keyHash: hash(key), scopes, createdById: actor.id, expiresAt } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'api_key.created', entityType: 'api_key', entityId: k.id, data: { name: k.name, prefix, scopes, expiresAt: expiresAt?.toISOString() ?? null } });
      return k;
    });
    const users = new Map([[actor.id, (await this.prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }))?.name ?? '']]);
    return { ...this.view(row, users, row.createdById, null), key };
  }

  async revoke(orgId: string, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const k = await tx.apiKey.findFirst({ where: { id, orgId } });
      if (!k) throw new NotFoundException({ error: 'NOT_FOUND', message: 'API key not found' });
      if (k.revokedAt) throw new DomainError('API_KEY_REVOKED', 'This key is already revoked', HttpStatus.CONFLICT);
      await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'api_key.revoked', entityType: 'api_key', entityId: id, data: { name: k.name, prefix: k.prefix } });
    });
    return this.list(orgId);
  }

  /**
   * Who is calling, from the Authorization header: a live key of an organisation that is served
   * here, whose creator is still a member with a role that allows the scope this call needs.
   */
  async authenticate(header: string | undefined, need: ApiScope, write: boolean): Promise<ApiKeyCaller> {
    const unauthorised = (message: string) => new UnauthorizedException({ error: 'INVALID_API_KEY', message });
    const raw = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!raw) throw unauthorised('Send the key as "Authorization: Bearer t2t_…"');
    if (!parseApiKey(raw)) throw unauthorised('That is not a Talk2Tax API key');
    const found = await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const k = await tx.apiKey.findUnique({ where: { keyHash: hash(raw.trim()) } });
        if (!k) return null;
        const member = await tx.membership.findUnique({
          where: { orgId_userId: { orgId: k.orgId, userId: k.createdById } },
          include: {
            user: { select: { id: true, email: true, name: true } },
            org: { select: { functionalCurrency: true, fiscalYearStartMonth: true, dataRegion: true, suspendedAt: true, suspendedReason: true, subscription: { select: { status: true, trialEndsAt: true, currentPeriodEnd: true, plan: { select: { name: true, features: true } } } } } },
          },
        });
        return { k, member };
      }),
    );
    if (!found) throw unauthorised('This key is not recognised');
    const { k, member } = found;
    if (k.revokedAt) throw unauthorised('This key was revoked');
    if (k.expiresAt && k.expiresAt.getTime() <= Date.now()) throw unauthorised('This key has expired');
    if (!member) throw unauthorised('The person who made this key has left the organisation; make a new key');
    this.regions.assertHere(member.org.dataRegion);
    if (!k.scopes.includes(need)) throw new ForbiddenException({ error: 'API_KEY_SCOPE', message: `This key does not have the ${need} scope` });
    const role = member.role as RoleName;
    if (!hasPermission(role, SCOPE_PERMISSION[need])) throw new ForbiddenException({ error: 'FORBIDDEN', message: `The key's owner (${role}) no longer has ${SCOPE_PERMISSION[need]}` });
    if (write && member.org.suspendedAt) throw new HttpException({ error: 'ORG_SUSPENDED', message: `This organisation is suspended: ${member.org.suspendedReason}` }, HttpStatus.LOCKED);
    if (write && member.org.subscription && accessOf(member.org.subscription).level === 'READ_ONLY') throw new HttpException({ error: 'PLAN_REQUIRED', message: 'The organisation has no active plan, so records cannot be changed' }, HttpStatus.PAYMENT_REQUIRED);
    // Recorded at most once a minute, so a busy integration does not write on every call.
    if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60_000) {
      await this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => tx.apiKey.update({ where: { id: k.id }, data: { lastUsedAt: new Date() } })));
    }
    return {
      keyId: k.id,
      prefix: k.prefix,
      scopes: k.scopes as ApiScope[],
      org: { id: k.orgId, role, functionalCurrency: member.org.functionalCurrency, fiscalYearStartMonth: member.org.fiscalYearStartMonth },
      user: { ...member.user, platformRole: null },
    };
  }
}
