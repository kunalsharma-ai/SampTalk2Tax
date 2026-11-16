import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, dec, minorUnits } from '@talk2tax/accounting-engine';
import { Contact } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { OrgRef, SubledgerService } from '../ledgers/subledger.service';

export interface ContactInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
  address?: string | null;
  isCustomer?: boolean;
  isVendor?: boolean;
  paymentTermsDays?: number;
  creditLimit?: string | null;
  isActive?: boolean;
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subledger: SubledgerService,
  ) {}

  async list(org: OrgRef, q: { role?: 'customer' | 'vendor'; q?: string; includeInactive: boolean }) {
    const contacts = await this.prisma.contact.findMany({
      where: {
        orgId: org.id,
        ...(q.role === 'customer' ? { isCustomer: true } : q.role === 'vendor' ? { isVendor: true } : {}),
        ...(q.includeInactive ? {} : { isActive: true }),
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const [sales, purchases] = await Promise.all([
      this.subledger.balances(this.prisma, org.id, 'SALES'),
      this.subledger.balances(this.prisma, org.id, 'PURCHASES'),
    ]);
    return contacts.map((c) => this.serialize(org, c, sales.get(c.id), purchases.get(c.id)));
  }

  async get(org: OrgRef, id: string) {
    const c = await this.find(org.id, id);
    const [sales, purchases] = await Promise.all([
      this.subledger.balances(this.prisma, org.id, 'SALES', todayIso(), id),
      this.subledger.balances(this.prisma, org.id, 'PURCHASES', todayIso(), id),
    ]);
    return this.serialize(org, c, sales.get(id), purchases.get(id));
  }

  statement(org: OrgRef, id: string, q: { ledger: 'SALES' | 'PURCHASES'; from?: string; to?: string }) {
    const to = q.to ?? todayIso();
    const from = q.from ?? `${to.slice(0, 4)}-01-01`;
    if (from > to) throw new DomainError('INVALID_RANGE', '"from" must not be after "to"');
    return this.subledger.statement(org, id, q.ledger, from, to);
  }

  async create(org: OrgRef, actor: { id: string }, input: ContactInput & { name: string }) {
    const data = this.validate(org, input);
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.contact.create({
        data: {
          orgId: org.id,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          taxId: input.taxId ?? null,
          address: input.address ?? null,
          isCustomer: input.isCustomer ?? false,
          isVendor: input.isVendor ?? false,
          paymentTermsDays: input.paymentTermsDays ?? 30,
          creditLimit: data.creditLimit,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.created', entityType: 'contact', entityId: c.id, data: { name: c.name, isCustomer: c.isCustomer, isVendor: c.isVendor } });
      return this.serialize(org, c);
    });
  }

  async update(org: OrgRef, actor: { id: string }, id: string, input: ContactInput) {
    const data = this.validate(org, input);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.contact.findFirst({ where: { id, orgId: org.id } });
      if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contact not found' });
      const isCustomer = input.isCustomer ?? before.isCustomer;
      const isVendor = input.isVendor ?? before.isVendor;
      if (!isCustomer && !isVendor) throw new DomainError('INVALID_CONTACT', 'A contact must be a customer, a vendor or both');
      if ((before.isCustomer && !isCustomer) || (before.isVendor && !isVendor)) {
        const used = await tx.document.count({
          where: { orgId: org.id, contactId: id, kind: { in: before.isCustomer && !isCustomer ? ['INVOICE', 'CREDIT_NOTE'] : ['BILL', 'VENDOR_CREDIT'] } },
        });
        if (used > 0) throw new DomainError('CONTACT_IN_USE', 'This contact already has documents in that role', HttpStatus.CONFLICT);
      }
      const c = await tx.contact.update({
        where: { id },
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone,
          taxId: input.taxId,
          address: input.address,
          isCustomer: input.isCustomer,
          isVendor: input.isVendor,
          paymentTermsDays: input.paymentTermsDays,
          creditLimit: input.creditLimit === undefined ? undefined : data.creditLimit,
          isActive: input.isActive,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.updated', entityType: 'contact', entityId: id, data: { ...input } });
      return this.serialize(org, c);
    });
  }

  private validate(org: OrgRef, input: ContactInput) {
    let creditLimit: string | null = null;
    if (input.creditLimit) {
      const v = dec(input.creditLimit);
      if (v.decimalPlaces() > minorUnits(org.functionalCurrency)) throw new DomainError('INVALID_AMOUNT', 'Credit limit has too many decimal places');
      creditLimit = v.toFixed();
    }
    return { creditLimit };
  }

  private async find(orgId: string, id: string) {
    const c = await this.prisma.contact.findFirst({ where: { id, orgId } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contact not found' });
    return c;
  }

  private serialize(org: OrgRef, c: Contact, sales?: { outstanding: InstanceType<typeof D>; unapplied: InstanceType<typeof D>; overdue: InstanceType<typeof D> }, purchases?: typeof sales) {
    const scale = minorUnits(org.functionalCurrency);
    const z = new D(0);
    const bal = (b?: typeof sales) =>
      b ? { outstanding: b.outstanding.toFixed(scale), overdue: b.overdue.toFixed(scale), unapplied: b.unapplied.toFixed(scale), balance: b.outstanding.minus(b.unapplied).toFixed(scale) } : { outstanding: z.toFixed(scale), overdue: z.toFixed(scale), unapplied: z.toFixed(scale), balance: z.toFixed(scale) };
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      taxId: c.taxId,
      address: c.address,
      isCustomer: c.isCustomer,
      isVendor: c.isVendor,
      paymentTermsDays: c.paymentTermsDays,
      creditLimit: c.creditLimit ? c.creditLimit.toFixed(scale) : null,
      isActive: c.isActive,
      receivable: bal(sales),
      payable: bal(purchases),
      createdAt: c.createdAt.toISOString(),
    };
  }
}
