import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { BillReaderService } from './bill-reader.service';

const NAME = 'Bill reading';

/**
 * Reads uploaded PDF bills in the background (PERF-013): woken by each upload, and every
 * BILL_READER_RUNNER_INTERVAL_SECONDS for readings left by a server that stopped mid-way
 * (see BillReaderService.readWaiting). 0 turns it off, and uploads then wait.
 */
@Injectable()
export class BillReaderRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('BillReading');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly reader: BillReaderService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.BILL_READER_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register(NAME, every);
    if (every > 0) {
      this.reader.onWake(() => void this.tick());
      this.timer = setInterval(() => void this.heartbeats.track(NAME, () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Uploaded bills are read in the background, and waiting ones checked every ${every} s`);
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  /** Reads until nothing waits; a wake while it runs makes it look once more. */
  tick() {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    const run = async () => {
      do {
        this.again = false;
        await this.reader.readWaiting();
      } while (this.again && !this.stopped);
    };
    this.inFlight = run()
      .catch((e: Error) => this.logger.warn(`Reading bills failed: ${e.message}`))
      .finally(() => (this.inFlight = null));
    return this.inFlight;
  }
}
