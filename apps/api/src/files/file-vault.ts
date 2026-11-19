import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Binary } from '@talk2tax/document-db';
import { DomainError } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { SecretBox, secretBoxFor } from '../integrations/secret-box';

type StoredBytes = Buffer | Uint8Array | Binary;

/** A stored file's bytes as a Buffer, whether the driver gave a Buffer, a Uint8Array or a BSON Binary. */
export function storedBytes(c: StoredBytes): Buffer {
  if (Buffer.isBuffer(c)) return c;
  if (c instanceof Uint8Array) return Buffer.from(c.buffer, c.byteOffset, c.byteLength);
  const b = c.buffer;
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Encryption at rest for uploaded files (SEC-011): attachments, tax notice files and invoices
 * vendors send through the portal are stored sealed with AES-256-GCM under the server's
 * encryption key (INTEGRATIONS_ENCRYPTION_KEY, or one derived from JWT_SECRET), with the key's
 * id beside them (contentKeyId). Files stored before this have no key id and are read as they
 * are, until Platform admin → Encryption keys seals them.
 */
@Injectable()
export class FileVault {
  readonly box: SecretBox;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.box = secretBoxFor(config);
  }

  seal(plain: Buffer): { content: Buffer; contentKeyId: string } {
    const s = this.box.sealBytes(plain);
    return { content: s.content, contentKeyId: s.keyId };
  }

  /** The file as uploaded. With sha256, the bytes are checked against the checksum taken at upload. */
  open(stored: StoredBytes, contentKeyId: string | null | undefined, sha256?: string | null): Buffer {
    const bytes = storedBytes(stored);
    let plain = bytes;
    if (contentKeyId) {
      const opened = this.box.openBytes(bytes, contentKeyId);
      if (!opened && this.box.canOpen(contentKeyId)) throw new DomainError('FILE_DAMAGED', 'This file was changed or damaged after it was stored', HttpStatus.INTERNAL_SERVER_ERROR);
      if (!opened) throw new DomainError('FILE_KEY_MISSING', 'This file was encrypted with a key this server does not have. List that key in INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS to read it.', HttpStatus.CONFLICT);
      plain = opened;
    }
    if (sha256 && createHash('sha256').update(plain).digest('hex') !== sha256) throw new DomainError('FILE_DAMAGED', 'This file does not match the checksum taken when it was uploaded', HttpStatus.INTERNAL_SERVER_ERROR);
    return plain;
  }

  /** How a stored file is held: under the current key, a previous key still listed, an unknown key, or not encrypted. */
  classify(contentKeyId: string | null | undefined): 'current' | 'previous' | 'unreadable' | 'unencrypted' {
    if (!contentKeyId) return 'unencrypted';
    if (contentKeyId === this.box.keyId) return 'current';
    return this.box.canOpen(contentKeyId) ? 'previous' : 'unreadable';
  }
}
