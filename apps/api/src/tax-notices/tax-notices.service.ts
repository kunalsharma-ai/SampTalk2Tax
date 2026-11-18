import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { minorUnits, TAX_AUTHORITY_LABEL, taxNoticeIssues, taxNoticeUrgency, D } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { cleanFileName, MAX_ATTACHMENT_BYTES, sniffContentType } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { taxNoticeFiles, TaxNoticeDoc, TaxNoticeEventKind, TaxNoticeOutcomeName, taxNotices, TaxAuthorityName, TaxNoticeStatusName } from '../db/collections/tax-notices';
import { memberships } from '../db/collections/tenancy';

export interface NoticeDetails {
  reference: string;
  section?: string | null;
  subject: string;
  period?: string | null;
  receivedOn: string;
  responseDue?: string | null;
  demand?: string | null;
  assigneeId?: string | null;
}

const MAX_FILES = 20;
const OUTCOME_LABEL: Record<TaxNoticeOutcomeName, string> = { DROPPED: 'Dropped with no demand', DEMAND_PAID: 'Demand paid', APPEALED: 'Appealed', OTHER: 'Other' };

/**
 * Tax notices (TAX-024). MongoDB only. Anyone who reads reports sees them; accounts.manage
 * records and works them, like compliance filings. Every step is audited and kept in the
 * notice's own history.
 */
@Injectable()
export class TaxNoticesService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private invalid(issues: string[]) {
    return new DomainError('NOTICE_INVALID', 'The notice is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }

  private async find(id: string) {
    const n = await this.store.collection(taxNotices).findById(id);
    if (!n) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Tax notice not found' });
    return n;
  }

  private async check(org: OrgContext, authority: TaxAuthorityName, d: NoticeDetails) {
    const issues = taxNoticeIssues({ authority, ...d }, org.functionalCurrency, todayIso());
    if (d.assigneeId && !(await this.store.collection(memberships).exists({ userId: d.assigneeId }))) issues.push('The person it is given to must be a member of the organisation');
    if (issues.length) throw this.invalid(issues);
  }

  private fields(d: NoticeDetails) {
    return {
      reference: d.reference.trim(),
      section: d.section?.trim() || null,
      subject: d.subject.trim(),
      period: d.period?.trim() || null,
      receivedOn: toDbDate(d.receivedOn),
      responseDue: d.responseDue ? toDbDate(d.responseDue) : null,
      demand: d.demand ? new D(d.demand).toFixed() : null,
      assigneeId: d.assigneeId ?? null,
    };
  }

  private event(kind: TaxNoticeEventKind, byId: string, text: string | null, on = todayIso()) {
    return { id: randomUUID(), kind, on: toDbDate(on), text, byId, at: new Date() };
  }

  private duplicate(e: unknown, d: { reference: string }, authority: TaxAuthorityName): never {
    if (isDuplicateKeyError(e)) throw new DomainError('NOTICE_EXISTS', `A ${TAX_AUTHORITY_LABEL[authority]} notice ${d.reference.trim()} is already recorded`, HttpStatus.CONFLICT);
    throw e;
  }

  async list(org: OrgContext, q: { status?: TaxNoticeStatusName }) {
    const rows = await this.store.collection(taxNotices).find(q.status ? { status: q.status } : {}, { sort: { receivedOn: -1 } });
    const today = todayIso();
    const names = await this.names(rows.map((r) => r.assigneeId));
    const items = rows
      .map((n) => this.summary(org, n, today, names))
      .sort((a, b) => rank(a.urgency) - rank(b.urgency) || (a.responseDue ?? '9999').localeCompare(b.responseDue ?? '9999') || b.receivedOn.localeCompare(a.receivedOn));
    const open = items.filter((i) => i.status === 'OPEN');
    return {
      today,
      summary: { open: open.length, overdue: open.filter((i) => i.urgency === 'OVERDUE').length, dueSoon: open.filter((i) => i.urgency === 'DUE_SOON').length, responded: items.filter((i) => i.status === 'RESPONDED').length, closed: items.filter((i) => i.status === 'CLOSED').length },
      items,
    };
  }

  private summary(org: OrgContext, n: TaxNoticeDoc, today: string, names: Map<string, string>) {
    const responseDue = n.responseDue ? fromDbDate(n.responseDue) : null;
    return {
      id: n.id,
      authority: n.authority,
      authorityLabel: TAX_AUTHORITY_LABEL[n.authority],
      reference: n.reference,
      section: n.section,
      subject: n.subject,
      period: n.period,
      receivedOn: fromDbDate(n.receivedOn),
      responseDue,
      demand: n.demand ? new D(n.demand).toFixed(minorUnits(org.functionalCurrency)) : null,
      status: n.status,
      outcome: n.outcome,
      outcomeLabel: n.outcome ? OUTCOME_LABEL[n.outcome] : null,
      assigneeId: n.assigneeId,
      assignee: n.assigneeId ? (names.get(n.assigneeId) ?? null) : null,
      ...taxNoticeUrgency({ status: n.status, responseDue }, today),
    };
  }

  async get(org: OrgContext, id: string) {
    const n = await this.find(id);
    const files = await this.store.collection(taxNoticeFiles).find({ noticeId: id }, { sort: { createdAt: 1 }, projection: { content: 0 } });
    const names = await this.names([n.assigneeId, ...n.events.map((e) => e.byId), ...files.map((f) => f.uploadedById)]);
    return {
      ...this.summary(org, n, todayIso(), names),
      history: n.events.map((e) => ({ id: e.id, kind: e.kind, on: fromDbDate(e.on), text: e.text, by: names.get(e.byId) ?? null, at: e.at.toISOString() })),
      files: files.map((f) => ({ id: f.id, fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes, sha256: f.sha256, uploadedBy: names.get(f.uploadedById) ?? null, createdAt: f.createdAt.toISOString() })),
    };
  }

  async create(org: OrgContext, actorId: string, input: NoticeDetails & { authority: TaxAuthorityName }) {
    await this.check(org, input.authority, input);
    const now = new Date();
    const f = this.fields(input);
    const n = await this.store
      .collection(taxNotices)
      .insertOne({ orgId: org.id, authority: input.authority, ...f, status: 'OPEN', outcome: null, events: [this.event('RECEIVED', actorId, null, input.receivedOn)], createdById: actorId, createdAt: now, updatedAt: now })
      .catch((e: unknown) => this.duplicate(e, input, input.authority));
    await this.record(org.id, actorId, 'tax_notice.recorded', n.id, { authority: n.authority, reference: n.reference, responseDue: input.responseDue ?? null, demand: f.demand });
    return this.get(org, n.id);
  }

  async update(org: OrgContext, actorId: string, id: string, input: NoticeDetails) {
    const n = await this.find(id);
    if (n.status === 'CLOSED') throw new DomainError('NOTICE_CLOSED', 'A closed notice cannot be changed; reopen it first', HttpStatus.CONFLICT);
    await this.check(org, n.authority, input);
    const f = this.fields(input);
    const was: Record<string, string | null> = { reference: n.reference, section: n.section, subject: n.subject, period: n.period, receivedOn: fromDbDate(n.receivedOn), responseDue: n.responseDue ? fromDbDate(n.responseDue) : null, demand: n.demand ? new D(n.demand).toFixed() : null, assigneeId: n.assigneeId };
    const next: Record<string, string | null> = { ...f, receivedOn: input.receivedOn, responseDue: input.responseDue || null };
    const changed = Object.keys(was).filter((k) => (was[k] ?? '') !== (next[k] ?? ''));
    if (!changed.length) return this.get(org, id);
    await this.store
      .collection(taxNotices)
      .updateOne({ id }, { $set: { ...f, updatedAt: new Date() }, $push: { events: this.event('UPDATED', actorId, `Changed ${changed.join(', ')}`) } } as never)
      .catch((e: unknown) => this.duplicate(e, input, n.authority));
    await this.record(org.id, actorId, 'tax_notice.updated', id, { changed });
    return this.get(org, id);
  }

  async note(org: OrgContext, actorId: string, id: string, text: string) {
    await this.find(id);
    await this.push(id, this.event('NOTE', actorId, text.trim()));
    await this.record(org.id, actorId, 'tax_notice.noted', id, {});
    return this.get(org, id);
  }

  async respond(org: OrgContext, actorId: string, id: string, input: { on: string; text: string }) {
    const n = await this.find(id);
    if (n.status !== 'OPEN') throw new DomainError('NOTICE_NOT_OPEN', n.status === 'RESPONDED' ? 'A reply is already recorded; add a note for a further reply' : 'A closed notice cannot be answered; reopen it first', HttpStatus.CONFLICT);
    if (input.on > todayIso()) throw this.invalid(['The reply cannot be dated in the future']);
    if (input.on < fromDbDate(n.receivedOn)) throw this.invalid(['The reply cannot be before the notice was received']);
    await this.push(id, this.event('RESPONDED', actorId, input.text.trim(), input.on), { status: 'RESPONDED' });
    await this.record(org.id, actorId, 'tax_notice.responded', id, { on: input.on, late: !!n.responseDue && input.on > fromDbDate(n.responseDue) });
    return this.get(org, id);
  }

  async close(org: OrgContext, actorId: string, id: string, input: { outcome: TaxNoticeOutcomeName; text: string }) {
    const n = await this.find(id);
    if (n.status === 'CLOSED') throw new DomainError('NOTICE_CLOSED', 'This notice is already closed', HttpStatus.CONFLICT);
    await this.push(id, this.event('CLOSED', actorId, `${OUTCOME_LABEL[input.outcome]}: ${input.text.trim()}`), { status: 'CLOSED', outcome: input.outcome });
    await this.record(org.id, actorId, 'tax_notice.closed', id, { outcome: input.outcome });
    return this.get(org, id);
  }

  async reopen(org: OrgContext, actorId: string, id: string, text: string) {
    const n = await this.find(id);
    if (n.status !== 'CLOSED') throw new DomainError('NOTICE_NOT_CLOSED', 'Only a closed notice can be reopened', HttpStatus.CONFLICT);
    const answered = n.events.some((e) => e.kind === 'RESPONDED');
    await this.push(id, this.event('REOPENED', actorId, text.trim()), { status: answered ? 'RESPONDED' : 'OPEN', outcome: null });
    await this.record(org.id, actorId, 'tax_notice.reopened', id, {});
    return this.get(org, id);
  }

  async addFile(org: OrgContext, actorId: string, id: string, fileName: string, content: Buffer) {
    await this.find(id);
    if (!content.length) throw this.invalid(['The file is empty']);
    if (content.length > MAX_ATTACHMENT_BYTES) throw this.invalid(['A file can be at most 5 MB']);
    const contentType = sniffContentType(content);
    if (!contentType) throw this.invalid(['Upload a PDF, PNG, JPEG or WebP file']);
    if ((await this.store.collection(taxNoticeFiles).count({ noticeId: id })) >= MAX_FILES) throw this.invalid([`A notice can have at most ${MAX_FILES} files`]);
    const name = cleanFileName(fileName);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const f = await this.store.collection(taxNoticeFiles).insertOne({ orgId: org.id, noticeId: id, fileName: name, contentType, sizeBytes: content.length, sha256, content, uploadedById: actorId, createdAt: new Date() });
    await this.push(id, this.event('FILE', actorId, name));
    await this.record(org.id, actorId, 'tax_notice.file_added', id, { fileId: f.id, fileName: name, sha256 });
    return this.get(org, id);
  }

  async file(id: string, fileId: string) {
    const f = await this.store.collection(taxNoticeFiles).findOne({ id: fileId, noticeId: id });
    if (!f) throw new NotFoundException({ error: 'NOT_FOUND', message: 'File not found' });
    const c = f.content as { buffer?: ArrayBufferLike } | Buffer;
    return { fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes, sha256: f.sha256, content: Buffer.isBuffer(c) ? c : Buffer.from((c as { buffer: ArrayBuffer }).buffer) };
  }

  private async push(id: string, event: ReturnType<TaxNoticesService['event']>, set: Partial<TaxNoticeDoc> = {}) {
    await this.store.collection(taxNotices).updateOne({ id }, { $set: { ...set, updatedAt: new Date() }, $push: { events: event } } as never);
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length ? await this.store.collection(users).find({ id: { $in: unique } }) : [];
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private record(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'tax_notice', entityId, data }));
  }
}

function rank(u: string) {
  return ['OVERDUE', 'DUE_SOON', 'UPCOMING', 'NO_DEADLINE', 'DONE'].indexOf(u);
}
