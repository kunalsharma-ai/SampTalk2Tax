import { routePattern } from '@talk2tax/accounting-engine';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { MetricsService } from './metrics.service';

const INCOMING_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Gives every request an id (kept from X-Request-Id when the web server sent a sensible one),
 * returns it in the X-Request-Id header and in error bodies, and times the request for System
 * health under its route pattern (/v1/orgs/:orgId/journals, never the ids themselves).
 */
export function requestContext(metrics: MetricsService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming && INCOMING_ID.test(incoming) ? incoming : randomUUID();
    (req as Request & { requestId: string }).requestId = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const matched = (req as Request & { route?: { path?: string } }).route?.path;
      const route = matched ? `${req.method} ${routePattern(`${req.baseUrl ?? ''}${matched}`)}` : res.statusCode === 404 ? `${req.method} (no route)` : `${req.method} ${routePattern(req.path)}`;
      metrics.record(route, res.statusCode, Math.round(ms * 10) / 10);
    });
    next();
  };
}
