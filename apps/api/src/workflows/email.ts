import { Injectable } from '@nestjs/common';
import { smtpRetryable } from '@talk2tax/accounting-engine';
import { IntegrationsService, MailSetupError } from '../integrations/integrations.service';
import { brandedEmailAttachments, brandedEmailHtml } from './branded-email';

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  /** The same on every attempt of one delivery, so a mail system can drop repeats. */
  messageId: string;
  headers?: Record<string, string>;
  /**
   * Talk2Tax's own messages (support replies, subscription reminders) also carry an HTML version
   * under the Talk2Tax logo. Leave it off for anything an organisation sends in its own name.
   */
  branded?: boolean;
}

export interface EmailResult {
  ok: boolean;
  /** The SMTP reply code of the answer that decided the result; null when no answer came. */
  status: number | null;
  /** Whether a failure is worth trying again (no answer, or a 4xx answer). */
  retryable: boolean;
  error: string | null;
  /** The server's answer, cut to 500 characters. */
  responseSnippet: string | null;
  durationMs: number;
}

export const EMAIL_NOT_SET_UP = 'Email is not set up: an owner or admin can add a mail server in Settings → Integrations';

/**
 * Sends email for one organisation (plain text, plus a branded HTML version for Talk2Tax's own messages), through its own mail server (Settings →
 * Integrations) or else the server's SMTP_URL. One connection per message: automations and
 * reminders send a few emails a minute at most, and a fresh connection never carries a stale or
 * broken session into the next delivery.
 */
@Injectable()
export class MailerService {
  constructor(private readonly integrations: IntegrationsService) {}

  /** Whether this organisation can send email, from which address, and whose server is used. */
  async status(orgId: string): Promise<{ ready: boolean; from: string | null; source: 'ORGANISATION' | 'SERVER' | 'NONE' }> {
    const m = await this.integrations.mail(orgId);
    return { ready: m.source !== 'NONE', from: m.from, source: m.source };
  }

  async send(orgId: string, m: EmailMessage): Promise<EmailResult> {
    const started = Date.now();
    const mail = await this.integrations.mail(orgId);
    if (mail.source === 'NONE') return { ok: false, status: null, retryable: false, error: EMAIL_NOT_SET_UP, responseSnippet: null, durationMs: 0 };
    const ms = mail.timeoutMs;
    let transport: Awaited<ReturnType<typeof mail.transport>> | null = null;
    try {
      transport = await mail.transport();
      const info = await transport.sendMail({
        from: mail.from,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        to: m.to,
        subject: m.subject,
        text: m.text,
        ...(m.branded ? { html: brandedEmailHtml(m.text, m.subject), attachments: brandedEmailAttachments() } : {}),
        messageId: m.messageId,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All', ...m.headers },
      });
      const rejected = (info.rejected ?? []).map(String);
      const response = String(info.response ?? '').slice(0, 500) || null;
      if (rejected.length) {
        // Some addresses were refused and the rest accepted: the message went, so it is not sent again.
        return { ok: true, status: 250, retryable: false, error: null, responseSnippet: `Refused: ${rejected.join(', ')}. ${response ?? ''}`.slice(0, 500), durationMs: Date.now() - started };
      }
      return { ok: true, status: Number(/^\d{3}/.exec(response ?? '')?.[0] ?? 250), retryable: false, error: null, responseSnippet: response, durationMs: Date.now() - started };
    } catch (e) {
      if (e instanceof MailSetupError) return { ok: false, status: null, retryable: false, error: e.message, responseSnippet: null, durationMs: Date.now() - started };
      const err = e as Error & { responseCode?: number; response?: string; code?: string };
      const status = typeof err.responseCode === 'number' ? err.responseCode : null;
      const timedOut = err.code === 'ETIMEDOUT';
      return {
        ok: false,
        status,
        retryable: smtpRetryable(status),
        error: (timedOut ? `No answer within ${ms / 1000} seconds` : status ? `The mail server answered ${status}` : `Could not reach the mail server: ${err.message}`).slice(0, 1000),
        responseSnippet: err.response ? String(err.response).slice(0, 500) : null,
        durationMs: Date.now() - started,
      };
    } finally {
      transport?.close();
    }
  }
}
