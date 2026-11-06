import { Injectable } from '@nestjs/common';
import { PrismaService, withSystemAccess } from '../common/prisma.service';

/**
 * The check behind controlled support access (ADMIN-022): a person who runs Talk2Tax may
 * read an organisation's books only while that organisation has an unexpired, unrevoked
 * grant. Called by the auth guard before any tenant context exists, so it reads with system
 * access, for this lookup only.
 */
@Injectable()
export class SupportAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async activeGrant(orgId: string, now = new Date()) {
    return this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const grant = await tx.supportAccessGrant.findFirst({
          where: { orgId, revokedAt: null, expiresAt: { gt: now } },
          orderBy: { expiresAt: 'desc' },
          select: { id: true, expiresAt: true },
        });
        if (!grant) return null;
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { functionalCurrency: true, fiscalYearStartMonth: true, dataRegion: true },
        });
        return org ? { grant, org } : null;
      }),
    );
  }

  /** One row per request made under a grant; the organisation sees them under Support → Support access. */
  async logView(grantId: string, orgId: string, userId: string, path: string) {
    await this.prisma.supportAccessView.create({ data: { grantId, orgId, userId, path: path.slice(0, 500) } });
  }
}
