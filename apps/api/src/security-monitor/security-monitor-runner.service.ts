import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { SecurityMonitorService } from './security-monitor.service';

const NAME = 'Security monitor';

/** Checks the audit trail for security alerts every SECURITY_MONITOR_INTERVAL_SECONDS (five minutes by default). */
@Injectable()
export class SecurityMonitorRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SecurityMonitor');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly monitor: SecurityMonitorService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.SECURITY_MONITOR_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`The audit trail is checked for security alerts every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.monitor.scan().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
