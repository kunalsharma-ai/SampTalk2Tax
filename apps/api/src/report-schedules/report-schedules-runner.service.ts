import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { ReportSchedulesService } from './report-schedules.service';

const NAME = 'Scheduled reports';

/** Sends scheduled reports that are due (RPT-031), checked every REPORT_SCHEDULE_RUNNER_INTERVAL_SECONDS. */
@Injectable()
export class ReportSchedulesRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ScheduledReports');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly schedules: ReportSchedulesService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.REPORT_SCHEDULE_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Scheduled reports are sent when due, checked every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.schedules.runDueAll().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
