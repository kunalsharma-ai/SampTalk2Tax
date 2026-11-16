import { postgresOnly } from '../db/mirror-writes';
import { HttpStatus, Injectable } from '@nestjs/common';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { Tx } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { accounts, type AccountDoc, type AccountTypeName } from '../db/collections/chart';
import { PostgresMirrorService } from '../db/postgres-mirror.service';

export interface SystemAccountSpec {
  code: string;
  name: string;
  type: AccountTypeName;
  subtype?: string | null;
  description?: string | null;
  /** Placed under this header account when it exists, is a header and has the same type. */
  parentCode?: string | null;
}

/**
 * Writes to the chart of accounts for modules that set up their own accounts (GST, payroll,
 * TDS/TCS, bad debts, expense claims). MongoDB holds the chart; each account is copied into the
 * caller's PostgreSQL transaction, which still posts against it.
 *
 * If the caller's transaction is rolled back, the account stays in MongoDB without its copy.
 * Setting up again finds it by code, copies it, and records it in the audit trail then: an
 * account is audited as created in the same transaction that first gives PostgreSQL its copy.
 */
@Injectable()
export class ChartService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
    private readonly audit: AuditService,
  ) {}

  private chart(orgId: string) {
    const c = this.store.collection(accounts);
    return {
      byCode: (code: string) => runInOrg(orgId, () => c.findOne({ code })),
      find: (filter: Record<string, unknown>) => runInOrg(orgId, () => c.find(filter)),
      insert: (doc: Omit<AccountDoc, 'id' | 'orgId'>) => runInOrg(orgId, () => c.insertOne(doc)),
    };
  }

  async byCode(orgId: string, code: string) {
    return this.chart(orgId).byCode(code);
  }

  async find(orgId: string, filter: Record<string, unknown>) {
    return this.chart(orgId).find(filter);
  }

  /**
   * The standard account for each spec: the one with its code if that account has the same
   * name and type, otherwise a new one. A code used by another account is refused.
   */
  async ensure<K extends string>(tx: Tx, orgId: string, actorId: string, specs: Record<K, SystemAccountSpec>, reason: string): Promise<Record<K, string>> {
    const out = {} as Record<K, string>;
    for (const key of Object.keys(specs) as K[]) {
      const spec = specs[key];
      const existing = await this.chart(orgId).byCode(spec.code);
      if (existing && (existing.name !== spec.name || existing.type !== spec.type)) {
        throw new DomainError('ACCOUNT_CODE_TAKEN', `Account code ${spec.code} is already used by "${existing.name}". Choose the accounts yourself.`, HttpStatus.CONFLICT);
      }
      out[key] = existing ? (await this.copied(tx, orgId, actorId, existing, reason)).id : await this.create(tx, orgId, actorId, spec, reason);
    }
    return out;
  }

  /** Adds one account and copies it into `tx`. Returns its id. */
  async create(tx: Tx, orgId: string, actorId: string, spec: SystemAccountSpec, reason: string): Promise<string> {
    const parent = spec.parentCode ? await this.chart(orgId).byCode(spec.parentCode) : null;
    const now = new Date();
    let a: AccountDoc;
    try {
      a = await this.chart(orgId).insert({
        code: spec.code,
        name: spec.name,
        type: spec.type,
        subtype: spec.subtype ?? null,
        description: spec.description ?? null,
        parentId: parent && !parent.isPostable && parent.type === spec.type ? parent.id : null,
        isPostable: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
      // Set up at the same moment by another request.
      const other = await this.chart(orgId).byCode(spec.code);
      if (!other || other.name !== spec.name || other.type !== spec.type) throw new DomainError('ACCOUNT_CODE_TAKEN', `Account code ${spec.code} was just taken`, HttpStatus.CONFLICT);
      a = other;
    }
    return (await this.copied(tx, orgId, actorId, a, reason)).id;
  }

  /** Makes sure PostgreSQL has its copy; the first copy is when the account is audited as created. */
  private async copied(tx: Tx, orgId: string, actorId: string, a: AccountDoc, reason: string) {
    const present = await postgresOnly(tx).account.findFirst({ where: { id: a.id, orgId }, select: { id: true } });
    if (present) return a;
    await this.mirror.accounts([...(a.parentId ? [a.parentId] : []), a.id], tx);
    await this.audit.append(tx, { orgId, actorId, action: 'account.created', entityType: 'account', entityId: a.id, data: { code: a.code, name: a.name, type: a.type, subtype: a.subtype, reason } });
    return a;
  }
}
