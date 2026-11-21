import type { AnyCollectionDef } from '@talk2tax/document-db';
import { MIRRORED } from './mirrored-models';
import { authSessions, knownDevices, loginThrottles, mfaChallenges, userMfa, users } from './collections/identity';
import { accessRules, orgSecuritySettings } from './collections/security';
import { allowanceRates, claimAllowances } from './collections/allowances';
import { expensePolicyRules } from './collections/expense-policy';
import { taxNoticeFiles, taxNotices } from './collections/tax-notices';
import { financialTags } from './collections/financial-tags';
import { reportScheduleRuns, reportSchedules } from './collections/report-schedules';
import { reportViews } from './collections/report-views';
import { reportDesignVersions } from './collections/report-design-versions';
import { sodReviews } from './collections/sod-reviews';
import { controlTests, internalControls } from './collections/internal-controls';
import { auditFindings } from './collections/audit-findings';
import { auditSamples } from './collections/audit-samples';
import { orgSetup } from './collections/org-setup';
import { billCheckReviews } from './collections/bill-checks';
import { accountReconciliations } from './collections/account-reconciliations';
import { costAllocationRules, costAllocationRuns } from './collections/cost-allocations';
import { advanceTaxPlans } from './collections/advance-tax';
import { gstPayments } from './collections/gst-payments';
import { leaveEntries, leaveTypes } from './collections/leave';
import { depositEvents, deposits } from './collections/deposits';
import { journalApprovalPolicies, journalApprovals } from './collections/journal-approvals';
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
export const COLLECTIONS: readonly AnyCollectionDef[] = [users, authSessions, knownDevices, loginThrottles, userMfa, mfaChallenges, organizations, orgSecuritySettings, accessRules, memberships, invitations, accounts, fiscalPeriods, journalEntries, contacts, documents, payments, allocations, approvalPolicies, approvalRequests, attachments, expenseClaims, allowanceRates, claimAllowances, expensePolicyRules, taxNotices, taxNoticeFiles, financialTags, billCheckReviews, accountReconciliations, costAllocationRules, costAllocationRuns, journalApprovalPolicies, journalApprovals, advanceTaxPlans, gstPayments, leaveTypes, leaveEntries, deposits, depositEvents, bankStatementImports, bankStatementLines, bankMatches, bankReconciliations, reportSchedules, reportScheduleRuns, orgSetup, reportViews, reportDesignVersions, sodReviews, internalControls, controlTests, auditFindings, auditSamples, ...MIRRORED.map((m) => m.def)];
