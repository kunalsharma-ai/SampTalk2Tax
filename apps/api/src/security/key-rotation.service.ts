import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { userMfa } from '../db/collections/identity';
import { SecretBox, secretBoxFor } from '../integrations/secret-box';

type Actor = { id: string };
type Sealed = { cipher: string | null; keyId: string | null };
type Count = { current: number; previous: number; unreadable: number };
/** One kind of stored secret: how to read every sealed value, and how to seal one again. */
interface Store {
  key: string;
  name: string;
  rows: () => Promise<{ id: string; orgId: string | null; values: Record<string, Sealed> }[]>;
  write: (row: { id: string; orgId: string | null }, field: string, sealed: { cipher: string; keyId: string }) => Promise<void>;
}

/**
 * Encryption key rotation (SEC-013) for the secrets stored in the app: organisations' AI and
 * email keys, payment gateway keys and webhook secrets (organisations' and the platform's), CRM
 * webhook signing secrets and two-step sign-in secrets. Each sealed value records the id of the key
 * that sealed it. After INTEGRATIONS_ENCRYPTION_KEY changes and the old key is listed in
 * INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS, the report shows what is still under an old key, and
 * re-encrypting seals every readable value again with the current key. Values no listed key can
 * open are counted, never changed: they have to be entered again.
 */
@Injectable()
export class KeyRotationService {
  private readonly box: SecretBox;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.box = secretBoxFor(config);
  }

  private stores(): Store[] {
    const p = this.prisma;
    const inOrg = <T>(orgId: string | null, fn: () => Promise<T>) => (orgId ? runInOrg(orgId, fn) : runAsSystem(fn));
    return [
      {
        key: 'integrations',
        name: 'AI and email keys (Settings → Integrations)',
        rows: async () => (await runAsSystem(() => p.orgIntegration.findMany({ where: { secretCipher: { not: null } }, select: { id: true, orgId: true, secretCipher: true, keyId: true } }))).map((r) => ({ id: r.id, orgId: r.orgId, values: { secret: { cipher: r.secretCipher, keyId: r.keyId } } })),
        write: (r, _f, s) => inOrg(r.orgId, () => p.orgIntegration.update({ where: { id: r.id }, data: { secretCipher: s.cipher, keyId: s.keyId } }).then(() => undefined)),
      },
      {
        key: 'org-gateways',
        name: "Organisations' payment gateways",
        rows: async () =>
          (await runAsSystem(() => p.orgPaymentGateway.findMany({ select: { id: true, orgId: true, secretCipher: true, secretKeyId: true, webhookCipher: true, webhookKeyId: true } }))).map((r) => ({
            id: r.id,
            orgId: r.orgId,
            values: { secret: { cipher: r.secretCipher, keyId: r.secretKeyId }, webhook: { cipher: r.webhookCipher, keyId: r.webhookKeyId } },
          })),
        write: (r, f, s) => inOrg(r.orgId, () => p.orgPaymentGateway.update({ where: { id: r.id }, data: f === 'secret' ? { secretCipher: s.cipher, secretKeyId: s.keyId } : { webhookCipher: s.cipher, webhookKeyId: s.keyId } }).then(() => undefined)),
      },
      {
        key: 'platform-gateways',
        name: 'Platform payment gateways',
        rows: async () =>
          (await runAsSystem(() => p.platformPaymentGateway.findMany({ select: { provider: true, secretCipher: true, secretKeyId: true, webhookCipher: true, webhookKeyId: true } }))).map((r) => ({
            id: r.provider,
            orgId: null,
            values: { secret: { cipher: r.secretCipher, keyId: r.secretKeyId }, webhook: { cipher: r.webhookCipher, keyId: r.webhookKeyId } },
          })),
        write: (r, f, s) => runAsSystem(() => p.platformPaymentGateway.update({ where: { provider: r.id }, data: f === 'secret' ? { secretCipher: s.cipher, secretKeyId: s.keyId } : { webhookCipher: s.cipher, webhookKeyId: s.keyId } }).then(() => undefined)),
      },
      {
        key: 'crm-webhooks',
        name: 'CRM webhook signing secrets',
        rows: async () => (await runAsSystem(() => p.crmWebhook.findMany({ select: { id: true, orgId: true, secretCipher: true, secretKeyId: true } }))).map((r) => ({ id: r.id, orgId: r.orgId, values: { secret: { cipher: r.secretCipher, keyId: r.secretKeyId } } })),
        write: (r, _f, s) => inOrg(r.orgId, () => p.crmWebhook.update({ where: { id: r.id }, data: { secretCipher: s.cipher, secretKeyId: s.keyId } }).then(() => undefined)),
      },
      {
        key: 'two-step',
        name: 'Two-step sign-in authenticators',
        rows: async () => (await runAsSystem(() => this.store.collection(userMfa).find({}))).map((m) => ({ id: m.id, orgId: null, values: { secret: { cipher: m.secretCipher, keyId: m.keyId } } })),
        write: (r, _f, s) => runAsSystem(() => this.store.collection(userMfa).updateOne({ id: r.id }, { $set: { secretCipher: s.cipher, keyId: s.keyId, updatedAt: new Date() } }).then(() => undefined)),
      },
    ];
  }

  private classify(v: Sealed): keyof Count | null {
    if (!v.cipher || !v.keyId) return null;
    if (v.keyId === this.box.keyId) return 'current';
    return this.box.canOpen(v.keyId) && this.box.open(v.cipher, v.keyId) !== null ? 'previous' : 'unreadable';
  }

  /** What every store holds: sealed with the current key, with a previous key still listed, or with a key no longer known. */
  async report() {
    const stores: ({ key: string; name: string } & Count)[] = [];
    for (const s of this.stores()) {
      const c: Count = { current: 0, previous: 0, unreadable: 0 };
      for (const r of await s.rows()) for (const v of Object.values(r.values)) {
        const k = this.classify(v);
        if (k) c[k]++;
      }
      stores.push({ key: s.key, name: s.name, ...c });
    }
    const total = (k: keyof Count) => stores.reduce((n, s) => n + s[k], 0);
    return { currentKeyId: this.box.keyId, previousKeyIds: this.box.previousKeyIds, stores, totals: { current: total('current'), previous: total('previous'), unreadable: total('unreadable') } };
  }

  /** Seals every value under a previous key again with the current key. Unreadable values are left as they are. */
  async reseal(actor: Actor) {
    if (this.running) throw new DomainError('RESEAL_RUNNING', 'Re-encryption is already running', HttpStatus.CONFLICT);
    this.running = true;
    try {
      const resealed: Record<string, number> = {};
      for (const s of this.stores()) {
        resealed[s.key] = 0;
        for (const r of await s.rows()) {
          for (const [field, v] of Object.entries(r.values)) {
            if (this.classify(v) !== 'previous') continue;
            const plain = this.box.open(v.cipher!, v.keyId!)!;
            await s.write(r, field, this.box.seal(plain));
            resealed[s.key]++;
          }
        }
      }
      const after = await this.report();
      await this.prisma.$transaction((tx) =>
        this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.secrets_resealed', entityType: 'encryption_key', entityId: this.box.keyId, data: { keyId: this.box.keyId, resealed, unreadable: after.totals.unreadable } }),
      );
      return { resealed, ...after };
    } finally {
      this.running = false;
    }
  }
}
