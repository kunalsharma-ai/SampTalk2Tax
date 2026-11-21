import { HttpStatus, Injectable } from '@nestjs/common';
import {
  IMPORT_COLUMNS,
  IMPORT_KINDS,
  importTemplate,
  minorUnits,
  planAccountImport,
  planContactImport,
  planOpeningBalanceImport,
  type AccountType,
  type ImportKind,
  type ImportPlan,
} from '@talk2tax/accounting-engine';
import { hasPermission, type Permission } from '@talk2tax/security';
import { checkGstin } from '@talk2tax/tax-engine';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ContactsService } from '../contacts/contacts.service';
import { OpeningBalancesService } from '../opening-balances/opening-balances.service';

const TITLES: Record<ImportKind, { title: string; what: string; permission: Permission }> = {
  accounts: { title: 'Chart of accounts', what: 'New accounts, with their type, subtype and parent. Codes already in your chart are left as they are.', permission: 'accounts.manage' },
  customers: { title: 'Customers', what: 'New customers with their contact, GST and credit details. Names already in your contacts are left as they are.', permission: 'contacts.manage' },
  vendors: { title: 'Vendors', what: 'New vendors with their contact, GST and PAN details. Names already in your contacts are left as they are.', permission: 'contacts.manage' },
  'opening-balances': { title: 'Opening balances', what: 'A debit or credit for each account on your start date. Replaces your current opening balances as one journal.', permission: 'journals.post' },
};

export interface ImportInput {
  csv: string;
  /** Opening balances: the date they are posted on. */
  date?: string;
}

export interface ImportResult {
  kind: ImportKind;
  created: number;
  skipped: number;
  failed: { row: number; message: string }[];
  /** Opening balances: the journal posted. */
  journalId?: string;
}

/**
 * Imports a chart of accounts, customers, vendors and opening balances from CSV (UX-009 to UX-012).
 * A preview plans the file against the books; an import plans it again, refuses it while any row
 * has a problem, and then creates each row through the same services as the screens, so every
 * rule and every audit entry applies.
 */
@Injectable()
export class DataImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly contacts: ContactsService,
    private readonly opening: OpeningBalancesService,
  ) {}

  overview(org: OrgContext) {
    return {
      kinds: IMPORT_KINDS.map((kind) => ({
        kind,
        ...TITLES[kind],
        allowed: hasPermission(org.role, TITLES[kind].permission),
        columns: IMPORT_COLUMNS[kind],
        template: importTemplate(kind),
      })),
      currency: org.functionalCurrency,
    };
  }

  private allow(org: OrgContext, kind: ImportKind) {
    if (!hasPermission(org.role, TITLES[kind].permission)) throw new DomainError('FORBIDDEN', `Your role cannot import ${TITLES[kind].title.toLowerCase()}`, HttpStatus.FORBIDDEN);
  }

  async preview(org: OrgContext, kind: ImportKind, input: ImportInput): Promise<ImportPlan<unknown>> {
    this.allow(org, kind);
    const decimals = minorUnits(org.functionalCurrency);
    if (kind === 'accounts') {
      const chart = (await this.accounts.list(org.id, { includeInactive: true })) as { code: string; type: AccountType; isPostable: boolean }[];
      return planAccountImport(input.csv, chart);
    }
    if (kind === 'customers' || kind === 'vendors') {
      const existing = await this.prisma.contact.findMany({ where: { orgId: org.id } });
      return planContactImport(kind, input.csv, existing, { decimals, checkGstin });
    }
    const { accounts } = await this.opening.get(org);
    return planOpeningBalanceImport(input.csv, accounts, { decimals });
  }

  async run(org: OrgContext, user: AuthUser, kind: ImportKind, input: ImportInput): Promise<ImportResult & { plan: ImportPlan<unknown> }> {
    const plan = await this.preview(org, kind, input);
    if (plan.issues.length) throw new DomainError('IMPORT_HAS_PROBLEMS', `The file has ${plan.issues.length} problem${plan.issues.length === 1 ? '' : 's'}; fix them and try again`, HttpStatus.UNPROCESSABLE_ENTITY, { plan });
    const todo = plan.rows.filter((r) => r.action === 'CREATE');
    const failed: { row: number; message: string }[] = [];
    let created = 0;
    let journalId: string | undefined;
    if (kind === 'opening-balances') {
      if (!input.date) throw new DomainError('DATE_REQUIRED', 'Choose the date the opening balances are posted on');
      const lines = todo.map((r) => r.values as { accountId: string; debit: string | null; credit: string | null }).map((v) => ({ accountId: v.accountId, debit: v.debit, credit: v.credit }));
      const result = await this.opening.set(org, user, { date: input.date, lines });
      journalId = result.journalId;
      created = lines.length;
    } else if (kind === 'accounts') {
      const ids = new Map(((await this.accounts.list(org.id, { includeInactive: true })) as { id: string; code: string }[]).map((a) => [a.code.toLowerCase(), a.id]));
      for (const r of todo) {
        const v = r.values as { code: string; name: string; type: AccountType; subtype: string | null; parentCode: string | null; isPostable: boolean; description: string | null };
        try {
          const parentId = v.parentCode ? (ids.get(v.parentCode.toLowerCase()) ?? null) : null;
          if (v.parentCode && !parentId) throw new Error(`Parent ${v.parentCode} was not created`);
          const a = await this.accounts.create(org.id, user.id, { code: v.code, name: v.name, type: v.type, subtype: v.subtype ?? undefined, parentId, isPostable: v.isPostable, description: v.description ?? undefined });
          ids.set(v.code.toLowerCase(), a.id);
          created++;
        } catch (e) {
          failed.push({ row: r.row, message: (e as Error).message });
        }
      }
    } else {
      for (const r of todo) {
        const v = r.values as Record<string, string | number | null>;
        try {
          await this.contacts.create(org, user, {
            name: v.name as string,
            email: (v.email as string) ?? null,
            phone: (v.phone as string) ?? null,
            gstin: (v.gstin as string) ?? null,
            pan: (v.pan as string) ?? null,
            stateCode: v.gstin ? undefined : ((v.stateCode as string) ?? null),
            taxId: (v.taxId as string) ?? null,
            address: (v.address as string) ?? null,
            city: (v.city as string) ?? null,
            pincode: (v.pincode as string) ?? null,
            ...(v.paymentTermsDays !== null ? { paymentTermsDays: v.paymentTermsDays as number } : {}),
            creditLimit: (v.creditLimit as string) ?? null,
            isCustomer: kind === 'customers',
            isVendor: kind === 'vendors',
          });
          created++;
        } catch (e) {
          failed.push({ row: r.row, message: (e as Error).message });
        }
      }
    }
    const skipped = plan.rows.filter((r) => r.action === 'SKIP').length;
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'data_import.completed', entityType: 'data_import', entityId: org.id, data: { kind, rows: plan.summary.rows, created, skipped, failed: failed.length, ...(journalId ? { journalId } : {}) } }),
    );
    return { kind, created, skipped, failed, ...(journalId ? { journalId } : {}), plan };
  }
}
