import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { DocumentValidationError, JournalValidationError, MoneyError, StatementImportError } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import type { Response } from 'express';

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
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(status).json(body);
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
  const m = /(?:ERROR: |message: ")([^"\n]*(?:immutable|does not balance|cannot be deleted|Cannot post|outside its fiscal period|append-only|not postable|at least two lines|header totals|Allocation|settle|Cannot void|different contacts|Bank statement line|Bank match|Reconciliation|needs an approval|Approval|Attachment)[^"\n]*)/.exec(msg);
  return m ? m[1] : null;
}

/** body-parser rejects oversized bodies before Nest sees them; keep that a clear 413 instead of a 500. */
function isBodyTooLarge(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { type?: string }).type === 'entity.too.large';
}
