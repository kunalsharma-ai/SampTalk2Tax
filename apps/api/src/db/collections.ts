import type { AnyCollectionDef } from '@talk2tax/document-db';
import { MIRRORED } from './mirrored-models';
import { authSessions, loginThrottles, mfaChallenges, userMfa, users } from './collections/identity';
import { orgSecuritySettings } from './collections/security';
import { allowanceRates, claimAllowances } from './collections/allowances';
import { accounts, fiscalPeriods } from './collections/chart';
import { journalEntries } from './collections/ledger';
import { allocations, approvalPolicies, approvalRequests, attachments, contacts, documents, payments } from './collections/sales';
import { expenseClaims } from './collections/expenses';
import { bankMatches, bankReconciliations, bankStatementImports, bankStatementLines } from './collections/banking';
import { invitations, memberships, organizations } from './collections/tenancy';

/**
 * Every MongoDB collection the API uses. A collection must be listed here before any code
 * can reach it, and before a $lookup or $unionWith may read it. Modules add their
 * definitions as they move from PostgreSQL (see docs/MONGODB.md › Order of the move).
 */
export const COLLECTIONS: readonly AnyCollectionDef[] = [users, authSessions, loginThrottles, userMfa, mfaChallenges, organizations, orgSecuritySettings, memberships, invitations, accounts, fiscalPeriods, journalEntries, contacts, documents, payments, allocations, approvalPolicies, approvalRequests, attachments, expenseClaims, allowanceRates, claimAllowances, bankStatementImports, bankStatementLines, bankMatches, bankReconciliations, ...MIRRORED.map((m) => m.def)];
