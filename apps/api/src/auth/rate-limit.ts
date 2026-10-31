import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, OnModuleDestroy, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AppConfig, CONFIG } from '../config';
import { TokensService } from './tokens.service';

export const RATE_LIMIT_BUCKET = 'talk2tax:rateLimitBucket';
export type RateBucket = 'auth' | 'api';

/** Puts a route in the stricter per-IP "auth" bucket (sign-in, register, refresh). */
export const AuthRateLimit = () => SetMetadata(RATE_LIMIT_BUCKET, 'auth' satisfies RateBucket);

const WINDOW_MS = 60_000;

interface Window {
  start: number;
  count: number;
}

/**
 * Fixed one-minute windows held in memory. Each API process counts on its own, so with
 * N instances the effective limit is N times the setting; a shared store (Redis) would
 * be needed to make it exact. Login lockout (LoginThrottleService) is in PostgreSQL and
 * does not have this gap.
 */
export class FixedWindowCounter {
  private readonly windows = new Map<string, Window>();
  hit(key: string, now = Date.now()): { count: number; resetMs: number } {
    let w = this.windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, resetMs: w.start + WINDOW_MS - now };
  }
  sweep(now = Date.now()): void {
    for (const [k, w] of this.windows) if (now - w.start >= WINDOW_MS) this.windows.delete(k);
  }
  get size(): number {
    return this.windows.size;
  }
}

/**
 * Global guard that runs before authentication. Requests are counted per client IP in
 * the "auth" bucket, and per signed-in user (or per IP when no valid token is sent) in
 * the "api" bucket. Over the limit: 429 RATE_LIMITED with Retry-After.
 */
@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly counter = new FixedWindowCounter();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.timer = setInterval(() => this.counter.sweep(), WINDOW_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const bucket = this.reflector.getAllAndOverride<RateBucket | undefined>(RATE_LIMIT_BUCKET, [ctx.getHandler(), ctx.getClass()]) ?? 'api';
    const ip = req.ip ?? 'unknown';
    let key: string;
    let limit: number;
    if (bucket === 'auth') {
      key = `auth:ip:${ip}`;
      limit = this.config.RATE_LIMIT_AUTH_PER_MINUTE;
    } else {
      const header = req.headers['authorization'];
      const claims = typeof header === 'string' && header.startsWith('Bearer ') ? await this.tokens.verifyAccess(header.slice(7)) : null;
      key = claims ? `api:user:${claims.userId}` : `api:ip:${ip}`;
      limit = this.config.RATE_LIMIT_API_PER_MINUTE;
    }
    const { count, resetMs } = this.counter.hit(key);
    const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      throw new HttpException({ error: 'RATE_LIMITED', message: `Too many requests. Try again in ${resetSeconds} seconds.` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
