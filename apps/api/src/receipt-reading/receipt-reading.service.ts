import { HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { pdfText } from '@talk2tax/accounting-engine';
import { readReceipt, type ReceiptReading } from '@talk2tax/tax-engine';
import { createWorker, type Worker } from 'tesseract.js';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { FileScannerService } from '../files/file-scanner.service';

const MAX_BYTES = 5 * 1024 * 1024; // not money
const MAX_INFLATED = 40 * 1024 * 1024; // not money
const MAX_TEXT = 20_000; // not money
const OCR_TIMEOUT_MS = 60_000; // not money

type Kind = { source: 'PHOTO' | 'PDF'; contentType: string };

/** What a file's first bytes say it is. */
function sniff(bytes: Buffer): Kind | null {
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('\x89PNG')) return { source: 'PHOTO', contentType: 'image/png' };
  if (head.startsWith('\xff\xd8\xff')) return { source: 'PHOTO', contentType: 'image/jpeg' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { source: 'PHOTO', contentType: 'image/webp' };
  if (bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) return { source: 'PDF', contentType: 'application/pdf' };
  return null;
}

export interface ReceiptReadingResult {
  id: string;
  source: 'PHOTO' | 'PDF';
  fileName: string;
  /** How sure the OCR engine was of the characters it read, 0 to 100; null for a PDF's own text. */
  ocrConfidence: number | null;
  text: string;
  reading: ReceiptReading;
}

/**
 * Reads receipts (EXP-004): OCR on photos with Tesseract running inside the API (the English model
 * ships with Talk2Tax, so no receipt leaves the server and no key is needed), or the text layer of a
 * PDF, then picks out the fields with the tax engine's readReceipt. Nothing is stored except the
 * file scan record and an audit event; the reading fills a form the member checks and saves.
 */
@Injectable()
export class ReceiptReadingService implements OnModuleDestroy {
  private readonly logger = new Logger(ReceiptReadingService.name);
  private worker: Promise<Worker> | null = null;
  /** One worker reads one image at a time; later requests wait their turn. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scanner: FileScannerService,
  ) {}

  async onModuleDestroy() {
    const w = this.worker;
    this.worker = null;
    if (w) await (await w).terminate().catch(() => undefined);
  }

  private startWorker(): Promise<Worker> {
    const langPath = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    // Without an errorHandler a failed job is also thrown from the worker's message handler, outside any request.
    const w = createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none', errorHandler: (e: unknown) => this.logger.warn(`OCR could not read an image: ${String(e)}`) });
    w.catch((e) => {
      this.logger.error(`The OCR engine did not start: ${String(e)}`);
      if (this.worker === w) this.worker = null;
    });
    return w;
  }

  private ocr(image: Buffer): Promise<{ text: string; confidence: number }> {
    const run = this.queue.then(async () => {
      this.worker ??= this.startWorker();
      const worker = await this.worker;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DomainError('OCR_TIMEOUT', 'Reading the photo took too long; try a smaller or clearer photo', HttpStatus.UNPROCESSABLE_ENTITY)), OCR_TIMEOUT_MS);
      });
      try {
        const r = await Promise.race([worker.recognize(image), timeout]);
        return { text: r.data.text, confidence: Math.round(r.data.confidence) };
      } catch (e) {
        // A stuck or failed worker is replaced for the next request.
        const stale = this.worker;
        this.worker = null;
        void stale?.then((x) => x.terminate()).catch(() => undefined);
        if (e instanceof DomainError) throw e;
        throw new DomainError('PHOTO_NOT_READABLE', 'The photo could not be read; take it again in good light, flat and in focus', HttpStatus.UNPROCESSABLE_ENTITY);
      } finally {
        clearTimeout(timer);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async read(org: OrgContext, user: AuthUser, fileName: string, content: unknown): Promise<ReceiptReadingResult> {
    // Only a Buffer is accepted, so a tampered body (an array or a string) never reaches the checks below.
    if (typeof content === 'string' || Array.isArray(content) || !Buffer.isBuffer(content) || content.length === 0) throw new DomainError('EMPTY_FILE', 'The file is empty');
    const bytes: Buffer = content;
    if (bytes.length > MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 'Receipts can be at most 5 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    const kind = sniff(bytes);
    if (!kind) throw new DomainError('UNSUPPORTED_FILE', 'Upload a photo (JPEG, PNG or WebP) or a PDF of the receipt', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    const name = fileName.trim().slice(0, 255) || (kind.source === 'PDF' ? 'receipt.pdf' : 'receipt');
    await this.scanner.check({ orgId: org.id, source: 'ATTACHMENT', fileName: name, contentType: kind.contentType, content: bytes, actorId: user.id });

    let text: string;
    let ocrConfidence: number | null = null;
    if (kind.source === 'PDF') {
      const r = pdfText(new Uint8Array(bytes), (d) => inflateSync(d, { maxOutputLength: MAX_INFLATED }));
      if (r.problem) throw new DomainError('NO_TEXT', `${r.problem}. Upload a photo of the receipt instead`, HttpStatus.UNPROCESSABLE_ENTITY);
      text = r.text;
    } else {
      const r = await this.ocr(bytes);
      text = r.text;
      ocrConfidence = r.confidence;
    }
    text = text.split('\u0000').join('').slice(0, MAX_TEXT);
    if (!text.trim()) throw new DomainError('NO_TEXT', 'No text was found on the receipt; take the photo again closer and in good light', HttpStatus.UNPROCESSABLE_ENTITY);

    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    const reading = readReceipt(text, { today: todayIso(), dayFirst: o.countryCode !== 'US' });
    const id = randomUUID();
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: 'receipt.read',
        entityType: 'receipt_reading',
        entityId: id,
        data: {
          source: kind.source,
          fileName: name,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          ocrConfidence,
          merchant: reading.merchant?.value ?? null,
          date: reading.date?.value ?? null,
          total: reading.total?.value ?? null,
          warnings: reading.warnings.length,
        },
      }),
    );
    return { id, source: kind.source, fileName: name, ocrConfidence, text, reading };
  }
}
