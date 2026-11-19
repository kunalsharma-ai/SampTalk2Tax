import type { NextFunction, Request, Response } from 'express';

/**
 * Encryption in transit (SEC-010). With HTTPS_ONLY, a request must have reached Talk2Tax over
 * HTTPS: Express reads the protocol from X-Forwarded-Proto across the trusted proxy hops, so
 * TLS can end at the load balancer or web app in front. The health check is exempt, because
 * load balancers and the container's own check call it directly.
 */
export function httpsOnly() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.secure || req.path === '/health') return next();
    res.status(403).json({ error: 'HTTPS_REQUIRED', message: 'Talk2Tax accepts requests over HTTPS only. Use the https:// address.' });
  };
}
