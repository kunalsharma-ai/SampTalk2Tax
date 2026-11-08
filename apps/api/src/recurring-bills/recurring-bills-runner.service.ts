import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { RecurringBillsService } from './recurring-bills.service';

const NAME = 'Recurring bills';

/**
 * Makes recurring vendor bills in the background: every RECURRING_BILL_RUNNER_INTERVAL_SECONDS each active
 * recurring bill's runs that have fallen due become bills (see RecurringBillsService.runDue).
 */
@Injectable()
export class RecurringBillsRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RecurringBills');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly bills: RecurringBillsService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.RECURRING_BILL_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Recurring bills are made as runs fall due, checked every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.bills.runAll().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
