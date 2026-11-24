import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { pdfText } from '@talk2tax/accounting-engine';
import { readTaxDocument, taxDocumentYear, type TaxDocumentContext, type TaxDocumentReading } from '@talk2tax/tax-engine';
import { AdvanceTaxService } from '../advance-tax/advance-tax.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { taxDocumentReadings, type TaxDocumentReadingDoc } from '../db/collections/tax-document-readings';
import { FileScannerService } from '../files/file-scanner.service';
import { FileVault } from '../files/file-vault';

const MAX_BYTES = 5 * 1024 * 1024; // not money
const MAX_TEXT = 200_000; // not money
const MAX_INFLATED = 40 * 1024 * 1024; // not money
const LIST_LIMIT = 50; // not money
const ref = (n: number) => `TD-${String(n).padStart(4, '0')}`;

export type TaxDocumentView = TaxDocumentReading & { year: string | null; booksTds: string | null };

/**
 * Tax document interpretation (TAX-043): a tax document someone received (TDS certificate, annual
 * tax statement, GST challan, US Form 1099) read from a PDF or pasted text. The engine recognises
 * it, finds its fields with the line each came from, explains it and checks it against the
 * organisation's own PAN, TAN and GSTIN and, for an annual statement, the TDS receivable account
 * for the year. Deterministic: no AI model is used and nothing is guessed. reports.read to see
 * readings; accounts.manage to read a document or mark one reviewed.
 */
@Injectable()
export class TaxDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
    private readonly vault: FileVault,
    private readonly scanner: FileScannerService,
    private readonly advanceTax: AdvanceTaxService,
  ) {}

  async readFile(org: OrgContext, user: AuthUser, fileName: string, content: unknown) {
    // Only a Buffer is accepted, so a tampered body (an array or a string) never reaches the checks below.
    if (typeof content === 'string' || Array.isArray(content) || !Buffer.isBuffer(content) || content.length === 0) throw new DomainError('EMPTY_FILE', 'The file is empty');
    const bytes: Buffer = content;
    if (bytes.length > MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 'Documents can be at most 5 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    const head = bytes.subarray(0, 8).toString('latin1');
    if (head.startsWith('\x89PNG') || head.startsWith('\xff\xd8\xff') || head.startsWith('RIFF'))
      throw new DomainError('PHOTO_NOT_READABLE', 'Photos have no text to read. Download the PDF from the portal, or paste the text of the document', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-'))
      throw new DomainError('UNSUPPORTED_FILE', 'Only PDF documents can be read; paste the text of others', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    const name = fileName.trim().slice(0, 255) || 'document.pdf';
    await this.scanner.check({ orgId: org.id, source: 'ATTACHMENT', fileName: name, contentType: 'application/pdf', content: bytes, actorId: user.id });
    const r = pdfText(new Uint8Array(bytes), (d) => inflateSync(d, { maxOutputLength: MAX_INFLATED }));
    if (r.problem) throw new DomainError('NO_TEXT', r.problem, HttpStatus.UNPROCESSABLE_ENTITY, { pages: r.pages });
    return this.record(org, user, { source: 'PDF', fileName: name, bytes, text: r.text, pages: r.pages });
  }

  async readText(org: OrgContext, user: AuthUser, text: string, fileName: string | null) {
    const clean = text.split('\u0000').join('').slice(0, MAX_TEXT);
    if (!clean.trim()) throw new DomainError('EMPTY_TEXT', 'Paste the text of the document');
    return this.record(org, user, { source: 'TEXT', fileName: fileName?.trim().slice(0, 255) || null, bytes: Buffer.from(clean, 'utf8'), text: clean, pages: 0 });
  }

  /** The organisation's own identifiers, to check a document is addressed to it. */
  private async context(org: OrgContext): Promise<TaxDocumentContext> {
    const [reg, wh] = await Promise.all([
      this.prisma.gstRegistration.findUnique({ where: { orgId: org.id }, select: { gstin: true } }),
      this.prisma.withholdingSettings.findUnique({ where: { orgId: org.id }, select: { tan: true } }),
    ]);
    return { ownGstin: reg?.gstin ?? null, ownPan: reg ? reg.gstin.slice(2, 12) : null, ownTan: wh?.tan ?? null };
  }

  /** TDS in the TDS receivable account for a year, when the advance tax plan names that account (India only). */
  private async booksTds(org: OrgContext, year: string | null) {
    if (!year) return null;
    try {
      const a = await this.advanceTax.get(org, year);
      return a.plan.tdsAccount ? a.credits.tds : null;
    } catch {
      // Not an Indian organisation, or a year the advance tax page does not cover.
      return null;
    }
  }

  private async interpret(org: OrgContext, text: string): Promise<TaxDocumentView> {
    const ctx = await this.context(org);
    const first = readTaxDocument(text, ctx);
    const year = taxDocumentYear(first);
    const booksTds = first.kind === 'ANNUAL_TAX_STATEMENT' ? await this.booksTds(org, year) : null;
    const reading = booksTds === null ? first : readTaxDocument(text, { ...ctx, booksTds });
    return { ...reading, year, booksTds };
  }

  private async record(org: OrgContext, user: AuthUser, input: { source: 'PDF' | 'TEXT'; fileName: string | null; bytes: Buffer; text: string; pages: number }) {
    const result = await this.interpret(org, input.text);
    const sealed = input.source === 'PDF' ? this.vault.seal(input.bytes) : null;
    const number = await this.store.nextTenantSequence('tax_document_reading');
    const doc = await this.store.collection(taxDocumentReadings).insertOne({
      number,
      source: input.source,
      fileName: input.fileName,
      sizeBytes: input.bytes.length,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      content: sealed?.content ?? null,
      contentKeyId: sealed?.contentKeyId ?? null,
      text: input.text.slice(0, MAX_TEXT),
      pages: input.pages,
      kind: result.kind,
      result: result as unknown as Record<string, unknown>,
      status: 'READ',
      reviewNote: null,
      reviewedById: null,
      reviewedAt: null,
      createdById: user.id,
      createdAt: new Date(),
    });
    await this.log(org, user, 'tax_document.read', doc.id, {
      number: ref(number),
      source: input.source,
      fileName: input.fileName,
      sha256: doc.sha256,
      kind: result.kind,
      fields: result.fields.length,
      checks: result.checks.filter((c) => c.level !== 'OK').length,
    });
    return this.view(doc);
  }

  private async view(d: TaxDocumentReadingDoc) {
    const ids = [d.createdById, d.reviewedById].filter((x): x is string => !!x);
    const who = new Map((await this.store.collection(users).find({ id: { $in: ids } })).map((u) => [u.id, u.name]));
    return {
      id: d.id,
      number: ref(d.number),
      source: d.source,
      fileName: d.fileName,
      sizeBytes: d.sizeBytes,
      pages: d.pages,
      text: d.text,
      kind: d.kind,
      reading: d.result as unknown as TaxDocumentView,
      status: d.status,
      reviewNote: d.reviewNote,
      createdBy: who.get(d.createdById) ?? 'Former member',
      createdAt: d.createdAt.toISOString(),
      reviewedBy: d.reviewedById ? (who.get(d.reviewedById) ?? 'Former member') : null,
      reviewedAt: d.reviewedAt?.toISOString() ?? null,
    };
  }

  private async reading(id: string) {
    const d = await this.store.collection(taxDocumentReadings).findById(id);
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Tax document reading not found' });
    return d;
  }

  async list() {
    const rows = await this.store.collection(taxDocumentReadings).find({}, { sort: { createdAt: -1 }, limit: LIST_LIMIT, projection: { content: 0, text: 0 } });
    const who = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(rows.map((r) => r.createdById))] } })).map((u) => [u.id, u.name]));
    return rows.map((r) => {
      const res = r.result as unknown as TaxDocumentView;
      return {
        id: r.id,
        number: ref(r.number),
        source: r.source,
        fileName: r.fileName,
        kind: r.kind,
        title: res.title,
        year: res.year,
        problems: res.checks.filter((c) => c.level !== 'OK').length,
        status: r.status,
        createdBy: who.get(r.createdById) ?? 'Former member',
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  async get(id: string) {
    return this.view(await this.reading(id));
  }

  async review(org: OrgContext, user: AuthUser, id: string, note: string) {
    const d = await this.reading(id);
    if (d.status !== 'READ') throw new DomainError('ALREADY_REVIEWED', 'This document was already marked reviewed', HttpStatus.CONFLICT);
    const u = await this.store
      .collection(taxDocumentReadings)
      .updateOne({ id, status: 'READ' }, { $set: { status: 'REVIEWED', reviewNote: note.trim() || null, reviewedById: user.id, reviewedAt: new Date() } });
    if (!u.matched) throw new DomainError('CHANGED', 'The reading changed meanwhile; reload it', HttpStatus.CONFLICT);
    await this.log(org, user, 'tax_document.reviewed', id, { number: ref(d.number), kind: d.kind, note: note.trim() || null });
    return this.get(id);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'tax_document_reading', entityId, data }));
  }
}
