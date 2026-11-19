import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Seals integration secrets (API keys, SMTP passwords) with AES-256-GCM before they are stored.
 * The key is INTEGRATIONS_ENCRYPTION_KEY when the server sets one, otherwise it is derived from
 * JWT_SECRET (HKDF-SHA256 with its own label), so nothing extra has to be configured. Each sealed
 * value records a short id of the key that sealed it; if the key later changes, the value is
 * reported as needing to be entered again instead of failing in an unclear way.
 *
 * Key rotation (SEC-013): the keys the server used before can be listed in
 * INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS. Values sealed with one of them still open, and the
 * re-encryption in Platform admin → Encryption keys seals them again with the current key, after
 * which the old key can be removed.
 */
export class SecretBox {
  private readonly key: Buffer;
  readonly keyId: string;
  /** Keys used before, by id: they open what they sealed, and never seal. */
  private readonly previous = new Map<string, Buffer>();

  constructor(opts: { encryptionKey?: string; jwtSecret: string; previousKeys?: readonly string[] }) {
    this.key = deriveKey(opts.encryptionKey, opts.jwtSecret);
    this.keyId = idOf(this.key);
    for (const p of opts.previousKeys ?? []) {
      const k = p.startsWith('jwt:') ? deriveKey(undefined, p.slice(4)) : deriveKey(p, '');
      const id = idOf(k);
      if (id !== this.keyId) this.previous.set(id, k);
    }
  }

  /** The ids of the previous keys this server can still open values with. */
  get previousKeyIds(): string[] {
    return [...this.previous.keys()];
  }

  /** Whether a value sealed with this key id can be opened here (current or previous key). */
  canOpen(keyId: string): boolean {
    return keyId === this.keyId || this.previous.has(keyId);
  }

  seal(plain: string): { cipher: string; keyId: string } {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { cipher: Buffer.concat([iv, c.getAuthTag(), body]).toString('base64'), keyId: this.keyId };
  }

  /**
   * Encryption at rest for file bytes (SEC-011): the same AES-256-GCM key, as
   * MAGIC (5 bytes) + iv (12) + tag (16) + ciphertext. The key id is kept beside the bytes.
   */
  sealBytes(plain: Buffer): { content: Buffer; keyId: string } {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return { content: Buffer.concat([FILE_MAGIC, iv, c.getAuthTag(), body]), keyId: this.keyId };
  }

  /** The file's bytes, or null when they were sealed with a key this server does not have, or changed. */
  openBytes(sealed: Buffer, keyId: string): Buffer | null {
    const key = keyId === this.keyId ? this.key : this.previous.get(keyId);
    if (!key || sealed.length < FILE_OVERHEAD || !sealed.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(5, 17));
      d.setAuthTag(sealed.subarray(17, 33));
      return Buffer.concat([d.update(sealed.subarray(33)), d.final()]);
    } catch {
      return null;
    }
  }

  /** The secret, or null when it was sealed with another key or has been tampered with. */
  open(cipher: string, keyId: string): string | null {
    const key = keyId === this.keyId ? this.key : this.previous.get(keyId);
    if (!key) return null;
    try {
      const raw = Buffer.from(cipher, 'base64');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/** Sealed file bytes start with these five bytes; a sealed file is FILE_OVERHEAD bytes longer than the file. */
export const FILE_MAGIC = Buffer.from('T2TF1');
export const FILE_OVERHEAD = 5 + 12 + 16;

/** Whether a stored file's length fits its size: the file itself, or sealed (FILE_OVERHEAD longer). */
export function storedSizeFits(stored: number, sizeBytes: number, sealed: boolean): boolean {
  return stored === sizeBytes + (sealed ? FILE_OVERHEAD : 0);
}

function deriveKey(encryptionKey: string | undefined, jwtSecret: string): Buffer {
  return encryptionKey
    ? createHash('sha256').update(encryptionKey, 'utf8').digest()
    : Buffer.from(hkdfSync('sha256', Buffer.from(jwtSecret, 'utf8'), Buffer.alloc(0), Buffer.from('talk2tax/integrations/v1', 'utf8'), 32));
}

function idOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** The server's secret box, with the current key and any previous ones from the configuration. */
export function secretBoxFor(config: { INTEGRATIONS_ENCRYPTION_KEY?: string; JWT_SECRET: string; INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS?: string[] }): SecretBox {
  return new SecretBox({ encryptionKey: config.INTEGRATIONS_ENCRYPTION_KEY, jwtSecret: config.JWT_SECRET, previousKeys: config.INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS });
}

/** The last four characters, for recognising a stored secret without revealing it. */
export function secretHint(secret: string): string {
  return `…${secret.slice(-4)}`;
}
