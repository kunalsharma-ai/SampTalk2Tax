import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, financialTagIssues, minorUnits, TAG_PRESETS } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { FinancialTagDoc, financialTags } from '../db/collections/financial-tags';
import { lineSums, postedBetween } from '../db/ledger-queries';

export interface TagInput {
  key: string;
  label: string;
  isActive?: boolean;
  values: { code: string; name: string; isActive?: boolean }[];
}

/**
 * Financial tags (GL-031) and locations (GL-028). MongoDB only. The organisation defines the
 * tags it reports by; journal lines carry them in `dimensions`, and profit by tag splits the
 * profit and loss by one of them. accounts.read sees them, accounts.manage changes them.
 */
@Injectable()
export class FinancialTagsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private invalid(issues: string[]) {
    return new DomainError('TAG_INVALID', issues[0] ?? 'The tag is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }

  private clean(t: TagInput) {
    return {
      key: t.key.trim(),
      label: t.label.trim(),
      values: t.values.map((v) => ({ code: v.code.trim().toUpperCase(), name: v.name.trim(), isActive: v.isActive ?? true })),
    };
  }

  private serialize(t: FinancialTagDoc) {
    return { id: t.id, key: t.key, label: t.label, isActive: t.isActive, values: t.values, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString() };
  }

  async list() {
    const rows = await this.store.collection(financialTags).find({}, { sort: { label: 1 } });
    const used = new Set(rows.map((r) => r.key));
    return {
      items: rows.map((r) => this.serialize(r)),
      presets: Object.entries(TAG_PRESETS).filter(([key]) => !used.has(key)).map(([key, label]) => ({ key, label })),
    };
  }

  async create(org: OrgContext, actorId: string, input: TagInput) {
    const t = this.clean(input);
    const issues = financialTagIssues(t);
    if (issues.length) throw this.invalid(issues);
    const now = new Date();
    try {
      const doc = await this.store.collection(financialTags).insertOne({ orgId: org.id, ...t, isActive: input.isActive ?? true, createdById: actorId, createdAt: now, updatedAt: now });
      await this.log(org.id, actorId, 'financial_tag.created', doc.id, { key: t.key, label: t.label, values: t.values.length });
      return this.serialize(doc);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('TAG_EXISTS', `A tag with key ${t.key} already exists`, HttpStatus.CONFLICT);
      throw e;
    }
  }

  async update(org: OrgContext, actorId: string, id: string, input: Omit<TagInput, 'key'>) {
    const before = await this.store.collection(financialTags).findById(id);
    if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Tag not found' });
    const t = this.clean({ ...input, key: before.key });
    const issues = financialTagIssues(t);
    const codes = new Set(t.values.map((v) => v.code));
    for (const v of before.values) if (!codes.has(v.code)) issues.push(`Value ${v.code} may be on journal lines: switch it off instead of removing it`);
    if (issues.length) throw this.invalid(issues);
    const isActive = input.isActive ?? before.isActive;
    await this.store.collection(financialTags).updateOne({ id }, { $set: { label: t.label, values: t.values, isActive, updatedAt: new Date() } } as never);
    await this.log(org.id, actorId, 'financial_tag.updated', id, { key: before.key, label: t.label, isActive, values: t.values.length });
    return this.serialize((await this.store.collection(financialTags).findById(id))!);
  }

  /**
   * Profit and loss split by one tag over posted entries in a period (closing entries left out).
   * Lines without the tag show as "Not tagged", so the columns add up to the whole profit.
   */
  async profitByTag(org: OrgContext, q: { key: string; from: string; to: string }) {
    const tag = await this.store.collection(financialTags).findOne({ key: q.key });
    if (!tag) throw new NotFoundException({ error: 'NOT_FOUND', message: `No tag with key ${q.key}` });
    if (q.from > q.to) throw this.invalid(['The start date is after the end date']);
    const pl = await this.store.collection(accounts).find({ type: { $in: ['REVENUE', 'EXPENSE'] } }, { sort: { code: 1 } });
    const scale = minorUnits(org.functionalCurrency);
    const sums = pl.length
      ? await lineSums(this.store, org.id, {
          entry: postedBetween(toDbDate(q.from), toDbDate(q.to), { excludeClosing: true }),
          line: { accountId: { $in: pl.map((a) => a.id) } },
          by: { accountId: 'lines.accountId', value: `lines.dimensions.${tag.key}` },
        })
      : [];
    const names = new Map(tag.values.map((v) => [v.code, v.name]));
    const columns = new Map<string, { code: string | null; name: string; revenue: InstanceType<typeof D>; expenses: InstanceType<typeof D> }>();
    const rows = new Map<string, { accountId: string; code: string; name: string; type: string; amounts: Map<string, InstanceType<typeof D>> }>();
    const byId = new Map(pl.map((a) => [a.id, a]));
    for (const s of sums) {
      const a = byId.get(String(s.key.accountId));
      if (!a) continue;
      const code = typeof s.key.value === 'string' && s.key.value ? s.key.value : null;
      const col = code ?? '';
      if (!columns.has(col)) columns.set(col, { code, name: code ? (names.get(code) ?? `${code} (not defined)`) : 'Not tagged', revenue: new D(0), expenses: new D(0) });
      const c = columns.get(col)!;
      const amount = a.type === 'REVENUE' ? s.credit.minus(s.debit) : s.debit.minus(s.credit);
      if (a.type === 'REVENUE') c.revenue = c.revenue.plus(amount);
      else c.expenses = c.expenses.plus(amount);
      if (!rows.has(a.id)) rows.set(a.id, { accountId: a.id, code: a.code, name: a.name, type: a.type, amounts: new Map() });
      const r = rows.get(a.id)!;
      r.amounts.set(col, (r.amounts.get(col) ?? new D(0)).plus(amount));
    }
    // Defined values first in their own order, then codes nobody defined, then untagged lines.
    const order = [...tag.values.map((v) => v.code).filter((c) => columns.has(c)), ...[...columns.keys()].filter((k) => k && !names.has(k)).sort(), ...(columns.has('') ? [''] : [])];
    const fmt = (d: InstanceType<typeof D>) => d.toFixed(scale);
    let revenue = new D(0);
    let expenses = new D(0);
    for (const c of columns.values()) {
      revenue = revenue.plus(c.revenue);
      expenses = expenses.plus(c.expenses);
    }
    return {
      tag: { key: tag.key, label: tag.label },
      from: q.from,
      to: q.to,
      currency: org.functionalCurrency,
      columns: order.map((k) => {
        const c = columns.get(k)!;
        return { code: c.code, name: c.name, revenue: fmt(c.revenue), expenses: fmt(c.expenses), netIncome: fmt(c.revenue.minus(c.expenses)) };
      }),
      rows: [...rows.values()]
        .sort((a, b) => (a.type === b.type ? a.code.localeCompare(b.code) : a.type === 'REVENUE' ? -1 : 1))
        .map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, type: r.type, amounts: order.map((k) => fmt(r.amounts.get(k) ?? new D(0))), total: fmt([...r.amounts.values()].reduce((x, y) => x.plus(y), new D(0))) })),
      total: { revenue: fmt(revenue), expenses: fmt(expenses), netIncome: fmt(revenue.minus(expenses)) },
    };
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'financial_tag', entityId, data }));
  }
}
