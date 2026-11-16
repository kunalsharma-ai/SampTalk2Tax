import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { CrmWebhooksService } from './crm-webhooks.service';

const NAME = 'CRM webhooks';

/**
 * Sends CRM events to webhooks in the background: every CRM_WEBHOOK_RUNNER_INTERVAL_SECONDS new
 * audit events become deliveries and due deliveries are sent (see CrmWebhooksService.tick).
 */
@Injectable()
export class CrmWebhooksRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CrmWebhooksRunner');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly hooks: CrmWebhooksService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.CRM_WEBHOOK_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`CRM events are sent to webhooks, checked every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.hooks.tick().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
