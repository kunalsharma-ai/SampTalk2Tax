import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { authSessions, knownDevices } from '../db/collections/identity';
import { MailerService } from '../workflows/email';
import { ClientMeta, SessionsService } from './sessions.service';

const DAY_MS = 86_400_000;
/** How long trusting a device skips the two-step code there. */
export const TRUST_DAYS = 30;
/** The web app's device key: random, URL-safe. Anything else is treated as no key. */
const KEY = /^[A-Za-z0-9_-]{22,100}$/;

/** A readable name for a browser's user agent, as the web app shows it. Display only. */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return (browser ?? os ?? ua.slice(0, 60)) || 'Unknown device';
}

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export interface SeenDevice {
  id: string;
  label: string;
  /** First sign-in from this device by a person who already had another one. */
  isNew: boolean;
}

/**
 * The devices a person signs in from (SEC-009): recognised by the key the web app keeps in an
 * httpOnly cookie. A sign-in from a new device, once the person has another one, is recorded and
 * emailed to them. A device they trust skips the two-step code for 30 days.
 */
@Injectable()
export class DevicesService {
  private readonly log = new Logger(DevicesService.name);

  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private keyOf(meta: ClientMeta): string | null {
    return meta.deviceKey && KEY.test(meta.deviceKey) ? meta.deviceKey : null;
  }

  /** Records the sign-in on its device. Without a device key (API clients), there is no device. */
  async seen(userId: string, meta: ClientMeta): Promise<SeenDevice | null> {
    const key = this.keyOf(meta);
    if (!key) return null;
    const keyHash = hashKey(key);
    const now = new Date();
    const col = this.store.collection(knownDevices);
    const found = await col.findOne({ userId, keyHash });
    if (found) {
      await col.updateOne({ id: found.id }, { $set: { lastSeenAt: now, lastIp: meta.ip?.slice(0, 64) || null } });
      return { id: found.id, label: found.label, isNew: false };
    }
    const hadOthers = await col.exists({ userId });
    const label = deviceLabel(meta.userAgent).slice(0, 120);
    const d = await col.insertOne({ userId, keyHash, label, userAgent: meta.userAgent?.slice(0, 300) || null, firstSeenAt: now, lastSeenAt: now, lastIp: meta.ip?.slice(0, 64) || null, trustedUntil: null });
    return { id: d.id, label, isNew: hadOthers };
  }

  /** Whether this sign-in comes from a device the person trusts, so the two-step code is skipped. */
  async trusted(userId: string, meta: ClientMeta): Promise<boolean> {
    const key = this.keyOf(meta);
    if (!key) return false;
    const d = await this.store.collection(knownDevices).findOne({ userId, keyHash: hashKey(key) });
    return !!d?.trustedUntil && d.trustedUntil > new Date();
  }

  /** Records a sign-in from a new device and emails the person; the email never holds up signing in. */
  async alertNew(user: { id: string; email: string; name: string }, device: SeenDevice, meta: ClientMeta): Promise<void> {
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: user.id, action: 'session.new_device', entityType: 'device', entityId: device.id, data: { label: device.label, ip: meta.ip ?? null } }));
    const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const text = [
      `Hello ${user.name},`,
      '',
      `Your Talk2Tax account was just signed in to from a device it has not seen before:`,
      '',
      `  Device: ${device.label}`,
      `  Address: ${meta.ip ?? 'unknown'}`,
      `  Time: ${when} (India time)`,
      '',
      'If this was you, there is nothing to do.',
      `If it was not, change your password now and sign that device out: ${this.config.APP_URL.replace(/\/$/, '')}/account`,
      '',
      'Talk2Tax',
    ].join('\n');
    void this.mailer
      .sendAsTalk2Tax({ to: [user.email], subject: 'New sign-in to your Talk2Tax account', text, messageId: `<new-device-${device.id}@talk2tax>`, branded: true })
      .then((r) => {
        if (!r.ok) this.log.warn(`New-device alert for ${device.id} not sent: ${r.error}`);
      })
      .catch((e: Error) => this.log.warn(`New-device alert for ${device.id} not sent: ${e.message}`));
  }

  /** The person's devices, newest first, marking the one this session is on. */
  async list(userId: string, currentSessionId: string) {
    const rows = await this.store.collection(knownDevices).find({ userId }, { sort: { lastSeenAt: -1 } });
    const current = await this.store.collection(authSessions).findById(currentSessionId);
    const live = await this.store.collection(authSessions).find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } });
    const now = new Date();
    return rows.map((d) => ({
      id: d.id,
      label: d.label,
      firstSeenAt: d.firstSeenAt.toISOString(),
      lastSeenAt: d.lastSeenAt.toISOString(),
      lastIp: d.lastIp,
      trustedUntil: d.trustedUntil && d.trustedUntil > now ? d.trustedUntil.toISOString() : null,
      current: !!current?.deviceId && current.deviceId === d.id,
      signedIn: live.filter((s) => s.deviceId === d.id).length,
    }));
  }

  private async own(userId: string, deviceId: string) {
    const d = await this.store.collection(knownDevices).findById(deviceId);
    if (!d || d.userId !== userId) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Device not found' });
    return d;
  }

  /** Trusts the device this session is on for 30 days. Only the device itself can be trusted. */
  async trustCurrent(userId: string, currentSessionId: string) {
    const s = await this.store.collection(authSessions).findById(currentSessionId);
    if (!s?.deviceId) throw new UnprocessableEntityException({ error: 'NO_DEVICE', message: 'This sign-in is not from a known device; sign out and in again from the web app to trust it' });
    const d = await this.own(userId, s.deviceId);
    const trustedUntil = new Date(Date.now() + TRUST_DAYS * DAY_MS);
    await this.store.collection(knownDevices).updateOne({ id: d.id }, { $set: { trustedUntil } });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: userId, action: 'device.trusted', entityType: 'device', entityId: d.id, data: { label: d.label, until: trustedUntil.toISOString() } }));
    return this.list(userId, currentSessionId);
  }

  /** Trusts a device as part of signing in with a code (the session is not made yet). */
  async trustOnSignIn(userId: string, deviceId: string) {
    const trustedUntil = new Date(Date.now() + TRUST_DAYS * DAY_MS);
    await this.store.collection(knownDevices).updateOne({ id: deviceId, userId }, { $set: { trustedUntil } });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: userId, action: 'device.trusted', entityType: 'device', entityId: deviceId, data: { until: trustedUntil.toISOString(), onSignIn: true } }));
  }

  async untrust(userId: string, deviceId: string, currentSessionId: string) {
    const d = await this.own(userId, deviceId);
    await this.store.collection(knownDevices).updateOne({ id: d.id }, { $set: { trustedUntil: null } });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: userId, action: 'device.untrusted', entityType: 'device', entityId: d.id, data: { label: d.label } }));
    return this.list(userId, currentSessionId);
  }

  /**
   * Forgets a device: its sessions are signed out and it is no longer trusted. Signing in there
   * again counts as a new device, with an alert. The device this session is on cannot be forgotten.
   */
  async forget(userId: string, deviceId: string, currentSessionId: string) {
    const d = await this.own(userId, deviceId);
    const current = await this.store.collection(authSessions).findById(currentSessionId);
    if (current?.deviceId === d.id) throw new UnprocessableEntityException({ error: 'CURRENT_DEVICE', message: 'This is the device you are using; sign out instead' });
    const live = await this.store.collection(authSessions).find({ userId, deviceId: d.id, revokedAt: null });
    for (const s of live) await this.sessions.revokeOne(userId, s.id);
    await this.store.collection(knownDevices).deleteOne({ id: d.id });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: userId, action: 'device.forgotten', entityType: 'device', entityId: d.id, data: { label: d.label, signedOut: live.length } }));
    return this.list(userId, currentSessionId);
  }
}
