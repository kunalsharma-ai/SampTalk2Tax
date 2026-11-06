import { z } from 'zod';

const RegionDirectory = z.record(
  z.string().regex(/^[a-z0-9-]{2,32}$/, 'region codes are 2-32 lowercase letters, digits or dashes'),
  z.object({ name: z.string().trim().min(1).max(80), appUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'must be http(s)') }).strict(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
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
  /** The sender of every email, such as "Talk2Tax <no-reply@example.com>". Needed with SMTP_URL. */
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
}).superRefine((c, ctx) => {
  if (c.SMTP_URL && !c.EMAIL_FROM) ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message: 'EMAIL_FROM is required when SMTP_URL is set' });
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}

export const CONFIG = Symbol('CONFIG');
