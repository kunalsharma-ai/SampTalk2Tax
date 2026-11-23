import { HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { dec, minorUnits, missingClaimReceipts } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { claimAllowances } from '../db/collections/allowances';
import { expenseCategories } from '../db/collections/expense-categories';
import { expensePolicyRules } from '../db/collections/expense-policy';
import { expenseClaims } from '../db/collections/expenses';
import { receiptRequests } from '../db/collections/receipt-requests';
import { MailerService } from '../workflows/email';

type Actor = { id: string };
const LIVE = ['SUBMITTED', 'APPROVED', 'REIMBURSED'] as const;
/** How soon the same claim's receipt may be asked for again. */
const ASK_AGAIN_HOURS = 24;

/**
 * Missing receipt detection (EXP-021). MongoDB only. Claims that went in without a receipt, why
 * each matters (the policy's "receipt above" amount, a category that always needs one, or simply
 * none attached), and finance asking the claimant for it: recorded, emailed when email is set up,
 * shown on the claim, and answered once a receipt is attached.
 */
@Injectable()
export class MissingReceiptsService {
  private readonly log = new Logger(MissingReceiptsService.name);

  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private async receiptCounts(orgId: string, claimIds: string[]) {
    const rows = claimIds.length ? await this.prisma.attachment.findMany({ where: { orgId, entityType: 'EXPENSE_CLAIM', entityId: { in: claimIds }, removedAt: null }, select: { entityId: true } }) : [];
    const n = new Map<string, number>();
    for (const r of rows) n.set(r.entityId, (n.get(r.entityId) ?? 0) + 1); // not money: a count
    return n;
  }

  /** Claims submitted in the last `days` days that have no receipt, with the requests made for each. */
  async report(org: OrgContext, days: number, today = todayIso()) {
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000); // not money
    const claims = await this.store.collection(expenseClaims).find({ status: { $in: [...LIVE] }, submittedAt: { $gte: since } }, { sort: { submittedAt: 1 } });
    const ids = claims.map((c) => c.id);
    const [counts, allowances, cats, rules, asked] = await Promise.all([
      this.receiptCounts(org.id, ids),
      ids.length ? this.store.collection(claimAllowances).find({ claimId: { $in: ids } }, { projection: { claimId: 1, lineNo: 1 } }) : [],
      this.store.collection(expenseCategories).find({ receipt: 'ALWAYS' }, { projection: { id: 1 } }),
      this.store.collection(expensePolicyRules).find({ isActive: true, kind: 'RECEIPT_ABOVE' }),
      ids.length ? this.store.collection(receiptRequests).find({ claimId: { $in: ids } }, { sort: { requestedAt: -1 } }) : [],
    ]);
    const allowanceLines = new Set(allowances.map((a) => `${a.claimId}#${a.lineNo}`));
    const always = new Set(cats.map((c) => c.id));
    // The lowest "receipt above" amount decides: any line over it needs a receipt.
    const above = rules.map((r) => String(r.amount)).reduce<string | null>((m, a) => (m == null || dec(a).lt(m) ? a : m), null);
    const scale = minorUnits(org.functionalCurrency);
    const r = missingClaimReceipts(
      claims.map((c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        claimantId: c.claimantId,
        status: c.status,
        submittedOn: c.submittedAt!.toISOString().slice(0, 10),
        receiptCount: counts.get(c.id) ?? 0,
        lines: c.lines.map((l) => ({ lineNo: l.lineNo, amount: String(l.amount), isAllowance: allowanceLines.has(`${c.id}#${l.lineNo}`), categoryNeedsReceipt: !!l.categoryId && always.has(l.categoryId) })),
      })),
      { receiptAbove: above, today, scale },
    );
    const people = await this.names([...r.items.map((x) => x.claimantId), ...asked.map((a) => a.requestedById)]);
    const lastAsked = new Map<string, (typeof asked)[number]>();
    for (const a of asked) if (!lastAsked.has(a.claimId)) lastAsked.set(a.claimId, a);
    const askCount = new Map<string, number>();
    for (const a of asked) askCount.set(a.claimId, (askCount.get(a.claimId) ?? 0) + 1); // not money: a count
    return {
      currency: org.functionalCurrency,
      days,
      from: since.toISOString().slice(0, 10),
      to: today,
      receiptAbove: above == null ? null : dec(above).toFixed(scale),
      checked: r.checked,
      missing: r.missing,
      required: r.required,
      amount: r.amount,
      requiredAmount: r.requiredAmount,
      canAsk: hasPermission(org.role, 'expenses.reimburse'),
      items: r.items.map((x) => {
        const last = lastAsked.get(x.id);
        return { ...x, claimant: people.get(x.claimantId) ?? null, asked: last ? { at: last.requestedAt.toISOString(), by: people.get(last.requestedById) ?? null, times: askCount.get(x.id) ?? 1, emailed: last.emailed } : null };
      }),
      byClaimant: r.byClaimant.map((p) => ({ ...p, claimant: people.get(p.claimantId) ?? null })),
    };
  }

  private async names(ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private async claim(org: OrgContext, actor: Actor, claimId: string) {
    const c = await this.store.collection(expenseClaims).findById(claimId);
    if (!c || (c.claimantId !== actor.id && !hasPermission(org.role, 'expenses.read'))) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense claim not found' });
    return c;
  }

  /** Finance asks the claimant for the receipt; emailed to them when email is set up. */
  async ask(org: OrgContext, actor: Actor, claimId: string, note: string | null) {
    const c = await this.claim(org, actor, claimId);
    if (!(LIVE as readonly string[]).includes(c.status)) throw new DomainError('NOT_SUBMITTED', 'Only a submitted, approved or reimbursed claim can be asked about', HttpStatus.CONFLICT);
    if (c.claimantId === actor.id) throw new DomainError('OWN_CLAIM', 'You cannot ask yourself for a receipt', HttpStatus.UNPROCESSABLE_ENTITY);
    if ((await this.receiptCounts(org.id, [c.id])).get(c.id)) throw new DomainError('HAS_RECEIPT', 'The claim already has a receipt attached', HttpStatus.CONFLICT);
    const last = (await this.store.collection(receiptRequests).find({ claimId }, { sort: { requestedAt: -1 }, limit: 1 }))[0];
    if (last && Date.now() - last.requestedAt.getTime() < ASK_AGAIN_HOURS * 3_600_000) {
      throw new DomainError('ASKED_RECENTLY', `The receipt was already asked for in the last ${ASK_AGAIN_HOURS} hours`, HttpStatus.CONFLICT);
    }
    const [claimant, asker] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: c.claimantId }, select: { email: true, name: true } }),
      this.prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }),
    ]);
    const clean = note?.trim() || null;
    let emailed: boolean | null = null;
    let emailError: string | null = null;
    if (claimant && (await this.mailer.status(org.id)).ready) {
      const link = `${this.config.APP_URL.replace(/\/$/, '')}/orgs/${org.id}/expenses/${c.id}`;
      const res = await this.mailer.send(org.id, {
        to: [claimant.email],
        subject: `Receipt needed for expense claim ${c.number}`,
        text: `Hello ${claimant.name},\n\n${asker?.name ?? 'Finance'} asked for the receipt for your expense claim ${c.number} (${c.title}), which has none attached.${clean ? `\n\n${clean}` : ''}\n\nAttach a photo or PDF of the receipt on the claim: ${link}\n`,
        messageId: `<receipt-request-${c.id}-${Date.now()}@talk2tax>`,
        context: { source: 'OTHER', approvedByPerson: true },
      });
      emailed = res.ok;
      emailError = res.ok ? null : (res.error ?? 'Not sent');
      if (!res.ok) this.log.warn(`Receipt request for ${c.number} not emailed: ${emailError}`);
    }
    const doc = await this.store.collection(receiptRequests).insertOne({ orgId: org.id, claimId: c.id, claimantId: c.claimantId, note: clean, requestedById: actor.id, requestedAt: new Date(), emailed, emailError });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'expense_claim.receipt_requested', entityType: 'expense_claim', entityId: c.id, data: { number: c.number, requestId: doc.id, note: clean, emailed, emailError } }));
    return this.requests(org, actor, claimId);
  }

  /** The requests made on a claim, for the claimant and finance; answered once a receipt is attached. */
  async requests(org: OrgContext, actor: Actor, claimId: string) {
    const c = await this.claim(org, actor, claimId);
    const rows = await this.store.collection(receiptRequests).find({ claimId }, { sort: { requestedAt: -1 } });
    const names = await this.names(rows.map((r) => r.requestedById));
    const receipts = (await this.receiptCounts(org.id, [c.id])).get(c.id) ?? 0;
    return {
      answered: receipts > 0,
      requests: rows.map((r) => ({ id: r.id, at: r.requestedAt.toISOString(), by: names.get(r.requestedById) ?? null, note: r.note, emailed: r.emailed, emailError: hasPermission(org.role, 'expenses.read') ? r.emailError : null })),
    };
  }
}
