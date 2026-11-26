import { Injectable } from '@nestjs/common';
import { DocumentStoreService } from '../common/document-store.service';
import { runAsSystem } from '../common/tenant-context';
import { orgRotations } from '../db/collections/org-rotations';
import { organizations } from '../db/collections/tenancy';

/**
 * Thousands of organisations (PERF-001). A background job that visits every organisation in
 * turn keeps when each is next due here, so a pass costs the same however many organisations
 * there are: it reads the few that are due by index, claims each (so two servers never visit the
 * same one at once) and sets when it is due again. New organisations join, and removed ones
 * leave, when the counts differ.
 */
@Injectable()
export class OrgRotationService {
  constructor(private readonly store: DocumentStoreService) {}

  /** Up to `limit` organisations due for `job` at `now`, the longest waiting first, each claimed for `claimSeconds`. */
  async claimDue(job: string, now: Date, limit: number, claimSeconds = 600): Promise<{ orgId: string; lastAt: Date | null }[]> {
    return runAsSystem(async () => {
      await this.sync(job, now);
      const c = this.store.collection(orgRotations);
      const due = await c.find({ job, nextAt: { $lte: now } }, { sort: { nextAt: 1 }, limit });
      const claimed: { orgId: string; lastAt: Date | null }[] = [];
      for (const row of due) {
        // Claimed only if no one moved it on since it was read.
        const r = await c.updateOne({ id: row.id, nextAt: row.nextAt }, { $set: { nextAt: new Date(now.getTime() + claimSeconds * 1000) } });
        if (r.matched === 1) claimed.push({ orgId: row.orgId, lastAt: row.lastAt });
      }
      return claimed;
    });
  }

  /** Sets when an organisation is next due; `visited` records that the job ran for it. */
  async dueAgain(job: string, orgId: string, nextAt: Date, visited: Date | null = null) {
    await runAsSystem(() => this.store.collection(orgRotations).updateOne({ job, orgId }, { $set: { nextAt, ...(visited ? { lastAt: visited } : {}) } }));
  }

  /** How many organisations the job keeps, and how many are due now. */
  async counts(job: string, now = new Date()) {
    return runAsSystem(async () => {
      const c = this.store.collection(orgRotations);
      return { organisations: await c.count({ job }), due: await c.count({ job, nextAt: { $lte: now } }) };
    });
  }

  /** Adds organisations the job does not keep yet (due now) and drops removed ones, only when the counts differ. */
  private async sync(job: string, now: Date) {
    const c = this.store.collection(orgRotations);
    const [orgCount, rowCount] = await Promise.all([this.store.collection(organizations).count({}), c.count({ job })]);
    if (orgCount === rowCount) return;
    const [orgIds, kept] = await Promise.all([this.store.collection(organizations).distinct<string>('id'), c.distinct<string>('orgId', { job })]);
    const known = new Set(kept);
    const missing = orgIds.filter((id) => !known.has(id));
    if (missing.length) {
      try {
        await c.insertMany(missing.map((orgId) => ({ id: `${job}:${orgId}`, job, orgId, nextAt: now, lastAt: null })));
      } catch (e) {
        // Another server added some at the same moment; the rest are added on its next pass.
        if (!/duplicate key|E11000/i.test((e as Error).message)) throw e;
      }
    }
    const live = new Set(orgIds);
    const gone = kept.filter((id) => !live.has(id));
    if (gone.length) await c.deleteMany({ job, orgId: { $in: gone } });
  }
}
