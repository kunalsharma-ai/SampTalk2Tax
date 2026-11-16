import { HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { crmActionsFor, crmEventFor, CRM_WEBHOOK_EVENT_NAMES, CRM_WEBHOOK_EVENTS, nextWebhookAttempt, type CrmWebhookEvent } from '@talk2tax/accounting-engine';
import type { CrmWebhook } from '@talk2tax/database';
import type { RoleName } from '@talk2tax/security';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, mirrorRows } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { ContactsService } from '../contacts/contacts.service';
import { CrmService } from '../crm/crm.service';
import { SecretBox, secretHint } from '../integrations/secret-box';
import { checkWebhookUrl, sendWebhook, signPayload, SIGNATURE_HEADER, WebhookAddressError, type WebhookResult } from '../workflows/webhook';

type Actor = { id: string };
type Org = { id: string; role: RoleName; functionalCurrency: string; fiscalYearStartMonth?: number };
export interface WebhookInput {
  name: string;
  url: string;
  events: CrmWebhookEvent[];
  enabled?: boolean;
}

/** Audit events read for one webhook in one pass. */
const EVENT_BATCH = 200;
/** Deliveries sent in one pass. */
const DELIVERY_BATCH = 50;
/** How long a claimed delivery is held before another pass may try it (if this one died). */
const LEASE_SECONDS = 300;

/**
 * Webhooks for an external CRM: which events go where, the signed deliveries, and the background
 * pass that turns new audit events into deliveries and sends the ones that are due.
 */
@Injectable()
export class CrmWebhooksService {
  private readonly logger = new Logger('CrmWebhooks');
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crm: CrmService,
    private readonly contacts: ContactsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox({ encryptionKey: config.INTEGRATIONS_ENCRYPTION_KEY, jwtSecret: config.JWT_SECRET });
  }

  // ------------------------------------------------------------------ settings

  private checkInput(input: WebhookInput) {
    try {
      checkWebhookUrl(input.url, this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    } catch (e) {
      if (e instanceof WebhookAddressError) throw new DomainError('WEBHOOK_URL', e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
    const events = [...new Set(input.events)].filter((e) => CRM_WEBHOOK_EVENT_NAMES.includes(e));
    if (!events.length) throw new DomainError('WEBHOOK_EVENTS', 'Choose at least one event to send', HttpStatus.UNPROCESSABLE_ENTITY);
    return { name: input.name.trim(), url: input.url.trim(), events: CRM_WEBHOOK_EVENT_NAMES.filter((e) => events.includes(e)) };
  }

  private newSecret() {
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const sealed = this.box.seal(secret);
    return { secret, secretCipher: sealed.cipher, secretKeyId: sealed.keyId, secretHint: secretHint(secret) };
  }

  private async view(w: CrmWebhook) {
    const [counts, last] = await Promise.all([
      this.prisma.crmWebhookDelivery.groupBy({ by: ['status'], where: { orgId: w.orgId, webhookId: w.id }, _count: { _all: true } }),
      this.prisma.crmWebhookDelivery.findFirst({ where: { orgId: w.orgId, webhookId: w.id, status: { not: 'PENDING' } }, orderBy: { finishedAt: 'desc' }, select: { status: true, finishedAt: true, lastStatusCode: true, lastError: true } }),
    ]);
    const n = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    return {
      id: w.id,
      name: w.name,
      url: w.url,
      events: w.events,
      enabled: w.enabled,
      secretHint: w.secretHint,
      secretUsable: this.box.open(w.secretCipher, w.secretKeyId) !== null,
      deliveries: { pending: n('PENDING'), succeeded: n('SUCCEEDED'), failed: n('FAILED') },
      lastDelivery: last ? { status: last.status, at: last.finishedAt?.toISOString() ?? null, statusCode: last.lastStatusCode, error: last.lastError } : null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  async list(orgId: string) {
    const hooks = await this.prisma.crmWebhook.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    return {
      webhooks: await Promise.all(hooks.map((w) => this.view(w))),
      events: CRM_WEBHOOK_EVENT_NAMES.map((e) => ({ event: e, label: CRM_WEBHOOK_EVENTS[e].label })),
      signatureHeader: SIGNATURE_HEADER,
    };
  }

  private async find(db: Pick<Tx, 'crmWebhook'>, orgId: string, id: string) {
    const w = await db.crmWebhook.findFirst({ where: { id, orgId } });
    if (!w) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Webhook not found' });
    return w;
  }

  /** A new webhook. Its signing secret is returned only here (and on rotation). Only events after now are sent. */
  async create(orgId: string, actor: Actor, input: WebhookInput) {
    const v = this.checkInput(input);
    const s = this.newSecret();
    const w = await this.prisma.$transaction(async (tx) => {
      const hi = (await tx.auditEvent.aggregate({ where: { orgId }, _max: { id: true } }))._max.id ?? 0n;
      const row = await tx.crmWebhook.create({ data: { orgId, ...v, enabled: input.enabled ?? true, secretCipher: s.secretCipher, secretKeyId: s.secretKeyId, secretHint: s.secretHint, lastEventId: hi, createdById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'crm_webhook.created', entityType: 'crm_webhook', entityId: row.id, data: { name: v.name, url: v.url, events: v.events } });
      return row;
    });
    return { ...(await this.view(w)), secret: s.secret };
  }

  async update(orgId: string, actor: Actor, id: string, input: WebhookInput) {
    const v = this.checkInput(input);
    const w = await this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, orgId, id);
      const enabled = input.enabled ?? before.enabled;
      // Turned back on: events from while it was off are not sent afterwards.
      const lastEventId = !before.enabled && enabled ? ((await tx.auditEvent.aggregate({ where: { orgId }, _max: { id: true } }))._max.id ?? before.lastEventId) : before.lastEventId;
      const row = await tx.crmWebhook.update({ where: { id }, data: { ...v, enabled, lastEventId } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'crm_webhook.updated', entityType: 'crm_webhook', entityId: id, data: { name: v.name, url: v.url, events: v.events, enabled } });
      return row;
    });
    return this.view(w);
  }

  async rotateSecret(orgId: string, actor: Actor, id: string) {
    const s = this.newSecret();
    const w = await this.prisma.$transaction(async (tx) => {
      await this.find(tx, orgId, id);
      const row = await tx.crmWebhook.update({ where: { id }, data: { secretCipher: s.secretCipher, secretKeyId: s.secretKeyId, secretHint: s.secretHint } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'crm_webhook.secret_rotated', entityType: 'crm_webhook', entityId: id, data: { hint: s.secretHint } });
      return row;
    });
    return { ...(await this.view(w)), secret: s.secret };
  }

  async remove(orgId: string, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const w = await this.find(tx, orgId, id);
      await tx.crmWebhook.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'crm_webhook.deleted', entityType: 'crm_webhook', entityId: id, data: { name: w.name, url: w.url } });
    });
    return this.list(orgId);
  }

  async deliveries(orgId: string, id: string) {
    await this.find(this.prisma, orgId, id);
    const rows = await this.prisma.crmWebhookDelivery.findMany({ where: { orgId, webhookId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.status === 'PENDING' ? (d.nextAttemptAt?.toISOString() ?? null) : null,
        statusCode: d.lastStatusCode,
        error: d.lastError,
        responseSnippet: d.responseSnippet,
        durationMs: d.durationMs,
        createdAt: d.createdAt.toISOString(),
        finishedAt: d.finishedAt?.toISOString() ?? null,
        body: d.body,
      })),
    };
  }

  /** Sends a failed delivery again now, with the same body. */
  async retry(orgId: string, actor: Actor, id: string, deliveryId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.find(tx, orgId, id);
      const d = await tx.crmWebhookDelivery.findFirst({ where: { id: deliveryId, orgId, webhookId: id } });
      if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Delivery not found' });
      if (d.status !== 'FAILED') throw new DomainError('DELIVERY_NOT_FAILED', 'Only a failed delivery can be sent again', HttpStatus.CONFLICT);
      await tx.crmWebhookDelivery.update({ where: { id: deliveryId }, data: { status: 'PENDING', nextAttemptAt: new Date(), finishedAt: null } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'crm_webhook.delivery_retried', entityType: 'crm_webhook', entityId: id, data: { deliveryId, event: d.event } });
    });
    await this.deliver(orgId, deliveryId);
    return this.deliveries(orgId, id);
  }

  /** Sends a "ping" now and reports what the other system answered. */
  async test(orgId: string, actor: Actor, id: string) {
    const w = await this.find(this.prisma, orgId, id);
    const deliveryId = (
      await this.prisma.$transaction(async (tx) => {
        const d = await tx.crmWebhookDelivery.create({ data: { orgId, webhookId: w.id, eventId: null, event: 'ping', body: '', nextAttemptAt: new Date() } });
        const body = JSON.stringify({ id: d.id, event: 'ping', occurredAt: d.createdAt.toISOString(), organisationId: orgId, test: true, data: { message: 'A test from Talk2Tax. Your endpoint received it.' }, object: null });
        await tx.crmWebhookDelivery.update({ where: { id: d.id }, data: { body } });
        await this.audit.append(tx, { orgId, actorId: actor.id, action: 'crm_webhook.tested', entityType: 'crm_webhook', entityId: id, data: { deliveryId: d.id } });
        return d;
      })
    ).id;
    const r = await this.deliver(orgId, deliveryId, { finalOnFailure: true });
    return { ok: r?.ok ?? false, statusCode: r?.status ?? null, error: r?.error ?? null, durationMs: r?.durationMs ?? null, responseSnippet: r?.responseSnippet ?? null };
  }

  // ------------------------------------------------------------------ background pass

  /** One pass: new events become deliveries, then due deliveries are sent. */
  async tick(): Promise<{ queued: number; sent: number }> {
    const hooks = await tenantStorage.run({ bypass: true }, async () => await this.prisma.crmWebhook.findMany({ where: { enabled: true }, select: { id: true, orgId: true } }));
    let queued = 0;
    for (const h of hooks) {
      try {
        queued += await tenantStorage.run({ orgId: h.orgId }, () => this.collect(h.orgId, h.id));
      } catch (e) {
        this.logger.error(`CRM webhook ${h.id} failed to read events: ${(e as Error).message}`);
      }
    }
    const due = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.$queryRaw<{ id: string; org_id: string }[]>`
        UPDATE crm_webhook_deliveries SET next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE id IN (SELECT id FROM crm_webhook_deliveries WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT ${DELIVERY_BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, org_id`,
    );
    if (due.length) await tenantStorage.run({ bypass: true }, () => mirrorRows(this.prisma, 'CrmWebhookDelivery', { id: { in: due.map((d) => d.id) } }));
    let sent = 0;
    for (const d of due) {
      try {
        await tenantStorage.run({ orgId: d.org_id }, () => this.deliver(d.org_id, d.id));
        sent++;
      } catch (e) {
        this.logger.error(`CRM webhook delivery ${d.id} failed: ${(e as Error).message}`);
      }
    }
    return { queued, sent };
  }

  /** Turns this webhook's new audit events into deliveries, in order, once each. */
  private async collect(orgId: string, webhookId: string): Promise<number> {
    let queued = 0;
    for (;;) {
      const r = await this.prisma.$transaction(
        async (tx) => {
          const cur = await tx.$queryRaw<{ last_event_id: bigint; events: string[]; enabled: boolean }[]>`SELECT last_event_id, events, enabled FROM crm_webhooks WHERE id = ${webhookId}::uuid AND org_id = ${orgId}::uuid FOR UPDATE SKIP LOCKED`;
          if (!cur.length || !cur[0]!.enabled) return { n: 0, more: false };
          const from = cur[0]!.last_event_id;
          // Audit ids are committed in order within an organisation, so all up to the highest visible id are visible.
          const hi = (await tx.auditEvent.aggregate({ where: { orgId }, _max: { id: true } }))._max.id ?? from;
          const events = await tx.auditEvent.findMany({
            where: { orgId, id: { gt: from, lte: hi }, action: { in: crmActionsFor(cur[0]!.events) } },
            orderBy: { id: 'asc' },
            take: EVENT_BATCH,
            select: { id: true, action: true, entityId: true },
          });
          let n = 0;
          for (const e of events) {
            const event = crmEventFor(e.action);
            if (!event) continue;
            // Contacts are customers, vendors or both; only customers are CRM events.
            if (event.startsWith('customer.') && !(e.entityId && (await tx.contact.findFirst({ where: { id: e.entityId, orgId }, select: { isCustomer: true } }))?.isCustomer)) continue;
            // The body is written at the first attempt (see deliver), once the record can be read.
            await tx.crmWebhookDelivery.create({ data: { orgId, webhookId, eventId: e.id, event, body: '', nextAttemptAt: new Date() } });
            n++;
          }
          const more = events.length === EVENT_BATCH;
          const next = more ? events[events.length - 1]!.id : hi > from ? hi : from;
          await tx.crmWebhook.update({ where: { id: webhookId }, data: { lastEventId: next } });
          return { n, more };
        },
        { timeout: 60_000 },
      );
      queued += r.n;
      if (!r.more) return queued;
    }
  }

  /** The JSON sent for an event: what the audit trail recorded, and the record as it stands at the first attempt. */
  private async eventBody(orgId: string, d: { id: string; event: string; eventId: bigint }): Promise<string> {
    const e = await this.prisma.auditEvent.findFirst({ where: { orgId, id: d.eventId }, select: { entityType: true, entityId: true, data: true, createdAt: true } });
    const { viaApiKey: _, ...data } = ((e?.data as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const object = e ? await this.objectFor(orgId, e.entityType, e.entityId) : null;
    return JSON.stringify({ id: d.id, event: d.event, occurredAt: e?.createdAt.toISOString() ?? null, organisationId: orgId, test: false, data: { id: e?.entityId ?? null, ...data }, object });
  }

  /** The record as it stands now, or null if it is gone. */
  private async objectFor(orgId: string, entityType: string, entityId: string | null): Promise<unknown> {
    if (!entityId) return null;
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { functionalCurrency: true } });
    const ref = { id: orgId, role: 'OWNER' as RoleName, functionalCurrency: org?.functionalCurrency ?? 'INR' };
    try {
      if (entityType === 'crm_lead') return await this.crm.getLead(ref, entityId);
      if (entityType === 'crm_deal') return await this.crm.getDeal(ref, entityId);
      if (entityType === 'contact') return await this.contacts.get(ref as never, entityId);
    } catch (e) {
      this.logger.warn(`Could not read ${entityType} ${entityId} for a webhook: ${(e as Error).message}`);
      return null;
    }
    return null;
  }

  /** Sends one delivery now and records the attempt. A test delivery is not tried again. */
  private async deliver(orgId: string, deliveryId: string, opts: { finalOnFailure?: boolean } = {}): Promise<WebhookResult | null> {
    const d = await this.prisma.crmWebhookDelivery.findFirst({ where: { id: deliveryId, orgId }, include: { webhook: true } });
    if (!d || d.status !== 'PENDING') return null;
    if (!d.body && d.eventId !== null) {
      d.body = await this.eventBody(orgId, { id: d.id, event: d.event, eventId: d.eventId });
      await this.prisma.crmWebhookDelivery.update({ where: { id: d.id }, data: { body: d.body } });
    }
    const secret = this.box.open(d.webhook.secretCipher, d.webhook.secretKeyId);
    const attempt = d.attempts + 1;
    const res: WebhookResult = secret
      ? await sendWebhook(d.webhook.url, d.body, { [SIGNATURE_HEADER]: signPayload(secret, d.body), 't2t-event': d.event, 't2t-delivery': d.id, 't2t-attempt': String(attempt) }, { allowPrivateNetworks: this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS, timeoutMs: this.config.WEBHOOK_TIMEOUT_SECONDS * 1000 })
      : { ok: false, status: null, durationMs: 0, responseSnippet: null, error: 'The signing secret can no longer be read (the encryption key changed); rotate the secret' };
    const now = new Date();
    const next = res.ok || opts.finalOnFailure || !secret ? null : nextWebhookAttempt(attempt, res.status, now);
    await this.prisma.crmWebhookDelivery.update({
      where: { id: d.id },
      data: {
        attempts: attempt,
        status: res.ok ? 'SUCCEEDED' : next ? 'PENDING' : 'FAILED',
        nextAttemptAt: res.ok ? null : next,
        finishedAt: res.ok || !next ? now : null,
        lastStatusCode: res.status,
        lastError: res.error?.slice(0, 300) ?? null,
        responseSnippet: res.responseSnippet?.slice(0, 500) ?? null,
        durationMs: res.durationMs,
      },
    });
    return res;
  }
}

