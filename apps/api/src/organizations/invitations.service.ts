import { assertMemberRoom } from '../billing/limits';
import { ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { canAssignRole, RoleName } from '@talk2tax/security';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, useOrgInTx } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { users } from '../db/collections/identity';
import { invitations, memberships, organizations } from '../db/collections/tenancy';
import { PostgresMirrorService } from '../db/postgres-mirror.service';

const INVITE_TTL_MS = 7 * 86_400_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface Actor {
  id: string;
  role: RoleName;
}

type InvitationStatus = 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'REVOKED';

function statusOf(i: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now = new Date()): InvitationStatus {
  if (i.acceptedAt) return 'ACCEPTED';
  if (i.revokedAt) return 'REVOKED';
  return i.expiresAt <= now ? 'EXPIRED' : 'PENDING';
}

function forbidRole(actor: Actor, role: RoleName) {
  if (!canAssignRole(actor.role, role)) throw new ForbiddenException({ error: 'FORBIDDEN', message: `A ${actor.role.toLowerCase()} cannot grant the ${role.toLowerCase()} role` });
}

/**
 * Invitations and membership changes, kept in MongoDB. Talk2Tax does not send email yet:
 * creating or renewing an invitation returns a one-time link token for the inviter to share.
 * Membership changes are copied to PostgreSQL and audited there right after they are made.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
  ) {}

  private get invites() {
    return this.store.collection(invitations);
  }

  private get members() {
    return this.store.collection(memberships);
  }

  private newToken() {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: hash(token) };
  }

  private serialize(i: { id: string; email: string; role: string; createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; invitedBy?: { name: string } | null }) {
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      status: statusOf(i),
      invitedBy: i.invitedBy?.name ?? null,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
      acceptedAt: i.acceptedAt?.toISOString() ?? null,
      revokedAt: i.revokedAt?.toISOString() ?? null,
    };
  }

  private audited(orgId: string, event: Parameters<AuditService['append']>[1], membershipIds: string[] = []) {
    return this.prisma.$transaction(async (tx) => {
      if (membershipIds.length) await this.mirror.memberships(membershipIds, tx);
      // Accept and preview routes carry no organisation in their path; the audit row is this org's.
      await useOrgInTx(tx, orgId);
      await this.audit.append(tx, event);
    });
  }

  async list(orgId: string) {
    const rows = await runInOrg(orgId, () => this.invites.find({}, { sort: { createdAt: -1 }, limit: 100 }));
    const inviters = await this.store.collection(users).find({ id: { $in: [...new Set(rows.map((r) => r.invitedById))] } });
    const names = new Map(inviters.map((u) => [u.id, u]));
    return rows.map((r) => this.serialize({ ...r, invitedBy: names.get(r.invitedById) ?? null }));
  }

  async create(orgId: string, actor: Actor, input: { email: string; role: RoleName }) {
    forbidRole(actor, input.role);
    const email = input.email.trim().toLowerCase();
    const person = await this.store.collection(users).findOne({ email });
    const created = await runInOrg(orgId, () =>
      this.store.transaction(async () => {
        if (person && (await this.members.exists({ userId: person.id }))) throw new ConflictException({ error: 'ALREADY_MEMBER', message: 'That person is already a member' });
        const open = await this.invites.findOne({ openFor: email });
        if (open && open.expiresAt > new Date()) {
          throw new ConflictException({ error: 'INVITE_EXISTS', message: 'There is already an open invitation for this email. Create a new link for it or revoke it.' });
        }
        if (open) await this.invites.updateOne({ id: open.id }, { $set: { revokedAt: new Date(), revokedById: actor.id }, $unset: { openFor: '' } });
        await this.prisma.$transaction((tx) => assertMemberRoom(tx, this.store, orgId, { countOpenInvitations: true }));
        const { token, tokenHash } = this.newToken();
        const now = new Date();
        const inv = await this.invites.insertOne({
          email,
          role: input.role,
          tokenHash,
          invitedById: actor.id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          acceptedAt: null,
          acceptedById: null,
          revokedAt: null,
          revokedById: null,
          openFor: email,
        });
        return { inv, token };
      }),
    ).catch((e: unknown) => {
      // Two invitations for one address at the same moment: the one-open index decides.
      throw isDuplicateKeyError(e) ? new ConflictException({ error: 'INVITE_EXISTS', message: 'There is already an open invitation for this email. Create a new link for it or revoke it.' }) : e;
    });
    await this.audited(orgId, { orgId, actorId: actor.id, action: 'invitation.created', entityType: 'invitation', entityId: created.inv.id, data: { email, role: input.role } });
    return { invitation: this.serialize(created.inv), token: created.token };
  }

  /** A new link (and seven more days) for an open invitation. The old link stops working. */
  async renew(orgId: string, actor: Actor, id: string) {
    const out = await runInOrg(orgId, async () => {
      const inv = await this.openInvitation(id);
      forbidRole(actor, inv.role as RoleName);
      const { token, tokenHash } = this.newToken();
      const updated = await this.invites.findOneAndUpdate({ id }, { $set: { tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
      return { invitation: this.serialize(updated!), token };
    });
    await this.audited(orgId, { orgId, actorId: actor.id, action: 'invitation.renewed', entityType: 'invitation', entityId: id });
    return out;
  }

  async revoke(orgId: string, actor: Actor, id: string) {
    const out = await runInOrg(orgId, async () => {
      const inv = await this.openInvitation(id);
      forbidRole(actor, inv.role as RoleName);
      const updated = await this.invites.findOneAndUpdate({ id }, { $set: { revokedAt: new Date(), revokedById: actor.id }, $unset: { openFor: '' } });
      return this.serialize(updated!);
    });
    await this.audited(orgId, { orgId, actorId: actor.id, action: 'invitation.revoked', entityType: 'invitation', entityId: id });
    return out;
  }

  private async openInvitation(id: string) {
    const inv = await this.invites.findById(id);
    if (!inv) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invitation not found' });
    if (inv.acceptedAt || inv.revokedAt) throw new ConflictException({ error: 'INVITE_CLOSED', message: `This invitation was already ${inv.acceptedAt ? 'accepted' : 'revoked'}` });
    return inv;
  }

  /**
   * Looks an invitation up by its link token. The invitee is not a member yet, so this one
   * read crosses tenants; the token (256 random bits) is the authority for it.
   */
  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return runAsSystem(() => this.invites.findOne({ tokenHash: hash(token) }));
  }

  async preview(token: string, user: { id: string; email: string }) {
    const inv = await this.byToken(token);
    if (!inv) throw new NotFoundException({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid. Ask for a new one.' });
    const [org, inviter, member] = await Promise.all([
      this.store.collection(organizations).findById(inv.orgId),
      this.store.collection(users).findById(inv.invitedById),
      runInOrg(inv.orgId, () => this.members.exists({ userId: user.id })),
    ]);
    if (!org) throw new NotFoundException({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid. Ask for a new one.' });
    return {
      organization: { id: org.id, name: org.name, isDemo: org.isDemo },
      email: inv.email,
      role: inv.role,
      invitedBy: inviter?.name ?? null,
      status: statusOf(inv),
      expiresAt: inv.expiresAt.toISOString(),
      forYou: inv.email === user.email.toLowerCase(),
      alreadyMember: member,
    };
  }

  async accept(token: string, user: { id: string; email: string }) {
    const inv = await this.byToken(token);
    if (!inv) throw new NotFoundException({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid. Ask for a new one.' });
    const status = statusOf(inv);
    if (status !== 'PENDING') {
      throw new GoneException({ error: `INVITE_${status}`, message: `This invitation has ${status === 'EXPIRED' ? 'expired' : `already been ${status.toLowerCase()}`}. Ask for a new one.` });
    }
    if (inv.email !== user.email.toLowerCase()) {
      throw new ForbiddenException({ error: 'INVITE_OTHER_EMAIL', message: `This invitation is for ${inv.email}. Sign in with that email to accept it.` });
    }
    // From here on the work is inside the inviting organisation.
    const m = await runInOrg(inv.orgId, () =>
      this.store.transaction(async () => {
        if (await this.members.exists({ userId: user.id })) throw new ConflictException({ error: 'ALREADY_MEMBER', message: 'You are already a member of this organisation' });
        await this.prisma.$transaction((tx) => assertMemberRoom(tx, this.store, inv.orgId, { countOpenInvitations: false }));
        const accepted = await this.invites.updateOne({ id: inv.id, openFor: { $exists: true } }, { $set: { acceptedAt: new Date(), acceptedById: user.id }, $unset: { openFor: '' } });
        if (accepted.matched === 0) throw new GoneException({ error: 'INVITE_CLOSED', message: 'This invitation is no longer open' });
        return this.members.insertOne({ userId: user.id, role: inv.role, createdAt: new Date() });
      }),
    );
    await this.audited(inv.orgId, { orgId: inv.orgId, actorId: user.id, action: 'invitation.accepted', entityType: 'membership', entityId: m.id, data: { invitationId: inv.id, role: inv.role } }, [m.id]);
    return { orgId: inv.orgId, role: inv.role };
  }

  async changeRole(orgId: string, actor: Actor, userId: string, role: RoleName) {
    const changed = await runInOrg(orgId, () =>
      this.store.transaction(async () => {
        const m = await this.memberOf(userId);
        if (m.role === role) return null;
        // Both the old and the new role must be ones the actor may grant: an admin cannot touch owners.
        forbidRole(actor, m.role as RoleName);
        forbidRole(actor, role);
        if (m.role === 'OWNER') await this.assertAnotherOwner(m.id);
        await this.members.updateOne({ id: m.id }, { $set: { role } });
        return m;
      }),
    );
    if (changed) {
      await this.audited(orgId, { orgId, actorId: actor.id, action: 'member.role_changed', entityType: 'membership', entityId: changed.id, data: { userId, from: changed.role, to: role } }, [changed.id]);
    }
    return { userId, role };
  }

  async remove(orgId: string, actor: Actor, userId: string) {
    const removed = await runInOrg(orgId, () =>
      this.store.transaction(async () => {
        const m = await this.memberOf(userId);
        forbidRole(actor, m.role as RoleName);
        if (m.role === 'OWNER') await this.assertAnotherOwner(m.id);
        await this.members.deleteOne({ id: m.id });
        return m;
      }),
    );
    await this.audited(orgId, { orgId, actorId: actor.id, action: 'member.removed', entityType: 'membership', entityId: removed.id, data: { userId, role: removed.role } }, [removed.id]);
  }

  /** Friendly check; the memberships guard enforces the same rule. */
  private async assertAnotherOwner(membershipId: string) {
    const others = await this.members.count({ role: 'OWNER', id: { $ne: membershipId } });
    if (others === 0) throw new ConflictException({ error: 'LAST_OWNER', message: 'An organisation must keep at least one owner. Make someone else an owner first.' });
  }

  private async memberOf(userId: string) {
    const m = await this.members.findOne({ userId });
    if (!m) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Member not found' });
    return m;
  }
}
