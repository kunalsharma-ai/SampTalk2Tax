import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { ContractsService } from './contracts.service';

const NAME = 'Contract billing';

/**
 * Bills customer contracts in the background: every CONTRACT_RUNNER_INTERVAL_SECONDS each active
 * contract's periods that have fallen due become draft invoices (see ContractsService.billDue).
 */
@Injectable()
export class ContractsRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ContractBilling');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly contracts: ContractsService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.CONTRACT_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Contracts are billed as periods fall due, checked every ${every} s`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  tick() {
    if (!this.inFlight) this.inFlight = this.contracts.runAll().finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
