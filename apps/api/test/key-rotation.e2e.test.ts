import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { SecretBox } from '../src/integrations/secret-box';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Encryption key rotation (SEC-013) against the real API and database. Secrets are entered while
 * the server uses an old key; the server moves to a new key with the old one listed as previous,
 * so they still open; re-encrypting seals them with the new key; and the old key can then go.
 * Each run uses its own random keys, so other tests' secrets are only ever counted, never changed.
 */
const OLD = randomBytes(24).toString('hex');
const NEW = randomBytes(24).toString('hex');
const oldBox = new SecretBox({ encryptionKey: OLD, jwtSecret: '' });
const newBox = new SecretBox({ encryptionKey: NEW, jwtSecret: '' });
const AI_KEY = 'sk-ant-rotation-test-ABCD';

let before: Ctx;
let during: Ctx;
let afterwards: Ctx;
let admin: TestUser;
let support: TestUser;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
type Report = { currentKeyId: string; previousKeyIds: string[]; stores: { key: string; current: number; previous: number; unreadable: number }[]; totals: { current: number; previous: number; unreadable: number } };
const store = (r: Report, key: string) => r.stores.find((s) => s.key === key)!;

beforeAll(async () => {
  before = await bootApp({ INTEGRATIONS_ENCRYPTION_KEY: OLD });
  admin = await registerUser(before, 'Keys Admin');
  support = await registerUser(before, 'Keys Support');
  owner = await registerUser(before, 'Keys Owner');
  await before.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await before.app.get(AdminService).grant(support.email, 'SUPPORT');
  org = await createOrg(before, owner, { name: 'Key Rotation Ltd' });
  await before.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ apiKey: AI_KEY, model: 'claude-sonnet-5-5', enabled: true }).expect(200);
  // An active authenticator sealed with the old key (written directly: the app would need a code from a phone).
  const sealed = oldBox.seal('JBSWY3DPEHPK3PXP');
  await before.db.collection('user_mfa').insertOne({ _id: owner.id as never, status: 'ACTIVE', secretCipher: sealed.cipher, keyId: sealed.keyId, lastStep: null, recoveryCodes: [], enabledAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  during = await bootApp({ INTEGRATIONS_ENCRYPTION_KEY: NEW, INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS: ` ${OLD} ` });
  afterwards = await bootApp({ INTEGRATIONS_ENCRYPTION_KEY: NEW });
});
afterAll(async () => {
  await before?.db.collection('user_mfa').deleteOne({ _id: owner?.id as never });
  await before?.app.close();
  await during?.app.close();
  await afterwards?.app.close();
});

describe('encryption key rotation', () => {
  it('reports what each key sealed, to platform administrators only', async () => {
    await during.http().get('/v1/admin/encryption-keys').set(owner.auth).expect(403);
    const r = (await during.http().get('/v1/admin/encryption-keys').set(support.auth).expect(200)).body as Report;
    expect(r.currentKeyId).toBe(newBox.keyId);
    expect(r.previousKeyIds).toEqual([oldBox.keyId]);
    expect(store(r, 'integrations').previous).toBeGreaterThanOrEqual(1);
    expect(store(r, 'two-step').previous).toBeGreaterThanOrEqual(1);
    expect(r.stores.map((s) => s.key)).toEqual(['integrations', 'org-gateways', 'platform-gateways', 'crm-webhooks', 'two-step']);
  });

  it('keeps secrets sealed with a listed previous key working, and not the others', async () => {
    const view = (await during.http().get(`${org.base}/integrations`).set(owner.auth).expect(200)).body;
    expect(view.ai).toMatchObject({ configured: true, secretUnreadable: false, secretHint: '…ABCD' });
    // Without the old key listed, the same secret cannot be opened and has to be entered again.
    expect((await afterwards.http().get(`${org.base}/integrations`).set(owner.auth).expect(200)).body.ai.secretUnreadable).toBe(true);
  });

  it('re-encrypts every secret it can open with the current key, and audits it', async () => {
    await during.http().post('/v1/admin/encryption-keys/reseal').set(support.auth).expect(403);
    const r = (await during.http().post('/v1/admin/encryption-keys/reseal').set(admin.auth).expect(200)).body as Report & { resealed: Record<string, number> };
    expect(r.resealed.integrations).toBeGreaterThanOrEqual(1);
    expect(r.resealed['two-step']).toBeGreaterThanOrEqual(1);
    expect(r.totals.previous).toBe(0);
    const row = await during.prisma.orgIntegration.findFirstOrThrow({ where: { orgId: org.orgId, kind: 'AI_ANTHROPIC' } });
    expect(row.keyId).toBe(newBox.keyId);
    expect(newBox.open(row.secretCipher!, row.keyId!)).toBe(AI_KEY);
    const mfa = await during.db.collection('user_mfa').findOne({ _id: owner.id as never });
    expect(mfa).toMatchObject({ status: 'ACTIVE', keyId: newBox.keyId });
    expect(newBox.open(mfa!.secretCipher, mfa!.keyId)).toBe('JBSWY3DPEHPK3PXP');
    const audit = await during.prisma.auditEvent.findMany({ where: { action: 'platform.secrets_resealed', actorId: admin.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ keyId: newBox.keyId });
    expect(JSON.stringify(audit[0]!.data)).not.toContain(AI_KEY);
  });

  it('works without the old key afterwards', async () => {
    expect((await afterwards.http().get(`${org.base}/integrations`).set(owner.auth).expect(200)).body.ai).toMatchObject({ configured: true, secretUnreadable: false });
    const r = (await afterwards.http().get('/v1/admin/encryption-keys').set(admin.auth).expect(200)).body as Report;
    expect(r.previousKeyIds).toEqual([]);
  });

  it('refuses a previous key that is too short', async () => {
    await expect(bootApp({ INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS: 'short' })).rejects.toThrow(/at least 32 characters/);
  });
});
