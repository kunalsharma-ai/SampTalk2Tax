import { HttpStatus, Injectable } from '@nestjs/common';
import { OPENING_BALANCE_EQUITY, OPENING_REFERENCE, OpeningAccount, OpeningLineInput, planOpeningBalances } from '@talk2tax/accounting-engine';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { organizations } from '../db/collections/tenancy';
import { JournalsService } from '../journals/journals.service';

interface OrgInfo {
  id: string;
  functionalCurrency: string;
}

/**
 * Opening balances (GL-010): one OPENING journal, found by its reference. Saving new balances
 * reverses the current journal and posts the new one in one transaction, so the books never hold
 * two sets, and the history of what was entered stays in the ledger.
 */
@Injectable()
export class OpeningBalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly accounts: AccountsService,
    private readonly journals: JournalsService,
  ) {}

  /** Accounts that take an opening balance: postable and active, not a control account, not Opening Balance Equity. */
  private async eligible(orgId: string): Promise<{ accounts: (OpeningAccount & { subtype: string | null })[]; offset: { id: string; code: string; name: string } | null }> {
    const org = await this.store.collection(organizations).findById(orgId);
    const control = new Set([org?.arAccountId, org?.apAccountId, org?.claimsAccountId].filter(Boolean));
    const all = (await this.accounts.list(orgId, {})) as { id: string; code: string; name: string; type: OpeningAccount['type']; subtype: string | null; isPostable: boolean; isActive: boolean }[];
    const offset = all.find((a) => a.code === OPENING_BALANCE_EQUITY.code && a.type === 'EQUITY' && a.isPostable && a.isActive) ?? null;
    const accounts = all.filter((a) => a.isPostable && a.isActive && !control.has(a.id) && a.id !== offset?.id).map(({ id, code, name, type, subtype }) => ({ id, code, name, type, subtype }));
    return { accounts, offset: offset && { id: offset.id, code: offset.code, name: offset.name } };
  }

  async get(org: OrgInfo) {
    const { accounts, offset } = await this.eligible(org.id);
    const current = await this.journals.currentByReference(org.id, 'OPENING', OPENING_REFERENCE);
    const balances = (current?.lines ?? [])
      .filter((l) => l.accountId !== offset?.id)
      .map((l) => ({ accountId: l.accountId, accountCode: l.accountCode, accountName: l.accountName, debit: l.functionalDebit, credit: l.functionalCredit }));
    const diff = current?.lines.find((l) => l.accountId === offset?.id);
    return {
      currency: org.functionalCurrency,
      accounts,
      offsetAccount: offset,
      current: current && {
        journalId: current.id,
        entryNumber: current.entryNumber,
        date: current.date,
        balances,
        difference: diff ? { debit: diff.functionalDebit, credit: diff.functionalCredit } : null,
      },
    };
  }

  async set(org: OrgInfo, actor: { id: string }, input: { date: string; lines: OpeningLineInput[] }) {
    let { accounts, offset } = await this.eligible(org.id);
    if (!offset) {
      // Made the first time balances are saved, under the Equity heading when there is one.
      const parent = ((await this.accounts.list(org.id, { type: 'EQUITY' })) as { id: string; code: string; isPostable: boolean }[]).find((a) => !a.isPostable && a.code === '3000');
      const created = await this.accounts.create(org.id, actor.id, { code: OPENING_BALANCE_EQUITY.code, name: OPENING_BALANCE_EQUITY.name, type: 'EQUITY', subtype: OPENING_BALANCE_EQUITY.subtype, parentId: parent?.id ?? null, isPostable: true, description: 'Takes the difference in the opening balances. Clear it once the balances are agreed.' });
      offset = { id: created.id, code: created.code, name: created.name };
    }
    const plan = planOpeningBalances({ currency: org.functionalCurrency, accounts, lines: input.lines, offsetAccountId: offset.id });
    if (plan.issues.length) throw new DomainError('INVALID_OPENING_BALANCES', plan.issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues: plan.issues });
    const current = await this.journals.currentByReference(org.id, 'OPENING', OPENING_REFERENCE);
    const id = await this.prisma.$transaction(async (tx) => {
      if (current) await this.journals.reverseInTx(tx, org, actor, current.id, { date: current.date, memo: `Opening balances replaced (JE-${current.entryNumber})` });
      const created = await this.journals.createInTx(
        tx,
        org,
        actor,
        { date: input.date, type: 'OPENING', memo: 'Opening balances', reference: OPENING_REFERENCE, lines: plan.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })) },
        { post: true, requireApproval: true },
      );
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'opening_balances.set',
        entityType: 'journal_entry',
        entityId: created.id,
        data: { date: input.date, accounts: plan.lines.length, total: plan.totalDebit, difference: plan.difference, replaced: current?.id ?? null },
      });
      return created.id;
    });
    return { ...(await this.get(org)), journalId: id, warnings: plan.warnings };
  }
}
