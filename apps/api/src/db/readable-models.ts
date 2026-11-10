import { readableModels } from './mirror-writes';
import { accounts, fiscalPeriods } from './collections/chart';
import { expenseClaims } from './collections/expenses';
import { users } from './collections/identity';
import { journalEntries } from './collections/ledger';
import { bankMatches, bankReconciliations, bankStatementImports, bankStatementLines } from './collections/banking';
import { allocations, approvalPolicies, approvalRequests, attachments, contacts, documents, payments } from './collections/sales';
import { invitations, memberships, organizations } from './collections/tenancy';

/**
 * The tables moved by hand before step 7 (MongoDB is their record and PostgreSQL holds a copy),
 * registered so their reads come from MongoDB too (docs/MONGODB.md › Reads). Lines kept inside
 * their parent's document are read from there.
 */
readableModels([
  { model: 'User', def: users },
  { model: 'Organization', def: organizations },
  { model: 'Membership', def: memberships },
  { model: 'Invitation', def: invitations },
  { model: 'Account', def: accounts },
  { model: 'FiscalPeriod', def: fiscalPeriods },
  { model: 'JournalEntry', def: journalEntries },
  { model: 'JournalLine', def: journalEntries, embedded: { parent: journalEntries, path: 'lines', parentKey: 'entryId' } },
  { model: 'Contact', def: contacts },
  { model: 'Document', def: documents },
  { model: 'DocumentLine', def: documents, embedded: { parent: documents, path: 'lines', parentKey: 'documentId' } },
  { model: 'Payment', def: payments },
  { model: 'Allocation', def: allocations },
  { model: 'ApprovalPolicy', def: approvalPolicies },
  { model: 'ApprovalRequest', def: approvalRequests },
  { model: 'Attachment', def: attachments },
  { model: 'ExpenseClaim', def: expenseClaims },
  { model: 'ExpenseClaimLine', def: expenseClaims, embedded: { parent: expenseClaims, path: 'lines', parentKey: 'claimId' } },
  { model: 'BankStatementImport', def: bankStatementImports },
  { model: 'BankStatementLine', def: bankStatementLines },
  { model: 'BankMatch', def: bankMatches },
  { model: 'BankReconciliation', def: bankReconciliations },
]);
