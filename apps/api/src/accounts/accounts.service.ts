import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AccountNode, AccountType, isValidSubtype, validateAccountParent } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { accounts, type AccountDoc } from '../db/collections/chart';
import { organizations } from '../db/collections/tenancy';
import { PostgresMirrorService, thenInPostgres } from '../db/postgres-mirror.service';

export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  description?: string;
  parentId?: string | null;
  isPostable?: boolean;
}

export interface UpdateAccountInput {
  code?: string;
  name?: string;
  subtype?: string | null;
  description?: string | null;
  parentId?: string | null;
  isPostable?: boolean;
  isActive?: boolean;
}

/**
 * The chart of accounts. MongoDB holds it; after each change the account is copied to
 * PostgreSQL, where the ledger (not moved yet) posts against it and keeps its foreign keys.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
  ) {}

  private accounts(orgId: string) {
    const c = this.store.collection(accounts);
    return {
      find: (filter: Record<string, unknown>, sort?: Record<string, 1 | -1>) => runInOrg(orgId, () => c.find(filter, sort ? { sort } : {})),
      byId: (id: string) => runInOrg(orgId, () => c.findOne({ id })),
      count: (filter: Record<string, unknown>) => runInOrg(orgId, () => c.count(filter)),
      insert: (doc: Omit<AccountDoc, 'id' | 'orgId'>) => runInOrg(orgId, () => c.insertOne(doc)),
      update: (id: string, set: Record<string, unknown>) => runInOrg(orgId, () => c.updateOne({ id }, { $set: set })),
      remove: (id: string) => runInOrg(orgId, () => c.deleteOne({ id })),
    };
  }

  async list(orgId: string, opts: { includeInactive?: boolean; type?: AccountType }) {
    const rows = await this.accounts(orgId).find({ ...(opts.type ? { type: opts.type } : {}), ...(opts.includeInactive ? {} : { isActive: true }) }, { code: 1 });
    return rows.map(serialize);
  }

  async get(orgId: string, id: string) {
    const a = await this.accounts(orgId).byId(id);
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
    return serialize(a);
  }

  private async nodes(orgId: string): Promise<Map<string, AccountNode>> {
    const all = await this.accounts(orgId).find({});
    return new Map(all.map((a) => [a.id, { id: a.id, parentId: a.parentId, type: a.type } as AccountNode]));
  }

  async create(orgId: string, actorId: string, input: CreateAccountInput) {
    if (input.subtype && !isValidSubtype(input.type, input.subtype)) {
      throw new UnprocessableEntityException({ error: 'INVALID_SUBTYPE', message: `${input.subtype} is not a valid ${input.type} subtype` });
    }
    const parentError = validateAccountParent(null, input.type, input.parentId ?? null, await this.nodes(orgId));
    if (parentError) throw new UnprocessableEntityException({ error: 'INVALID_PARENT', message: parentError });
    const now = new Date();
    const a = await this.accounts(orgId).insert({
      code: input.code,
      name: input.name,
      type: input.type,
      subtype: input.subtype ?? null,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      isPostable: input.isPostable ?? true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    return thenInPostgres(
      serialize(a),
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.mirror.accounts([a.id], tx);
          await this.audit.append(tx, { orgId, actorId, action: 'account.created', entityType: 'account', entityId: a.id, data: { ...input } });
        }),
      async () => void (await this.accounts(orgId).remove(a.id)),
    );
  }

  async update(orgId: string, actorId: string, id: string, input: UpdateAccountInput) {
    const before = await this.accounts(orgId).byId(id);
    if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
    // Journal lines are still in PostgreSQL.
    const lineCount = await this.prisma.journalLine.count({ where: { orgId, accountId: id } });
    const org = await this.store.collection(organizations).findById(orgId);
    if (org && (id === org.arAccountId || id === org.apAccountId || id === org.claimsAccountId) && (input.isActive === false || input.isPostable === false)) {
      throw new ConflictException({ error: 'CONTROL_ACCOUNT', message: 'The receivables and payables control accounts must stay active and postable' });
    }

    if (input.subtype && !isValidSubtype(before.type, input.subtype)) {
      throw new UnprocessableEntityException({ error: 'INVALID_SUBTYPE', message: `${input.subtype} is not a valid ${before.type} subtype` });
    }
    if (input.code !== undefined && input.code !== before.code && lineCount > 0) {
      throw new ConflictException({ error: 'ACCOUNT_IN_USE', message: 'The code of an account with journal lines cannot change' });
    }
    if (input.isPostable === false && before.isPostable && lineCount > 0) {
      throw new ConflictException({ error: 'ACCOUNT_IN_USE', message: 'An account with journal lines cannot become a header account' });
    }
    if (input.isPostable === true && !before.isPostable) {
      const children = await this.accounts(orgId).count({ parentId: id });
      if (children > 0) throw new ConflictException({ error: 'HAS_CHILDREN', message: 'An account with child accounts must stay a header account' });
    }
    if (input.isActive === false && before.isActive) {
      const bal = await this.prisma.journalLine.aggregate({
        where: { orgId, accountId: id, entry: { status: 'POSTED' } },
        _sum: { functionalDebit: true, functionalCredit: true },
      });
      const d = bal._sum.functionalDebit;
      const c = bal._sum.functionalCredit;
      if (d && c && !d.equals(c)) {
        throw new ConflictException({ error: 'NON_ZERO_BALANCE', message: 'Accounts with a non-zero balance cannot be deactivated' });
      }
    }
    if (input.parentId !== undefined) {
      const err = validateAccountParent(id, before.type, input.parentId, await this.nodes(orgId));
      if (err) throw new UnprocessableEntityException({ error: 'INVALID_PARENT', message: err });
    }

    const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    await this.accounts(orgId).update(id, { ...changes, updatedAt: new Date() });
    const after = (await this.accounts(orgId).byId(id))!;
    return thenInPostgres(
      serialize(after),
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.mirror.accounts([id], tx);
          await this.audit.append(tx, { orgId, actorId, action: 'account.updated', entityType: 'account', entityId: id, data: { before: serialize(before), changes: { ...input } } });
        }),
      async () => {
        const { id: _id, orgId: _org, ...was } = before;
        await this.accounts(orgId).update(id, was);
      },
    );
  }
}

export function serialize(a: {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  description: string | null;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
}) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    description: a.description,
    parentId: a.parentId,
    isPostable: a.isPostable,
    isActive: a.isActive,
  };
}
