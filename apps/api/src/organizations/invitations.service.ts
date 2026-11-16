import { ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@talk2tax/database';
import { canAssignRole, RoleName } from '@talk2tax/security';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService, Tx, useOrgInTx, withSystemAccess } from '../common/prisma.service';

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
 * Invitations and membership changes. Talk2Tax does not send email yet: creating or
 * renewing an invitation returns a one-time link token for the inviter to share.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private newToken() {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: hash(token) };
  }

  private serialize(i: { id: string; email: string; role: Role; createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; invitedBy?: { name: string } | null }) {
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

  async list(orgId: string) {
    const rows = await this.prisma.invitation.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const inviters = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.invitedById))] } }, select: { id: true, name: true } });
    const names = new Map(inviters.map((u) => [u.id, u]));
    return rows.map((r) => this.serialize({ ...r, invitedBy: names.get(r.invitedById) ?? null }));
  }

  async create(orgId: string, actor: Actor, input: { email: string; role: RoleName }) {
    forbidRole(actor, input.role);
    const email = input.email.trim().toLowerCase();
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.membership.findFirst({ where: { orgId, user: { email } } });
      if (member) throw new ConflictException({ error: 'ALREADY_MEMBER', message: 'That person is already a member' });
      const open = await tx.invitation.findFirst({ where: { orgId, email, acceptedAt: null, revokedAt: null } });
      if (open && open.expiresAt > new Date()) {
        throw new ConflictException({ error: 'INVITE_EXISTS', message: 'There is already an open invitation for this email. Create a new link for it or revoke it.' });
      }
      if (open) await tx.invitation.update({ where: { id: open.id }, data: { revokedAt: new Date(), revokedById: actor.id } });
      const { token, tokenHash } = this.newToken();
      const inv = await tx.invitation.create({ data: { orgId, email, role: input.role as Role, tokenHash, invitedById: actor.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'invitation.created', entityType: 'invitation', entityId: inv.id, data: { email, role: input.role } });
      return { invitation: this.serialize(inv), token };
    });
  }

  /** A new link (and seven more days) for an open invitation. The old link stops working. */
  async renew(orgId: string, actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.openInvitation(tx, orgId, id);
      forbidRole(actor, inv.role as RoleName);
      const { token, tokenHash } = this.newToken();
      const updated = await tx.invitation.update({ where: { id }, data: { tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'invitation.renewed', entityType: 'invitation', entityId: id });
      return { invitation: this.serialize(updated), token };
    });
  }

  async revoke(orgId: string, actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.openInvitation(tx, orgId, id);
      forbidRole(actor, inv.role as RoleName);
      const updated = await tx.invitation.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'invitation.revoked', entityType: 'invitation', entityId: id });
      return this.serialize(updated);
    });
  }

  private async openInvitation(tx: Tx, orgId: string, id: string) {
    const inv = await tx.invitation.findFirst({ where: { id, orgId } });
    if (!inv) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invitation not found' });
    if (inv.acceptedAt || inv.revokedAt) throw new ConflictException({ error: 'INVITE_CLOSED', message: `This invitation was already ${inv.acceptedAt ? 'accepted' : 'revoked'}` });
    return inv;
  }

  /**
   * Looks an invitation up by its link token. The invitee is not a member yet, so this one
   * read crosses tenants; the token (256 random bits) is the authority for it.
   */
  private async byToken(tx: Tx, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return withSystemAccess(tx, () =>
      tx.invitation.findUnique({ where: { tokenHash: hash(token) }, include: { org: { select: { id: true, name: true, isDemo: true } } } }),
    );
  }

  async preview(token: string, user: { id: string; email: string }) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.byToken(tx, token);
      if (!inv) throw new NotFoundException({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid. Ask for a new one.' });
      const inviter = await tx.user.findUnique({ where: { id: inv.invitedById }, select: { name: true } });
      const member = await withSystemAccess(tx, () => tx.membership.findUnique({ where: { orgId_userId: { orgId: inv.orgId, userId: user.id } } }));
      return {
        organization: { id: inv.org.id, name: inv.org.name, isDemo: inv.org.isDemo },
        email: inv.email,
        role: inv.role,
        invitedBy: inviter?.name ?? null,
        status: statusOf(inv),
        expiresAt: inv.expiresAt.toISOString(),
        forYou: inv.email === user.email.toLowerCase(),
        alreadyMember: Boolean(member),
      };
    });
  }

  async accept(token: string, user: { id: string; email: string }) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.byToken(tx, token);
      if (!inv) throw new NotFoundException({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid. Ask for a new one.' });
      const status = statusOf(inv);
      if (status !== 'PENDING') {
        throw new GoneException({ error: `INVITE_${status}`, message: `This invitation has ${status === 'EXPIRED' ? 'expired' : `already been ${status.toLowerCase()}`}. Ask for a new one.` });
      }
      if (inv.email !== user.email.toLowerCase()) {
        throw new ForbiddenException({ error: 'INVITE_OTHER_EMAIL', message: `This invitation is for ${inv.email}. Sign in with that email to accept it.` });
      }
      // From here on this transaction acts inside the inviting organisation.
      await useOrgInTx(tx, inv.orgId);
      const existing = await tx.membership.findUnique({ where: { orgId_userId: { orgId: inv.orgId, userId: user.id } } });
      if (existing) throw new ConflictException({ error: 'ALREADY_MEMBER', message: 'You are already a member of this organisation' });
      const accepted = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date(), acceptedById: user.id } });
      if (accepted.count === 0) throw new GoneException({ error: 'INVITE_CLOSED', message: 'This invitation is no longer open' });
      const m = await tx.membership.create({ data: { orgId: inv.orgId, userId: user.id, role: inv.role } });
      await this.audit.append(tx, { orgId: inv.orgId, actorId: user.id, action: 'invitation.accepted', entityType: 'membership', entityId: m.id, data: { invitationId: inv.id, role: inv.role } });
      return { orgId: inv.orgId, role: inv.role };
    });
  }

  async changeRole(orgId: string, actor: Actor, userId: string, role: RoleName) {
    return this.prisma.$transaction(async (tx) => {
      const m = await this.memberOf(tx, orgId, userId);
      if (m.role === role) return { userId, role };
      // Both the old and the new role must be ones the actor may grant: an admin cannot touch owners.
      forbidRole(actor, m.role as RoleName);
      forbidRole(actor, role);
      if (m.role === 'OWNER') await this.assertAnotherOwner(tx, orgId, m.id);
      await tx.membership.update({ where: { id: m.id }, data: { role: role as Role } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'member.role_changed', entityType: 'membership', entityId: m.id, data: { userId, from: m.role, to: role } });
      return { userId, role };
    });
  }

  async remove(orgId: string, actor: Actor, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      const m = await this.memberOf(tx, orgId, userId);
      forbidRole(actor, m.role as RoleName);
      if (m.role === 'OWNER') await this.assertAnotherOwner(tx, orgId, m.id);
      await tx.membership.delete({ where: { id: m.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'member.removed', entityType: 'membership', entityId: m.id, data: { userId, role: m.role } });
    });
  }

  /** Friendly check; the database trigger memberships_last_owner enforces the same rule. */
  private async assertAnotherOwner(tx: Tx, orgId: string, membershipId: string) {
    const others = await tx.membership.count({ where: { orgId, role: 'OWNER', id: { not: membershipId } } });
    if (others === 0) throw new ConflictException({ error: 'LAST_OWNER', message: 'An organisation must keep at least one owner. Make someone else an owner first.' });
  }

  private async memberOf(tx: Tx, orgId: string, userId: string) {
    const m = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
    if (!m) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Member not found' });
    return m;
  }
}
