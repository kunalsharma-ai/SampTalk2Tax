import { DocumentStoreService } from '../common/document-store.service';
import { organizations } from '../db/collections/tenancy';
import { PostgresMirrorService } from '../db/postgres-mirror.service';
import { HttpException, HttpStatus, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService, withSystemAccess } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';

export interface RegionInfo {
  region: string;
  name: string;
  /** The region's web app, when the directory knows it. */
  appUrl: string | null;
}

/**
 * Regional deployment. One API and its database serve one region (DEPLOYMENT_REGION). Every
 * organisation is tagged with the region it was created in, and only that region's API serves
 * it: a copy found anywhere else (a restored backup, a database moved between regions) is
 * refused with WRONG_REGION and the address of its home region, so the books are never written
 * in two places.
 */
@Injectable()
export class RegionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Regions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
  ) {}

  /** Organisations from before regions existed belong to the first region that serves this database. */
  async onApplicationBootstrap() {
    const claimed = await this.claimUntagged();
    if (claimed) this.logger.log(`Tagged ${claimed} organisation(s) from before regional deployment as ${this.config.DEPLOYMENT_REGION}`);
  }

  async claimUntagged(): Promise<number> {
    const orgs = this.store.collection(organizations);
    const untagged = (await orgs.find({ dataRegion: null }, { projection: { id: 1 } })).map((o) => o.id);
    if (!untagged.length) return 0;
    await orgs.updateMany({ id: { $in: untagged }, dataRegion: null }, { $set: { dataRegion: this.config.DEPLOYMENT_REGION } });
    await this.mirror.organizations(untagged);
    return untagged.length;
  }

  get current(): string {
    return this.config.DEPLOYMENT_REGION;
  }

  /** What this deployment says about itself and the regions it knows. */
  here() {
    const directory = this.config.REGION_DIRECTORY;
    const regions: RegionInfo[] = Object.entries(directory)
      .map(([region, r]) => ({ region, name: r.name, appUrl: r.appUrl }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!directory[this.current]) regions.unshift({ region: this.current, name: this.config.DEPLOYMENT_REGION_NAME, appUrl: null });
    return { region: this.current, name: this.config.DEPLOYMENT_REGION_NAME, regions };
  }

  describe(region: string | null): RegionInfo & { here: boolean } {
    const code = region ?? this.current;
    const here = code === this.current;
    const known = this.config.REGION_DIRECTORY[code];
    return { region: code, name: here ? this.config.DEPLOYMENT_REGION_NAME : (known?.name ?? code), appUrl: known?.appUrl ?? null, here };
  }

  /** Refuses an organisation whose data lives in another region. */
  assertHere(orgRegion: string | null) {
    if (!orgRegion || orgRegion === this.current) return;
    const home = this.describe(orgRegion);
    throw new HttpException(
      {
        error: 'WRONG_REGION',
        message: `This organisation's data is kept in ${home.name}. ${home.appUrl ? `Open it at ${home.appUrl}.` : 'Open it in that region’s Talk2Tax.'}`,
        region: home.region,
        regionName: home.name,
        appUrl: home.appUrl,
      },
      HttpStatus.MISDIRECTED,
    );
  }

  /**
   * Hands an organisation to another region (an operator step, run with `pnpm region:move` on
   * this region's API). From then on this region refuses it and points people to the new one;
   * its data is then copied to that region's database (docs/REGIONAL_DEPLOYMENT.md). Moving it
   * back to this region undoes a move that was not completed.
   */
  async move(orgId: string, to: string, reason: string) {
    if (!/^[a-z0-9-]{2,32}$/.test(to)) throw new DomainError('REGION_INVALID', 'Region codes are 2-32 lowercase letters, digits or dashes', HttpStatus.UNPROCESSABLE_ENTITY);
    if (to !== this.current && !this.config.REGION_DIRECTORY[to]) {
      throw new DomainError('REGION_UNKNOWN', `${to} is not in REGION_DIRECTORY; add it there first so people can be pointed to it`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (!reason.trim()) throw new DomainError('REGION_REASON_REQUIRED', 'Say why the organisation is moving', HttpStatus.UNPROCESSABLE_ENTITY);
    const orgs = this.store.collection(organizations);
    const org = await orgs.findById(orgId);
    if (!org) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
    const from = org.dataRegion ?? this.current;
    if (from === to) throw new DomainError('REGION_UNCHANGED', `${org.name} is already in ${to}`, HttpStatus.CONFLICT);
    if (from !== this.current && to !== this.current) {
      throw new DomainError('REGION_NOT_HERE', `${org.name} lives in ${from}; move it from that region`, HttpStatus.CONFLICT);
    }
    await orgs.updateOne({ id: orgId }, { $set: { dataRegion: to, updatedAt: new Date() } });
    await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        await this.mirror.organizations([orgId], tx);
        await this.audit.append(tx, { orgId, actorId: null, action: 'organization.region_moved', entityType: 'organization', entityId: orgId, data: { from, to, reason: reason.trim(), by: this.current } });
      }),
    );
    return { orgId, name: org.name, from, to };
  }
}
