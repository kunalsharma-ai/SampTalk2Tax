import { totpCode, totpStep } from '@talk2tax/security';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { bootApp, Ctx } from './helpers';

/**
 * Known devices (SEC-009) against the real API and database: devices recognised by the web app's
 * key, an alert emailed for a sign-in from a new device (not for the first one), trusting the
 * device in use so two-step sign-in skips the code there, trusting it while entering a code,
 * stopping trust, forgetting a device (its sessions signed out, an alert again next time), and
 * keeping each person to their own devices.
 */
const PASSWORD = 'a-very-long-test-password';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
let ctx: Ctx;
let smtp: SmtpStandIn;
const key = () => randomBytes(24).toString('base64url');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const register = async (device: string) => {
  const email = `${randomBytes(6).toString('hex')}@example.test`;
  const r = await ctx.http().post('/v1/auth/register').set({ 'x-t2t-device': device, 'user-agent': CHROME_WIN }).send({ email, name: 'Device Owner', password: PASSWORD }).expect(201);
  return { id: r.body.user.id as string, email, token: r.body.accessToken as string };
};
const login = (email: string, device: string | null, ua = SAFARI_IOS) => ctx.http().post('/v1/auth/login').set({ ...(device ? { 'x-t2t-device': device } : {}), 'user-agent': ua }).send({ email, password: PASSWORD });
const alertsTo = (email: string) => smtp.messages.filter((m) => m.to?.includes(email) && m.subject === 'New sign-in to your Talk2Tax account');
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
};
const nextCode = async (userId: string, secret: string) => {
  const row = await ctx.db.collection('user_mfa').findOne({ _id: userId as never });
  return totpCode(secret, Math.max(totpStep(), (row?.lastStep ?? -1) + 1) * 30_000);
};

beforeAll(async () => {
  smtp = await startSmtpStandIn();
  ctx = await bootApp({ SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, EMAIL_FROM: 'Talk2Tax <robot@talk2tax.test>' });
});
afterAll(async () => {
  await ctx?.app.close();
  await smtp?.close();
});

describe('known devices', () => {
  it('knows the first device without an alert, and emails a sign-in from a new one', async () => {
    const laptop = key();
    const phone = key();
    const u = await register(laptop);
    let devices = (await ctx.http().get('/v1/auth/devices').set(auth(u.token)).expect(200)).body;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ label: 'Chrome on Windows', current: true, trustedUntil: null, signedIn: 1 });

    // The same device again: no alert.
    await login(u.email, laptop, CHROME_WIN).expect(200);
    // A sign-in without a key (an API client) is not a device.
    await login(u.email, null).expect(200);
    // A key in the wrong shape is ignored too.
    await login(u.email, 'short').expect(200);
    expect((await ctx.http().get('/v1/auth/devices').set(auth(u.token)).expect(200)).body).toHaveLength(1);

    const p = await login(u.email, phone).expect(200);
    await waitFor(() => alertsTo(u.email).length > 0);
    const alerts = alertsTo(u.email);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain('Device: Safari on iOS');
    expect(alerts[0]!.text).toContain('/account');
    devices = (await ctx.http().get('/v1/auth/devices').set(auth(p.body.accessToken)).expect(200)).body;
    expect(devices.map((d: { label: string; current: boolean }) => [d.label, d.current])).toEqual([
      ['Safari on iOS', true],
      ['Chrome on Windows', false],
    ]);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'session.new_device', actorId: u.id } });
    expect(audit?.data).toMatchObject({ label: 'Safari on iOS' });
    // Only a hash of the key is kept.
    expect(JSON.stringify(await ctx.db.collection('known_devices').find({ userId: u.id }).toArray())).not.toContain(phone);
  });

  it('trusts a device so two-step sign-in skips the code there, and only there', async () => {
    const laptop = key();
    const phone = key();
    const u = await register(laptop);
    const setup = await ctx.http().post('/v1/auth/mfa/setup').set(auth(u.token)).send({ password: PASSWORD }).expect(200);
    await ctx.http().post('/v1/auth/mfa/confirm').set(auth(u.token)).send({ code: totpCode(setup.body.secret) }).expect(200);
    expect((await login(u.email, laptop).expect(200)).body.mfaRequired).toBe(true);

    const trusted = (await ctx.http().post('/v1/auth/devices/current/trust').set(auth(u.token)).expect(200)).body;
    expect(Date.parse(trusted[0].trustedUntil) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const r = await login(u.email, laptop).expect(200);
    expect(r.body.accessToken).toBeTruthy();
    const ev = await ctx.prisma.auditEvent.findFirst({ where: { action: 'session.created', entityId: r.body.sessionId } });
    expect(ev?.data).toMatchObject({ secondStep: 'TRUSTED_DEVICE' });
    // Another device still needs the code; trusting it while entering the code.
    const challenge = (await login(u.email, phone).expect(200)).body;
    expect(challenge.mfaRequired).toBe(true);
    await ctx.http().post('/v1/auth/login/code').set({ 'x-t2t-device': phone, 'user-agent': SAFARI_IOS }).send({ challengeToken: challenge.challengeToken, code: await nextCode(u.id, setup.body.secret), trustDevice: true }).expect(200);
    expect((await login(u.email, phone).expect(200)).body.accessToken).toBeTruthy();

    // Stop trusting the laptop: the code is needed there again.
    const laptopId = trusted[0].id;
    const after = (await ctx.http().delete(`/v1/auth/devices/${laptopId}/trust`).set(auth(u.token)).expect(200)).body;
    expect(after.find((d: { id: string }) => d.id === laptopId).trustedUntil).toBeNull();
    expect((await login(u.email, laptop).expect(200)).body.mfaRequired).toBe(true);
  });

  it('forgets a device: signs it out, and alerts again when it comes back', async () => {
    const laptop = key();
    const phone = key();
    const u = await register(laptop);
    const p = await login(u.email, phone).expect(200);
    await waitFor(() => alertsTo(u.email).length > 0);
    const phoneId = (await ctx.http().get('/v1/auth/devices').set(auth(u.token)).expect(200)).body.find((d: { label: string }) => d.label === 'Safari on iOS').id;
    // The device in use cannot be forgotten.
    expect((await ctx.http().delete(`/v1/auth/devices/${phoneId}`).set(auth(p.body.accessToken)).expect(422)).body.error).toBe('CURRENT_DEVICE');
    const left = (await ctx.http().delete(`/v1/auth/devices/${phoneId}`).set(auth(u.token)).expect(200)).body;
    expect(left).toHaveLength(1);
    await ctx.http().get('/v1/auth/devices').set(auth(p.body.accessToken)).expect(401);
    await login(u.email, phone).expect(200);
    await waitFor(() => alertsTo(u.email).length > 1);
    expect(alertsTo(u.email)).toHaveLength(2);
  });

  it('keeps each person to their own devices, and trusts only a known device', async () => {
    const a = await register(key());
    const b = await register(key());
    const bDevice = (await ctx.http().get('/v1/auth/devices').set(auth(b.token)).expect(200)).body[0].id;
    await ctx.http().delete(`/v1/auth/devices/${bDevice}`).set(auth(a.token)).expect(404);
    await ctx.http().delete(`/v1/auth/devices/${bDevice}/trust`).set(auth(a.token)).expect(404);
    const keyless = await login(a.email, null).expect(200);
    expect((await ctx.http().post('/v1/auth/devices/current/trust').set(auth(keyless.body.accessToken)).expect(422)).body.error).toBe('NO_DEVICE');
  });
});
