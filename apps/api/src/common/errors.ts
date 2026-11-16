import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { DocumentValidationError, JournalValidationError, MoneyError, StatementImportError } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import type { Request, Response } from 'express';
import { ErrorsService } from '../operations/errors.service';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

@Catch()
@Injectable()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  constructor(@Optional() private readonly errors?: ErrorsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { requestId?: string; user?: { id: string }; org?: { id: string } }>();
    const { status, body } = this.map(exception);
    const retryAfter = (exception as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
    if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
    // The request id lets a person quote the exact failure to support (System → Errors finds it).
    const requestId = req?.requestId;
    if (status >= 500) {
      this.logger.error(`${requestId ?? '-'} ${exception instanceof Error ? exception.stack : String(exception)}`);
      // An unavailable service (maintenance, a gateway) is expected; only unexpected failures are tracked.
      if (this.errors && requestId && status !== 503) {
        const orgId = req.org?.id ?? (typeof req.params?.orgId === 'string' && /^[0-9a-f-]{36}$/i.test(req.params.orgId) ? req.params.orgId : null);
        void this.errors.record({ error: exception, status, requestId, method: req.method, path: req.originalUrl ?? req.url, orgId, userId: req.user?.id ?? null });
      }
    }
    res.status(status).json(requestId ? { ...body, requestId } : body);
  }

  private map(e: unknown): { status: number; body: Record<string, unknown> } {
    if (e instanceof HttpException) {
      const r = e.getResponse();
      const body = typeof r === 'string' ? { error: 'HTTP_ERROR', message: r } : (r as Record<string, unknown>);
      return { status: e.getStatus(), body: { error: body.error ?? 'HTTP_ERROR', ...body, statusCode: undefined } };
    }
    if (e instanceof DomainError) {
      return { status: e.status, body: { error: e.code, message: e.message, details: e.details } };
    }
    if (e instanceof JournalValidationError) {
      return { status: 422, body: { error: 'JOURNAL_INVALID', message: 'Journal entry is invalid', issues: e.issues } };
    }
    if (e instanceof DocumentValidationError) {
      return { status: 422, body: { error: 'DOCUMENT_INVALID', message: 'Document is invalid', details: { issues: e.issues } } };
    }
    if (e instanceof StatementImportError) {
      return { status: 422, body: { error: 'STATEMENT_INVALID', message: 'The statement file could not be read', details: { issues: e.issues } } };
    }
    if (isBodyTooLarge(e)) {
      return { status: 413, body: { error: 'PAYLOAD_TOO_LARGE', message: 'The request is too large' } };
    }
    if (e instanceof MoneyError) {
      return { status: 422, body: { error: 'INVALID_AMOUNT', message: e.message } };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') return { status: 409, body: { error: 'CONFLICT', message: 'A record with these unique values already exists', target: e.meta?.target } };
      if (e.code === 'P2025') return { status: 404, body: { error: 'NOT_FOUND', message: 'Record not found' } };
      if (e.code === 'P2003') return { status: 409, body: { error: 'REFERENCE_CONFLICT', message: 'Operation would break a reference between records' } };
    }
    const dbMessage = extractDbIntegrityMessage(e);
    if (dbMessage) return { status: 409, body: { error: 'LEDGER_INTEGRITY', message: dbMessage } };
    return { status: 500, body: { error: 'INTERNAL', message: 'Unexpected server error' } };
  }
}

/** Messages raised by the database integrity triggers (SQLSTATE P0001). */
export function extractDbIntegrityMessage(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : '';
  const m = /(?:ERROR: |message: ")([^"\n]*(?:immutable|does not balance|cannot be deleted|Cannot post|outside its fiscal period|append-only|not postable|at least two lines|header totals|Allocation|settle|Cannot void|different contacts|Bank statement line|Bank match|Reconciliation|needs an approval|Approval|Attachment|Invitation|at least one owner|[Bb]udget|[Mm]anagement report|[Aa]lert|[Cc]opilot|[Ff]ixed asset|[Dd]isposed asset|[Dd]epreciation|[Ww]orkflow|[Tt]ask|[Cc]ollections run|[Rr]eminder|draft is written|AI model wrote|AI model proposed|Send attempts|AI reconciliation run|AI bank suggestion|proposed before it is decided|close certification|[Mm]onth-end close|AI close review|adjusting entry|A template keeps|schedule that has run|Runs already made|[Ww]rite-off|type of a posted journal|[Pp]ayment batch|[Bb]ank details|Bank-detail|[Dd]ebit note|[Rr]ecurring bill|payment plan|[Dd]ispute|pro forma invoice|[Pp]urchase order|[Gg]oods receipt|[Gg]oods are received|received line|match acceptance|bill line is billed|bill is matched|milestone is invoiced|progress claim|billing method can no longer|[Rr]etainer|payment link|customer onboarding|vendor review|be reviewed|A review can only|international payment|Usage is never|Recorded usage|Billed usage|Voided usage|meters do not change|A meter keeps|Revenue recognition|customer portal link)[^"\n]*)/.exec(msg);
  return m ? m[1] : null;
}

/** body-parser rejects oversized bodies before Nest sees them; keep that a clear 413 instead of a 500. */
function isBodyTooLarge(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { type?: string }).type === 'entity.too.large';
}
