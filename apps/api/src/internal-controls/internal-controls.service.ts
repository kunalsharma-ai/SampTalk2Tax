import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  AUTOMATIC_CHECKS,
  automaticCheckOutcome,
  CONTROL_LIBRARY,
  controlStatus,
  dueControlPeriod,
  parseControlPeriod,
  type AutomaticCheck,
  type CheckOutcome,
  type ControlFrequency,
  type ControlPeriod,
} from '@talk2tax/accounting-engine';
import { hasPermission, type RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { bankReconciliations } from '../db/collections/banking';
import { accounts, fiscalPeriods } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { auditFindings } from '../db/collections/audit-findings';
import { controlTests, internalControls, type ControlTestDoc, type InternalControlDoc } from '../db/collections/internal-controls';
import { journalEntries } from '../db/collections/ledger';
import { contacts } from '../db/collections/sales';
import { memberships, organizations } from '../db/collections/tenancy';
import { SegregationOfDutiesService } from '../segregation-of-duties/segregation-of-duties.service';

export interface ControlInput {
  title: string;
  objective: string;
  area: string;
  frequency: ControlFrequency;
  ownerId: string;
  active?: boolean;
}

/** Most controls one organisation keeps, so the register stays usable. */
export const MAX_CONTROLS = 200;

/**
 * Internal controls register (AUDIT-008 control testing, AUDIT-013 control ownership). Reading
 * needs audit.read; adding and changing controls needs org.manage; recording a test needs
 * audit.read, and the owner may test their own control only when no one else can. Automatic
 * checks are worked out by the server for the period; tests are kept as recorded and audited.
 */
@Injectable()
export class InternalControlsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sod: SegregationOfDutiesService,
  ) {}

  private async fyStart(orgId: string) {
    return (await this.store.collection(organizations).findById(orgId))?.fiscalYearStartMonth ?? 4;
  }

  private async names(ids: string[]) {
    const list = ids.length ? await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }) : [];
    return new Map(list.map((u) => [u.id, u.name ?? u.email]));
  }

  private async control(id: string) {
    const c = await this.store.collection(internalControls).findById(id);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Control not found' });
    return c;
  }

  /** Members who can test controls (audit.read). */
  private async testers() {
    return (await this.store.collection(memberships).find({})).filter((m) => hasPermission(m.role as RoleName, 'audit.read'));
  }

  /** The register: every control with its owner, the period due for testing and where it stands, plus library controls not yet added. */
  async list(org: OrgContext, user: AuthUser) {
    const [controls, fy, members] = await Promise.all([this.store.collection(internalControls).find({}, { sort: { area: 1, title: 1 } }), this.fyStart(org.id), this.store.collection(memberships).find({})]);
    const today = todayIso();
    const due = new Map(controls.map((c) => [c.id, dueControlPeriod(c.frequency, today, fy)]));
    const tests = controls.length ? await this.store.collection(controlTests).find({ controlId: { $in: controls.map((c) => c.id) } }, { sort: { testedAt: -1 } }) : [];
    const names = await this.names([...controls.map((c) => c.ownerId), ...tests.map((t) => t.testedById), ...members.map((m) => m.userId)]);
    const rows = controls.map((c) => {
      const period = due.get(c.id)!;
      const forPeriod = tests.find((t) => t.controlId === c.id && t.periodKey === period.key) ?? null;
      const last = tests.find((t) => t.controlId === c.id) ?? null;
      return {
        ...this.view(c, names),
        duePeriod: period,
        status: controlStatus(c, forPeriod?.result ?? null, today, fy),
        lastTest: last ? this.testView(last, names) : null,
        canTest: c.active && hasPermission(org.role, 'audit.read'),
        isOwner: c.ownerId === user.id,
      };
    });
    const used = new Set(controls.map((c) => c.templateId).filter(Boolean));
    return {
      controls: rows,
      library: CONTROL_LIBRARY.filter((t) => !used.has(t.id)).map((t) => ({ ...t, checkDescription: t.check ? AUTOMATIC_CHECKS[t.check] : null })),
      members: members.filter((m) => m.role !== 'EMPLOYEE').map((m) => ({ id: m.userId, name: names.get(m.userId) ?? 'A member', role: m.role })).sort((a, b) => a.name.localeCompare(b.name)),
      canManage: hasPermission(org.role, 'org.manage'),
      summary: {
        passed: rows.filter((r) => r.status === 'PASSED').length,
        failed: rows.filter((r) => r.status === 'FAILED').length,
        due: rows.filter((r) => r.status === 'DUE').length,
        overdue: rows.filter((r) => r.status === 'OVERDUE').length,
      },
    };
  }

  private view(c: InternalControlDoc, names: Map<string, string>) {
    return {
      id: c.id,
      title: c.title,
      objective: c.objective,
      area: c.area,
      frequency: c.frequency,
      check: c.check,
      checkDescription: c.check ? AUTOMATIC_CHECKS[c.check as AutomaticCheck] ?? null : null,
      templateId: c.templateId,
      owner: { id: c.ownerId, name: names.get(c.ownerId) ?? 'A former member' },
      active: c.active,
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private testView(t: ControlTestDoc, names: Map<string, string>) {
    return {
      id: t.id,
      periodKey: t.periodKey,
      from: fromDbDate(t.from),
      to: fromDbDate(t.to),
      result: t.result,
      method: t.method,
      notes: t.notes,
      evidence: t.evidence,
      selfTested: t.selfTested,
      testedBy: { id: t.testedById, name: names.get(t.testedById) ?? 'A former member' },
      testedAt: t.testedAt.toISOString(),
    };
  }

  /** One control with every test recorded against it, newest first. */
  async get(org: OrgContext, user: AuthUser, id: string) {
    const c = await this.control(id);
    const [fy, tests] = await Promise.all([this.fyStart(org.id), this.store.collection(controlTests).find({ controlId: id }, { sort: { testedAt: -1 } })]);
    const names = await this.names([c.ownerId, ...tests.map((t) => t.testedById)]);
    const period = dueControlPeriod(c.frequency, todayIso(), fy);
    const forPeriod = tests.find((t) => t.periodKey === period.key) ?? null;
    const failed = tests.filter((t) => t.result === 'FAIL').map((t) => t.id);
    const raised = new Map((failed.length ? await this.store.collection(auditFindings).find({ testId: { $in: failed } }) : []).map((f) => [f.testId, { id: f.id, reference: `F-${String(f.number).padStart(3, '0')}`, status: f.status }]));
    return {
      ...this.view(c, names),
      duePeriod: period,
      status: controlStatus(c, forPeriod?.result ?? null, todayIso(), fy),
      tests: tests.map((t) => ({ ...this.testView(t, names), finding: raised.get(t.id) ?? null })),
      canTest: c.active && hasPermission(org.role, 'audit.read'),
      canManage: hasPermission(org.role, 'org.manage'),
      isOwner: c.ownerId === user.id,
    };
  }

  private async assertOwner(ownerId: string) {
    const m = await this.store.collection(memberships).findOne({ userId: ownerId });
    if (!m || m.role === 'EMPLOYEE') throw new DomainError('OWNER_NOT_MEMBER', 'The owner must be a member of the organisation who works on the books', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async assertTitleFree(title: string, except?: string) {
    const clash = await this.store.collection(internalControls).findOne({ title });
    if (clash && clash.id !== except) throw new DomainError('DUPLICATE', 'A control with this title already exists', HttpStatus.CONFLICT);
  }

  /** Adds a control: one from the library (keeping its automatic check) or one of the organisation's own, tested by hand. */
  async create(org: OrgContext, user: AuthUser, input: ({ templateId: string } | ControlInput) & { ownerId: string }) {
    let data: Omit<InternalControlDoc, 'id' | 'orgId' | 'createdById' | 'createdAt' | 'updatedById' | 'updatedAt'>;
    if ('templateId' in input && input.templateId) {
      const t = CONTROL_LIBRARY.find((x) => x.id === input.templateId);
      if (!t) throw new DomainError('NOT_FOUND', 'There is no such library control', HttpStatus.NOT_FOUND);
      if (await this.store.collection(internalControls).findOne({ templateId: t.id })) throw new DomainError('DUPLICATE', 'This library control is already in the register', HttpStatus.CONFLICT);
      data = { title: t.title, objective: t.objective, area: t.area, frequency: t.frequency, check: t.check, templateId: t.id, ownerId: input.ownerId, active: true };
    } else {
      const c = input as ControlInput;
      data = { title: c.title, objective: c.objective, area: c.area, frequency: c.frequency, check: null, templateId: null, ownerId: c.ownerId, active: true };
    }
    await this.assertOwner(data.ownerId);
    await this.assertTitleFree(data.title);
    if ((await this.store.collection(internalControls).count({})) >= MAX_CONTROLS) throw new DomainError('TOO_MANY', `An organisation keeps at most ${MAX_CONTROLS} controls`, HttpStatus.CONFLICT);
    const now = new Date();
    const doc = await this.store.collection(internalControls).insertOne({ ...data, createdById: user.id, createdAt: now, updatedById: user.id, updatedAt: now });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'control.created', entityType: 'internal_control', entityId: doc.id, data: { title: doc.title, frequency: doc.frequency, check: doc.check, ownerId: doc.ownerId, templateId: doc.templateId } }));
    return this.get(org, user, doc.id);
  }

  /** Changes a control's wording, owner, frequency or whether it is in use. A library control keeps its automatic check. */
  async update(org: OrgContext, user: AuthUser, id: string, input: ControlInput) {
    const before = await this.control(id);
    await this.assertOwner(input.ownerId);
    await this.assertTitleFree(input.title, id);
    const set = { title: input.title, objective: input.objective, area: input.area, frequency: input.frequency, ownerId: input.ownerId, active: input.active ?? before.active, updatedById: user.id, updatedAt: new Date() };
    await this.store.collection(internalControls).updateOne({ id }, { $set: set });
    const changed = (['title', 'objective', 'area', 'frequency', 'ownerId', 'active'] as const).filter((k) => before[k] !== set[k]);
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'control.updated', entityType: 'internal_control', entityId: id, data: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, set[k]])) } }),
    );
    return this.get(org, user, id);
  }

  private async period(c: InternalControlDoc, key: string): Promise<ControlPeriod> {
    const p = parseControlPeriod(c.frequency, key, await this.fyStart(c.orgId));
    if (!p) throw new DomainError('INVALID_PERIOD', `Not a ${c.frequency.toLowerCase()} period`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (p.to >= todayIso()) throw new DomainError('PERIOD_NOT_ENDED', 'A period is tested once it has ended', HttpStatus.UNPROCESSABLE_ENTITY);
    return p;
  }

  /** Runs a control's automatic check for a period without recording anything. */
  async runCheck(org: OrgContext, id: string, periodKey: string) {
    const c = await this.control(id);
    if (!c.check) throw new DomainError('NO_AUTOMATIC_CHECK', 'This control is tested by hand', HttpStatus.CONFLICT);
    const p = await this.period(c, periodKey);
    return { period: p, ...(await this.check(org.id, c.check as AutomaticCheck, p)) };
  }

  /** Records a test. An automatic check's result and evidence come from the books; a manual test needs the result and notes. */
  async recordTest(org: OrgContext, user: AuthUser, id: string, input: { period: string; result?: 'PASS' | 'FAIL'; notes?: string | null }) {
    const c = await this.control(id);
    if (!c.active) throw new DomainError('INACTIVE', 'This control is not in use', HttpStatus.CONFLICT);
    const p = await this.period(c, input.period);
    let selfTested = false;
    if (c.ownerId === user.id) {
      if ((await this.testers()).some((m) => m.userId !== user.id)) throw new ForbiddenException({ error: 'OWNER_CANNOT_TEST', message: 'Someone other than the control’s owner must test it' });
      selfTested = true;
    }
    const notes = input.notes?.trim() || null;
    let outcome: CheckOutcome | null = null;
    if (c.check) outcome = await this.check(org.id, c.check as AutomaticCheck, p);
    else {
      if (!input.result) throw new DomainError('RESULT_REQUIRED', 'Say whether the control worked', HttpStatus.UNPROCESSABLE_ENTITY);
      if (!notes || notes.length < 10) throw new DomainError('NOTES_REQUIRED', 'Say what you checked, in at least 10 characters', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const doc = await this.store.collection(controlTests).insertOne({
      controlId: c.id,
      periodKey: p.key,
      from: toDbDate(p.from),
      to: toDbDate(p.to),
      result: outcome ? outcome.result : input.result!,
      method: outcome ? 'AUTOMATIC' : 'MANUAL',
      notes,
      evidence: outcome ? { summary: outcome.summary, exceptions: outcome.exceptions } : null,
      selfTested,
      testedById: user.id,
      testedAt: new Date(),
    });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'control.tested', entityType: 'internal_control', entityId: c.id, data: { test: doc.id, period: p.key, result: doc.result, method: doc.method, exceptions: outcome?.exceptions.length ?? null, selfTested } }),
    );
    return this.get(org, user, c.id);
  }

  /** Gathers the facts for an automatic check over a period. */
  private async check(orgId: string, check: AutomaticCheck, p: ControlPeriod): Promise<CheckOutcome> {
    const end = toDbDate(p.to);
    if (check === 'BANKS_RECONCILED') {
      const banks = await this.store.collection(accounts).find({ subtype: 'BANK', isActive: true }, { sort: { code: 1 } });
      const used = [];
      for (const b of banks) if (await this.store.collection(journalEntries).count({ status: 'POSTED', date: { $lte: end }, 'lines.accountId': b.id })) used.push(b);
      const exceptions: string[] = [];
      for (const b of used) {
        const latest = (await this.store.collection(bankReconciliations).find({ accountId: b.id, status: 'COMPLETED' }, { sort: { statementDate: -1 }, limit: 1 }))[0];
        if (!latest) exceptions.push(`${b.code} ${b.name}: never reconciled`);
        else if (fromDbDate(latest.statementDate) < p.to) exceptions.push(`${b.code} ${b.name}: reconciled only to ${fromDbDate(latest.statementDate)}`);
      }
      return automaticCheckOutcome(check, { items: used.length, exceptions });
    }
    if (check === 'JOURNALS_SEGREGATED') {
      const [count, open] = await Promise.all([
        this.store.collection(journalEntries).count({ status: 'POSTED', source: 'MANUAL', date: { $gte: toDbDate(p.from), $lte: end } }),
        this.sod.unreviewedFindings(orgId, p.from, p.to),
      ]);
      const exceptions = open.filter((f) => f.rule === 'SELF_POSTED_JOURNAL').map((f) => `${f.subject.label} on ${f.date}: posted by its author and not reviewed`);
      return automaticCheckOutcome(check, { items: count, exceptions });
    }
    if (check === 'VENDOR_BANK_DETAILS_VERIFIED') {
      const details = await this.prisma.vendorBankDetails.findMany({ where: { orgId, changedAt: { lte: new Date(`${p.to}T23:59:59.999Z`) } } });
      const open = details.filter((d) => !d.verifiedAt);
      const vendors = new Map((open.length ? await this.store.collection(contacts).find({ id: { $in: open.map((d) => d.contactId) } }) : []).map((x) => [x.id, x.name]));
      const exceptions = open.map((d) => `${vendors.get(d.contactId) ?? 'A vendor'}: changed on ${d.changedAt.toISOString().slice(0, 10)} and not verified`);
      return automaticCheckOutcome(check, { items: details.length, exceptions });
    }
    const periods = await this.store.collection(fiscalPeriods).find({ endDate: { $lte: end } }, { sort: { startDate: 1 } });
    const exceptions = periods.filter((x) => x.status === 'OPEN').map((x) => `${x.name} is still open`);
    return automaticCheckOutcome(check, { items: periods.length, exceptions });
  }
}
