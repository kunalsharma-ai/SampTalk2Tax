import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfig, CONFIG } from '../config';

const ISSUER = 'talk2tax-api';
const AUDIENCE = 'talk2tax';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

/** Signs and checks access tokens, and makes and parses refresh tokens. Holds no state. */
@Injectable()
export class TokensService {
  private readonly key: Uint8Array;
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.JWT_SECRET);
  }

  get accessTtlSeconds(): number {
    return this.config.JWT_TTL_SECONDS;
  }

  async signAccess(claims: AccessClaims): Promise<{ accessToken: string; expiresIn: number }> {
    const expiresIn = this.config.JWT_TTL_SECONDS;
    const accessToken = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.key);
    return { accessToken, expiresIn };
  }

  /** Returns the claims of a valid, unexpired access token, or null. Tokens without a session are refused. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      return null;
    }
  }

  /** A new refresh secret (256 bits) and its hash. Only the hash is stored. */
  newSecret(): { secret: string; hash: string } {
    const secret = randomBytes(32).toString('base64url');
    return { secret, hash: hashSecret(secret) };
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function sameHash(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A refresh token is "<session id>.<secret>". */
export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID.test(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { sessionId, secret };
}
