import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DocumentStoreService } from '../common/document-store.service';
import { loginThrottles } from '../db/collections/identity';
import { AppConfig, CONFIG } from '../config';

/** Thrown for a locked address. Carries Retry-After for the response. */
export class TooManyAttemptsError extends HttpException {
  constructor(
    public readonly retryAfterSeconds: number,
    body: { error: string; message: string },
  ) {
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Counts failed sign-ins per email address in MongoDB (so every API instance sees the
 * same count). After LOGIN_MAX_FAILURES failures within LOGIN_LOCK_MINUTES the address is
 * locked for LOGIN_LOCK_MINUTES. Unknown addresses are counted the same way, so the answer
 * never reveals whether an account exists.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    private readonly store: DocumentStoreService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async assertNotLocked(email: string): Promise<void> {
    const row = await this.store.collection(loginThrottles).findById(email);
    if (row?.lockedUntil && row.lockedUntil > new Date()) throw this.lockedError(row.lockedUntil);
  }

  /**
   * Records a failure; returns true when this failure locked the address. Read and write
   * happen in one transaction: two failures at the same moment conflict and one is retried,
   * so neither is lost.
   */
  async recordFailure(email: string): Promise<boolean> {
    const windowMs = this.config.LOGIN_LOCK_MINUTES * 60_000;
    const max = this.config.LOGIN_MAX_FAILURES;
    return this.store.transaction(async () => {
      const c = this.store.collection(loginThrottles);
      const row = await c.findById(email);
      const now = new Date();
      const fresh = !row || row.firstFailureAt.getTime() < now.getTime() - windowMs;
      const failures = fresh ? 1 : row.failures + 1;
      const lockedUntil = failures >= max ? new Date(now.getTime() + windowMs) : null;
      await c.updateOne(
        { id: email },
        { $set: { failures, firstFailureAt: fresh ? now : row.firstFailureAt, lockedUntil, updatedAt: now } },
        { upsert: true },
      );
      return failures === max && lockedUntil !== null;
    });
  }

  async clear(email: string): Promise<void> {
    await this.store.collection(loginThrottles).deleteMany({ id: email });
  }

  lockedError(until: Date): TooManyAttemptsError {
    const seconds = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
    const minutes = Math.ceil(seconds / 60);
    return new TooManyAttemptsError(seconds, {
      error: 'TOO_MANY_ATTEMPTS',
      message: `Too many failed sign-ins for this email. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    });
  }
}
