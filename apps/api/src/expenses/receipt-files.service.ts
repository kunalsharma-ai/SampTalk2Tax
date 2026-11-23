import { Injectable } from '@nestjs/common';
import { CLAIMED_FILE_STATUSES, type FileHolder, type SharedReceiptFile, sharedReceiptFiles } from '@talk2tax/accounting-engine';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { attachments } from '../db/collections/sales';

/**
 * The same receipt file claimed twice (EXP-018): files attached to expense claims that are also,
 * byte for byte, on another claim that counts (submitted, approved or reimbursed) or on a supplier
 * bill that is posted. Only current versions of files that were not removed are compared.
 */
@Injectable()
export class ReceiptFilesService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
  ) {}

  async forClaims(orgId: string, claimIds: string[]): Promise<Map<string, SharedReceiptFile[]>> {
    if (!claimIds.length) return new Map();
    // null also matches a file saved before versions existed, which has no replacedById.
    const live = { removedAt: null, replacedById: null } as const;
    const files = await this.store.collection(attachments).find({ entityType: 'EXPENSE_CLAIM', entityId: { $in: claimIds }, ...live }, { projection: { entityId: 1, sha256: 1, fileName: 1, createdAt: 1 }, sort: { createdAt: 1 } });
    if (!files.length) return new Map();
    const same = await this.store.collection(attachments).find(
      { sha256: { $in: [...new Set(files.map((f) => f.sha256))] }, entityType: { $in: ['EXPENSE_CLAIM', 'DOCUMENT'] }, ...live },
      { projection: { entityType: 1, entityId: 1, sha256: 1, createdAt: 1 }, sort: { createdAt: 1 } },
    );
    const claimIdsElsewhere = [...new Set(same.filter((a) => a.entityType === 'EXPENSE_CLAIM').map((a) => a.entityId))];
    const docIds = [...new Set(same.filter((a) => a.entityType === 'DOCUMENT').map((a) => a.entityId))];
    const [claims, bills] = await Promise.all([
      claimIdsElsewhere.length ? this.prisma.expenseClaim.findMany({ where: { orgId, id: { in: claimIdsElsewhere }, status: { in: [...CLAIMED_FILE_STATUSES] } }, select: { id: true, number: true, claimantId: true } }) : [],
      docIds.length ? this.prisma.document.findMany({ where: { orgId, id: { in: docIds }, kind: 'BILL', status: 'POSTED' }, select: { id: true, number: true, contact: { select: { name: true } } } }) : [],
    ]);
    const people = await this.prisma.user.findMany({ where: { id: { in: [...new Set(claims.map((c) => c.claimantId))] } }, select: { id: true, name: true } });
    const claimLabel = new Map(claims.map((c) => [c.id, `${c.number}, ${people.find((p) => p.id === c.claimantId)?.name ?? 'a former member'}`]));
    const billLabel = new Map(bills.map((b) => [b.id, `Bill ${b.number} from ${b.contact.name}`]));
    const holders: FileHolder[] = [];
    for (const a of same) {
      if (a.entityType === 'EXPENSE_CLAIM' && claimLabel.has(a.entityId)) holders.push({ sha256: a.sha256, kind: 'EXPENSE_CLAIM', id: a.entityId, label: claimLabel.get(a.entityId)! });
      if (a.entityType === 'DOCUMENT' && billLabel.has(a.entityId)) holders.push({ sha256: a.sha256, kind: 'BILL', id: a.entityId, label: billLabel.get(a.entityId)! });
    }
    return sharedReceiptFiles(files.map((f) => ({ claimId: f.entityId, sha256: f.sha256, fileName: f.fileName })), holders);
  }
}
