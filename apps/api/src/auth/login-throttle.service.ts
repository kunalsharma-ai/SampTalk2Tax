import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
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
 * Counts failed sign-ins per email address in PostgreSQL (so every API instance sees
 * the same count). After LOGIN_MAX_FAILURES failures within LOGIN_LOCK_MINUTES the
 * address is locked for LOGIN_LOCK_MINUTES. Unknown addresses are counted the same way,
 * so the answer never reveals whether an account exists.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async assertNotLocked(email: string): Promise<void> {
    const row = await this.prisma.loginThrottle.findUnique({ where: { email }, select: { lockedUntil: true } });
    if (row?.lockedUntil && row.lockedUntil > new Date()) throw this.lockedError(row.lockedUntil);
  }

  /** Records a failure; returns true when this failure locked the address. */
  async recordFailure(email: string): Promise<boolean> {
    const win = `${this.config.LOGIN_LOCK_MINUTES} minutes`;
    const max = this.config.LOGIN_MAX_FAILURES;
    const rows = await this.prisma.$queryRaw<{ failures: number; locked_until: Date | null }[]>`
      INSERT INTO login_throttles (email, failures, first_failure_at, locked_until, updated_at)
      VALUES (${email}, 1, now(), CASE WHEN 1 >= ${max}::int THEN now() + ${win}::interval END, now())
      ON CONFLICT (email) DO UPDATE SET
        failures = CASE WHEN login_throttles.first_failure_at < now() - ${win}::interval THEN 1 ELSE login_throttles.failures + 1 END,
        first_failure_at = CASE WHEN login_throttles.first_failure_at < now() - ${win}::interval THEN now() ELSE login_throttles.first_failure_at END,
        locked_until = CASE
          WHEN (CASE WHEN login_throttles.first_failure_at < now() - ${win}::interval THEN 1 ELSE login_throttles.failures + 1 END) >= ${max}::int
          THEN now() + ${win}::interval
          ELSE NULL END,
        updated_at = now()
      RETURNING failures, locked_until`;
    return rows[0]?.failures === max && rows[0].locked_until !== null;
  }

  async clear(email: string): Promise<void> {
    await this.prisma.loginThrottle.deleteMany({ where: { email } });
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
