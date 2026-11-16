import { Inject, Injectable } from '@nestjs/common';
import { smtpRetryable } from '@talk2tax/accounting-engine';
import { createTransport } from 'nodemailer';
import { AppConfig, CONFIG } from '../config';

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  /** The same on every attempt of one delivery, so a mail system can drop repeats. */
  messageId: string;
  headers?: Record<string, string>;
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

export const EMAIL_NOT_SET_UP = 'Email is not set up on this server (SMTP_URL and EMAIL_FROM)';

/**
 * Sends plain-text email through the SMTP server in SMTP_URL. One connection per message:
 * automations send a few emails a minute at most, and a fresh connection never carries a
 * stale or broken session into the next delivery.
 */
@Injectable()
export class MailerService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get ready(): boolean {
    return !!(this.config.SMTP_URL && this.config.EMAIL_FROM);
  }

  async send(m: EmailMessage): Promise<EmailResult> {
    const started = Date.now();
    if (!this.ready) return { ok: false, status: null, retryable: false, error: EMAIL_NOT_SET_UP, responseSnippet: null, durationMs: 0 };
    const ms = this.config.SMTP_TIMEOUT_SECONDS * 1000;
    const transport = createTransport({ url: this.config.SMTP_URL, connectionTimeout: ms, greetingTimeout: ms, socketTimeout: ms });
    try {
      const info = await transport.sendMail({
        from: this.config.EMAIL_FROM,
        to: m.to,
        subject: m.subject,
        text: m.text,
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
      transport.close();
    }
  }
}
