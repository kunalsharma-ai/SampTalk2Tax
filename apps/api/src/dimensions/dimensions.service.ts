import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { checkDimensionCode, D, minorUnits, profitByDimension, type DimensionType } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

export interface DimOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
type Actor = { id: string };

export interface ValueInput {
  type: DimensionType;
  code: string;
  name: string;
  description?: string | null;
  customer?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isActive?: boolean;
}

const LABEL: Record<DimensionType, string> = { DEPARTMENT: 'department', PROJECT: 'project' };

@Injectable()
export class DimensionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(v: { id: string; type: DimensionType; code: string; name: string; description: string | null; customer: string | null; startDate: Date | null; endDate: Date | null; isActive: boolean; createdAt: Date }, usage?: { lines: number }) {
    return {
      id: v.id,
      type: v.type,
      code: v.code,
      name: v.name,
      description: v.description,
      customer: v.customer,
      startDate: v.startDate ? fromDbDate(v.startDate) : null,
      endDate: v.endDate ? fromDbDate(v.endDate) : null,
      isActive: v.isActive,
      lines: usage?.lines ?? 0,
      createdAt: v.createdAt.toISOString(),
    };
  }

  /** Every department and project, with how many posted journal lines use each. */
  async list(org: DimOrg, type?: DimensionType) {
    const rows = await this.prisma.dimensionValue.findMany({ where: { orgId: org.id, ...(type ? { type } : {}) }, orderBy: [{ type: 'asc' }, { code: 'asc' }] });
    const counts = await this.prisma.$queryRaw<{ id: string; n: bigint }[]>`
      SELECT v.id, (SELECT COUNT(*) FROM journal_lines l WHERE l.org_id = v.org_id AND (l.department_id = v.id OR l.project_id = v.id)) AS n
      FROM dimension_values v WHERE v.org_id = ${org.id}::uuid`;
    const n = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return { values: rows.map((v) => this.serialize(v, { lines: n.get(v.id) ?? 0 })), can: { manage: hasPermission(org.role, 'accounts.manage') } };
  }

  private check(input: ValueInput) {
    const errors: string[] = [];
    const codeIssue = checkDimensionCode(input.code);
    if (codeIssue) errors.push(codeIssue);
    if (!input.name.trim()) errors.push('Give it a name');
    if (input.type === 'DEPARTMENT' && (input.customer || input.startDate || input.endDate)) errors.push('Only projects have a customer and dates');
    if (input.startDate && input.endDate && input.endDate < input.startDate) errors.push('A project cannot end before it starts');
    if (errors.length) throw new DomainError('DIMENSION_INVALID', errors[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { errors });
  }

  private duplicate(e: unknown, input: ValueInput): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new DomainError('DIMENSION_CODE_TAKEN', `There is already a ${LABEL[input.type]} with the code ${input.code.toUpperCase()}`, HttpStatus.CONFLICT);
    if (e instanceof Prisma.PrismaClientUnknownRequestError && /dimension_values_code_key/.test(e.message)) throw new DomainError('DIMENSION_CODE_TAKEN', `There is already a ${LABEL[input.type]} with the code ${input.code.toUpperCase()}`, HttpStatus.CONFLICT);
    throw e;
  }

  async create(org: DimOrg, actor: Actor, input: ValueInput) {
    this.check(input);
    try {
      const v = await this.prisma.$transaction(async (tx) => {
        const created = await tx.dimensionValue.create({
          data: {
            orgId: org.id,
            type: input.type,
            code: input.code.toUpperCase(),
            name: input.name.trim(),
            description: input.description?.trim() || null,
            customer: input.type === 'PROJECT' ? input.customer?.trim() || null : null,
            startDate: input.type === 'PROJECT' && input.startDate ? toDbDate(input.startDate) : null,
            endDate: input.type === 'PROJECT' && input.endDate ? toDbDate(input.endDate) : null,
            createdById: actor.id,
          },
        });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'dimension.created', entityType: 'dimension_value', entityId: created.id, data: { type: input.type, code: created.code, name: created.name } });
        return created;
      });
      return this.serialize(v);
    } catch (e) {
      this.duplicate(e, input);
    }
  }

  async update(org: DimOrg, actor: Actor, id: string, input: Omit<ValueInput, 'type'> & { isActive: boolean }) {
    const v = await this.prisma.dimensionValue.findFirst({ where: { id, orgId: org.id } });
    if (!v) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Department or project not found' });
    const full = { ...input, type: v.type };
    this.check(full);
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const u = await tx.dimensionValue.update({
          where: { id },
          data: {
            code: input.code.toUpperCase(),
            name: input.name.trim(),
            description: input.description?.trim() || null,
            customer: v.type === 'PROJECT' ? input.customer?.trim() || null : null,
            startDate: v.type === 'PROJECT' && input.startDate ? toDbDate(input.startDate) : null,
            endDate: v.type === 'PROJECT' && input.endDate ? toDbDate(input.endDate) : null,
            isActive: input.isActive,
          },
        });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'dimension.updated', entityType: 'dimension_value', entityId: id, data: { code: u.code, name: u.name, isActive: u.isActive, wasActive: v.isActive } });
        return u;
      });
      return this.serialize(updated);
    } catch (e) {
      this.duplicate(e, full);
    }
  }

  /** The profit and loss for a period with a column per department or project, and what is not assigned. */
  async profit(org: DimOrg, q: { type: DimensionType; from: string; to: string; includeInactive?: boolean }) {
    if (q.from > q.to) throw new DomainError('INVALID_RANGE', 'The start must be on or before the end');
    const values = await this.prisma.dimensionValue.findMany({ where: { orgId: org.id, type: q.type }, orderBy: { code: 'asc' } });
    const col = q.type === 'DEPARTMENT' ? Prisma.sql`l.department_id` : Prisma.sql`l.project_id`;
    const rows = await this.prisma.$queryRaw<{ account_id: string; code: string; name: string; type: 'REVENUE' | 'EXPENSE'; value_id: string | null; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
      SELECT a.id AS account_id, a.code, a.name, a.type::text AS type, ${col} AS value_id,
             SUM(l.functional_debit) AS debit, SUM(l.functional_credit) AS credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
      JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id = ${org.id}::uuid AND e.status = 'POSTED' AND a.type IN ('REVENUE', 'EXPENSE')
        AND e.date >= ${toDbDate(q.from)}::date AND e.date <= ${toDbDate(q.to)}::date
      GROUP BY a.id, a.code, a.name, a.type, ${col}`;
    const used = new Set(rows.map((r) => r.value_id).filter(Boolean));
    const shown = values.filter((v) => v.isActive || q.includeInactive || used.has(v.id));
    const report = profitByDimension(
      shown.map((v) => ({ id: v.id, code: v.code, name: v.name })),
      rows.map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, valueId: r.value_id, debit: new D(r.debit.toString()).toFixed(), credit: new D(r.credit.toString()).toFixed() })),
      minorUnits(org.functionalCurrency),
    );
    return { type: q.type, from: q.from, to: q.to, currency: org.functionalCurrency, ...report };
  }
}
