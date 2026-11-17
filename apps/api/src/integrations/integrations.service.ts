import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { Prisma, type IntegrationKind, type OrgIntegration } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { AnthropicCopilotModel, COPILOT_MODEL, type CopilotModel } from '../copilot/copilot.model';
import { isPublicAddress } from '../workflows/webhook';
import { SecretBox, secretHint } from './secret-box';
import { brandedEmailAttachments, brandedEmailHtml } from '../workflows/branded-email';
import { UsageService } from '../usage/usage.service';

type Actor = { id: string; email: string };
export type Source = 'ORGANISATION' | 'SERVER' | 'NONE';

/** Claude models offered in the AI integration. Any other model id can be typed in. */
export const AI_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (most capable)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (faster, lower cost)' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (fastest, lowest cost)' },
] as const;

export interface AiSettings {
  model: string;
}
export interface EmailSettings {
  host: string;
  port: number;
  security: 'TLS' | 'STARTTLS' | 'NONE';
  username: string | null;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
}

/** What an AI agent should call for one organisation, and where the key came from. */
export interface ResolvedAi {
  model: CopilotModel | null;
  modelName: string;
  source: Source;
}

/** How one organisation's email is sent: its own SMTP server, the server's, or not at all. */
export type ResolvedMail =
  | { source: 'NONE'; from: null }
  | { source: 'ORGANISATION' | 'SERVER'; from: string; replyTo: string | null; transport: () => Promise<Transporter<SMTPTransport.SentMessageInfo>>; timeoutMs: number };

const KIND_PATH: Record<string, IntegrationKind> = { ai: 'AI_ANTHROPIC', email: 'EMAIL_SMTP' };

export function kindFromPath(p: string): IntegrationKind {
  const k = KIND_PATH[p];
  if (!k) throw new DomainError('NOT_FOUND', 'No such integration', HttpStatus.NOT_FOUND);
  return k;
}

/**
 * Integrations an organisation sets up in the app: its own Claude API key and model, and its own
 * SMTP server for email. Secrets are encrypted before they are stored and never returned. Every
 * AI agent and every email sender asks this service, per organisation, what to use: the
 * organisation's own settings when it has turned them on, otherwise the server's environment
 * settings as a fallback, otherwise nothing (and the feature says it is not set up).
 */
@Injectable()
export class IntegrationsService {
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(COPILOT_MODEL) private readonly serverModel: CopilotModel | null,
    private readonly usage: UsageService,
  ) {
    this.box = new SecretBox({ encryptionKey: config.INTEGRATIONS_ENCRYPTION_KEY, jwtSecret: config.JWT_SECRET });
  }

  private row(orgId: string, kind: IntegrationKind) {
    return this.prisma.orgIntegration.findUnique({ where: { orgId_kind: { orgId, kind } } });
  }

  private secretOf(r: OrgIntegration): string | null {
    return r.secretCipher && r.keyId ? this.box.open(r.secretCipher, r.keyId) : null;
  }

  // ------------------------------------------------------------------ resolution, used by every agent and sender

  async ai(orgId: string): Promise<ResolvedAi> {
    const r = await this.row(orgId, 'AI_ANTHROPIC');
    if (r?.enabled) {
      const key = this.secretOf(r);
      const s = r.settings as unknown as AiSettings;
      if (key) {
        const name = s.model || this.config.COPILOT_MODEL;
        return { model: this.usage.metered(orgId, new AnthropicCopilotModel(key, this.config.ANTHROPIC_BASE_URL, name), 'ORGANISATION'), modelName: name, source: 'ORGANISATION' };
      }
    }
    if (this.serverModel) return { model: this.usage.metered(orgId, this.serverModel, 'SERVER'), modelName: this.config.COPILOT_MODEL, source: 'SERVER' };
    return { model: null, modelName: (r?.settings as unknown as AiSettings | undefined)?.model || this.config.COPILOT_MODEL, source: 'NONE' };
  }

  async mail(orgId: string): Promise<ResolvedMail> {
    const timeoutMs = this.config.SMTP_TIMEOUT_SECONDS * 1000;
    const r = await this.row(orgId, 'EMAIL_SMTP');
    if (r?.enabled) {
      const s = r.settings as unknown as EmailSettings;
      const password = r.secretCipher ? this.secretOf(r) : null;
      if (!r.secretCipher || password !== null) {
        return { source: 'ORGANISATION', from: formatFrom(s), replyTo: s.replyTo, timeoutMs, transport: () => this.smtpTransport(s, password, timeoutMs) };
      }
    }
    if (this.config.SMTP_URL && this.config.EMAIL_FROM) {
      const url = this.config.SMTP_URL;
      return { source: 'SERVER', from: this.config.EMAIL_FROM, replyTo: null, timeoutMs, transport: async () => createTransport({ url, connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs }) };
    }
    return { source: 'NONE', from: null };
  }

  /**
   * A connection to an organisation's own mail server. The host is looked up once and the
   * connection made to that address (so a name cannot be pointed somewhere else between the
   * check and the connection); private and loopback addresses are refused on a public server.
   */
  private async smtpTransport(s: EmailSettings, password: string | null, timeoutMs: number) {
    let address = s.host;
    if (!isIP(s.host)) {
      const found = await lookup(s.host, { all: true }).catch(() => [] as { address: string }[]);
      if (!found.length) throw new MailSetupError(`The mail server ${s.host} could not be found`);
      address = found[0]!.address;
      if (!this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS && found.some((a) => !isPublicAddress(a.address))) throw new MailSetupError(`The mail server ${s.host} is on a private network, which this server does not allow`);
    } else if (!this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS && !isPublicAddress(s.host)) {
      throw new MailSetupError(`The mail server ${s.host} is on a private network, which this server does not allow`);
    }
    return createTransport({
      host: address,
      port: s.port,
      secure: s.security === 'TLS',
      requireTLS: s.security === 'STARTTLS',
      ignoreTLS: s.security === 'NONE',
      ...(s.username ? { auth: { user: s.username, pass: password ?? '' } } : {}),
      tls: { servername: isIP(s.host) ? undefined : s.host },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
  }

  // ------------------------------------------------------------------ the settings page

  private async userNames(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  async view(orgId: string) {
    const rows = await this.prisma.orgIntegration.findMany({ where: { orgId } });
    const names = await this.userNames(rows.flatMap((r) => [r.updatedById, r.testedById]));
    const [ai, mail] = await Promise.all([this.ai(orgId), this.mail(orgId)]);
    const card = (kind: IntegrationKind, source: Source, server: boolean) => {
      const r = rows.find((x) => x.kind === kind);
      const unreadable = !!r?.secretCipher && this.secretOf(r) === null;
      return {
        kind,
        configured: !!r,
        enabled: r?.enabled ?? false,
        settings: r?.settings ?? null,
        secretHint: r?.secretHint ?? null,
        secretUnreadable: unreadable,
        testStatus: r?.testStatus ?? 'NOT_TESTED',
        testMessage: r?.testMessage ?? null,
        testedAt: r?.testedAt?.toISOString() ?? null,
        testedBy: r?.testedById ? (names.get(r.testedById) ?? 'Former member') : null,
        updatedAt: r?.updatedAt.toISOString() ?? null,
        updatedBy: r ? (names.get(r.updatedById) ?? 'Former member') : null,
        inUse: source,
        serverFallback: server,
      };
    };
    return {
      ai: { ...card('AI_ANTHROPIC', ai.source, !!this.serverModel), modelInUse: ai.modelName, models: AI_MODELS, defaultModel: this.config.COPILOT_MODEL },
      email: { ...card('EMAIL_SMTP', mail.source, !!(this.config.SMTP_URL && this.config.EMAIL_FROM)), fromInUse: mail.from, allowPlain: this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS },
    };
  }

  async saveAi(orgId: string, actor: Actor, input: { apiKey?: string | null; model: string; enabled: boolean }) {
    return this.save(orgId, actor, 'AI_ANTHROPIC', { model: input.model } satisfies AiSettings, input.apiKey ?? null, input.enabled, true);
  }

  async saveEmail(orgId: string, actor: Actor, input: Omit<EmailSettings, 'username' | 'fromName' | 'replyTo'> & { username?: string | null; fromName?: string | null; replyTo?: string | null; password?: string | null; clearPassword?: boolean; enabled: boolean }) {
    if (input.security === 'NONE' && !this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS) {
      throw new DomainError('VALIDATION_FAILED', 'Choose TLS or STARTTLS: this server does not send email without encryption', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (!this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS && isIP(input.host) && !isPublicAddress(input.host)) {
      throw new DomainError('VALIDATION_FAILED', 'The mail server is on a private network, which this server does not allow', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const settings: EmailSettings = { host: input.host, port: input.port, security: input.security, username: input.username || null, fromAddress: input.fromAddress, fromName: input.fromName || null, replyTo: input.replyTo || null };
    return this.save(orgId, actor, 'EMAIL_SMTP', settings, input.password ?? null, input.enabled, false, !!input.clearPassword);
  }

  /** Saves settings; a new secret replaces the old one, and leaving it empty keeps it. Any change resets the test. */
  private async save(orgId: string, actor: Actor, kind: IntegrationKind, settings: AiSettings | EmailSettings, secret: string | null, enabled: boolean, secretRequired: boolean, clearSecret = false) {
    const before = await this.row(orgId, kind);
    const sealed = secret ? this.box.seal(secret) : null;
    if (secretRequired && !sealed && (!before?.secretCipher || (before && this.secretOf(before) === null))) {
      throw new DomainError('VALIDATION_FAILED', before?.secretCipher ? 'The stored key can no longer be read; enter it again' : 'Enter the API key', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const secretData = sealed ? { secretCipher: sealed.cipher, keyId: sealed.keyId, secretHint: secretHint(secret!) } : clearSecret ? { secretCipher: null, keyId: null, secretHint: null } : {};
    const changed = !before || !!sealed || clearSecret || JSON.stringify(before.settings) !== JSON.stringify(settings);
    const reset = changed ? { testStatus: 'NOT_TESTED' as const, testMessage: null, testedAt: null, testedById: null } : {};
    await this.prisma.$transaction(async (tx) => {
      await tx.orgIntegration.upsert({
        where: { orgId_kind: { orgId, kind } },
        create: { orgId, kind, enabled, settings: settings as unknown as Prisma.InputJsonValue, updatedById: actor.id, ...secretData, ...reset },
        update: { enabled, settings: settings as unknown as Prisma.InputJsonValue, updatedById: actor.id, ...secretData, ...reset },
      });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: before ? 'integration.updated' : 'integration.created',
        entityType: 'integration',
        entityId: kind,
        // Never the secret itself: only whether it changed and its hint.
        data: { kind, enabled, settings: settings as unknown as Prisma.InputJsonValue, secretChanged: !!sealed, secretCleared: clearSecret, secretHint: sealed ? secretHint(secret!) : (before?.secretHint ?? null) },
      });
    });
    return this.view(orgId);
  }

  async remove(orgId: string, actor: Actor, kind: IntegrationKind) {
    const before = await this.row(orgId, kind);
    if (!before) throw new DomainError('NOT_FOUND', 'This integration is not set up', HttpStatus.NOT_FOUND);
    await this.prisma.$transaction(async (tx) => {
      await tx.orgIntegration.delete({ where: { id: before.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'integration.removed', entityType: 'integration', entityId: kind, data: { kind } });
    });
    return this.view(orgId);
  }

  /**
   * Tries the organisation's own settings for real: a one-line request to Claude, or a
   * connection to the mail server followed by a test email to the person testing. The result
   * is kept on the integration and in the audit trail.
   */
  async test(orgId: string, actor: Actor, kind: IntegrationKind) {
    const r = await this.row(orgId, kind);
    if (!r) throw new DomainError('NOT_FOUND', 'Set this integration up before testing it', HttpStatus.NOT_FOUND);
    const outcome = kind === 'AI_ANTHROPIC' ? await this.testAi(r) : await this.testEmail(r, actor);
    await this.prisma.$transaction(async (tx) => {
      await tx.orgIntegration.update({ where: { id: r.id }, data: { testStatus: outcome.ok ? 'OK' : 'FAILED', testMessage: outcome.message.slice(0, 500), testedAt: new Date(), testedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'integration.tested', entityType: 'integration', entityId: kind, data: { kind, ok: outcome.ok, message: outcome.message.slice(0, 500) } });
    });
    return { ok: outcome.ok, message: outcome.message, integrations: await this.view(orgId) };
  }

  private async testAi(r: OrgIntegration): Promise<{ ok: boolean; message: string }> {
    const key = this.secretOf(r);
    if (!key) return { ok: false, message: 'The stored key can no longer be read; enter it again.' };
    const model = (r.settings as unknown as AiSettings).model || this.config.COPILOT_MODEL;
    try {
      const res = await new AnthropicCopilotModel(key, this.config.ANTHROPIC_BASE_URL).send(
        { model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] },
        { signal: AbortSignal.timeout(30_000) },
      );
      return { ok: true, message: `Connected: ${res.model ?? model} answered.` };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return { ok: false, message: 'Anthropic rejected the API key. Check that it is copied in full and still active.' };
      if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, message: `The key works but has no access to ${model}.` };
      if (e instanceof Anthropic.NotFoundError) return { ok: false, message: `The model ${model} was not found. Choose another model.` };
      if (e instanceof Anthropic.RateLimitError) return { ok: false, message: 'The key works, but the account is over its rate or spending limit.' };
      if (e instanceof Anthropic.APIConnectionError) return { ok: false, message: 'Could not reach Anthropic from this server.' };
      return { ok: false, message: `The AI provider answered with an error: ${(e as Error).message}`.slice(0, 500) };
    }
  }

  private async testEmail(r: OrgIntegration, actor: Actor): Promise<{ ok: boolean; message: string }> {
    const s = r.settings as unknown as EmailSettings;
    const password = r.secretCipher ? this.secretOf(r) : null;
    if (r.secretCipher && password === null) return { ok: false, message: 'The stored password can no longer be read; enter it again.' };
    const timeoutMs = this.config.SMTP_TIMEOUT_SECONDS * 1000;
    let transport: Transporter | null = null;
    try {
      transport = await this.smtpTransport(s, password, timeoutMs);
      await transport.verify();
      const subject = 'Talk2Tax: test email';
      const text = `This is a test email from Talk2Tax.\n\nYour organisation's mail server (${s.host}:${s.port}) is set up correctly: reminders and automation emails will be sent through it from ${formatFrom(s)}.`;
      await transport.sendMail({
        from: formatFrom(s),
        ...(s.replyTo ? { replyTo: s.replyTo } : {}),
        to: actor.email,
        subject,
        text,
        html: brandedEmailHtml(text, subject),
        attachments: brandedEmailAttachments(),
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      return { ok: true, message: `Connected to ${s.host}:${s.port} and sent a test email to ${actor.email}.` };
    } catch (e) {
      const err = e as Error & { responseCode?: number; code?: string };
      if (e instanceof MailSetupError) return { ok: false, message: e.message };
      if (err.code === 'EAUTH') return { ok: false, message: 'The mail server refused the username or password.' };
      if (err.code === 'ETIMEDOUT') return { ok: false, message: `No answer from ${s.host}:${s.port} within ${timeoutMs / 1000} seconds.` };
      if (err.code === 'ESOCKET' || err.code === 'ECONNECTION') return { ok: false, message: `Could not connect to ${s.host}:${s.port}: ${err.message}`.slice(0, 500) };
      return { ok: false, message: (err.responseCode ? `The mail server answered ${err.responseCode}: ${err.message}` : `Sending failed: ${err.message}`).slice(0, 500) };
    } finally {
      transport?.close();
    }
  }
}

export class MailSetupError extends Error {}

function formatFrom(s: EmailSettings): string {
  return s.fromName ? `"${s.fromName.replace(/["\\]/g, '')}" <${s.fromAddress}>` : s.fromAddress;
}
