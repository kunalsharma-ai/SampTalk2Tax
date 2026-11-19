import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { loadConfig, resolveSecretFiles, weakSecret } from '../src/config';
import { main } from '../src/db/backup';
import { bootApp, Ctx, registerUser } from './helpers';

/**
 * Secrets management (SEC-012), against the real API and database: every secret can be read from
 * a file (NAME_FILE, as Docker and Kubernetes mount secrets), never from both places at once; a
 * production server refuses example or reused secrets; and System health shows where each secret
 * came from without showing any value.
 */
const strong = () => randomBytes(32).toString('hex');
const base = { NODE_ENV: 'production', MONGODB_URL: 'mongodb://localhost:27017/x?replicaSet=rs0', APP_URL: 'http://localhost:3000' };
let dir: string;
let ctx: Ctx;
let jwt: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 't2t-secrets-'));
  jwt = strong();
  // As a mounted secret: one line with a trailing newline.
  await fs.writeFile(join(dir, 'jwt'), `${jwt}\n`, { mode: 0o600 });
  ctx = await bootApp({ JWT_SECRET: '', JWT_SECRET_FILE: join(dir, 'jwt') });
});
afterAll(async () => {
  await ctx?.app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('secret files', () => {
  it('reads NAME_FILE, refuses both at once, and says which file cannot be read', async () => {
    const r = resolveSecretFiles({ JWT_SECRET_FILE: join(dir, 'jwt'), SMTP_PASS: 'from-env' });
    expect(r.env.JWT_SECRET).toBe(jwt);
    expect(r.sources).toEqual({ JWT_SECRET: 'FILE', SMTP_PASS: 'ENVIRONMENT' });
    expect(r.errors).toEqual([]);
    expect(() => loadConfig({ ...base, JWT_SECRET: strong(), JWT_SECRET_FILE: join(dir, 'jwt') })).toThrow(/JWT_SECRET: set JWT_SECRET or JWT_SECRET_FILE, not both/);
    expect(() => loadConfig({ ...base, JWT_SECRET_FILE: join(dir, 'missing') })).toThrow(/JWT_SECRET_FILE: cannot read .*missing \(ENOENT\)/);
    const c = loadConfig({ ...base, JWT_SECRET_FILE: join(dir, 'jwt') });
    expect(c.JWT_SECRET).toBe(jwt);
    expect(c.SECRET_SOURCES.JWT_SECRET).toBe('FILE');
  });

  it('refuses example and reused secrets in production only', () => {
    expect(weakSecret('ci-only-secret-that-is-at-least-32-characters-long')).toMatch(/example/);
    expect(weakSecret('a'.repeat(40))).toMatch(/too few characters/);
    expect(weakSecret(strong())).toBeNull();
    expect(() => loadConfig({ ...base, JWT_SECRET: 'replace-me-with-a-long-random-string-of-32-chars' })).toThrow(/JWT_SECRET is an example value: generate one with openssl rand -hex 32/);
    expect(() => loadConfig({ ...base, JWT_SECRET: strong(), INTEGRATIONS_ENCRYPTION_KEY: 'b'.repeat(40) })).toThrow(/INTEGRATIONS_ENCRYPTION_KEY repeats too few/);
    const same = strong();
    expect(() => loadConfig({ ...base, JWT_SECRET: same, INTEGRATIONS_ENCRYPTION_KEY: same })).toThrow(/must differ from JWT_SECRET/);
    // Development and tests keep their example values.
    expect(loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: 'replace-me-with-a-long-random-string-of-32-chars' }).JWT_SECRET).toMatch(/^replace-me/);
  });

  it('lets the backup command read its key from a file', async () => {
    await fs.writeFile(join(dir, 'bk'), 'a-backup-key-from-a-file-only\n');
    await expect(main(['create', '--out', dir], { MONGODB_URL: 'mongodb://localhost:1/x', BACKUP_ENCRYPTION_KEY: 'k'.repeat(20), BACKUP_ENCRYPTION_KEY_FILE: join(dir, 'bk') })).rejects.toThrow(/not both/);
    await expect(main(['create', '--out', dir], { MONGODB_URL: 'mongodb://localhost:1/x', BACKUP_ENCRYPTION_KEY_FILE: join(dir, 'nope') })).rejects.toThrow(/BACKUP_ENCRYPTION_KEY_FILE: cannot read/);
  });
});

describe('System health', () => {
  it('shows where each secret came from, and never a value', async () => {
    const admin = await registerUser(ctx, 'Secrets Admin');
    await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
    const res = await ctx.http().get('/v1/admin/system').set(admin.auth).expect(200);
    const s = res.body.secrets;
    expect(s.items.map((i: { name: string }) => i.name)).toEqual(['JWT_SECRET', 'MONGODB_URL', 'INTEGRATIONS_ENCRYPTION_KEY', 'INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS', 'ANTHROPIC_API_KEY', 'SMTP_URL', 'SMTP_PASS']);
    expect(s.items[0]).toEqual({ name: 'JWT_SECRET', set: true, source: 'FILE' });
    expect(s.items[1]).toMatchObject({ name: 'MONGODB_URL', set: true, source: 'ENVIRONMENT' });
    expect(s.fromFiles).toBeGreaterThanOrEqual(1);
    if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) expect(s.items[2]).toEqual({ name: 'INTEGRATIONS_ENCRYPTION_KEY', set: true, source: 'DERIVED' });
    expect(JSON.stringify(res.body)).not.toContain(jwt);
    // Not for anyone else.
    const owner = await registerUser(ctx, `Owner ${randomUUID().slice(0, 6)}`);
    await ctx.http().get('/v1/admin/system').set(owner.auth).expect(403);
  });
});
