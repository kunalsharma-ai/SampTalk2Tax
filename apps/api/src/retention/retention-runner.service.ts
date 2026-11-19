import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { RetentionService } from './retention.service';

const NAME = 'Data retention';

/** Applies every organisation's retention periods every RETENTION_RUNNER_INTERVAL_SECONDS (a day by default). */
@Injectable()
export class RetentionRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Retention');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly retention: RetentionService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.RETENTION_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Data retention periods are applied every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.retention.runAll().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
