import { z } from 'zod';

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
