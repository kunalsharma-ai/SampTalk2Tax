import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { userMfa } from '../db/collections/identity';
import { SecretBox, secretBoxFor } from '../integrations/secret-box';
import { attachments } from '../db/collections/sales';
import { taxNoticeFiles } from '../db/collections/tax-notices';
import { FileVault } from '../files/file-vault';

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
type FileCount = { current: number; previous: number; unencrypted: number; unreadable: number };
/** One kind of stored file (SEC-011): how many are held under each key, and how to seal one again. */
interface FileStore {
  key: string;
  name: string;
  keyIds: () => Promise<{ keyId: string | null; n: number }[]>;
  /** Up to `limit` files not under the current key, with their bytes. */
  stale: (current: string, limit: number) => Promise<{ id: string; orgId: string; content: Buffer | Uint8Array | import('@talk2tax/document-db').Binary; keyId: string | null; sha256: string }[]>;
  write: (f: { id: string; orgId: string }, sealed: { content: Buffer; contentKeyId: string }) => Promise<void>;
}
const notCurrent = (current: string) => ({ $or: [{ contentKeyId: { $exists: false } }, { contentKeyId: null }, { contentKeyId: { $ne: current } }] });
const byKey = [{ $group: { _id: { $ifNull: ['$contentKeyId', null] }, n: { $sum: 1 } } }];

/**
 * Encryption key rotation (SEC-013) for the secrets stored in the app: organisations' AI and
 * email keys, payment gateway keys and webhook secrets (organisations' and the platform's), CRM
 * webhook signing secrets, single sign-on client secrets and two-step sign-in secrets. Each sealed value records the id of the key
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
    private readonly vault: FileVault,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.box = secretBoxFor(config);
  }

  /** Uploaded files (SEC-011): attachments, tax notice files and invoices sent through the vendor portal. */
  private fileStores(): FileStore[] {
    const p = this.prisma;
    const col = <T = Record<string, unknown>>(def: typeof attachments | typeof taxNoticeFiles) => this.store.collection(def as never) as unknown as {
      aggregate: (pl: unknown[]) => Promise<{ _id: string | null; n: number }[]>;
      find: (f: unknown, o?: unknown) => Promise<T[]>;
      updateOne: (f: unknown, u: unknown) => Promise<unknown>;
    };
    const native = (key: string, name: string, def: typeof attachments | typeof taxNoticeFiles): FileStore => ({
      key,
      name,
      keyIds: async () => (await runAsSystem(() => col(def).aggregate([{ $match: { content: { $ne: null } } }, ...byKey]))).map((r) => ({ keyId: r._id, n: r.n })),
      stale: async (current, limit) =>
        (await runAsSystem(() => col<{ id: string; orgId: string; content: Buffer; contentKeyId?: string | null; sha256: string }>(def).find(notCurrent(current), { limit, sort: { createdAt: 1 } }))).map((f) => ({ id: f.id, orgId: f.orgId, content: f.content, keyId: f.contentKeyId ?? null, sha256: f.sha256 })),
      write: (f, sealed) => runInOrg(f.orgId, () => col(def).updateOne({ id: f.id }, { $set: { content: sealed.content, contentKeyId: sealed.contentKeyId } })).then(() => undefined),
    });
    return [
      native('attachments', 'Attachments (bills, receipts, statements, documents)', attachments),
      native('tax-notice-files', 'Tax notice files', taxNoticeFiles),
      {
        key: 'vendor-portal-files',
        name: 'Invoices sent through the vendor portal',
        keyIds: async () => {
          const rows = await runAsSystem(() => p.vendorPortalSubmission.findMany({ where: { sha256: { not: null } }, select: { contentKeyId: true } }));
          const m = new Map<string | null, number>();
          for (const r of rows) m.set(r.contentKeyId ?? null, (m.get(r.contentKeyId ?? null) ?? 0) + 1);
          return [...m].map(([keyId, n]) => ({ keyId, n }));
        },
        stale: async (current, limit) =>
          (
            await runAsSystem(() =>
              p.vendorPortalSubmission.findMany({ where: { sha256: { not: null }, OR: [{ contentKeyId: null }, { contentKeyId: { not: current } }] }, select: { id: true, orgId: true, content: true, contentKeyId: true, sha256: true }, take: limit, orderBy: { createdAt: 'asc' } }),
            )
          )
            .filter((r) => r.content)
            .map((r) => ({ id: r.id, orgId: r.orgId, content: r.content!, keyId: r.contentKeyId, sha256: r.sha256! })),
        write: (f, sealed) => runInOrg(f.orgId, () => p.vendorPortalSubmission.update({ where: { id: f.id }, data: { content: new Uint8Array(sealed.content), contentKeyId: sealed.contentKeyId } })).then(() => undefined),
      },
    ];
  }

  private async fileReport() {
    const files: ({ key: string; name: string } & FileCount)[] = [];
    for (const s of this.fileStores()) {
      const c: FileCount = { current: 0, previous: 0, unencrypted: 0, unreadable: 0 };
      for (const r of await s.keyIds()) c[this.vault.classify(r.keyId)] += r.n;
      files.push({ key: s.key, name: s.name, ...c });
    }
    const total = (k: keyof FileCount) => files.reduce((n, f) => n + f[k], 0);
    return { files, fileTotals: { current: total('current'), previous: total('previous'), unencrypted: total('unencrypted'), unreadable: total('unreadable') } };
  }

  /** Seals every readable file not under the current key: files stored before encryption, and files under a previous key. */
  private async resealFiles(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of this.fileStores()) {
      out[s.key] = 0;
      const skipped = new Set<string>();
      for (;;) {
        const batch = (await s.stale(this.box.keyId, 50 + skipped.size)).filter((f) => !skipped.has(f.id));
        if (!batch.length) break;
        for (const f of batch) {
          const kind = this.vault.classify(f.keyId);
          if (kind === 'unreadable') {
            skipped.add(f.id);
            continue;
          }
          let plain: Buffer;
          try {
            plain = this.vault.open(f.content, f.keyId, f.sha256);
          } catch {
            skipped.add(f.id);
            continue;
          }
          await s.write(f, this.vault.seal(plain));
          out[s.key]!++;
        }
      }
    }
    return out;
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
        key: 'sso',
        name: 'Single sign-on client secrets',
        rows: async () => (await runAsSystem(() => p.ssoConnection.findMany({ select: { orgId: true, clientSecretCipher: true, clientSecretKeyId: true } }))).map((r) => ({ id: r.orgId, orgId: r.orgId, values: { secret: { cipher: r.clientSecretCipher, keyId: r.clientSecretKeyId } } })),
        write: (r, _f, s) => inOrg(r.orgId, () => p.ssoConnection.update({ where: { orgId: r.id }, data: { clientSecretCipher: s.cipher, clientSecretKeyId: s.keyId } }).then(() => undefined)),
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
    return { currentKeyId: this.box.keyId, previousKeyIds: this.box.previousKeyIds, stores, totals: { current: total('current'), previous: total('previous'), unreadable: total('unreadable') }, ...(await this.fileReport()) };
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
      const files = await this.resealFiles();
      const after = await this.report();
      await this.prisma.$transaction((tx) =>
        this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.secrets_resealed', entityType: 'encryption_key', entityId: this.box.keyId, data: { keyId: this.box.keyId, resealed, files, unreadable: after.totals.unreadable, unreadableFiles: after.fileTotals.unreadable } }),
      );
      return { resealed, filesSealed: files, ...after };
    } finally {
      this.running = false;
    }
  }
}
