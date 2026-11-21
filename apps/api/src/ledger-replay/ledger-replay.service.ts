import { HttpStatus, Injectable } from '@nestjs/common';
import { D, replayComparison, replayIssue, replaySummary } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { journalEntries } from '../db/collections/ledger';
import { lineSums } from '../db/ledger-queries';

const MAX_CHANGES = 200;

/**
 * Financial transaction replay (AUDIT-017). Replays the posted ledger as it stood at a past
 * moment, for entries dated up to a cut-off, and sets it beside the ledger now for the same
 * dates, with every entry posted since that explains the difference. Read-only; each replay is
 * audited. Needs audit.read.
 */
@Injectable()
export class LedgerReplayService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async replay(org: OrgContext, user: AuthUser, q: { asOf: string; through: string }) {
    const asOf = new Date(q.asOf);
    const issue = replayIssue(asOf, q.through, new Date());
    if (issue) throw new DomainError('INVALID_REPLAY', issue, HttpStatus.UNPROCESSABLE_ENTITY);
    const through = toDbDate(q.through);
    const by = { accountId: 'lines.accountId' };
    const [then, now] = await Promise.all([
      lineSums(this.store, org.id, { entry: { status: 'POSTED', date: { $lte: through }, postedAt: { $lte: asOf } }, by }),
      lineSums(this.store, org.id, { entry: { status: 'POSTED', date: { $lte: through } }, by }),
    ]);
    const sums = (list: typeof then) => list.map((r) => ({ accountId: String(r.key.accountId), debit: r.debit.toFixed(), credit: r.credit.toFixed() }));
    const chart = new Map((await this.store.collection(accounts).find({})).map((a) => [a.id, a]));
    const code = (id: string) => chart.get(id)?.code ?? id;
    const rows = replayComparison(sums(then), sums(now), (a, b) => code(a).localeCompare(code(b)));
    const since = await this.store.collection(journalEntries).find({ status: 'POSTED', date: { $lte: through }, postedAt: { $gt: asOf } }, { sort: { postedAt: 1 }, limit: MAX_CHANGES + 1 });
    const total = await this.store.collection(journalEntries).count({ status: 'POSTED', date: { $lte: through }, postedAt: { $gt: asOf } });
    const people = [...new Set(since.slice(0, MAX_CHANGES).map((e) => e.postedById).filter((x): x is string => !!x))];
    const names = new Map((people.length ? await this.store.collection(users).find({ id: { $in: people } }) : []).map((u) => [u.id, u.name ?? u.email]));
    const reversed = new Map((await this.store.collection(journalEntries).find({ id: { $in: since.map((e) => e.reversesEntryId).filter((x): x is string => !!x) } })).map((e) => [e.id, e.entryNumber]));
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'ledger.replayed', entityType: 'organization', entityId: org.id, data: { asOf: asOf.toISOString(), through: q.through, entriesSince: total } }));
    return {
      asOf: asOf.toISOString(),
      through: q.through,
      summary: { ...replaySummary(rows), entriesSince: total },
      accounts: rows.map((r) => ({ ...r, code: code(r.accountId), name: chart.get(r.accountId)?.name ?? 'Unknown account' })),
      entriesSince: since.slice(0, MAX_CHANGES).map((e) => ({
        id: e.id,
        entryNumber: e.entryNumber,
        date: fromDbDate(e.date),
        postedAt: e.postedAt!.toISOString(),
        postedBy: e.postedById ? (names.get(e.postedById) ?? 'A former member') : null,
        source: e.source,
        memo: e.memo,
        amount: new D(String(e.totalDebit)).toFixed(2),
        reverses: e.reversesEntryId ? { id: e.reversesEntryId, entryNumber: reversed.get(e.reversesEntryId) ?? null } : null,
        accounts: [...new Set(e.lines.map((l) => code(l.accountId)))],
      })),
      moreEntries: total > MAX_CHANGES,
    };
  }
}
