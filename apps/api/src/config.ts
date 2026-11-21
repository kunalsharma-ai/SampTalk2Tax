import { readFileSync } from 'node:fs';
import { z } from 'zod';

const RegionDirectory = z.record(
  z.string().regex(/^[a-z0-9-]{2,32}$/, 'region codes are 2-32 lowercase letters, digits or dashes'),
  z.object({ name: z.string().trim().min(1).max(80), appUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'must be http(s)') }).strict(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /**
   * MongoDB, which is replacing PostgreSQL module by module (docs/MONGODB.md). Must be a
   * replica set (one node is enough) because postings use multi-document transactions.
   */
  MONGODB_URL: z
    .string()
    .min(1, 'MONGODB_URL is required')
    .refine((u) => /^mongodb(\+srv)?:\/\//.test(u), 'MONGODB_URL must start with mongodb:// or mongodb+srv://'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Access token lifetime. Short, because a refresh token renews it. */
  JWT_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(900),
  /** Hard lifetime of a signed-in session (refresh token), in days. */
  SESSION_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  /** A session not refreshed for this many days ends. */
  SESSION_IDLE_DAYS: z.coerce.number().int().positive().max(365).default(7),
  /** Failed sign-ins for one email before it is locked, and for how long. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  /** Requests per minute per client IP on sign-in, register and refresh. */
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Requests per minute per signed-in user (or per IP when signed out) on everything else. */
  RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().positive().default(600),
  /**
   * Express "trust proxy" setting: how many proxy hops to trust for X-Forwarded-For.
   * 0 means use the socket address. Set it to the real number of proxies in front of the API.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /**
   * Encryption in transit (SEC-010). true: every request except /health must have reached
   * Talk2Tax over HTTPS (TLS ends at the proxy in front, which says so in X-Forwarded-Proto, so
   * TRUST_PROXY_HOPS must be 1 or more); others are refused with 403 HTTPS_REQUIRED. Browsers are
   * told to use HTTPS only (Strict-Transport-Security). Unset: on in production when APP_URL is https.
   */
  HTTPS_ONLY: z.enum(['true', 'false', '']).optional(),
  /**
   * The database connection must be encrypted: MONGODB_URL is mongodb+srv:// or has tls=true.
   * Unset: the same as HTTPS_ONLY. Set false only where the database is reached over a private
   * network you trust; System health then shows the connection as not encrypted.
   */
  MONGODB_REQUIRE_TLS: z.enum(['true', 'false', '']).optional(),
  /**
   * AI copilot. The copilot calls Anthropic's Claude API with this key. Without it the
   * copilot says it is not set up and sends nothing anywhere. An empty value counts as unset.
   */
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  /** Where the Claude API is reached. Leave unset for Anthropic's own endpoint; set it for a gateway, or for tests. */
  ANTHROPIC_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(z.string().url('ANTHROPIC_BASE_URL must be a URL').optional()),
  /** The Claude model the copilot uses. */
  COPILOT_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  /** Most tool calls (rounds of looking at the books) the copilot may make for one question. */
  /** Agent execution limits (SEC-037): AI tasks each agent may start per hour in one organisation, unless the organisation sets its own (0 = no default limit). */
  AI_AGENT_TASKS_PER_HOUR: z.coerce.number().int().min(0).max(100_000).default(500),
  COPILOT_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(20).default(8),
  /** Longest the copilot may spend on one answer, in seconds, across all its calls to the model. */
  COPILOT_TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(240),
  /**
   * Workflow automations. How often the runner looks for new events and due webhooks, in
   * seconds; 0 turns the background runner off (the tests drive it by hand).
   */
  WORKFLOW_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(10),
  /**
   * Continuous alerts. How often the background checker looks for organisations whose checks
   * have not run for an hour, in seconds; 0 turns it off (the tests drive it by hand).
   */
  ALERTS_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  /**
   * Lets webhooks reach http:// addresses and private, loopback and link-local networks.
   * Only for local development and tests: in production a webhook must be a public https address.
   */
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => v === 'true'),
  /** Longest a webhook delivery may take before it counts as failed, in seconds. */
  WEBHOOK_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
  /**
   * Email. The SMTP server automations send through, as smtp://user:password@host:587
   * (STARTTLS is used when the server offers it; add ?requireTLS=true to insist) or
   * smtps://user:password@host:465. Without it, email actions fail with "Email is not set up".
   */
  SMTP_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(z.string().regex(/^smtps?:\/\/[^\s]+$/, 'SMTP_URL must start with smtp:// or smtps://').optional()),
  /**
   * The same server as separate settings, as nodemailer takes them (used when SMTP_URL is not
   * set): for Zoho Mail India, SMTP_HOST=smtppro.zoho.in, SMTP_PORT=465, SMTP_SECURE=true,
   * SMTP_USER=the sender address and SMTP_PASS=its app password.
   */
  SMTP_HOST: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  /** true: TLS from the start (port 465). false: STARTTLS when the server offers it (port 587). */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SMTP_USER: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  SMTP_PASS: z.string().optional(),
  /** The sender of every email, such as "Talk2Tax <no-reply@example.com>". Needed with SMTP_URL; with SMTP_HOST it defaults to SMTP_USER. */
  EMAIL_FROM: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  /** Longest one SMTP delivery may take, in seconds. */
  SMTP_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(20),
  /**
   * Optional key that encrypts integration secrets (API keys, SMTP passwords) set up in the app.
   * When unset, a key derived from JWT_SECRET is used. Changing either means those secrets have to
   * be entered again in Settings → Integrations.
   */
  INTEGRATIONS_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(z.string().min(32, 'INTEGRATIONS_ENCRYPTION_KEY must be at least 32 characters').optional()),
  /**
   * Keys used before INTEGRATIONS_ENCRYPTION_KEY (SEC-013), comma-separated: secrets sealed with
   * them still open, until Platform admin → Encryption keys seals them again with the current key.
   * When moving off the key derived from JWT_SECRET, list the old JWT_SECRET as `jwt:<secret>`.
   */
  INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().refine((k) => (k.startsWith('jwt:') ? k.length > 4 : k.length >= 32), 'Each previous key is at least 32 characters, or jwt:<the old JWT_SECRET>'))),
  /** Days a new organisation's trial (of every module) lasts. */
  PLAN_TRIAL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /**
   * Payment gateways are set up in Platform administration → Payments (keys are stored
   * encrypted). These only point the API at another address of the gateway's API, which the
   * tests use for a local stand-in; leave them unset in production.
   */
  PAYMENTS_STRIPE_API_URL: z.string().url().default('https://api.stripe.com'),
  PAYMENTS_RAZORPAY_API_URL: z.string().url().default('https://api.razorpay.com'),
  /** Seconds to wait for a payment gateway to answer. */
  PAYMENTS_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(20),
  /** How often renewals are issued and reminders sent (seconds); 0 turns the runner off. */
  BILLING_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(3600),
  /** How often customer contracts are billed as periods fall due (seconds); 0 turns the runner off. */
  /**
   * CRM webhooks. How often new CRM events are turned into deliveries and due deliveries are sent,
   * in seconds; 0 turns the background runner off (the tests drive it by hand).
   */
  CRM_WEBHOOK_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(10),
  CONTRACT_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(3600),
  /** How often months that have ended are checked for a close to start automatically (0 turns the runner off). */
  CLOSE_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(3600),
  /** How often scheduled reports are checked for runs that are due (RPT-031; 0 turns the runner off). */
  REPORT_SCHEDULE_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(900),
  /** How often recurring journals are checked for runs that have fallen due (0 turns the runner off). */
  RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(3600),
  /** How often each organisation's data retention periods are applied (SEC-020; 0 turns the runner off). */
  /** Security event monitoring (SEC-023): how often the audit trail is checked (seconds; 0 = off), and how many locked sign-ins in an hour raise an alert. */
  SECURITY_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  SECURITY_LOCKOUT_ALERT_COUNT: z.coerce.number().int().min(1).max(10000).default(5),
  /**
   * Backups (SEC-021/022). The backup command runs outside the API; these say how old the newest
   * good backup (hours) and restore drill (days) may be before Platform admin → Backups and System
   * health say so. 0 turns the check off.
   */
  BACKUP_MAX_AGE_HOURS: z.coerce.number().int().min(0).max(8760).default(26),
  RESTORE_DRILL_MAX_AGE_DAYS: z.coerce.number().int().min(0).max(3650).default(35),
  RETENTION_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(604800).default(86400),
  /** How often recurring bills are checked for runs that have fallen due (0 turns the runner off). */
  RECURRING_BILL_RUNNER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(3600),
  /**
   * Single sign-on (SEC-006/007). Lets an organisation's OpenID Connect provider be an http://
   * address or on a private, loopback or link-local network. Only for local development and
   * tests: in production the provider must be a public https address.
   */
  SSO_ALLOW_PRIVATE_NETWORKS: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => v === 'true'),
  /**
   * DNS servers used to check sign-in domains' TXT records, as host or host:port, comma-separated.
   * Empty uses the system's resolvers.
   */
  SSO_DNS_SERVERS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)),
  /**
   * Malware scanning of uploads (SEC-019): a ClamAV daemon as tcp://host:3310. When set, every
   * uploaded file is scanned before it is kept, and if the scanner cannot answer the upload is
   * refused. When empty, files get the structural checks only.
   */
  CLAMAV_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .refine((v) => !v || /^tcp:\/\/[^/\s]+(:\d+)?\/?$/.test(v), 'CLAMAV_URL is written tcp://host:3310'),
  CLAMAV_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  /** The web app's address, used for links in emails to members. */
  APP_URL: z.string().url('APP_URL must be a URL').default('http://localhost:3000'),
  /**
   * Regional deployment. Each deployment (this API and its database) serves one region, and
   * every organisation's data lives in the region it was created in. A short code such as
   * "in-mumbai" or "eu-frankfurt".
   */
  DEPLOYMENT_REGION: z.string().trim().regex(/^[a-z0-9-]{2,32}$/, 'DEPLOYMENT_REGION must be 2-32 lowercase letters, digits or dashes').default('local'),
  /** The region's name as people read it, such as "India (Mumbai)". */
  DEPLOYMENT_REGION_NAME: z.string().trim().min(1).max(80).default('Local server'),
  /**
   * The other regions, as JSON: {"eu-frankfurt":{"name":"European Union (Frankfurt)","appUrl":"https://eu.example.com"}}.
   * People whose organisation lives elsewhere are pointed to its region's app.
   */
  REGION_DIRECTORY: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || !v.trim()) return {} as Record<string, { name: string; appUrl: string }>;
      let raw: unknown;
      try {
        raw = JSON.parse(v);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'REGION_DIRECTORY must be JSON' });
        return z.NEVER;
      }
      const parsed = RegionDirectory.safeParse(raw);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: `REGION_DIRECTORY: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` });
        return z.NEVER;
      }
      return parsed.data;
    }),
}).transform((c) => {
  const httpsOnly = c.HTTPS_ONLY === 'true' || (!c.HTTPS_ONLY && c.NODE_ENV === 'production' && c.APP_URL.startsWith('https://'));
  const mongoTls = c.MONGODB_REQUIRE_TLS === 'true' || (!c.MONGODB_REQUIRE_TLS && httpsOnly);
  return { ...c, HTTPS_ONLY: httpsOnly, MONGODB_REQUIRE_TLS: mongoTls };
}).superRefine((c, ctx) => {
  if (c.HTTPS_ONLY && c.TRUST_PROXY_HOPS === 0) ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY_HOPS'], message: 'HTTPS_ONLY needs TRUST_PROXY_HOPS of 1 or more: TLS ends at the proxy in front of the API, which reports it in X-Forwarded-Proto' });
  if (c.MONGODB_REQUIRE_TLS && !mongoUsesTls(c.MONGODB_URL)) ctx.addIssue({ code: 'custom', path: ['MONGODB_URL'], message: 'The database connection must be encrypted: use mongodb+srv:// or add tls=true to MONGODB_URL (or set MONGODB_REQUIRE_TLS=false for a private network you trust)' });
  if (c.SMTP_URL && !c.EMAIL_FROM) ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message: 'EMAIL_FROM is required when SMTP_URL is set' });
  if (!c.SMTP_URL && c.SMTP_HOST && !c.EMAIL_FROM && !c.SMTP_USER) ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message: 'EMAIL_FROM (or SMTP_USER) is required when SMTP_HOST is set' });
  if (c.SMTP_USER && !c.SMTP_PASS) ctx.addIssue({ code: 'custom', path: ['SMTP_PASS'], message: 'SMTP_PASS is required with SMTP_USER' });
});

/** Whether a MongoDB connection string encrypts the connection (mongodb+srv:// does unless tls=false). */
export function mongoUsesTls(url: string): boolean {
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  const flag = (q.get('tls') ?? q.get('ssl'))?.toLowerCase();
  if (flag) return flag === 'true';
  return url.startsWith('mongodb+srv://');
}

export type AppConfig = z.infer<typeof schema>;

let cached: LoadedConfig | undefined;

/**
 * Secrets management (SEC-012): the settings that are secrets. Each can be given directly, or as
 * <NAME>_FILE, the path of a file holding it (Docker and Kubernetes secrets, or a file a secrets
 * manager's agent writes), so the value never has to sit in the environment or a compose file.
 */
export const SECRET_SETTINGS = ['JWT_SECRET', 'MONGODB_URL', 'INTEGRATIONS_ENCRYPTION_KEY', 'INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS', 'ANTHROPIC_API_KEY', 'SMTP_URL', 'SMTP_PASS', 'BACKUP_ENCRYPTION_KEY'] as const;
export type SecretSetting = (typeof SECRET_SETTINGS)[number];
export type SecretSource = 'ENVIRONMENT' | 'FILE';

/** The environment with every <NAME>_FILE read into <NAME>, and where each secret came from. */
export function resolveSecretFiles(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; sources: Partial<Record<SecretSetting, SecretSource>>; errors: string[] } {
  const out: NodeJS.ProcessEnv = { ...env };
  const sources: Partial<Record<SecretSetting, SecretSource>> = {};
  const errors: string[] = [];
  for (const name of SECRET_SETTINGS) {
    const path = env[`${name}_FILE`]?.trim();
    const direct = env[name];
    if (path) {
      if (direct !== undefined && direct !== '') {
        errors.push(`${name}: set ${name} or ${name}_FILE, not both`);
        continue;
      }
      try {
        out[name] = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
        sources[name] = 'FILE';
      } catch (e) {
        errors.push(`${name}_FILE: cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
      }
    } else if (direct !== undefined && direct !== '') sources[name] = 'ENVIRONMENT';
  }
  return { env: out, sources, errors };
}

/** Values from the examples and tests that must never protect a production server. */
const EXAMPLE_SECRET = /replace-me|ci-only|test-secret|changeme|change-me|example|password|secret{2,}/i;

/** Why a production secret is unsafe, or null. */
export function weakSecret(value: string): string | null {
  if (EXAMPLE_SECRET.test(value)) return 'is an example value';
  if (new Set(value).size < 10) return 'repeats too few characters to be random';
  return null;
}

export type LoadedConfig = AppConfig & { SECRET_SOURCES: Partial<Record<SecretSetting, SecretSource>> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  if (cached && env === process.env) return cached;
  const files = resolveSecretFiles(env);
  const parsed = schema.safeParse(files.env);
  const issues = [...files.errors, ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))];
  if (parsed.success && parsed.data.NODE_ENV === 'production') {
    const c = parsed.data;
    const jwt = weakSecret(c.JWT_SECRET);
    if (jwt) issues.push(`JWT_SECRET ${jwt}: generate one with openssl rand -hex 32`);
    if (c.INTEGRATIONS_ENCRYPTION_KEY) {
      const k = weakSecret(c.INTEGRATIONS_ENCRYPTION_KEY);
      if (k) issues.push(`INTEGRATIONS_ENCRYPTION_KEY ${k}: generate one with openssl rand -hex 32`);
      if (c.INTEGRATIONS_ENCRYPTION_KEY === c.JWT_SECRET) issues.push('INTEGRATIONS_ENCRYPTION_KEY must differ from JWT_SECRET');
    }
  }
  if (issues.length || !parsed.success) throw new Error(`Invalid configuration: ${issues.join('; ')}`);
  const loaded: LoadedConfig = { ...parsed.data, SECRET_SOURCES: files.sources };
  if (env === process.env) cached = loaded;
  return loaded;
}

export const CONFIG = Symbol('CONFIG');
