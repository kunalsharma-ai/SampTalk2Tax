import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { clamdScan, clamdVersion } from './clamd';
import { inspectFile } from './inspect';

export type UploadSource = 'ATTACHMENT' | 'TAX_NOTICE' | 'VENDOR_PORTAL';
type Result = 'CLEAN' | 'NOT_SCANNED' | 'INFECTED' | 'ACTIVE_CONTENT' | 'SCAN_FAILED';

const SOURCE_NAMES: Record<UploadSource, string> = { ATTACHMENT: 'Attachments', TAX_NOTICE: 'Tax notices', VENDOR_PORTAL: 'Vendor portal' };

/**
 * Checks every uploaded file before it is kept (SEC-018/019). The type is already known from the
 * file's first bytes (never the browser's claim). Then:
 *  1. Structure: a PDF that can run JavaScript, launch programs, carry other files or submit
 *     forms is refused (see inspect.ts).
 *  2. Malware: with CLAMAV_URL set, the bytes are streamed to ClamAV; a file with a signature is
 *     refused, and so is every file while the scanner cannot answer (fail closed).
 * Each check is recorded in file_scans, and each refused file in the organisation's audit trail.
 * Refused files are not kept.
 */
@Injectable()
export class FileScannerService {
  private readonly url: string | undefined;
  private readonly timeoutMs: number;
  private engine: { version: string; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.url = config.CLAMAV_URL;
    this.timeoutMs = config.CLAMAV_TIMEOUT_SECONDS * 1000;
  }

  /** Throws when the file must not be kept; otherwise records the check. */
  async check(input: { orgId: string; source: UploadSource; fileName: string; contentType: string; content: Buffer; actorId: string | null }): Promise<{ result: 'CLEAN' | 'NOT_SCANNED' }> {
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const record = async (result: Result, detail: string | null, engine: string | null) => {
      await runInOrg(input.orgId, () =>
        this.prisma.$transaction(async (tx) => {
          const row = await tx.fileScan.create({ data: { orgId: input.orgId, source: input.source, fileName: input.fileName.slice(0, 255), contentType: input.contentType, sizeBytes: input.content.length, sha256, result, detail: detail?.slice(0, 255) ?? null, engine, actorId: input.actorId } });
          if (result !== 'CLEAN' && result !== 'NOT_SCANNED') {
            await this.audit.append(tx, { orgId: input.orgId, actorId: input.actorId, action: 'file.refused', entityType: 'file_scan', entityId: row.id, data: { source: input.source, fileName: row.fileName, sha256, result, detail } });
          }
        }),
      );
    };

    const structural = inspectFile(input.content, input.contentType);
    if (structural) {
      await record('ACTIVE_CONTENT', structural.detail, null);
      throw new DomainError('FILE_ACTIVE_CONTENT', `This PDF can run code or carries other files (${structural.detail}), which Talk2Tax does not accept. Print it to a new PDF, or export it again without scripts or attachments, and upload that.`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (!this.url) {
      await record('NOT_SCANNED', null, null);
      return { result: 'NOT_SCANNED' };
    }
    const r = await clamdScan(this.url, input.content, this.timeoutMs);
    const engine = await this.engineVersion();
    if (r.status === 'INFECTED') {
      await record('INFECTED', r.signature, engine);
      throw new DomainError('FILE_INFECTED', `The virus scanner found malware in this file (${r.signature}). It was not saved.`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (r.status === 'ERROR') {
      await record('SCAN_FAILED', r.error, engine);
      throw new DomainError('FILE_SCAN_UNAVAILABLE', 'Files cannot be checked for viruses right now, so this one was not saved. Try again in a few minutes.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    await record('CLEAN', null, engine);
    return { result: 'CLEAN' };
  }

  /** The scanner's version, asked at most every ten minutes. */
  private async engineVersion(): Promise<string | null> {
    if (!this.url) return null;
    if (this.engine && Date.now() - this.engine.at < 600_000) return this.engine.version;
    const v = await clamdVersion(this.url, this.timeoutMs);
    if (!v.ok) return this.engine?.version ?? null;
    this.engine = { version: v.version, at: Date.now() };
    return v.version;
  }

  /** For Platform admin → File scanning: the scanner's state and the last 30 days of checks. */
  async report() {
    const scanner = this.url
      ? await clamdVersion(this.url, Math.min(this.timeoutMs, 5000)).then((v) => (v.ok ? { configured: true, ok: true, version: v.version, error: null } : { configured: true, ok: false, version: null, error: v.error }))
      : { configured: false, ok: false, version: null, error: null };
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await runAsSystem(() => this.prisma.fileScan.findMany({ where: { createdAt: { gte: since } }, select: { result: true, source: true } }));
    const counts: Record<Result, number> = { CLEAN: 0, NOT_SCANNED: 0, INFECTED: 0, ACTIVE_CONTENT: 0, SCAN_FAILED: 0 };
    for (const r of rows) counts[r.result as Result]++;
    const refused = await runAsSystem(() => this.prisma.fileScan.findMany({ where: { result: { in: ['INFECTED', 'ACTIVE_CONTENT', 'SCAN_FAILED'] } }, orderBy: { createdAt: 'desc' }, take: 50 }));
    const orgs = await runAsSystem(() => this.prisma.organization.findMany({ where: { id: { in: [...new Set(refused.map((r) => r.orgId))] } }, select: { id: true, name: true } }));
    const names = new Map(orgs.map((o) => [o.id, o.name]));
    return {
      scanner,
      last30Days: counts,
      refused: refused.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), organisation: names.get(r.orgId) ?? null, source: SOURCE_NAMES[r.source as UploadSource] ?? r.source, fileName: r.fileName, sizeBytes: r.sizeBytes, sha256: r.sha256, result: r.result, detail: r.detail })),
    };
  }
}
