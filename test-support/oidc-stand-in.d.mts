export interface OidcStandIn {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** DNS TXT records the stand-in DNS server answers, by name. */
  txt: Map<string, string[]>;
  /** Changes to the next ID token only. */
  next: { emailVerified?: boolean | string; wrongKey?: boolean; email?: string; nonce?: string; aud?: string; name?: string } | null;
  tokens: Record<string, any>[];
  requests: { method: string; path: string; headers: Record<string, any>; body: string }[];
  /** As if the person signed in on the provider's page: the address the provider sends the browser back to. */
  approve(authorizationUrl: string, email: string): Promise<string>;
  close(): Promise<void>;
}
export function startOidcStandIn(port?: number, opts?: { dnsPort?: number; clientId?: string; clientSecret?: string }): Promise<OidcStandIn>;
