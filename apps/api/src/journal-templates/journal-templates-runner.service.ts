import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { JournalTemplatesService } from './journal-templates.service';

const NAME = 'Recurring journals';

/**
 * Makes recurring journals in the background: every RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS each
 * active schedule's runs that have fallen due become journals (see JournalTemplatesService.runDue).
 */
@Injectable()
export class JournalTemplatesRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RecurringJournals');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly templates: JournalTemplatesService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Recurring journals are made as runs fall due, checked every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.templates.runAll().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
