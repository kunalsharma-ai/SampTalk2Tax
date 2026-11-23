import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { analyseNotice, D, NOTICE_TYPES } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { taxNoticeAnalyses } from '../db/collections/tax-notice-analyses';
import { taxNotices } from '../db/collections/tax-notices';

const RELATED = 10; // not money

/**
 * Tax notice analysis (TAX-050): what kind of notice it is (by authority and section, or as the
 * user chose), the usual reply deadline, how to reply, what to gather (a checklist whose ticks are
 * kept), interest building up on an unpaid income-tax demand, and other notices from the same
 * authority (for the same period, where one is given). Rule-based, each type citing its provision;
 * no AI and nothing guessed. reports.read to read; accounts.manage to choose the type and tick the
 * checklist, which is audited.
 */
@Injectable()
export class TaxNoticeAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
  ) {}

  private async notice(id: string) {
    const n = await this.store.collection(taxNotices).findById(id);
    if (!n) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Tax notice not found' });
    return n;
  }

  async get(org: OrgContext, id: string, today = todayIso()) {
    const n = await this.notice(id);
    const row = await this.store.collection(taxNoticeAnalyses).findOne({ noticeId: id });
    const analysis = analyseNotice(
      { authority: n.authority, section: n.section, status: n.status, receivedOn: fromDbDate(n.receivedOn), responseDue: n.responseDue ? fromDbDate(n.responseDue) : null, demand: n.demand ? new D(n.demand).toFixed() : null, chosenType: row?.chosenType ?? null, checked: row?.checked ?? [] },
      today,
    );
    const others = (await this.store.collection(taxNotices).find({ authority: n.authority, id: { $ne: id }, ...(n.period ? { period: n.period } : {}) }, { sort: { receivedOn: -1 }, limit: RELATED })).map((o) => ({ id: o.id, reference: o.reference, section: o.section, subject: o.subject, period: o.period, status: o.status, receivedOn: fromDbDate(o.receivedOn) }));
    const by = row ? (await this.store.collection(users).findById(row.updatedById))?.name ?? 'Former member' : null;
    return {
      noticeId: id,
      asOf: today,
      ...analysis,
      currency: org.functionalCurrency,
      chosenType: row?.chosenType ?? null,
      types: NOTICE_TYPES.filter((t) => t.authorities.includes(n.authority)).map((t) => ({ key: t.key, title: t.title })),
      related: { samePeriod: !!n.period, notices: others },
      updatedBy: by,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async save(org: OrgContext, user: AuthUser, id: string, input: { chosenType: string | null; checked: string[] }, today = todayIso()) {
    const n = await this.notice(id);
    const issues: string[] = [];
    const chosen = input.chosenType ? NOTICE_TYPES.find((t) => t.key === input.chosenType) : null;
    if (input.chosenType && (!chosen || !chosen.authorities.includes(n.authority))) issues.push(`${input.chosenType} is not a notice type for this authority`);
    const row = await this.store.collection(taxNoticeAnalyses).findOne({ noticeId: id });
    const preview = analyseNotice({ authority: n.authority, section: n.section, status: n.status, receivedOn: fromDbDate(n.receivedOn), responseDue: null, demand: null, chosenType: chosen ? chosen.key : null, checked: [] }, today);
    const keys = new Set(preview.checklist.map((c) => c.key));
    const checked = [...new Set(input.checked)];
    for (const k of checked) if (!keys.has(k)) issues.push(`"${k}" is not on this notice's checklist`);
    if (issues.length) throw new DomainError('ANALYSIS_INVALID', issues.join(' '), HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const ordered = preview.checklist.map((c) => c.key).filter((k) => checked.includes(k));
    const now = new Date();
    const col = this.store.collection(taxNoticeAnalyses);
    if (row) await col.updateOne({ id: row.id }, { $set: { chosenType: chosen?.key ?? null, checked: ordered, updatedById: user.id, updatedAt: now } });
    else {
      try {
        await col.insertOne({ noticeId: id, chosenType: chosen?.key ?? null, checked: ordered, updatedById: user.id, updatedAt: now, createdAt: now });
      } catch (e) {
        if (isDuplicateKeyError(e)) throw new DomainError('CHANGED', 'The analysis was saved meanwhile; reload and try again', HttpStatus.CONFLICT);
        throw e;
      }
    }
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'tax_notice.analysis_saved', entityType: 'tax_notice', entityId: id, data: { reference: n.reference, chosenType: chosen?.key ?? null, type: preview.type?.key ?? null, done: ordered.length, total: preview.checklist.length } }));
    return this.get(org, id, today);
  }
}
