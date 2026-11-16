import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AccountNode, AccountType, isValidSubtype, validateAccountParent } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';

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

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, opts: { includeInactive?: boolean; type?: AccountType }) {
    const rows = await this.prisma.account.findMany({
      where: { orgId, type: opts.type, ...(opts.includeInactive ? {} : { isActive: true }) },
      orderBy: { code: 'asc' },
    });
    return rows.map(serialize);
  }

  async get(orgId: string, id: string) {
    const a = await this.prisma.account.findFirst({ where: { id, orgId } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
    return serialize(a);
  }

  private async nodes(orgId: string): Promise<Map<string, AccountNode>> {
    const all = await this.prisma.account.findMany({ where: { orgId }, select: { id: true, parentId: true, type: true } });
    return new Map(all.map((a) => [a.id, a as AccountNode]));
  }

  async create(orgId: string, actorId: string, input: CreateAccountInput) {
    if (input.subtype && !isValidSubtype(input.type, input.subtype)) {
      throw new UnprocessableEntityException({ error: 'INVALID_SUBTYPE', message: `${input.subtype} is not a valid ${input.type} subtype` });
    }
    const parentError = validateAccountParent(null, input.type, input.parentId ?? null, await this.nodes(orgId));
    if (parentError) throw new UnprocessableEntityException({ error: 'INVALID_PARENT', message: parentError });
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.account.create({
        data: {
          orgId,
          code: input.code,
          name: input.name,
          type: input.type,
          subtype: input.subtype,
          description: input.description,
          parentId: input.parentId ?? null,
          isPostable: input.isPostable ?? true,
        },
      });
      await this.audit.append(tx, { orgId, actorId, action: 'account.created', entityType: 'account', entityId: a.id, data: { ...input } });
      return serialize(a);
    });
  }

  async update(orgId: string, actorId: string, id: string, input: UpdateAccountInput) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.account.findFirst({ where: { id, orgId } });
      if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
      const lineCount = await tx.journalLine.count({ where: { orgId, accountId: id } });

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
        const children = await tx.account.count({ where: { orgId, parentId: id } });
        if (children > 0) throw new ConflictException({ error: 'HAS_CHILDREN', message: 'An account with child accounts must stay a header account' });
      }
      if (input.isActive === false && before.isActive) {
        const bal = await tx.journalLine.aggregate({
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
        const all = await tx.account.findMany({ where: { orgId }, select: { id: true, parentId: true, type: true } });
        const err = validateAccountParent(id, before.type, input.parentId, new Map(all.map((a) => [a.id, a as AccountNode])));
        if (err) throw new UnprocessableEntityException({ error: 'INVALID_PARENT', message: err });
      }

      const after = await tx.account.update({ where: { id }, data: input });
      await this.audit.append(tx, {
        orgId,
        actorId,
        action: 'account.updated',
        entityType: 'account',
        entityId: id,
        data: { before: serialize(before), changes: { ...input } },
      });
      return serialize(after);
    });
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
