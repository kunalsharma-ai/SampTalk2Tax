import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { AppConfig, CONFIG } from '../config';

const ISSUER = 'talk2tax-api';
const AUDIENCE = 'talk2tax';

@Injectable()
export class TokensService {
  private readonly key: Uint8Array;
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.JWT_SECRET);
  }

  async issue(userId: string): Promise<{ accessToken: string; expiresIn: number }> {
    const expiresIn = this.config.JWT_TTL_SECONDS;
    const accessToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.key);
    return { accessToken, expiresIn };
  }

  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
