import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { CloseService } from './close.service';

const NAME = 'Month-end close start';

/**
 * Starts month-end closes in the background (WFLOW-021): every CLOSE_RUNNER_INTERVAL_SECONDS,
 * each organisation that turned automatic starting on has the close of the month that ended most
 * recently started, with tasks for open checks if it asked (see CloseService.autoStart).
 */
@Injectable()
export class CloseRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('MonthEndClose');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly close: CloseService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.CLOSE_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Month-end closes start as months end where asked, checked every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.close.autoStartAll().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
