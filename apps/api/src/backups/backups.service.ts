import { Inject, Injectable } from '@nestjs/common';
import { runAsSystem } from '../common/tenant-context';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';

const HOUR = 3_600_000;

/**
 * Backups and restore drills (SEC-021/022) as the backup command recorded them, for the people
 * who run Talk2Tax: the newest good backup and drill, whether either is overdue, and the history.
 */
@Injectable()
export class BackupsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private latest(kind: string) {
    return this.prisma.backupRun.findFirst({ where: { kind, status: 'OK' }, orderBy: { createdAt: 'desc' } });
  }

  /** What needs attention: no good backup or drill within the configured ages. */
  async status(now = new Date()) {
    const [backup, drill] = await runAsSystem(() => Promise.all([this.latest('BACKUP'), this.latest('RESTORE_DRILL')]));
    const backupLimit = this.config.BACKUP_MAX_AGE_HOURS;
    const drillLimit = this.config.RESTORE_DRILL_MAX_AGE_DAYS;
    const backupOverdue = backupLimit > 0 && (!backup || now.getTime() - backup.createdAt.getTime() > backupLimit * HOUR);
    const drillOverdue = drillLimit > 0 && (!drill || now.getTime() - drill.createdAt.getTime() > drillLimit * 24 * HOUR);
    const problems = [
      backupOverdue ? (backup ? `The newest backup is more than ${backupLimit} hours old` : 'No backup has been recorded') : null,
      drillOverdue ? (drill ? `The last restore drill was more than ${drillLimit} days ago` : 'No restore drill has been recorded') : null,
    ].filter((p): p is string => p !== null);
    return {
      limits: { backupMaxAgeHours: backupLimit, restoreDrillMaxAgeDays: drillLimit },
      lastBackup: backup ? { at: backup.createdAt, fileName: backup.fileName, bytes: Number(backup.bytes ?? 0), encrypted: backup.encrypted, documents: backup.documents } : null,
      lastDrill: drill ? { at: drill.createdAt, fileName: drill.fileName, durationMs: drill.durationMs, backupTakenAt: drill.backupTakenAt } : null,
      backupOverdue,
      drillOverdue,
      problems,
    };
  }

  async report(kind?: string) {
    const [status, runs] = await Promise.all([
      this.status(),
      runAsSystem(() => this.prisma.backupRun.findMany({ where: kind ? { kind } : {}, orderBy: { createdAt: 'desc' }, take: 100 })),
    ]);
    return {
      ...status,
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        fileName: r.fileName,
        bytes: r.bytes === null ? null : Number(r.bytes),
        fileSha256: r.fileSha256,
        encrypted: r.encrypted,
        consistent: r.consistent,
        collections: r.collections,
        documents: r.documents,
        backupTakenAt: r.backupTakenAt,
        durationMs: r.durationMs,
        host: r.host,
        error: r.error,
        at: r.createdAt,
      })),
    };
  }
}
