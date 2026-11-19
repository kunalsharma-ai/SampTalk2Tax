import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { hashPassword, hasPermission, RoleName } from '@talk2tax/security';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { ClientMeta } from '../auth/sessions.service';
import { assertMemberRoom } from '../billing/limits';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { users } from '../db/collections/identity';
import { memberships } from '../db/collections/tenancy';
import { SecretBox, secretBoxFor, secretHint } from '../integrations/secret-box';
import { authorizationUrl, discover, emailDomain, exchangeCode, fetchKeys, normaliseDomain, normaliseIssuer, OidcError, OidcHttpOptions, randomToken, verifyIdToken } from './oidc';

type Member = { orgId: string; role: RoleName };
type Actor = { id: string };

/** Roles someone can be given on their first single sign-on; owners and admins are always invited. */
export const AUTO_JOIN_ROLES = ['ACCOUNTANT', 'APPROVER', 'VIEWER', 'EMPLOYEE'] as const;
const STATE_TTL_MS = 10 * 60_000;
const MAX_DOMAINS = 20;
export const TXT_PREFIX = '_talk2tax-verification';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const fail = (code: string, message: string, status = HttpStatus.UNPROCESSABLE_ENTITY) => new DomainError(code, message, status);
const stateInvalid = () => fail('SSO_STATE_INVALID', 'This sign-in has expired or was started in another browser. Start again.', HttpStatus.UNAUTHORIZED);

export interface SaveConnection {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  enabled: boolean;
  enforced: boolean;
  autoJoinRole: (typeof AUTO_JOIN_ROLES)[number] | null;
}

/**
 * Single sign-on with OpenID Connect (SEC-006/007). An organisation connects its identity provider
 * (Microsoft Entra ID, Google Workspace, Okta, Keycloak, …) and proves the email domains it signs
 * in with by DNS TXT records. Someone whose email is at a verified domain then signs in through
 * the provider: the authorization code flow with PKCE, a state bound to their browser, and an ID
 * token checked against the provider's published keys. Only emails at the organisation's verified
 * domains are accepted, so a provider cannot sign anyone in as a person at another domain.
 *
 * Optionally, sign-in with SSO is enforced: members at a verified domain can no longer sign in with
 * a password (owners still can, so a broken provider never locks an organisation out), and new
 * people at the domain can join with a chosen role on their first sign-in.
 */
@Injectable()
export class SsoService {
  private readonly box: SecretBox;
  private readonly http: OidcHttpOptions;
  private readonly redirectUri: string;
  private readonly resolver: Resolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.box = secretBoxFor(config);
    this.http = { allowPrivateNetworks: config.SSO_ALLOW_PRIVATE_NETWORKS };
    this.redirectUri = `${config.APP_URL.replace(/\/+$/, '')}/api/session/sso/callback`;
    this.resolver = new Resolver({ timeout: 4000, tries: 2 });
    if (config.SSO_DNS_SERVERS.length) this.resolver.setServers(config.SSO_DNS_SERVERS);
  }

  // ------------------------------------------------------------------ settings

  async overview(member: Member) {
    const [c, domains] = await Promise.all([
      this.prisma.ssoConnection.findUnique({ where: { orgId: member.orgId } }),
      this.prisma.ssoDomain.findMany({ where: { orgId: member.orgId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      canManage: hasPermission(member.role, 'org.manage'),
      redirectUri: this.redirectUri,
      autoJoinRoles: AUTO_JOIN_ROLES,
      connection: c
        ? {
            protocol: c.protocol,
            issuer: c.issuer,
            clientId: c.clientId,
            clientSecretHint: c.clientSecretHint,
            clientSecretReadable: this.box.canOpen(c.clientSecretKeyId),
            enabled: c.enabled,
            enforced: c.enforced,
            autoJoinRole: c.autoJoinRole,
            updatedAt: c.updatedAt.toISOString(),
          }
        : null,
      domains: domains.map((d) => ({ id: d.id, domain: d.domain, verifiedAt: d.verifiedAt?.toISOString() ?? null, record: { name: `${TXT_PREFIX}.${d.domain}`, value: `talk2tax-verification=${d.token}` } })),
    };
  }

  /** Saves the connection after checking the provider's discovery document answers for the issuer. */
  async save(member: Member, actor: Actor, input: SaveConnection) {
    const issuer = normaliseIssuer(input.issuer);
    const clientId = input.clientId.trim();
    if (!clientId) throw fail('SSO_INVALID', 'Enter the client ID from your identity provider');
    try {
      await discover(issuer, this.http);
    } catch (e) {
      if (e instanceof OidcError) throw fail('SSO_PROVIDER_UNREACHABLE', `The identity provider could not be checked: ${e.message}`);
      throw e;
    }
    const before = await this.prisma.ssoConnection.findUnique({ where: { orgId: member.orgId } });
    const secret = input.clientSecret?.trim();
    if (!before && !secret) throw fail('SSO_INVALID', 'Enter the client secret from your identity provider');
    if (input.enforced) {
      if (!input.enabled) throw fail('SSO_INVALID', 'Turn single sign-on on before requiring it');
      const verified = await this.prisma.ssoDomain.count({ where: { orgId: member.orgId, verifiedAt: { not: null } } });
      if (!verified) throw fail('SSO_INVALID', 'Verify at least one domain before requiring single sign-on');
    }
    const sealed = secret ? this.box.seal(secret) : null;
    const data = {
      issuer,
      clientId,
      enabled: input.enabled,
      enforced: input.enforced,
      autoJoinRole: input.autoJoinRole,
      updatedById: actor.id,
      ...(sealed && secret ? { clientSecretCipher: sealed.cipher, clientSecretKeyId: sealed.keyId, clientSecretHint: secretHint(secret) } : {}),
    };
    await this.prisma.$transaction(async (tx) => {
      if (before) await tx.ssoConnection.update({ where: { orgId: member.orgId }, data });
      else await tx.ssoConnection.create({ data: { orgId: member.orgId, protocol: 'OIDC', ...data, clientSecretCipher: sealed!.cipher, clientSecretKeyId: sealed!.keyId, clientSecretHint: secretHint(secret!) } });
      await this.audit.append(tx, {
        orgId: member.orgId,
        actorId: actor.id,
        action: 'sso.connection_saved',
        entityType: 'sso_connection',
        entityId: member.orgId,
        data: { issuer, clientId, enabled: input.enabled, enforced: input.enforced, autoJoinRole: input.autoJoinRole, secretChanged: !!secret, created: !before },
      });
    });
    return this.overview(member);
  }

  async remove(member: Member, actor: Actor) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.ssoConnection.findUnique({ where: { orgId: member.orgId } });
      if (!before) throw fail('SSO_NOT_SET_UP', 'Single sign-on is not set up', HttpStatus.NOT_FOUND);
      await tx.ssoConnection.delete({ where: { orgId: member.orgId } });
      await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: 'sso.connection_removed', entityType: 'sso_connection', entityId: member.orgId, data: { issuer: before.issuer } });
    });
    return this.overview(member);
  }

  async addDomain(member: Member, actor: Actor, raw: string) {
    const domain = normaliseDomain(raw);
    if (!domain) throw fail('SSO_INVALID', `${raw.trim() || 'This'} is not a domain name; enter it like example.com`);
    await this.prisma.$transaction(async (tx) => {
      const mine = await tx.ssoDomain.findMany({ where: { orgId: member.orgId } });
      if (mine.some((d) => d.domain === domain)) throw fail('SSO_DOMAIN_EXISTS', `${domain} is already listed`, HttpStatus.CONFLICT);
      if (mine.length >= MAX_DOMAINS) throw fail('SSO_INVALID', `An organisation can list at most ${MAX_DOMAINS} domains`);
      const d = await tx.ssoDomain.create({ data: { orgId: member.orgId, domain, token: randomToken(24), createdById: actor.id } });
      await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: 'sso.domain_added', entityType: 'sso_domain', entityId: d.id, data: { domain } });
    });
    return this.overview(member);
  }

  /** Looks up the domain's TXT record; verified when it holds this organisation's value and no other organisation has the domain. */
  async verifyDomain(member: Member, actor: Actor, id: string) {
    const d = await this.prisma.ssoDomain.findFirst({ where: { id, orgId: member.orgId } });
    if (!d) throw fail('SSO_DOMAIN_NOT_FOUND', 'Domain not found', HttpStatus.NOT_FOUND);
    if (d.verifiedAt) return this.overview(member);
    const name = `${TXT_PREFIX}.${d.domain}`;
    const want = `talk2tax-verification=${d.token}`;
    let found: string[] = [];
    try {
      found = (await this.resolver.resolveTxt(name)).map((parts) => parts.join(''));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENODATA' && code !== 'ENOTFOUND') throw fail('SSO_DOMAIN_NOT_VERIFIED', `The DNS lookup of ${name} failed (${code ?? 'error'}); try again in a few minutes`);
    }
    if (!found.includes(want)) {
      throw fail('SSO_DOMAIN_NOT_VERIFIED', found.length ? `${name} has a TXT record, but not the value shown here. DNS changes can take up to an hour to appear.` : `No TXT record was found at ${name} yet. DNS changes can take up to an hour to appear.`);
    }
    await this.prisma.$transaction(async (tx) => {
      const taken = await runAsSystem(() => tx.ssoDomain.findFirst({ where: { domain: d.domain, verifiedAt: { not: null }, orgId: { not: member.orgId } } }));
      if (taken) throw fail('SSO_DOMAIN_TAKEN', `${d.domain} is verified for another organisation; it can sign in with one organisation's provider only`, HttpStatus.CONFLICT);
      await tx.ssoDomain.update({ where: { id: d.id }, data: { verifiedAt: new Date() } });
      await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: 'sso.domain_verified', entityType: 'sso_domain', entityId: d.id, data: { domain: d.domain } });
    });
    return this.overview(member);
  }

  async removeDomain(member: Member, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.ssoDomain.findFirst({ where: { id, orgId: member.orgId } });
      if (!d) throw fail('SSO_DOMAIN_NOT_FOUND', 'Domain not found', HttpStatus.NOT_FOUND);
      if (d.verifiedAt) {
        const c = await tx.ssoConnection.findUnique({ where: { orgId: member.orgId } });
        const others = await tx.ssoDomain.count({ where: { orgId: member.orgId, verifiedAt: { not: null }, id: { not: d.id } } });
        if (c?.enforced && !others) throw fail('SSO_INVALID', 'This is the last verified domain while single sign-on is required; stop requiring it first');
      }
      await tx.ssoDomain.delete({ where: { id: d.id } });
      await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: 'sso.domain_removed', entityType: 'sso_domain', entityId: d.id, data: { domain: d.domain, wasVerified: !!d.verifiedAt } });
    });
    return this.overview(member);
  }

  // ------------------------------------------------------------------ sign-in

  /** The organisation whose provider signs in this email, if its domain is verified and SSO is on. */
  private async connectionFor(email: string) {
    const domain = emailDomain(email);
    return runAsSystem(async () => {
      const d = await this.prisma.ssoDomain.findFirst({ where: { domain, verifiedAt: { not: null } } });
      if (!d) return null;
      const c = await this.prisma.ssoConnection.findUnique({ where: { orgId: d.orgId } });
      return c && c.enabled ? c : null;
    });
  }

  /** Starts a sign-in: the address to send the browser to. `binding` is the random value the browser keeps in a cookie. */
  async start(email: string, binding: string) {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw fail('VALIDATION_FAILED', 'Enter your work email', HttpStatus.BAD_REQUEST);
    const c = await this.connectionFor(e);
    if (!c) throw fail('SSO_NOT_SET_UP', `Single sign-on is not set up for ${emailDomain(e)}. Sign in with your password, or ask your admin.`, HttpStatus.NOT_FOUND);
    let provider;
    try {
      provider = await discover(c.issuer, this.http);
    } catch (err) {
      if (err instanceof OidcError) throw fail('SSO_PROVIDER_UNREACHABLE', `Your organisation's identity provider could not be reached: ${err.message}`, HttpStatus.BAD_GATEWAY);
      throw err;
    }
    const now = new Date();
    const state = randomToken(32);
    const nonce = randomToken(24);
    const codeVerifier = randomToken(48);
    await runAsSystem(async () => {
      await this.prisma.ssoLoginState.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
      await this.prisma.ssoLoginState.create({ data: { id: state, orgId: c.orgId, nonce, codeVerifier, bindingHash: sha256(binding), redirectUri: this.redirectUri, expiresAt: new Date(now.getTime() + STATE_TTL_MS) } });
    });
    return { authorizationUrl: authorizationUrl(provider, { clientId: c.clientId, redirectUri: this.redirectUri, state, nonce, codeVerifier, loginHint: e }) };
  }

  /** Finishes a sign-in with what the provider sent back to the browser. */
  async finish(input: { state: string; binding: string; code?: string; error?: string; errorDescription?: string }, meta: ClientMeta) {
    const row = await runAsSystem(() => this.prisma.ssoLoginState.findUnique({ where: { id: input.state } }));
    if (!row || row.usedAt || row.expiresAt < new Date()) throw stateInvalid();
    const a = Buffer.from(row.bindingHash, 'hex');
    const b = Buffer.from(sha256(input.binding), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw stateInvalid();
    const used = await runAsSystem(() => this.prisma.ssoLoginState.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } }));
    if (used.count !== 1) throw stateInvalid();

    const orgId = row.orgId;
    const refused = async (code: string, message: string, reason: string, email: string | null = null) => {
      await runInOrg(orgId, () => this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId: null, action: 'sso.sign_in_refused', entityType: 'sso_connection', entityId: orgId, data: { reason, email, ip: meta.ip ?? null } })));
      return fail(code, message, HttpStatus.FORBIDDEN);
    };
    if (input.error) throw await refused('SSO_PROVIDER_REFUSED', `Your identity provider did not sign you in: ${(input.errorDescription || input.error).slice(0, 200)}`, `provider:${input.error.slice(0, 60)}`);
    if (!input.code) throw stateInvalid();

    const c = await runAsSystem(() => this.prisma.ssoConnection.findUnique({ where: { orgId } }));
    if (!c || !c.enabled) throw await refused('SSO_NOT_SET_UP', 'Single sign-on was turned off for your organisation', 'disabled');
    const secret = this.box.open(c.clientSecretCipher, c.clientSecretKeyId);
    if (secret === null) throw await refused('SSO_NOT_SET_UP', 'Single sign-on needs its client secret entered again by an admin', 'secret_unreadable');

    let claims;
    try {
      const provider = await discover(c.issuer, this.http);
      const idToken = await exchangeCode(provider, { clientId: c.clientId, clientSecret: secret, redirectUri: row.redirectUri, code: input.code, codeVerifier: row.codeVerifier }, this.http);
      claims = verifyIdToken(idToken, await fetchKeys(provider, this.http), { issuer: c.issuer, clientId: c.clientId, nonce: row.nonce });
    } catch (e) {
      if (e instanceof OidcError) throw await refused('SSO_TOKEN_INVALID', `The sign-in could not be checked: ${e.message}`, 'token');
      throw e;
    }
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) throw await refused('SSO_NO_EMAIL', 'Your identity provider did not send your email address. Ask your admin to include the email claim.', 'no_email');
    if (claims.email_verified === false || claims.email_verified === 'false') throw await refused('SSO_EMAIL_NOT_VERIFIED', 'Your identity provider says your email address is not verified', 'email_not_verified', email);
    const verified = await runAsSystem(() => this.prisma.ssoDomain.findFirst({ where: { orgId, domain: emailDomain(email), verifiedAt: { not: null } } }));
    if (!verified) throw await refused('SSO_DOMAIN_MISMATCH', `${emailDomain(email)} is not one of your organisation's verified domains`, 'domain', email);

    let user = await this.store.collection(users).findOne({ email });
    if (user && !user.isActive) throw await refused('ACCOUNT_DISABLED', 'This account is disabled', 'inactive', email);
    if (user?.platformRole) throw await refused('SSO_PLATFORM_ADMIN', 'Platform administrators sign in with their password and two-step sign-in', 'platform_admin', email);
    const member = user ? await runAsSystem(() => this.store.collection(memberships).findOne({ orgId, userId: user!.id })) : null;
    let joined: { id: string; role: string } | null = null;
    if (!member) {
      if (!c.autoJoinRole) throw await refused('SSO_NOT_A_MEMBER', "You are not a member of this organisation yet. Ask one of its admins to invite you.", 'not_member', email);
      const role = c.autoJoinRole as RoleName;
      const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 120) : email.slice(0, email.indexOf('@'));
      // Someone whose account is made here gets a random password nobody knows: they sign in through SSO.
      const passwordHash = user ? null : await hashPassword(randomToken(32));
      const out = await runInOrg(orgId, () =>
        this.store.transaction(async () => {
          let u = user;
          if (!u) {
            const now = new Date();
            u = await this.store.collection(users).insertOne({ email, name, passwordHash: passwordHash!, isActive: true, platformRole: null, language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null, createdAt: now, updatedAt: now });
          }
          await this.prisma.$transaction((tx) => assertMemberRoom(tx, this.store, orgId, { countOpenInvitations: false }));
          const m = await this.store.collection(memberships).insertOne({ userId: u.id, role, createdAt: new Date() });
          return { u, m };
        }),
      );
      user = out.u;
      joined = { id: out.m.id, role };
      await runInOrg(orgId, () => this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId: user!.id, action: 'sso.member_joined', entityType: 'membership', entityId: out.m.id, data: { role, newAccount: !!passwordHash } })));
    }
    const session = await this.auth.startSsoSession(user!, meta);
    await runInOrg(orgId, () => this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId: user!.id, action: 'sso.signed_in', entityType: 'session', entityId: session.sessionId, data: { issuer: c.issuer, subject: String(claims.sub).slice(0, 255), joined: !!joined, ip: meta.ip ?? null } })));
    return { ...session, orgId };
  }
}
