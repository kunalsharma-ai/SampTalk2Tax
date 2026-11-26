import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { dec, extractBill, pdfText, type ExtractedBill } from '@talk2tax/accounting-engine';
import { checkGstin } from '@talk2tax/tax-engine';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { type BillReadingDoc, billReadings, PENDING_READING } from '../db/collections/bill-readings';
import { users } from '../db/collections/identity';
import { documents } from '../db/collections/sales';
import { ExpenseCategorizationService } from '../expense-categorization/expense-categorization.service';
import { FileScannerService } from '../files/file-scanner.service';
import { FileVault, storedBytes } from '../files/file-vault';

const MAX_BYTES = 5 * 1024 * 1024; // not money
const MAX_TEXT = 200_000; // not money
/** A PDF's streams may not inflate past this, so a crafted file cannot exhaust memory. */
const MAX_INFLATED = 40 * 1024 * 1024; // not money
const LIST_LIMIT = 50; // not money
/** How long a worker holds a reading before another may take it. */
const LEASE_MS = 2 * 60_000; // not money
const MAX_ATTEMPTS = 3; // not money
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
const ref = (n: number) => `BR-${String(n).padStart(4, '0')}`;
/** A reading still being read, or that could not be read, cannot be saved or discarded yet. */
function notReadYet(d: Pick<BillReadingDoc, 'status' | 'failure'>) {
  if (PENDING_READING.includes(d.status)) throw new DomainError('NOT_READ_YET', 'The bill is still being read; try again in a moment', HttpStatus.CONFLICT);
  if (d.status === 'FAILED') throw new DomainError('READING_FAILED', d.failure ?? 'The bill could not be read', HttpStatus.CONFLICT);
}
/** A reading has a result once it was read (READ, then SAVED or DISCARDED). */
const hasResult = (d: Pick<BillReadingDoc, 'status'>) => !PENDING_READING.includes(d.status) && d.status !== 'FAILED';

export interface LineSuggestion {
  accountId: string | null;
  accountName: string | null;
  taxRateId: string | null;
}
export type BillReading = ExtractedBill & { suggestions: LineSuggestion[]; duplicateOf: { id: string; number: string | null } | null };

/**
 * The bill reader (AP-025): a supplier's bill from a PDF or pasted text becomes a draft bill.
 * The PDF's text is read and the bill's fields found by the engine (pdf-text.ts and
 * bill-extraction.ts, deterministic: nothing is invented), then accounts and the tax rate are
 * suggested from the vendor's earlier bills and the organisation's rates. Nothing reaches the
 * books until a person reviews it in the bill form and saves it; saving links the reading to
 * the bill and attaches the PDF. Scans and photos have no text to read, which is said in words.
 * purchases.read to see readings; purchases.manage to read a bill and save or discard it.
 */
@Injectable()
export class BillReaderService {
  private readonly logger = new Logger('BillReader');
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
    private readonly vault: FileVault,
    private readonly scanner: FileScannerService,
    private readonly attachments: AttachmentsService,
    private readonly coding: ExpenseCategorizationService,
  ) {}

  /** Reads a PDF uploaded as the request body. */
  async readFile(org: OrgContext, user: AuthUser, fileName: string, content: unknown) {
    // Only a Buffer is accepted, so a tampered body (an array or a string) never reaches the checks below.
    if (typeof content === 'string' || Array.isArray(content) || !Buffer.isBuffer(content) || content.length === 0) throw new DomainError('EMPTY_FILE', 'The file is empty');
    const bytes: Buffer = content;
    if (bytes.length > MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 'Bills can be at most 5 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    const head = bytes.subarray(0, 8).toString('latin1');
    if (head.startsWith('\x89PNG') || head.startsWith('\xff\xd8\xff') || head.startsWith('RIFF')) {
      throw new DomainError('PHOTO_NOT_READABLE', 'Photos have no text to read. Upload the PDF the supplier sent, paste the text of the bill, or enter the bill by hand and attach the photo to it', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new DomainError('UNSUPPORTED_FILE', 'Only PDF bills can be read; paste the text of other bills', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    const name = fileName.trim().slice(0, 255) || 'bill.pdf';
    await this.scanner.check({ orgId: org.id, source: 'ATTACHMENT', fileName: name, contentType: 'application/pdf', content: bytes, actorId: user.id });
    // Reading the PDF's text is the slow part, so it happens in the background (PERF-013): the
    // reading is kept as QUEUED and the answer says so; the worker is woken at once.
    const sealed = this.vault.seal(bytes);
    const number = await this.store.nextTenantSequence('bill_reading');
    const doc = await this.store.collection(billReadings).insertOne({
      number,
      source: 'PDF',
      fileName: name,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content: sealed.content,
      contentKeyId: sealed.contentKeyId,
      text: '',
      pages: 0,
      result: {},
      status: 'QUEUED',
      attempts: 0,
      leaseUntil: null,
      failure: null,
      readAt: null,
      documentId: null,
      attachmentId: null,
      decidedById: null,
      decidedAt: null,
      createdById: user.id,
      createdAt: new Date(),
    });
    await this.log(org, user, 'bill_reading.queued', doc.id, { number: ref(number), source: 'PDF', fileName: name, sha256: doc.sha256 });
    this.wake();
    return this.view(doc);
  }

  // ------------------------------------------------------------------ background reading (PERF-013)

  private wakeHook: (() => void) | null = null;
  /** Set by the runner: asks it to look for waiting readings now. */
  onWake(fn: () => void) {
    this.wakeHook = fn;
  }
  private wake() {
    this.wakeHook?.();
  }

  /**
   * Reads waiting PDFs in every organisation, at most `max`, one at a time. A reading is taken by
   * setting it READING with a lease in one conditional write, so two workers never read the
   * same one; a worker that stops mid-way loses the lease and the reading is taken again. After
   * MAX_ATTEMPTS takes it is FAILED. Returns how many it finished.
   */
  async readWaiting(max = 20): Promise<number> {
    let finished = 0;
    for (let i = 0; i < max; i++) {
      const now = new Date();
      const waiting = { $or: [{ status: 'QUEUED' }, { status: 'READING', leaseUntil: { $lt: now } }] };
      const next = await runAsSystem(() => this.store.collection(billReadings).findOne(waiting, { sort: { createdAt: 1 }, projection: { id: 1, orgId: 1, status: 1, attempts: 1, leaseUntil: 1 } }));
      if (!next) break;
      const attempts = (next.attempts ?? 0) + 1;
      const taken = await runInOrg(next.orgId, () =>
        this.store.collection(billReadings).updateOne({ id: next.id, status: next.status, leaseUntil: next.leaseUntil ?? null }, { $set: { status: 'READING', attempts, leaseUntil: new Date(now.getTime() + LEASE_MS) } }),
      );
      if (taken.matched !== 1) continue; // another worker took it first
      await runInOrg(next.orgId, () => this.readOne(next.id, attempts));
      finished++;
    }
    return finished;
  }

  /** Reads one PDF the worker holds: READ with what was found, FAILED with the reason, or back in the queue after an error. */
  private async readOne(id: string, attempts: number) {
    const d = await this.reading(id);
    const fail = (failure: string) => this.store.collection(billReadings).updateOne({ id, status: 'READING' }, { $set: { status: 'FAILED', failure, leaseUntil: null, readAt: new Date() } });
    try {
      // The audit event is written first, so it is there by the time anyone sees the outcome.
      if (attempts > MAX_ATTEMPTS) {
        await this.logSystem(d, 'bill_reading.failed', { number: ref(d.number), attempts: MAX_ATTEMPTS });
        return fail(`The bill could not be read after ${MAX_ATTEMPTS} tries. Upload it again, paste its text, or enter the bill by hand`);
      }
      const bytes = this.vault.open(storedBytes(d.content!), d.contentKeyId, d.sha256);
      const t = pdfText(new Uint8Array(bytes), (x) => inflateSync(x, { maxOutputLength: MAX_INFLATED }));
      if (t.problem) {
        await this.logSystem(d, 'bill_reading.failed', { number: ref(d.number), reason: 'NO_TEXT', pages: t.pages });
        return fail(t.problem);
      }
      const org = await this.orgOf(d);
      const result = await this.read(org, t.text);
      await this.logSystem(d, 'bill_reading.read', {
        number: ref(d.number),
        source: d.source,
        fileName: d.fileName,
        sha256: d.sha256,
        supplier: result.supplier.name,
        invoiceNumber: result.invoiceNumber.value,
        total: result.total,
        lines: result.lines.length,
        checks: result.checks.length,
      });
      await this.store.collection(billReadings).updateOne(
        { id, status: 'READING' },
        { $set: { status: 'READ', text: t.text.slice(0, MAX_TEXT), pages: t.pages, result: result as unknown as Record<string, unknown>, leaseUntil: null, failure: null, readAt: new Date() } },
      );
    } catch (e) {
      // Another try later; the lease is given back now rather than waited out.
      await this.store
        .collection(billReadings)
        .updateOne({ id, status: 'READING' }, { $set: attempts >= MAX_ATTEMPTS ? { status: 'FAILED', failure: 'The bill could not be read. Upload it again, paste its text, or enter the bill by hand', leaseUntil: null, readAt: new Date() } : { status: 'QUEUED', leaseUntil: null } })
        .catch(() => undefined);
      this.logger.warn(`Bill reading ${ref(d.number)} failed on try ${attempts}: ${(e as Error).message}`);
    }
  }

  /** The organisation as the person who uploaded the bill sees it, for the suggestions. */
  private async orgOf(d: BillReadingDoc): Promise<OrgContext> {
    const [o, m] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: d.orgId }, select: { id: true, functionalCurrency: true, fiscalYearStartMonth: true } }),
      this.prisma.membership.findFirst({ where: { orgId: d.orgId, userId: d.createdById }, select: { role: true } }),
    ]);
    return { id: o.id, functionalCurrency: o.functionalCurrency, fiscalYearStartMonth: o.fiscalYearStartMonth, role: (m?.role ?? 'VIEWER') as OrgContext['role'] };
  }

  private logSystem(d: BillReadingDoc, action: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: d.orgId, actorId: d.createdById, action, entityType: 'bill_reading', entityId: d.id, data }));
  }

  /** Reads the text of a bill, pasted or from a text file. */
  async readText(org: OrgContext, user: AuthUser, text: string, fileName: string | null) {
    const clean = text.split('\u0000').join('').slice(0, MAX_TEXT);
    if (!clean.trim()) throw new DomainError('EMPTY_TEXT', 'Paste the text of the bill');
    return this.record(org, user, { source: 'TEXT', fileName: fileName?.trim().slice(0, 255) || null, bytes: Buffer.from(clean, 'utf8'), text: clean, pages: 0 });
  }

  private async record(org: OrgContext, user: AuthUser, input: { source: 'PDF' | 'TEXT'; fileName: string | null; bytes: Buffer; text: string; pages: number }) {
    const result = await this.read(org, input.text);
    const sealed = input.source === 'PDF' ? this.vault.seal(input.bytes) : null;
    const number = await this.store.nextTenantSequence('bill_reading');
    const doc = await this.store.collection(billReadings).insertOne({
      number,
      source: input.source,
      fileName: input.fileName,
      sizeBytes: input.bytes.length,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      content: sealed?.content ?? null,
      contentKeyId: sealed?.contentKeyId ?? null,
      text: input.text.slice(0, MAX_TEXT),
      pages: input.pages,
      result: result as unknown as Record<string, unknown>,
      status: 'READ',
      documentId: null,
      attachmentId: null,
      decidedById: null,
      decidedAt: null,
      createdById: user.id,
      createdAt: new Date(),
    });
    await this.log(org, user, 'bill_reading.read', doc.id, {
      number: ref(number),
      source: input.source,
      fileName: input.fileName,
      sha256: doc.sha256,
      supplier: result.supplier.name,
      invoiceNumber: result.invoiceNumber.value,
      total: result.total,
      lines: result.lines.length,
      checks: result.checks.length,
    });
    return this.view(doc);
  }

  /** The engine's reading, with GSTIN checks, a duplicate check and suggested accounts and tax rate. */
  private async read(org: OrgContext, text: string): Promise<BillReading> {
    const [vendors, reg, rates] = await Promise.all([
      this.prisma.contact.findMany({ where: { orgId: org.id, isVendor: true }, select: { id: true, name: true, gstin: true, taxId: true } }),
      this.prisma.gstRegistration.findUnique({ where: { orgId: org.id }, select: { gstin: true } }),
      this.prisma.taxRate.findMany({ where: { orgId: org.id, isActive: true }, select: { id: true, name: true, rate: true, kind: true, gstCategory: true } }),
    ]);
    const b = extractBill(text, { vendors: vendors.map((v) => ({ id: v.id, name: v.name, taxId: v.gstin ?? v.taxId })), ownTaxIds: reg ? [reg.gstin] : [], currency: org.functionalCurrency, today: todayIso() });
    const checks = [...b.checks];
    if (b.supplier.taxId) {
      const g = checkGstin(b.supplier.taxId);
      if (!g.valid) checks.unshift(`The supplier's GSTIN ${b.supplier.taxId} on the bill is not valid: ${g.issues.join('; ')}`);
    }
    let duplicateOf: BillReading['duplicateOf'] = null;
    if (b.supplier.contactId && b.invoiceNumber.value) {
      const d = await this.store.collection(documents).findOne({ kind: 'BILL', contactId: b.supplier.contactId, reference: b.invoiceNumber.value, status: { $ne: 'VOID' } }, { projection: { id: 1, number: 1 } });
      if (d) {
        duplicateOf = { id: d.id, number: d.number ?? null };
        checks.unshift(`Bill ${b.invoiceNumber.value} from ${b.supplier.name} is already in the books (${d.number ?? 'a draft'}); check before saving it again`);
      }
    }
    // the organisation's rate for the bill's tax rate, preferring a taxable GST rate
    let taxRateId: string | null = null;
    if (b.taxPercent.value) {
      const want = dec(b.taxPercent.value);
      const same = rates.filter((r) => dec(r.rate.toString()).equals(want));
      taxRateId = (same.find((r) => r.kind === 'GST' && r.gstCategory === 'TAXABLE') ?? same.find((r) => r.kind !== 'GST') ?? same[0])?.id ?? null;
      if (!taxRateId && b.taxTotal && !dec(b.taxTotal).isZero()) checks.push(`No active tax rate of ${b.taxPercent.value}% is set up, so the bill's lines would carry no tax; add one in Settings → Tax rates, or choose the tax on each line`);
    }
    let suggestions: LineSuggestion[] = b.lines.map(() => ({ accountId: null, accountName: null, taxRateId }));
    if (b.supplier.contactId && b.lines.length) {
      const coded = await this.coding.billCoding(org, { contactId: b.supplier.contactId, lines: b.lines.map((l, i) => ({ lineNo: i + 1, description: l.description })) });
      suggestions = coded.lines.map((c) => ({ accountId: c.account?.accountId ?? null, accountName: c.account ? `${c.account.code} ${c.account.name}` : null, taxRateId: taxRateId ?? c.taxRateId }));
    } else if (b.lines.length) {
      suggestions = await Promise.all(
        b.lines.map(async (l) => {
          const s = (await this.coding.forBillLine(org, { description: l.description })).suggestions[0];
          return { accountId: s?.accountId ?? null, accountName: s ? `${s.code} ${s.name}` : null, taxRateId };
        }),
      );
    }
    return { ...b, checks, suggestions, duplicateOf };
  }

  private async view(d: BillReadingDoc) {
    const ids = [d.createdById, d.decidedById].filter((x): x is string => !!x);
    const who = new Map((await this.store.collection(users).find({ id: { $in: ids } })).map((u) => [u.id, u.name]));
    const bill = d.documentId ? await this.store.collection(documents).findById(d.documentId) : null;
    return {
      id: d.id,
      number: ref(d.number),
      source: d.source,
      fileName: d.fileName,
      sizeBytes: d.sizeBytes,
      pages: d.pages,
      text: d.text,
      reading: hasResult(d) ? (d.result as unknown as BillReading) : null,
      status: d.status,
      failure: d.failure ?? null,
      readAt: d.readAt?.toISOString() ?? null,
      bill: bill ? { id: bill.id, number: bill.number ?? null, status: bill.status } : null,
      attachmentId: d.attachmentId,
      createdBy: who.get(d.createdById) ?? 'Former member',
      createdAt: d.createdAt.toISOString(),
      decidedBy: d.decidedById ? (who.get(d.decidedById) ?? 'Former member') : null,
      decidedAt: d.decidedAt?.toISOString() ?? null,
    };
  }

  private async reading(id: string) {
    const d = await this.store.collection(billReadings).findById(id);
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill reading not found' });
    return d;
  }

  async list() {
    const rows = await this.store.collection(billReadings).find({}, { sort: { createdAt: -1 }, limit: LIST_LIMIT, projection: { content: 0, text: 0 } });
    const who = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(rows.map((r) => r.createdById))] } })).map((u) => [u.id, u.name]));
    const bills = new Map((await this.store.collection(documents).find({ id: { $in: rows.map((r) => r.documentId).filter((x): x is string => !!x) } }, { projection: { id: 1, number: 1, status: 1 } })).map((b) => [b.id, b]));
    return rows.map((r) => {
      const res = hasResult(r) ? (r.result as unknown as BillReading) : null;
      const bill = r.documentId ? bills.get(r.documentId) : undefined;
      return {
        id: r.id,
        number: ref(r.number),
        source: r.source,
        fileName: r.fileName,
        supplier: res?.supplier.name ?? null,
        invoiceNumber: res?.invoiceNumber.value ?? null,
        total: res?.total ?? null,
        currency: res?.currency.value ?? null,
        checks: res?.checks.length ?? 0,
        status: r.status,
        failure: r.failure ?? null,
        bill: bill ? { id: bill.id, number: bill.number ?? null } : null,
        createdBy: who.get(r.createdById) ?? 'Former member',
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  async get(id: string) {
    return this.view(await this.reading(id));
  }

  /**
   * Links a reading to the bill a person saved from it (as a draft or posted): attaches the PDF
   * to the bill and records what the person changed from what was read.
   */
  async link(org: OrgContext, user: AuthUser, id: string, documentId: string) {
    const d = await this.reading(id);
    notReadYet(d);
    if (d.status !== 'READ') throw new DomainError('READING_DECIDED', d.status === 'SAVED' ? 'This bill was already saved from this reading' : 'This reading was discarded', HttpStatus.CONFLICT);
    const bill = await this.store.collection(documents).findById(documentId);
    if (!bill || bill.kind !== 'BILL' || bill.status === 'VOID') throw new DomainError('NOT_A_BILL', 'Link the reading to a bill that is in the books', HttpStatus.UNPROCESSABLE_ENTITY);
    const taken = await this.store.collection(billReadings).findOne({ documentId, status: 'SAVED' }, { projection: { id: 1 } });
    if (taken) throw new DomainError('BILL_LINKED', 'That bill was already saved from another reading', HttpStatus.CONFLICT);
    let attachmentId: string | null = null;
    if (d.source === 'PDF' && d.content) {
      const bytes = this.vault.open(storedBytes(d.content), d.contentKeyId, d.sha256);
      try {
        attachmentId = (await this.attachments.upload(org, user, { entityType: 'DOCUMENT', entityId: bill.id, fileName: d.fileName ?? 'bill.pdf', content: bytes })).id;
      } catch (e) {
        // the same file attached by hand first is fine
        if (!(e instanceof DomainError && e.code === 'DUPLICATE_FILE')) throw e;
      }
    }
    const r = d.result as unknown as BillReading;
    const changed: string[] = [];
    if (r.supplier.contactId !== bill.contactId) changed.push('supplier');
    if ((r.invoiceNumber.value ?? null) !== (bill.reference ?? null)) changed.push('bill number');
    if (r.issueDate.value !== day(bill.issueDate)) changed.push('bill date');
    if (r.dueDate.value && r.dueDate.value !== day(bill.dueDate)) changed.push('due date');
    if (r.currency.value !== bill.currency) changed.push('currency');
    if (r.total && !dec(r.total).equals(dec(String(bill.total)))) changed.push('total');
    if (r.lines.length !== bill.lines.length) changed.push('lines');
    const now = new Date();
    const u = await this.store.collection(billReadings).updateOne({ id, status: 'READ' }, { $set: { status: 'SAVED', documentId: bill.id, attachmentId, decidedById: user.id, decidedAt: now } });
    if (!u.matched) throw new DomainError('CHANGED', 'The reading changed meanwhile; reload it', HttpStatus.CONFLICT);
    await this.log(org, user, 'bill_reading.saved', id, { number: ref(d.number), documentId: bill.id, bill: bill.number ?? null, status: bill.status, attachmentId, read: { supplier: r.supplier.name, invoiceNumber: r.invoiceNumber.value, total: r.total }, saved: { reference: bill.reference ?? null, total: String(bill.total) }, changed });
    return this.get(id);
  }

  async discard(org: OrgContext, user: AuthUser, id: string, reason: string) {
    const d = await this.reading(id);
    notReadYet(d);
    if (d.status !== 'READ') throw new DomainError('READING_DECIDED', d.status === 'SAVED' ? 'This bill was already saved from this reading' : 'This reading was already discarded', HttpStatus.CONFLICT);
    const u = await this.store.collection(billReadings).updateOne({ id, status: 'READ' }, { $set: { status: 'DISCARDED', decidedById: user.id, decidedAt: new Date() } });
    if (!u.matched) throw new DomainError('CHANGED', 'The reading changed meanwhile; reload it', HttpStatus.CONFLICT);
    await this.log(org, user, 'bill_reading.discarded', id, { number: ref(d.number), reason: reason.trim() || null });
    return this.get(id);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'bill_reading', entityId, data }));
  }
}
