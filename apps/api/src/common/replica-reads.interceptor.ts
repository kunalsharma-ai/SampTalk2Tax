import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { DocumentStoreService } from './document-store.service';

/** The routes whose reads may go to a replica (PERF-011): report pages, read with GET. */
export function readsFromReplica(method: string, routePath: string | undefined): boolean {
  return method === 'GET' && !!routePath && routePath.startsWith('/v1/orgs/:orgId/reports');
}

/**
 * Read replicas (PERF-011). Runs the handler of a report page with its reads sent to a replica
 * when MONGODB_REPLICA_READS=reports. An interceptor runs after the guards, so sign-in, membership
 * and permission checks always read from the primary; writes and transactions stay there too.
 */
@Injectable()
export class ReplicaReadsInterceptor implements NestInterceptor {
  constructor(private readonly store: DocumentStoreService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { route?: { path?: string } }>();
    if (context.getType() !== 'http' || !readsFromReplica(req.method, `${req.baseUrl ?? ''}${req.route?.path ?? ''}`)) return next.handle();
    // The handler starts when the result is subscribed to, so it is subscribed inside the replica scope.
    return new Observable((subscriber) => this.store.fromReplica(() => next.handle().subscribe(subscriber)));
  }
}
