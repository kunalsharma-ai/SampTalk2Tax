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
import { aiDecisionRecords } from './collections/ai-decision-records';
import { auditEngagements } from './collections/audit-engagements';
import { auditEvidenceRequests } from './collections/audit-evidence';
import { expenseReceipts } from './collections/expense-receipts';
import { complianceDocuments } from './collections/compliance-documents';
import { vendorContracts } from './collections/vendor-contracts';
import { taxScenarios } from './collections/tax-scenarios';
import { vatReturns, vatSettings } from './collections/vat-returns';
import { stakeholderReports } from './collections/stakeholder-reports';
import { expenseTrips } from './collections/expense-trips';
import { incomeTaxComputations } from './collections/income-tax-computations';
import { taxAuditPreparations } from './collections/tax-audit-preparations';
import { taxRateVersions } from './collections/tax-rate-versions';
import { taxNoticeAnalyses } from './collections/tax-notice-analyses';
import { rcmSelfInvoices } from './collections/rcm-self-invoices';
import { supplierStatements } from './collections/supplier-statements';
import { billReadings } from './collections/bill-readings';
import { bankFeedConnections, bankFeedDeliveries } from './collections/bank-feeds';
import { auditorPortalLinks } from './collections/auditor-portal';
import { orgSetup } from './collections/org-setup';
import { billCheckReviews } from './collections/bill-checks';
import { communicationPolicies, contactEmailConsents } from './collections/communication';
import { contractMatchDismissals } from './collections/contract-matching';
import { departmentBudgets } from './collections/department-budgets';
import { expenseCategories } from './collections/expense-categories';
import { receiptRequests } from './collections/receipt-requests';
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
import { paymentPlans } from './collections/payment-plans';

/**
 * Every MongoDB collection the API uses. A collection must be listed here before any code
 * can reach it, and before a $lookup or $unionWith may read it. Modules add their
 * definitions as they move from PostgreSQL (see docs/MONGODB.md › Order of the move).
 */
export const COLLECTIONS: readonly AnyCollectionDef[] = [users, authSessions, knownDevices, loginThrottles, userMfa, mfaChallenges, organizations, orgSecuritySettings, accessRules, memberships, invitations, accounts, fiscalPeriods, journalEntries, contacts, documents, payments, allocations, approvalPolicies, approvalRequests, attachments, expenseClaims, allowanceRates, claimAllowances, expensePolicyRules, taxNotices, taxNoticeFiles, financialTags, billCheckReviews, accountReconciliations, costAllocationRules, costAllocationRuns, journalApprovalPolicies, journalApprovals, advanceTaxPlans, gstPayments, leaveTypes, leaveEntries, deposits, depositEvents, bankStatementImports, bankStatementLines, bankMatches, bankReconciliations, reportSchedules, reportScheduleRuns, orgSetup, reportViews, reportDesignVersions, sodReviews, internalControls, controlTests, auditFindings, auditSamples, aiDecisionRecords, auditEngagements, auditEvidenceRequests, auditorPortalLinks, paymentPlans, contactEmailConsents, communicationPolicies, contractMatchDismissals, departmentBudgets, expenseReceipts, complianceDocuments, vendorContracts, taxScenarios, stakeholderReports, expenseTrips, incomeTaxComputations, taxAuditPreparations, taxRateVersions, taxNoticeAnalyses, rcmSelfInvoices, supplierStatements, bankFeedConnections, bankFeedDeliveries, expenseCategories, receiptRequests, vatSettings, vatReturns, billReadings, ...MIRRORED.map((m) => m.def)];
