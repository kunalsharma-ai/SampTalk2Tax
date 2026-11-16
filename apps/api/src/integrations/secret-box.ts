import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Seals integration secrets (API keys, SMTP passwords) with AES-256-GCM before they are stored.
 * The key is INTEGRATIONS_ENCRYPTION_KEY when the server sets one, otherwise it is derived from
 * JWT_SECRET (HKDF-SHA256 with its own label), so nothing extra has to be configured. Each sealed
 * value records a short id of the key that sealed it; if the key later changes, the value is
 * reported as needing to be entered again instead of failing in an unclear way.
 */
export class SecretBox {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(opts: { encryptionKey?: string; jwtSecret: string }) {
    this.key = opts.encryptionKey
      ? createHash('sha256').update(opts.encryptionKey, 'utf8').digest()
      : Buffer.from(hkdfSync('sha256', Buffer.from(opts.jwtSecret, 'utf8'), Buffer.alloc(0), Buffer.from('talk2tax/integrations/v1', 'utf8'), 32));
    this.keyId = createHash('sha256').update(this.key).digest('hex').slice(0, 12);
  }

  seal(plain: string): { cipher: string; keyId: string } {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { cipher: Buffer.concat([iv, c.getAuthTag(), body]).toString('base64'), keyId: this.keyId };
  }

  /** The secret, or null when it was sealed with another key or has been tampered with. */
  open(cipher: string, keyId: string): string | null {
    if (keyId !== this.keyId) return null;
    try {
      const raw = Buffer.from(cipher, 'base64');
      const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/** The last four characters, for recognising a stored secret without revealing it. */
export function secretHint(secret: string): string {
  return `…${secret.slice(-4)}`;
}
