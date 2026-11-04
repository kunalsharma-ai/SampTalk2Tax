import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, dec, Dec } from '@talk2tax/accounting-engine';
import { Employee, PayComponentKind, PayrollLiability, PayrollSettings, Prisma, PtCategory, SalaryComponent, SalaryStructure } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import {
  checkPan,
  computePayslip,
  daysInMonth,
  esiContributionPeriodStart,
  monthsLeftInTaxYear,
  OneOffInput,
  payrollDueDates,
  PayslipResult,
  periodEnd,
  indiaState,
  periodStart,
  taxYearLabel,
  taxYearOf,
} from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';

export interface PayrollOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

export interface ComponentInput {
  code: string;
  name: string;
  kind: PayComponentKind;
  monthlyAmount: string;
}

export interface StructureInput {
  effectiveFrom: string;
  components: ComponentInput[];
}

export interface EmployeeInput {
  code: string;
  name: string;
  email?: string | null;
  pan?: string | null;
  dateOfJoining: string;
  dateOfLeaving?: string | null;
  workStateCode?: string | null;
  ptCategory?: PtCategory;
  pfMember?: boolean;
  epsMember?: boolean;
  pfOnFullWages?: boolean;
  uan?: string | null;
  esiNumber?: string | null;
  priorTaxYear?: string | null;
  priorIncome?: string;
  priorTds?: string;
}

const ACCOUNT_KEYS = ['salaryExpenseAccountId', 'employerContributionAccountId', 'netPayAccountId', 'pfPayableAccountId', 'esiPayableAccountId', 'ptPayableAccountId', 'tdsPayableAccountId'] as const;
type AccountKey = (typeof ACCOUNT_KEYS)[number];
export type PayrollAccounts = Record<AccountKey, string>;

const DEFAULT_ACCOUNTS: Record<AccountKey, { code: string; name: string; type: 'EXPENSE' | 'LIABILITY'; subtype: string; parent: string; label: string }> = {
  salaryExpenseAccountId: { code: '6100', name: 'Salaries and Wages', type: 'EXPENSE', subtype: 'PAYROLL_EXPENSE', parent: '6000', label: 'Salaries expense' },
  employerContributionAccountId: { code: '6110', name: 'Employer PF and ESI', type: 'EXPENSE', subtype: 'PAYROLL_EXPENSE', parent: '6000', label: 'Employer contributions expense' },
  netPayAccountId: { code: '2410', name: 'Salaries payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', parent: '2000', label: 'Net salaries payable' },
  pfPayableAccountId: { code: '2411', name: 'PF payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', parent: '2000', label: 'PF payable' },
  esiPayableAccountId: { code: '2412', name: 'ESI payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', parent: '2000', label: 'ESI payable' },
  ptPayableAccountId: { code: '2413', name: 'Professional tax payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', parent: '2000', label: 'Professional tax payable' },
  tdsPayableAccountId: { code: '2414', name: 'TDS on salary payable', type: 'LIABILITY', subtype: 'TAX_PAYABLE', parent: '2000', label: 'TDS on salary payable' },
};

const LIABILITY_ACCOUNT: Record<PayrollLiability, AccountKey> = {
  NET_PAY: 'netPayAccountId',
  PF: 'pfPayableAccountId',
  ESI: 'esiPayableAccountId',
  PT: 'ptPayableAccountId',
  TDS: 'tdsPayableAccountId',
};

export const LIABILITY_LABEL: Record<PayrollLiability, string> = {
  NET_PAY: 'Net salaries',
  PF: 'Provident fund',
  ESI: 'ESI',
  PT: 'Professional tax',
  TDS: 'TDS on salary',
};

type StructureWithComponents = SalaryStructure & { components: SalaryComponent[] };
type EmployeeWithStructures = Employee & { structures: StructureWithComponents[] };

const STRUCTURES = { structures: { include: { components: { orderBy: { position: 'asc' } } }, orderBy: { effectiveFrom: 'asc' } } } as const;
const MONEY = (v: Prisma.Decimal | Dec | string) => new D(v.toString()).toFixed(2);

/**
 * India payroll (Directive Part 9): employees and salary structures, monthly pay
 * runs with payslips worked out by packages/tax-engine computePayslip, posting to
 * the ledger, and paying out net salaries and statutory dues.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  // ------------------------------------------------------------------ settings

  async getSettings(orgId: string) {
    const s = await this.prisma.payrollSettings.findUnique({ where: { orgId } });
    if (!s) return { configured: false as const };
    return { configured: true as const, ...(await this.serializeSettings(this.prisma, s)) };
  }

  async saveSettings(orgId: string, actor: { id: string }, input: { pfEstablishmentCode?: string | null; esiEmployerCode?: string | null; ptRegistration?: string | null; accounts?: PayrollAccounts }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
      const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
      if (org.countryCode !== 'IN' || org.functionalCurrency !== 'INR') throw new DomainError('NOT_INDIA', 'Payroll is available to organisations in India that keep their books in INR');
      const before = await tx.payrollSettings.findUnique({ where: { orgId } });
      const accounts = input.accounts ?? (before ? pickAccounts(before) : await this.defaultAccounts(tx, orgId, actor));
      await this.checkAccounts(tx, orgId, accounts);
      if (before && ACCOUNT_KEYS.some((k) => before[k] !== accounts[k])) {
        const posted = await tx.payRun.count({ where: { orgId, status: { not: 'DRAFT' } } });
        if (posted > 0) throw new DomainError('PAYROLL_IN_USE', 'Pay runs have been posted to these accounts, so they cannot change', HttpStatus.CONFLICT);
      }
      const data = {
        pfEstablishmentCode: input.pfEstablishmentCode?.trim() || null,
        esiEmployerCode: input.esiEmployerCode?.trim() || null,
        ptRegistration: input.ptRegistration?.trim() || null,
        ...accounts,
      };
      const s = before ? await tx.payrollSettings.update({ where: { orgId }, data }) : await tx.payrollSettings.create({ data: { orgId, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: before ? 'payroll.settings_updated' : 'payroll.configured', entityType: 'payroll_settings', entityId: orgId, data });
      return { configured: true as const, ...(await this.serializeSettings(tx, s)) };
    });
  }

  // ------------------------------------------------------------------ employees

  async listEmployees(orgId: string) {
    const rows = await this.prisma.employee.findMany({ where: { orgId }, include: STRUCTURES, orderBy: { code: 'asc' } });
    return rows.map((e) => this.serializeEmployee(e));
  }

  async getEmployee(orgId: string, id: string) {
    return this.serializeEmployee(await this.employeeById(this.prisma, orgId, id));
  }

  async createEmployee(orgId: string, actor: { id: string }, input: EmployeeInput & { structure: StructureInput }) {
    const data = this.employeeData(input);
    const structure = this.structureData(input.structure);
    if (structure.effectiveFrom > input.dateOfJoining && structure.effectiveFrom.slice(0, 7) !== input.dateOfJoining.slice(0, 7)) {
      throw new DomainError('INVALID_STRUCTURE', 'The first salary must apply from the month the employee joins');
    }
    return this.prisma.$transaction(async (tx) => {
      const dup = await tx.employee.findUnique({ where: { orgId_code: { orgId, code: data.code } } });
      if (dup) throw new DomainError('DUPLICATE_EMPLOYEE_CODE', `Employee code ${data.code} is already used by ${dup.name}`, HttpStatus.CONFLICT);
      const e = await tx.employee.create({ data: { orgId, ...data } });
      await this.insertStructure(tx, orgId, actor, e.id, structure);
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'payroll.employee_created', entityType: 'employee', entityId: e.id, data: { code: e.code, name: e.name, effectiveFrom: structure.effectiveFrom } });
      return this.serializeEmployee(await this.employeeById(tx, orgId, e.id));
    });
  }

  async updateEmployee(orgId: string, actor: { id: string }, id: string, input: EmployeeInput) {
    const data = this.employeeData(input);
    return this.prisma.$transaction(async (tx) => {
      await this.lockEmployee(tx, orgId, id);
      const before = await tx.employee.findUniqueOrThrow({ where: { id } });
      if (data.code !== before.code) {
        const dup = await tx.employee.findUnique({ where: { orgId_code: { orgId, code: data.code } } });
        if (dup) throw new DomainError('DUPLICATE_EMPLOYEE_CODE', `Employee code ${data.code} is already used by ${dup.name}`, HttpStatus.CONFLICT);
      }
      const posted = await tx.payslip.findMany({ where: { employeeId: id, payRun: { status: 'POSTED' } }, select: { payRun: { select: { period: true } } } });
      if (posted.length) {
        const frozen: (keyof typeof data)[] = ['code', 'dateOfJoining', 'priorTaxYear', 'priorIncome', 'priorTds'];
        const changed = frozen.filter((k) => String(data[k] ?? '') !== String(normalised(before)[k] ?? ''));
        if (changed.length) throw new DomainError('EMPLOYEE_PAID', `Posted payslips use the employee's ${changed.join(', ')}; these cannot change now`, HttpStatus.CONFLICT);
        const last = posted.map((p) => p.payRun.period).sort().at(-1)!;
        if (data.dateOfLeaving && fromDbDate(data.dateOfLeaving) < periodStart(last)) throw new DomainError('EMPLOYEE_PAID', `The employee was paid for ${last}; the leaving date cannot be before that month`, HttpStatus.CONFLICT);
      }
      const e = await tx.employee.update({ where: { id }, data });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'payroll.employee_updated', entityType: 'employee', entityId: id, data: { ...input } });
      return this.serializeEmployee(await this.employeeById(tx, orgId, e.id));
    });
  }

  /** Add a salary revision from a month. A revision for a month no payslip uses yet replaces the earlier one for that month. */
  async addStructure(orgId: string, actor: { id: string }, employeeId: string, input: StructureInput) {
    const structure = this.structureData(input);
    return this.prisma.$transaction(async (tx) => {
      await this.lockEmployee(tx, orgId, employeeId);
      const e = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
      if (structure.effectiveFrom.slice(0, 7) < fromDbDate(e.dateOfJoining).slice(0, 7)) throw new DomainError('INVALID_STRUCTURE', 'A salary cannot apply before the employee joins');
      const existing = await tx.salaryStructure.findUnique({ where: { employeeId_effectiveFrom: { employeeId, effectiveFrom: toDbDate(structure.effectiveFrom) } }, include: { _count: { select: { payslips: true } } } });
      if (existing) {
        if (existing._count.payslips > 0) throw new DomainError('STRUCTURE_USED', `Payslips already use the salary from ${structure.effectiveFrom}; add a revision from a later month`, HttpStatus.CONFLICT);
        await tx.salaryComponent.deleteMany({ where: { structureId: existing.id } });
        await tx.salaryStructure.delete({ where: { id: existing.id } });
      }
      const s = await this.insertStructure(tx, orgId, actor, employeeId, structure);
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'payroll.salary_revised', entityType: 'employee', entityId: employeeId, data: { structureId: s.id, effectiveFrom: structure.effectiveFrom, components: structure.components } });
      return this.serializeEmployee(await this.employeeById(tx, orgId, employeeId));
    });
  }

  // ------------------------------------------------------------------ pay runs

  async listRuns(org: PayrollOrg) {
    const runs = await this.prisma.payRun.findMany({ where: { orgId: org.id }, include: { _count: { select: { payslips: true } }, remittances: true }, orderBy: [{ period: 'desc' }, { createdAt: 'desc' }], take: 120 });
    return runs.map((r) => ({
      id: r.id,
      number: r.number,
      period: r.period,
      status: r.status,
      payDate: fromDbDate(r.payDate),
      employees: r._count.payslips,
      gross: MONEY(r.gross),
      deductions: MONEY(r.deductions),
      net: MONEY(r.net),
      employerCost: MONEY(r.employerCost),
      paid: r.remittances.filter((x) => x.status === 'POSTED').map((x) => x.liability),
    }));
  }

  async getRun(org: PayrollOrg, id: string) {
    return this.serializeRun(this.prisma, org, id);
  }

  async createRun(org: PayrollOrg, actor: { id: string }, input: { period: string; payDate: string }) {
    if (input.payDate < periodStart(input.period)) throw new DomainError('INVALID_DATE', 'The pay date cannot be before the month it pays for');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id}::uuid FOR UPDATE`;
      await this.requireSettings(tx, org.id);
      const live = await tx.payRun.findFirst({ where: { orgId: org.id, period: input.period, status: { not: 'VOID' } } });
      if (live) throw new DomainError('PAY_RUN_EXISTS', `${live.number} already covers ${input.period}`, HttpStatus.CONFLICT);
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'doc:PAY_RUN', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1 RETURNING value`;
      const run = await tx.payRun.create({ data: { orgId: org.id, number: `PAY-${String(value).padStart(6, '0')}`, period: input.period, payDate: toDbDate(input.payDate), createdById: actor.id } });
      const skipped = await this.syncPayslips(tx, org.id, run.id, input.period, new Map());
      await this.updateTotals(tx, run.id);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.run_created', entityType: 'pay_run', entityId: run.id, data: { number: run.number, period: input.period, skipped } });
      return this.serializeRun(tx, org, run.id);
    });
  }

  /** Recalculate every payslip of a draft (after salary changes or new joiners), keeping loss-of-pay days and one-off earnings. */
  async recalculateRun(org: PayrollOrg, actor: { id: string }, id: string, input: { payDate?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, org.id, id);
      if (run.status !== 'DRAFT') throw new DomainError('PAY_RUN_POSTED', `${run.number} is ${run.status.toLowerCase()}`, HttpStatus.CONFLICT);
      if (input.payDate) {
        if (input.payDate < periodStart(run.period)) throw new DomainError('INVALID_DATE', 'The pay date cannot be before the month it pays for');
        await tx.payRun.update({ where: { id }, data: { payDate: toDbDate(input.payDate) } });
      }
      const kept = new Map((await tx.payslip.findMany({ where: { payRunId: id } })).map((p) => [p.employeeId, { lopDays: p.lopDays.toFixed(), oneOffs: p.oneOffs as unknown as OneOffInput[] }]));
      await tx.payslip.deleteMany({ where: { payRunId: id } });
      const skipped = await this.syncPayslips(tx, org.id, id, run.period, kept);
      await this.updateTotals(tx, id);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.run_recalculated', entityType: 'pay_run', entityId: id, data: { skipped, payDate: input.payDate } });
      return this.serializeRun(tx, org, id);
    });
  }

  async updatePayslip(org: PayrollOrg, actor: { id: string }, runId: string, employeeId: string, input: { lopDays: string; oneOffs: OneOffInput[] }) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, org.id, runId);
      if (run.status !== 'DRAFT') throw new DomainError('PAY_RUN_POSTED', `${run.number} is ${run.status.toLowerCase()}`, HttpStatus.CONFLICT);
      const slip = await tx.payslip.findUnique({ where: { payRunId_employeeId: { payRunId: runId, employeeId } } });
      if (!slip) throw new NotFoundException({ error: 'NOT_FOUND', message: 'This employee is not in the pay run' });
      const e = await this.employeeById(tx, org.id, employeeId);
      const facts = await this.payslipFacts(tx, org.id, e, run.period, { lopDays: input.lopDays, oneOffs: input.oneOffs });
      if (!facts.ok) throw new DomainError('INVALID_PAYSLIP', facts.reason);
      await tx.payslip.update({ where: { id: slip.id }, data: facts.data });
      await this.updateTotals(tx, runId);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.payslip_adjusted', entityType: 'pay_run', entityId: runId, data: { employeeId, lopDays: input.lopDays, oneOffs: input.oneOffs } });
      return this.serializeRun(tx, org, runId);
    });
  }

  async deleteRun(org: PayrollOrg, actor: { id: string }, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, org.id, id);
      if (run.status !== 'DRAFT') throw new DomainError('PAY_RUN_POSTED', `${run.number} is posted; void it instead`, HttpStatus.CONFLICT);
      await tx.payRun.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.run_deleted', entityType: 'pay_run', entityId: id, data: { number: run.number, period: run.period } });
      return { deleted: true };
    });
  }

  /** Post a draft: recalculates every payslip from the latest history, refuses if anything moved since it was reviewed, and posts one journal. */
  async postRun(org: PayrollOrg, actor: { id: string }, id: string) {
    if (!hasPermission(org.role, 'journals.post')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot post pay runs; it needs journals.post`, HttpStatus.FORBIDDEN);
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, org.id, id);
      if (run.status !== 'DRAFT') throw new DomainError('PAY_RUN_POSTED', `${run.number} is already ${run.status.toLowerCase()}`, HttpStatus.CONFLICT);
      const settings = await this.requireSettings(tx, org.id);
      const slips = await tx.payslip.findMany({ where: { payRunId: id }, include: { employee: true } });
      if (!slips.length) throw new DomainError('EMPTY_PAY_RUN', 'The pay run has no payslips');
      const changed: string[] = [];
      for (const s of slips) {
        const e = await this.employeeById(tx, org.id, s.employeeId);
        const facts = await this.payslipFacts(tx, org.id, e, run.period, { lopDays: s.lopDays.toFixed(), oneOffs: s.oneOffs as unknown as OneOffInput[] });
        if (!facts.ok) changed.push(`${e.name}: ${facts.reason}`);
        else if (facts.data.structureId !== s.structureId || facts.data.net !== MONEY(s.net) || facts.data.tds !== MONEY(s.tds) || facts.data.employerCost !== MONEY(s.employerCost)) changed.push(`${e.name}: the payslip has changed since it was worked out`);
      }
      if (changed.length) throw new DomainError('PAYSLIPS_CHANGED', 'Recalculate the pay run and review it again before posting', HttpStatus.CONFLICT, { issues: changed });
      const t = sumSlips(slips);
      const c = org.functionalCurrency;
      const employer = t.eps.plus(t.epfEmployer).plus(t.edli).plus(t.pfAdmin).plus(t.esiEmployer);
      const pf = t.pfEmployee.plus(t.eps).plus(t.epfEmployer).plus(t.edli).plus(t.pfAdmin);
      const esi = t.esiEmployee.plus(t.esiEmployer);
      const label = `${run.number} · salaries for ${monthName(run.period)}`;
      const lines = [
        { accountId: settings.salaryExpenseAccountId, debit: t.gross, description: 'Gross salaries' },
        { accountId: settings.employerContributionAccountId, debit: employer, description: 'Employer PF, EPS, EDLI, PF admin and ESI' },
        { accountId: settings.netPayAccountId, credit: t.net, description: 'Net salaries payable' },
        { accountId: settings.pfPayableAccountId, credit: pf, description: 'PF: employee and employer shares, EDLI, admin charges' },
        { accountId: settings.esiPayableAccountId, credit: esi, description: 'ESI: employee and employer shares' },
        { accountId: settings.ptPayableAccountId, credit: t.pt, description: 'Professional tax deducted' },
        { accountId: settings.tdsPayableAccountId, credit: t.tds, description: 'TDS on salary (s.392)' },
      ]
        .filter((l) => !(l.debit ?? l.credit)!.isZero())
        .map((l) => ({ accountId: l.accountId, currency: c, description: l.description, ...(l.debit ? { debit: l.debit.toFixed(2) } : { credit: l.credit!.toFixed(2) }) }));
      const je = await this.journals.postSystemEntry(tx, org, actor, { date: periodEnd(run.period), source: 'PAYROLL', memo: label, reference: run.number, lines });
      await tx.payRun.update({ where: { id }, data: { status: 'POSTED', journalEntryId: je.id, postedAt: new Date(), postedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.run_posted', entityType: 'pay_run', entityId: id, data: { number: run.number, period: run.period, gross: t.gross.toFixed(2), net: t.net.toFixed(2), journalEntryId: je.id } });
      return this.serializeRun(tx, org, id);
    });
  }

  async voidRun(org: PayrollOrg, actor: { id: string }, id: string, input: { date: string; reason: string }) {
    if (!hasPermission(org.role, 'journals.reverse')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot void pay runs; it needs journals.reverse`, HttpStatus.FORBIDDEN);
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, org.id, id);
      if (run.status !== 'POSTED') throw new DomainError('PAY_RUN_NOT_POSTED', run.status === 'DRAFT' ? 'Delete a draft instead of voiding it' : `${run.number} is already void`, HttpStatus.CONFLICT);
      const later = await tx.payRun.findFirst({ where: { orgId: org.id, status: 'POSTED', period: { gt: run.period } }, orderBy: { period: 'asc' } });
      if (later) throw new DomainError('LATER_PAY_RUN', `${later.number} for ${later.period} was worked out from this month's figures; void it first`, HttpStatus.CONFLICT);
      const paid = await tx.payrollRemittance.findMany({ where: { payRunId: id, status: 'POSTED' } });
      if (paid.length) throw new DomainError('PAY_RUN_PAID', `Void the payments recorded against ${run.number} first (${paid.map((p) => p.number).join(', ')})`, HttpStatus.CONFLICT);
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, run.journalEntryId!, { date: input.date, memo: `Void ${run.number}: ${input.reason}` });
      await tx.payRun.update({ where: { id }, data: { status: 'VOID', voidJournalEntryId: rev.id, voidDate: toDbDate(input.date), voidReason: input.reason } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.run_voided', entityType: 'pay_run', entityId: id, data: { number: run.number, date: input.date, reason: input.reason, reversalEntryId: rev.id } });
      return this.serializeRun(tx, org, id);
    });
  }

  /** Pay out one liability of a posted run: net salaries to employees, or a statutory due to its authority. */
  async remit(org: PayrollOrg, actor: { id: string }, runId: string, input: { liability: PayrollLiability; date: string; bankAccountId: string; reference: string }) {
    if (!hasPermission(org.role, 'journals.post')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot record payments; it needs journals.post`, HttpStatus.FORBIDDEN);
    const reference = input.reference.trim();
    if (!reference) throw new DomainError('INVALID_PAYMENT', 'Enter a reference (bank batch, challan or ECR number)');
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, org.id, runId);
      if (run.status !== 'POSTED') throw new DomainError('PAY_RUN_NOT_POSTED', `${run.number} must be posted first`, HttpStatus.CONFLICT);
      if (input.date < fromDbDate(run.payDate) && input.liability === 'NET_PAY') throw new DomainError('INVALID_DATE', 'Salaries cannot be paid before the pay date');
      if (input.date < periodStart(run.period)) throw new DomainError('INVALID_DATE', 'The payment cannot be before the month it pays for');
      const live = await tx.payrollRemittance.findFirst({ where: { payRunId: runId, liability: input.liability, status: 'POSTED' } });
      if (live) throw new DomainError('ALREADY_PAID', `${LIABILITY_LABEL[input.liability]} for ${run.number} is already recorded as ${live.number}`, HttpStatus.CONFLICT);
      const amount = liabilities(sumSlips(await tx.payslip.findMany({ where: { payRunId: runId } })))[input.liability];
      if (amount.isZero()) throw new DomainError('NOTHING_DUE', `${run.number} has no ${LIABILITY_LABEL[input.liability].toLowerCase()} to pay`);
      const bank = await tx.account.findFirst({ where: { id: input.bankAccountId, orgId: org.id } });
      if (!bank || !bank.isPostable || !bank.isActive || !['BANK', 'CASH'].includes(bank.subtype ?? '')) throw new DomainError('INVALID_BANK_ACCOUNT', 'Choose an active bank or cash account');
      const settings = await this.requireSettings(tx, org.id);
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'doc:PAYROLL_PAYMENT', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1 RETURNING value`;
      const number = `PAYP-${String(value).padStart(6, '0')}`;
      const c = org.functionalCurrency;
      const je = await this.journals.postSystemEntry(tx, org, actor, {
        date: input.date,
        source: 'PAYROLL',
        memo: `${number} · ${LIABILITY_LABEL[input.liability]} for ${monthName(run.period)} (${run.number}) · ${reference}`,
        reference: number,
        lines: [
          { accountId: settings[LIABILITY_ACCOUNT[input.liability]], currency: c, debit: amount.toFixed(2), description: `${LIABILITY_LABEL[input.liability]} paid` },
          { accountId: bank.id, currency: c, credit: amount.toFixed(2), description: reference },
        ],
      });
      const r = await tx.payrollRemittance.create({
        data: { orgId: org.id, payRunId: runId, liability: input.liability, number, date: toDbDate(input.date), bankAccountId: bank.id, reference, amount: amount.toFixed(2), journalEntryId: je.id, createdById: actor.id },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.paid', entityType: 'payroll_remittance', entityId: r.id, data: { number, liability: input.liability, payRun: run.number, amount: amount.toFixed(2), reference, journalEntryId: je.id } });
      return this.serializeRun(tx, org, runId);
    });
  }

  async voidRemittance(org: PayrollOrg, actor: { id: string }, runId: string, remittanceId: string, input: { date: string; reason: string }) {
    if (!hasPermission(org.role, 'journals.reverse')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot void payments; it needs journals.reverse`, HttpStatus.FORBIDDEN);
    return this.prisma.$transaction(async (tx) => {
      await this.lockRun(tx, org.id, runId);
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payroll_remittances WHERE id = ${remittanceId}::uuid AND org_id = ${org.id}::uuid AND pay_run_id = ${runId}::uuid FOR UPDATE`;
      if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment not found' });
      const r = await tx.payrollRemittance.findUniqueOrThrow({ where: { id: remittanceId } });
      if (r.status !== 'POSTED') throw new DomainError('ALREADY_VOID', 'Payment is already void', HttpStatus.CONFLICT);
      if (input.date < fromDbDate(r.date)) throw new DomainError('INVALID_DATE', 'The void date cannot be before the payment date');
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, r.journalEntryId, { date: input.date, memo: `Void ${r.number}: ${input.reason}` });
      await tx.payrollRemittance.update({ where: { id: remittanceId }, data: { status: 'VOID', voidJournalEntryId: rev.id, voidDate: toDbDate(input.date), voidReason: input.reason } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payroll.payment_voided', entityType: 'payroll_remittance', entityId: remittanceId, data: { number: r.number, date: input.date, reason: input.reason, reversalEntryId: rev.id } });
      return this.serializeRun(tx, org, runId);
    });
  }

  async getPayslip(org: PayrollOrg, runId: string, employeeId: string) {
    const slip = await this.prisma.payslip.findUnique({ where: { payRunId_employeeId: { payRunId: runId, employeeId } }, include: { employee: true, payRun: true } });
    if (!slip || slip.orgId !== org.id) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payslip not found' });
    const [o, settings] = await Promise.all([this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { name: true, legalName: true } }), this.prisma.payrollSettings.findUnique({ where: { orgId: org.id } })]);
    const ty = taxYearOf(periodStart(slip.payRun.period));
    const ytd = await this.prisma.payslip.aggregate({
      where: { employeeId, orgId: org.id, payRun: { status: 'POSTED', period: { gte: ty.from.slice(0, 7), lte: slip.payRun.period } } },
      _sum: { gross: true, tds: true, pfEmployee: true, pt: true },
    });
    return {
      organisation: { name: o.legalName ?? o.name, pfEstablishmentCode: settings?.pfEstablishmentCode ?? null, esiEmployerCode: settings?.esiEmployerCode ?? null },
      payRun: { id: slip.payRun.id, number: slip.payRun.number, period: slip.payRun.period, status: slip.payRun.status, payDate: fromDbDate(slip.payRun.payDate) },
      employee: this.employeeSummary(slip.employee),
      ...this.serializePayslip(slip),
      yearToDate: { taxYear: ty.label, postedOnly: true, gross: MONEY(ytd._sum.gross ?? '0'), tds: MONEY(ytd._sum.tds ?? '0'), pfEmployee: MONEY(ytd._sum.pfEmployee ?? '0'), pt: MONEY(ytd._sum.pt ?? '0') },
    };
  }

  // ------------------------------------------------------------------ calculation

  /** Create payslips for everyone employed in the month who has a salary. Returns who was left out and why. */
  private async syncPayslips(tx: Tx, orgId: string, runId: string, period: string, kept: Map<string, { lopDays: string; oneOffs: OneOffInput[] }>) {
    const employees = await tx.employee.findMany({
      where: { orgId, dateOfJoining: { lte: toDbDate(periodEnd(period)) }, OR: [{ dateOfLeaving: null }, { dateOfLeaving: { gte: toDbDate(periodStart(period)) } }] },
      include: STRUCTURES,
      orderBy: { code: 'asc' },
    });
    const skipped: { employeeId: string; name: string; reason: string }[] = [];
    for (const e of employees) {
      const facts = await this.payslipFacts(tx, orgId, e, period, kept.get(e.id) ?? { lopDays: '0', oneOffs: [] });
      if (!facts.ok) {
        skipped.push({ employeeId: e.id, name: e.name, reason: facts.reason });
        continue;
      }
      await tx.payslip.create({ data: { orgId, payRunId: runId, employeeId: e.id, ...facts.data } });
    }
    return skipped;
  }

  private async payslipFacts(tx: Tx, orgId: string, e: EmployeeWithStructures, period: string, adj: { lopDays: string; oneOffs: OneOffInput[] }) {
    const structure = [...e.structures].reverse().find((s) => fromDbDate(s.effectiveFrom) <= periodStart(period));
    if (!structure) return { ok: false as const, reason: `No salary applies in ${period}` };
    const n = daysInMonth(period);
    const joined = fromDbDate(e.dateOfJoining);
    const left = e.dateOfLeaving ? fromDbDate(e.dateOfLeaving) : null;
    const before = joined > periodStart(period) ? Number(joined.slice(8, 10)) - 1 : 0;
    const after = left && left < periodEnd(period) ? n - Number(left.slice(8, 10)) : 0;
    const outside = before + after;
    const lop = dec(adj.lopDays);
    if (lop.lt(0) || !lop.times(2).isInteger()) return { ok: false as const, reason: 'Loss-of-pay days must be whole or half days' };
    if (lop.gt(n - outside)) return { ok: false as const, reason: `Loss-of-pay days cannot exceed the ${n - outside} days employed this month` };
    const paidDays = new D(n - outside).minus(lop);

    // History from posted pay runs before this month.
    const ty = taxYearOf(periodStart(period));
    const earlier = await tx.payslip.findMany({
      where: { orgId, employeeId: e.id, payRun: { status: 'POSTED', period: { gte: ty.from.slice(0, 7), lt: period } } },
      select: { gross: true, tds: true, esiCovered: true, payRun: { select: { period: true } } },
    });
    const prior = e.priorTaxYear === taxYearLabel(period);
    const incomeBefore = earlier.reduce((s, p) => s.plus(p.gross.toString()), new D(prior ? e.priorIncome.toString() : 0));
    const tdsBefore = earlier.reduce((s, p) => s.plus(p.tds.toString()), new D(prior ? e.priorTds.toString() : 0));
    const esiStart = esiContributionPeriodStart(period);
    const firstInEsiPeriod = earlier
      .filter((p) => p.payRun.period >= esiStart)
      .sort((a, b) => a.payRun.period.localeCompare(b.payRun.period))[0];
    // ESI periods can cross the tax year (October–March does not, April–September does not), so the tax-year history is enough.
    let futureMonths = monthsLeftInTaxYear(period) - 1;
    if (left) {
      const leftMonth = left.slice(0, 7);
      futureMonths = leftMonth <= period ? 0 : Math.min(futureMonths, monthDiff(period, leftMonth));
    }

    let r: PayslipResult;
    try {
      r = computePayslip({
        period,
        paidDays: paidDays.toFixed(),
        components: structure.components.map((c) => ({ code: c.code, name: c.name, kind: c.kind, monthly: c.monthlyAmount.toString() })),
        oneOffs: adj.oneOffs,
        pf: { member: e.pfMember, eps: e.epsMember, onFullWages: e.pfOnFullWages },
        esiCoveredForPeriod: firstInEsiPeriod ? firstInEsiPeriod.esiCovered : null,
        pt: { stateCode: e.workStateCode, category: e.ptCategory },
        tax: { incomeBefore: incomeBefore.toFixed(2), tdsBefore: tdsBefore.toFixed(2), futureMonths, hasPan: !!e.pan },
      });
    } catch (err) {
      return { ok: false as const, reason: (err as Error).message };
    }
    return {
      ok: true as const,
      data: {
        structureId: structure.id,
        daysInMonth: n,
        daysOutside: outside.toFixed(1),
        lopDays: lop.toFixed(1),
        paidDays: paidDays.toFixed(1),
        oneOffs: adj.oneOffs as unknown as Prisma.InputJsonValue,
        earnings: r.earnings as unknown as Prisma.InputJsonValue,
        gross: r.gross,
        wages: r.wages,
        wagesAddedBack: r.wagesAddedBack,
        pfWages: r.pf.wages,
        pfEmployee: r.pf.employee,
        eps: r.pf.eps,
        epfEmployer: r.pf.epfEmployer,
        edli: r.pf.edli,
        pfAdmin: r.pf.admin,
        esiCovered: r.esi.covered,
        esiWages: r.esi.wages,
        esiEmployee: r.esi.employee,
        esiEmployer: r.esi.employer,
        pt: r.pt.amount,
        ptNote: r.pt.note,
        tds: r.tds.amount,
        tdsDetail: { ...r.tds, incomeBefore: incomeBefore.toFixed(2), tdsBefore: tdsBefore.toFixed(2), futureMonths } as unknown as Prisma.InputJsonValue,
        deductions: r.deductions,
        net: r.net,
        employerCost: r.employerCost,
      },
    };
  }

  private async updateTotals(tx: Tx, runId: string) {
    const t = sumSlips(await tx.payslip.findMany({ where: { payRunId: runId } }));
    await tx.payRun.update({ where: { id: runId }, data: { gross: t.gross.toFixed(2), deductions: t.deductions.toFixed(2), net: t.net.toFixed(2), employerCost: t.employerCost.toFixed(2) } });
  }

  // ------------------------------------------------------------------ serialisation

  private async serializeRun(db: Tx | PrismaService, org: PayrollOrg, id: string) {
    const run = await db.payRun.findFirst({
      where: { id, orgId: org.id },
      include: { payslips: { include: { employee: true }, orderBy: { employee: { code: 'asc' } } }, remittances: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Pay run not found' });
    const t = sumSlips(run.payslips);
    const due = liabilities(t);
    const dates = payrollDueDates(run.period);
    const banks = await db.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(run.remittances.map((r) => r.bankAccountId))] } }, select: { id: true, code: true, name: true } });
    const remittances = run.remittances.map((r) => ({
      id: r.id,
      number: r.number,
      liability: r.liability,
      date: fromDbDate(r.date),
      reference: r.reference,
      amount: MONEY(r.amount),
      status: r.status,
      bankAccount: banks.find((b) => b.id === r.bankAccountId) ?? { id: r.bankAccountId, code: '', name: '' },
      journalEntryId: r.journalEntryId,
      voidReason: r.voidReason,
    }));
    // Who is employed in the month but has no payslip (no salary set up).
    const missing =
      run.status === 'DRAFT'
        ? (
            await db.employee.findMany({
              where: { orgId: org.id, id: { notIn: run.payslips.map((p) => p.employeeId) }, dateOfJoining: { lte: toDbDate(periodEnd(run.period)) }, OR: [{ dateOfLeaving: null }, { dateOfLeaving: { gte: toDbDate(periodStart(run.period)) } }] },
              select: { id: true, name: true, code: true },
            })
          ).map((e) => ({ employeeId: e.id, name: e.name, code: e.code, reason: `No salary applies in ${run.period}` }))
        : [];
    return {
      id: run.id,
      number: run.number,
      period: run.period,
      status: run.status,
      payDate: fromDbDate(run.payDate),
      journalEntryId: run.journalEntryId,
      voidJournalEntryId: run.voidJournalEntryId,
      voidDate: run.voidDate ? fromDbDate(run.voidDate) : null,
      voidReason: run.voidReason,
      totals: {
        gross: t.gross.toFixed(2),
        deductions: t.deductions.toFixed(2),
        net: t.net.toFixed(2),
        employerCost: t.employerCost.toFixed(2),
        pfEmployee: t.pfEmployee.toFixed(2),
        pfEmployer: t.eps.plus(t.epfEmployer).toFixed(2),
        eps: t.eps.toFixed(2),
        edli: t.edli.toFixed(2),
        pfAdmin: t.pfAdmin.toFixed(2),
        esiEmployee: t.esiEmployee.toFixed(2),
        esiEmployer: t.esiEmployer.toFixed(2),
        pt: t.pt.toFixed(2),
        tds: t.tds.toFixed(2),
      },
      liabilities: (Object.keys(LIABILITY_LABEL) as PayrollLiability[]).map((l) => {
        const paid = remittances.find((r) => r.liability === l && r.status === 'POSTED') ?? null;
        return { liability: l, label: LIABILITY_LABEL[l], amount: due[l].toFixed(2), dueDate: l === 'NET_PAY' ? fromDbDate(run.payDate) : dates[l], payment: paid };
      }),
      payslips: run.payslips.map((p) => ({ employee: this.employeeSummary(p.employee), ...this.serializePayslip(p) })),
      missing,
      remittances,
    };
  }

  private serializePayslip(p: Prisma.PayslipGetPayload<object>) {
    return {
      id: p.id,
      daysInMonth: p.daysInMonth,
      daysOutside: p.daysOutside.toFixed(1),
      lopDays: p.lopDays.toFixed(1),
      paidDays: p.paidDays.toFixed(1),
      oneOffs: p.oneOffs as unknown as OneOffInput[],
      earnings: p.earnings as unknown as { code: string; name: string; kind: PayComponentKind; amount: string }[],
      gross: MONEY(p.gross),
      wages: MONEY(p.wages),
      wagesAddedBack: MONEY(p.wagesAddedBack),
      pf: { wages: MONEY(p.pfWages), employee: MONEY(p.pfEmployee), eps: MONEY(p.eps), epfEmployer: MONEY(p.epfEmployer), edli: MONEY(p.edli), admin: MONEY(p.pfAdmin) },
      esi: { covered: p.esiCovered, wages: MONEY(p.esiWages), employee: MONEY(p.esiEmployee), employer: MONEY(p.esiEmployer) },
      pt: { amount: MONEY(p.pt), note: p.ptNote },
      tds: { amount: MONEY(p.tds), ...(p.tdsDetail as Record<string, unknown>) },
      deductions: MONEY(p.deductions),
      net: MONEY(p.net),
      employerCost: MONEY(p.employerCost),
    };
  }

  private employeeSummary(e: Employee) {
    return { id: e.id, code: e.code, name: e.name, pan: e.pan, uan: e.uan, esiNumber: e.esiNumber, dateOfJoining: fromDbDate(e.dateOfJoining), dateOfLeaving: e.dateOfLeaving ? fromDbDate(e.dateOfLeaving) : null };
  }

  private serializeEmployee(e: EmployeeWithStructures) {
    const today = todayIso();
    const current = [...e.structures].reverse().find((s) => fromDbDate(s.effectiveFrom) <= today) ?? e.structures[0] ?? null;
    const structure = (s: StructureWithComponents) => ({
      id: s.id,
      effectiveFrom: fromDbDate(s.effectiveFrom),
      monthlyGross: s.components.reduce((sum, c) => sum.plus(c.monthlyAmount.toString()), new D(0)).toFixed(2),
      components: s.components.map((c) => ({ code: c.code, name: c.name, kind: c.kind, monthlyAmount: MONEY(c.monthlyAmount) })),
    });
    return {
      ...this.employeeSummary(e),
      email: e.email,
      workStateCode: e.workStateCode,
      ptCategory: e.ptCategory,
      pfMember: e.pfMember,
      epsMember: e.epsMember,
      pfOnFullWages: e.pfOnFullWages,
      priorTaxYear: e.priorTaxYear,
      priorIncome: MONEY(e.priorIncome),
      priorTds: MONEY(e.priorTds),
      status: e.dateOfLeaving && fromDbDate(e.dateOfLeaving) < today ? ('LEFT' as const) : fromDbDate(e.dateOfJoining) > today ? ('JOINING' as const) : ('ACTIVE' as const),
      currentSalary: current ? structure(current) : null,
      salaries: e.structures.map(structure),
    };
  }

  private async serializeSettings(db: Tx | PrismaService, s: PayrollSettings) {
    const ids = ACCOUNT_KEYS.map((k) => s[k]);
    const accs = await db.account.findMany({ where: { orgId: s.orgId, id: { in: ids } }, select: { id: true, code: true, name: true } });
    const acc = (id: string) => accs.find((a) => a.id === id) ?? { id, code: '', name: '' };
    return {
      pfEstablishmentCode: s.pfEstablishmentCode,
      esiEmployerCode: s.esiEmployerCode,
      ptRegistration: s.ptRegistration,
      accounts: Object.fromEntries(ACCOUNT_KEYS.map((k) => [k.replace(/AccountId$/, ''), acc(s[k])])) as Record<string, { id: string; code: string; name: string }>,
    };
  }

  // ------------------------------------------------------------------ helpers

  private employeeData(input: EmployeeInput) {
    const issues: string[] = [];
    const pan = input.pan?.trim().toUpperCase() || null;
    if (pan) {
      const c = checkPan(pan);
      if (!c.valid) issues.push(`PAN: ${c.issues[0]}`);
    }
    if (input.dateOfLeaving && input.dateOfLeaving < input.dateOfJoining) issues.push('The leaving date cannot be before the joining date');
    if (input.workStateCode && !indiaState(input.workStateCode)) issues.push(`Unknown state code ${input.workStateCode}`);
    const pfMember = input.pfMember ?? true;
    if (!pfMember && (input.epsMember || input.pfOnFullWages)) issues.push('EPS and PF on full wages need PF membership');
    const priorIncome = dec(input.priorIncome ?? '0');
    const priorTds = dec(input.priorTds ?? '0');
    if (priorIncome.decimalPlaces() > 2 || priorTds.decimalPlaces() > 2) issues.push('Amounts can have at most two decimal places');
    if ((priorIncome.gt(0) || priorTds.gt(0)) && !input.priorTaxYear) issues.push('Say which tax year the previous employer figures are for');
    if (issues.length) throw new DomainError('INVALID_EMPLOYEE', 'The employee is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return {
      code: input.code.trim(),
      name: input.name.trim(),
      email: input.email?.trim() || null,
      pan,
      dateOfJoining: toDbDate(input.dateOfJoining),
      dateOfLeaving: input.dateOfLeaving ? toDbDate(input.dateOfLeaving) : null,
      workStateCode: input.workStateCode || null,
      ptCategory: input.ptCategory ?? 'GENERAL',
      pfMember,
      epsMember: pfMember && (input.epsMember ?? true),
      pfOnFullWages: pfMember && (input.pfOnFullWages ?? false),
      uan: input.uan?.trim() || null,
      esiNumber: input.esiNumber?.trim() || null,
      priorTaxYear: priorIncome.gt(0) || priorTds.gt(0) ? (input.priorTaxYear ?? null) : null,
      priorIncome: priorIncome.toFixed(2),
      priorTds: priorTds.toFixed(2),
    };
  }

  private structureData(input: StructureInput) {
    const issues: string[] = [];
    if (input.effectiveFrom.slice(8, 10) !== '01') issues.push('A salary applies from the first day of a month');
    const codes = new Set<string>();
    for (const c of input.components) {
      const code = c.code.trim().toUpperCase();
      if (codes.has(code)) issues.push(`Component ${code} appears twice`);
      codes.add(code);
      const a = dec(c.monthlyAmount);
      if (a.decimalPlaces() > 2) issues.push(`${c.name}: at most two decimal places`);
    }
    if (!input.components.some((c) => c.kind === 'WAGES' && dec(c.monthlyAmount).gt(0))) issues.push('Add basic pay (a component counted as wages) above zero');
    if (issues.length) throw new DomainError('INVALID_STRUCTURE', 'The salary is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return { effectiveFrom: input.effectiveFrom, components: input.components.map((c) => ({ code: c.code.trim().toUpperCase(), name: c.name.trim(), kind: c.kind, monthlyAmount: dec(c.monthlyAmount).toFixed(2) })) };
  }

  private async insertStructure(tx: Tx, orgId: string, actor: { id: string }, employeeId: string, s: ReturnType<PayrollService['structureData']>) {
    const created = await tx.salaryStructure.create({ data: { orgId, employeeId, effectiveFrom: toDbDate(s.effectiveFrom), createdById: actor.id } });
    await tx.salaryComponent.createMany({ data: s.components.map((c, i) => ({ orgId, structureId: created.id, position: i, ...c })) });
    return created;
  }

  private async employeeById(db: Tx | PrismaService, orgId: string, id: string): Promise<EmployeeWithStructures> {
    const e = await db.employee.findFirst({ where: { id, orgId }, include: STRUCTURES });
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Employee not found' });
    return e;
  }

  private async lockEmployee(tx: Tx, orgId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM employees WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Employee not found' });
  }

  private async lockRun(tx: Tx, orgId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM pay_runs WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Pay run not found' });
    return tx.payRun.findUniqueOrThrow({ where: { id } });
  }

  private async requireSettings(db: Tx | PrismaService, orgId: string) {
    const s = await db.payrollSettings.findUnique({ where: { orgId } });
    if (!s) throw new DomainError('PAYROLL_NOT_CONFIGURED', 'Set up payroll first (Settings → Payroll)', HttpStatus.CONFLICT);
    return s;
  }

  private async defaultAccounts(tx: Tx, orgId: string, actor: { id: string }) {
    const out = {} as PayrollAccounts;
    for (const key of ACCOUNT_KEYS) {
      const spec = DEFAULT_ACCOUNTS[key];
      const existing = await tx.account.findUnique({ where: { orgId_code: { orgId, code: spec.code } } });
      if (existing) {
        if (existing.name !== spec.name || existing.type !== spec.type) throw new DomainError('ACCOUNT_CODE_TAKEN', `Account code ${spec.code} is already used by "${existing.name}". Choose the accounts yourself.`, HttpStatus.CONFLICT);
        out[key] = existing.id;
        continue;
      }
      const parent = await tx.account.findUnique({ where: { orgId_code: { orgId, code: spec.parent } } });
      const a = await tx.account.create({ data: { orgId, code: spec.code, name: spec.name, type: spec.type, subtype: spec.subtype, parentId: parent && !parent.isPostable && parent.type === spec.type ? parent.id : null, isPostable: true } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'account.created', entityType: 'account', entityId: a.id, data: { code: a.code, name: a.name, type: a.type, reason: 'Payroll setup' } });
      out[key] = a.id;
    }
    return out;
  }

  private async checkAccounts(tx: Tx, orgId: string, accounts: PayrollAccounts) {
    const ids = ACCOUNT_KEYS.map((k) => accounts[k]);
    const issues: string[] = [];
    if (new Set(ids).size !== ids.length) issues.push('Each payroll account must be different');
    const found = await tx.account.findMany({ where: { orgId, id: { in: ids } } });
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
    for (const key of ACCOUNT_KEYS) {
      const spec = DEFAULT_ACCOUNTS[key];
      const a = found.find((x) => x.id === accounts[key]);
      if (!a) issues.push(`${spec.label}: account not found`);
      else if (!a.isPostable || !a.isActive) issues.push(`${spec.label}: ${a.code} is a header or inactive account`);
      else if ([org.arAccountId, org.apAccountId, org.claimsAccountId].includes(a.id)) issues.push(`${spec.label}: ${a.code} is a control account`);
      else if (a.type !== spec.type) issues.push(`${spec.label}: must be ${spec.type === 'EXPENSE' ? 'an expense' : 'a liability'} account`);
    }
    if (issues.length) throw new DomainError('INVALID_ACCOUNT', 'Payroll accounts are invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }
}

function pickAccounts(s: PayrollSettings): PayrollAccounts {
  return Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, s[k]])) as PayrollAccounts;
}

function normalised(e: Employee) {
  return { ...e, dateOfJoining: e.dateOfJoining, priorIncome: e.priorIncome.toFixed(2), priorTds: e.priorTds.toFixed(2) } as Record<string, unknown>;
}

type SlipAmounts = Pick<Prisma.PayslipGetPayload<object>, 'gross' | 'deductions' | 'net' | 'employerCost' | 'pfEmployee' | 'eps' | 'epfEmployer' | 'edli' | 'pfAdmin' | 'esiEmployee' | 'esiEmployer' | 'pt' | 'tds'>;
type SlipKey = keyof SlipAmounts;
const SLIP_KEYS: SlipKey[] = ['gross', 'deductions', 'net', 'employerCost', 'pfEmployee', 'eps', 'epfEmployer', 'edli', 'pfAdmin', 'esiEmployee', 'esiEmployer', 'pt', 'tds'];

function sumSlips(slips: SlipAmounts[]): Record<SlipKey, Dec> {
  const t = Object.fromEntries(SLIP_KEYS.map((k) => [k, new D(0)])) as Record<SlipKey, Dec>;
  for (const s of slips) for (const k of SLIP_KEYS) t[k] = t[k].plus(s[k].toString());
  return t;
}

function liabilities(t: Record<SlipKey, Dec>): Record<PayrollLiability, Dec> {
  return {
    NET_PAY: t.net,
    PF: t.pfEmployee.plus(t.eps).plus(t.epfEmployer).plus(t.edli).plus(t.pfAdmin),
    ESI: t.esiEmployee.plus(t.esiEmployer),
    PT: t.pt,
    TDS: t.tds,
  };
}

function monthDiff(from: string, to: string) {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

function monthName(period: string) {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
