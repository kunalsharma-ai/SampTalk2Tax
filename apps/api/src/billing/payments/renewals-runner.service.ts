import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DunningStage, dunningStage, RENEWAL_NOTICE_DAYS } from '@talk2tax/accounting-engine';
import { PrismaService, withSystemAccess } from '../../common/prisma.service';
import { tenantStorage } from '../../common/tenant-context';
import { AppConfig, CONFIG } from '../../config';
import { HeartbeatsService } from '../../operations/heartbeats.service';
import { MailerService } from '../../workflows/email';
import { BillingService } from '../billing.service';
import { SubscriptionPaymentsService } from './subscription-payments.service';

const DAY = 86_400_000;

const SUBJECT: Record<DunningStage, (org: string) => string> = {
  UPCOMING: (o) => `Your Talk2Tax subscription for ${o} renews soon`,
  DUE: (o) => `Payment due: Talk2Tax subscription for ${o}`,
  FINAL: (o) => `Final reminder: ${o} becomes read-only in 2 days`,
  LAPSED: (o) => `${o} is now read-only on Talk2Tax`,
};

/**
 * Renewals and reminders, in the background. Every BILLING_RUNNER_INTERVAL_SECONDS it issues the
 * renewal invoice for each paid subscription whose period ends within RENEWAL_NOTICE_DAYS (not
 * for a cancelled one), and sends each reminder once per invoice as it falls due: upcoming,
 * due (grace), final, and lapsed (read-only). Reminders go to the organisation's owners and
 * admins through its email set-up; each is recorded in the subscription history either way.
 */
@Injectable()
export class RenewalsRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Renewals');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<{ issued: number; reminded: number }> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: SubscriptionPaymentsService,
    private readonly billing: BillingService,
    private readonly mailer: MailerService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.BILLING_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register('Renewals and reminders', every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track('Renewals and reminders', () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Renewals are issued ${RENEWAL_NOTICE_DAYS} days before a period ends, checked every ${every} s`);
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  /** One pass. For tests: `orgIds` limits it to those organisations and `now` is the time it runs at. */
  tick(opts: { orgIds?: string[]; now?: Date } = {}) {
    if (!this.inFlight) this.inFlight = this.pass(opts.orgIds ?? null, opts.now ?? new Date()).finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async pass(only: string[] | null, now: Date) {
    const due = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.subscription.findMany({
        where: { status: { in: ['ACTIVE', 'CANCELLED'] }, currentPeriodEnd: { lte: new Date(now.getTime() + RENEWAL_NOTICE_DAYS * DAY) }, ...(only ? { orgId: { in: only } } : {}) },
        select: { orgId: true, status: true, currentPeriodEnd: true, org: { select: { name: true } } },
        take: 500,
      }),
    );
    let issued = 0;
    let reminded = 0;
    for (const s of due) {
      try {
        const inv = await tenantStorage.run({ bypass: true }, async () =>
          await this.prisma.$transaction(async (tx) =>
            withSystemAccess(tx, async () => {
              if (s.status !== 'ACTIVE') return null;
              const before = await tx.subscriptionInvoice.count({ where: { orgId: s.orgId } });
              const r = await this.payments.issueRenewal(tx, s.orgId, now);
              if (r && (await tx.subscriptionInvoice.count({ where: { orgId: s.orgId } })) > before) issued++;
              return r;
            }),
          ),
        );
        if (!inv) continue;
        const stage = dunningStage(s.currentPeriodEnd!, now);
        if (stage && (await this.remind(s.orgId, s.org.name, inv.id, inv.reference, inv.total.toFixed(2), inv.currency, stage, s.currentPeriodEnd!))) reminded++;
      } catch (e) {
        this.logger.warn(`Renewal for ${s.orgId} failed: ${(e as Error).message}`);
      }
    }
    return { issued, reminded };
  }

  /** Sends one reminder for an invoice and stage, once. Returns whether it was due now. */
  private async remind(orgId: string, orgName: string, invoiceId: string, reference: string, total: string, currency: string, stage: DunningStage, periodEnd: Date) {
    const kind = `REMINDER_${stage}`;
    const sent = await tenantStorage.run({ bypass: true }, async () => await this.prisma.subscriptionEvent.findFirst({ where: { orgId, kind, data: { path: ['invoice'], equals: reference } } }));
    if (sent) return false;
    const people = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.membership.findMany({ where: { orgId, role: { in: ['OWNER', 'ADMIN'] }, user: { isActive: true } }, select: { user: { select: { email: true } } } }),
    );
    const to = people.map((p) => p.user.email);
    const link = `${this.config.APP_URL.replace(/\/$/, '')}/orgs/${orgId}/settings/subscription`;
    const when = periodEnd.toISOString().slice(0, 10);
    const text = [
      stage === 'UPCOMING' ? `Your Talk2Tax subscription for ${orgName} renews on ${when}.` : stage === 'LAPSED' ? `The renewal for ${orgName} was not paid, so its books are now read-only. Everything stays readable and exportable.` : `The renewal for ${orgName} was due on ${when} and is not paid yet. The books stay open during the 7-day grace period.`,
      '',
      `Amount: ${currency} ${total} (payment request ${reference}).`,
      `Pay or change plan: ${link}`,
    ].join('\n');
    let delivery: { ok: boolean; error: string | null } = { ok: false, error: 'No owners or admins to tell' };
    if (to.length) {
      const r = await this.mailer.send(orgId, { to, subject: SUBJECT[stage](orgName), text, messageId: `<renewal-${invoiceId}-${stage.toLowerCase()}@talk2tax>`, branded: true });
      delivery = { ok: r.ok, error: r.error };
    }
    await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => this.billing.event(tx, orgId, null, kind, { invoice: reference, stage, emailed: delivery.ok, to: delivery.ok ? to.length : 0, error: delivery.error }))),
    );
    return true;
  }
}
