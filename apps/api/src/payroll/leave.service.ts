import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import { taxYearOf } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { LeaveEntryDoc, leaveEntries, leaveTypes, LeaveTypeDoc } from '../db/collections/leave';
import { PayrollService } from './payroll.service';

export interface LeaveTypeInput {
  code: string;
  name: string;
  paid: boolean;
  annualDays: string;
  active?: boolean;
}

export interface LeaveInput {
  employeeId: string;
  leaveTypeId: string;
  from: string;
  to: string;
  days: string;
  reason?: string | null;
}

const halfDays = (v: string) => {
  const d = new D(v);
  return d.isFinite() && d.gte(0) && d.times(2).isInteger();
};
const calendarDays = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
/** April-March year label (2026-27) and its first and last months. */
function leaveYear(label: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new DomainError('INVALID_YEAR', 'The year looks like 2026-27');
  return { label, from: `${m[1]}-04`, to: `${Number(m[1]) + 1}-03` };
}

/**
 * Leave (PAY-011): leave types with a yearly allowance, leave recorded per employee and month,
 * balances for the April-March year, and unpaid leave carried to the payslip as loss of pay.
 * A month whose pay run is posted is closed for leave: it would no longer match the payslip.
 */
@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
    private readonly payroll: PayrollService,
  ) {}

  async listTypes() {
    const rows = await this.store.collection(leaveTypes).find({}, { sort: { code: 1 } });
    return rows.map(typeView);
  }

  async createType(orgId: string, actorId: string, input: LeaveTypeInput) {
    const data = this.checkType(input);
    if (await this.store.collection(leaveTypes).findOne({ code: data.code })) throw new DomainError('DUPLICATE_LEAVE_TYPE', `There is already a leave type ${data.code}`, HttpStatus.CONFLICT);
    const now = new Date();
    await this.store.collection(leaveTypes).insertOne({ orgId, ...data, active: input.active ?? true, createdById: actorId, createdAt: now, updatedAt: now });
    const t = (await this.store.collection(leaveTypes).findOne({ code: data.code }))!;
    await this.log(orgId, actorId, 'leave.type_created', t.id, { code: data.code, paid: data.paid, annualDays: data.annualDays });
    return typeView(t);
  }

  async updateType(orgId: string, actorId: string, id: string, input: LeaveTypeInput) {
    const t = await this.store.collection(leaveTypes).findById(id);
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Leave type not found' });
    const data = this.checkType(input);
    if (data.code !== t.code && (await this.store.collection(leaveTypes).findOne({ code: data.code }))) throw new DomainError('DUPLICATE_LEAVE_TYPE', `There is already a leave type ${data.code}`, HttpStatus.CONFLICT);
    // Whether leave is paid decides past payslips, so it cannot change once leave of the type is recorded.
    if (data.paid !== t.paid && (await this.store.collection(leaveEntries).findOne({ leaveTypeId: id }))) throw new DomainError('LEAVE_TYPE_IN_USE', 'Leave has been recorded under this type, so whether it is paid cannot change. Add a new type instead.', HttpStatus.CONFLICT);
    await this.store.collection(leaveTypes).updateOne({ id }, { $set: { ...data, active: input.active ?? t.active, updatedAt: new Date() } });
    await this.log(orgId, actorId, 'leave.type_updated', id, { ...data, active: input.active ?? t.active });
    return typeView((await this.store.collection(leaveTypes).findById(id))!);
  }

  async list(orgId: string, q: { employeeId?: string; year: string }) {
    const y = leaveYear(q.year);
    const rows = await this.store.collection(leaveEntries).find({ ...(q.employeeId ? { employeeId: q.employeeId } : {}), period: { $gte: y.from, $lte: y.to } }, { sort: { from: -1, createdAt: -1 } });
    const [types, emps] = await Promise.all([this.store.collection(leaveTypes).find({}), this.employees(orgId)]);
    return rows.map((r) => entryView(r, types, emps));
  }

  async record(orgId: string, actorId: string, input: LeaveInput) {
    const e = await this.prisma.employee.findFirst({ where: { orgId, id: input.employeeId } });
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Employee not found' });
    const t = await this.store.collection(leaveTypes).findById(input.leaveTypeId);
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Leave type not found' });
    if (!t.active) throw new DomainError('LEAVE_TYPE_INACTIVE', `${t.name} is no longer in use`, HttpStatus.CONFLICT);
    const { from, to } = input;
    if (to < from) throw new DomainError('INVALID_LEAVE', 'The leave ends before it starts');
    const period = from.slice(0, 7);
    if (to.slice(0, 7) !== period) throw new DomainError('INVALID_LEAVE', 'Record leave one month at a time: split leave that runs into the next month');
    if (from < fromDbDate(e.dateOfJoining)) throw new DomainError('INVALID_LEAVE', 'The leave starts before the employee joined');
    if (e.dateOfLeaving && to > fromDbDate(e.dateOfLeaving)) throw new DomainError('INVALID_LEAVE', 'The leave ends after the employee left');
    if (!halfDays(input.days) || new D(input.days).lte(0)) throw new DomainError('INVALID_LEAVE', 'Days of leave are whole or half days, more than zero');
    const span = calendarDays(from, to);
    if (new D(input.days).gt(span)) throw new DomainError('INVALID_LEAVE', `${from === to ? 'One day' : `${from} to ${to}`} has at most ${span} day${span === 1 ? '' : 's'} of leave`);
    await this.requireOpenMonth(orgId, e.id, period);
    const overlap = await this.store.collection(leaveEntries).findOne({ employeeId: e.id, status: 'RECORDED', from: { $lte: toDbDate(to) }, to: { $gte: toDbDate(from) } });
    if (overlap) throw new DomainError('LEAVE_OVERLAPS', `Leave is already recorded from ${fromDbDate(overlap.from)} to ${fromDbDate(overlap.to)}`, HttpStatus.CONFLICT);
    if (t.paid) {
      const year = taxYearOf(from).label;
      const bal = (await this.balances(orgId, year, e.id)).find((b) => b.leaveTypeId === t.id);
      const left = new D(bal?.left ?? t.annualDays);
      if (new D(input.days).gt(left)) throw new DomainError('NOT_ENOUGH_LEAVE', `Only ${left.toFixed()} days of ${t.name} are left in ${year}. Record the rest as unpaid leave.`, HttpStatus.CONFLICT);
    }
    const created = new Date();
    await this.store.collection(leaveEntries).insertOne({
      orgId,
      employeeId: e.id,
      leaveTypeId: t.id,
      paid: t.paid,
      period,
      from: toDbDate(from),
      to: toDbDate(to),
      days: new D(input.days).toFixed(),
      reason: input.reason?.trim() || null,
      status: 'RECORDED',
      createdById: actorId,
      createdAt: created,
      cancelledById: null,
      cancelledAt: null,
      cancelReason: null,
    });
    const doc = (await this.store.collection(leaveEntries).findOne({ employeeId: e.id, from: toDbDate(from), status: 'RECORDED' }))!;
    let draft: string | null = null;
    if (!t.paid) {
      try {
        draft = await this.payroll.refreshDraftPayslip(orgId, e.id, period);
      } catch (err) {
        // The draft payslip cannot take this much loss of pay: the leave is not kept.
        await this.store.collection(leaveEntries).deleteOne({ id: doc.id });
        throw err;
      }
    }
    await this.log(orgId, actorId, 'leave.recorded', doc.id, { employeeId: e.id, type: t.code, from, to, days: doc.days, paid: t.paid, draftUpdated: draft });
    const [types, emps] = await Promise.all([this.store.collection(leaveTypes).find({}), this.employees(orgId)]);
    return { ...entryView(doc, types, emps), draftUpdated: draft };
  }

  async cancel(orgId: string, actorId: string, id: string, input: { reason: string }) {
    const r = await this.store.collection(leaveEntries).findById(id);
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Leave not found' });
    if (r.status !== 'RECORDED') throw new DomainError('ALREADY_CANCELLED', 'This leave is already cancelled', HttpStatus.CONFLICT);
    await this.requireOpenMonth(orgId, r.employeeId, r.period);
    const reason = input.reason.trim();
    await this.store.collection(leaveEntries).updateOne({ id }, { $set: { status: 'CANCELLED', cancelledById: actorId, cancelledAt: new Date(), cancelReason: reason } });
    const draft = r.paid ? null : await this.payroll.refreshDraftPayslip(orgId, r.employeeId, r.period);
    await this.log(orgId, actorId, 'leave.cancelled', id, { reason, draftUpdated: draft });
    const [types, emps] = await Promise.all([this.store.collection(leaveTypes).find({}), this.employees(orgId)]);
    return { ...entryView((await this.store.collection(leaveEntries).findById(id))!, types, emps), draftUpdated: draft };
  }

  /** Each employee's paid leave for the year: allowance, taken and left; and unpaid leave taken. */
  async balances(orgId: string, year: string, employeeId?: string) {
    const y = leaveYear(year);
    const [types, emps, taken] = await Promise.all([
      this.store.collection(leaveTypes).find({}, { sort: { code: 1 } }),
      this.employees(orgId),
      this.store.collection(leaveEntries).find({ ...(employeeId ? { employeeId } : {}), status: 'RECORDED', period: { $gte: y.from, $lte: y.to } }),
    ]);
    const out: { employeeId: string; employeeCode: string; employeeName: string; leaveTypeId: string; code: string; name: string; paid: boolean; allowance: string | null; taken: string; left: string | null }[] = [];
    for (const e of emps.filter((x) => !employeeId || x.id === employeeId)) {
      // People who left before the year began have no balance in it.
      if (e.dateOfLeaving && e.dateOfLeaving.slice(0, 7) < y.from) continue;
      if (e.dateOfJoining.slice(0, 7) > y.to) continue;
      for (const t of types) {
        const days = taken.filter((x) => x.employeeId === e.id && x.leaveTypeId === t.id).reduce((s, x) => s.plus(x.days), new D(0));
        if (!t.active && days.isZero()) continue;
        out.push({
          employeeId: e.id,
          employeeCode: e.code,
          employeeName: e.name,
          leaveTypeId: t.id,
          code: t.code,
          name: t.name,
          paid: t.paid,
          allowance: t.paid ? new D(t.annualDays).toFixed() : null,
          taken: days.toFixed(),
          left: t.paid ? new D(t.annualDays).minus(days).toFixed() : null,
        });
      }
    }
    return out;
  }

  private async requireOpenMonth(orgId: string, employeeId: string, period: string) {
    const posted = await this.prisma.payslip.findFirst({ where: { orgId, employeeId, payRun: { status: 'POSTED', period } }, select: { payRun: { select: { number: true } } } });
    if (posted) throw new DomainError('MONTH_PAID', `${period} is paid in ${posted.payRun.number}, so its leave cannot change. Void the pay run first, or record leave in an open month.`, HttpStatus.CONFLICT);
  }

  private checkType(input: LeaveTypeInput) {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(code)) throw new DomainError('INVALID_LEAVE_TYPE', 'The code is 1 to 10 letters or digits, such as EL');
    const name = input.name.trim();
    if (!name) throw new DomainError('INVALID_LEAVE_TYPE', 'Give the leave type a name');
    if (!halfDays(input.annualDays) || new D(input.annualDays).gt(366)) throw new DomainError('INVALID_LEAVE_TYPE', 'Days a year are whole or half days, up to 366');
    if (!input.paid && !new D(input.annualDays).isZero()) throw new DomainError('INVALID_LEAVE_TYPE', 'Unpaid leave has no yearly allowance: set days a year to 0');
    return { code, name, paid: input.paid, annualDays: new D(input.annualDays).toFixed() };
  }

  private async employees(orgId: string) {
    const rows = await this.prisma.employee.findMany({ where: { orgId }, select: { id: true, code: true, name: true, dateOfJoining: true, dateOfLeaving: true }, orderBy: { code: 'asc' } });
    return rows.map((e) => ({ id: e.id, code: e.code, name: e.name, dateOfJoining: fromDbDate(e.dateOfJoining), dateOfLeaving: e.dateOfLeaving ? fromDbDate(e.dateOfLeaving) : null }));
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'leave', entityId, data }));
  }
}

const typeView = (t: LeaveTypeDoc) => ({ id: t.id, code: t.code, name: t.name, paid: t.paid, annualDays: new D(t.annualDays).toFixed(), active: t.active });

function entryView(r: LeaveEntryDoc, types: LeaveTypeDoc[], emps: { id: string; code: string; name: string }[]) {
  const t = types.find((x) => x.id === r.leaveTypeId);
  const e = emps.find((x) => x.id === r.employeeId);
  return {
    id: r.id,
    employee: { id: r.employeeId, code: e?.code ?? '', name: e?.name ?? '' },
    leaveType: { id: r.leaveTypeId, code: t?.code ?? '', name: t?.name ?? '' },
    paid: r.paid,
    period: r.period,
    from: fromDbDate(r.from),
    to: fromDbDate(r.to),
    days: new D(r.days).toFixed(),
    reason: r.reason,
    status: r.status,
    cancelReason: r.cancelReason,
  };
}
