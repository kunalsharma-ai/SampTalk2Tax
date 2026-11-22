import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { ChartService } from './accounts/chart.service';
import { ApprovalsController } from './approvals/approvals.controller';
import { ApprovalsService } from './approvals/approvals.service';
import { AttachmentsController } from './attachments/attachments.controller';
import { AttachmentsService } from './attachments/attachments.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { MfaService } from './auth/mfa.service';
import { DevicesService } from './auth/devices.service';
import { OrgSecurityService } from './organizations/org-security.service';
import { AuthGuard } from './auth/guards';
import { LoginThrottleService } from './auth/login-throttle.service';
import { RateLimitGuard } from './auth/rate-limit';
import { SessionsService } from './auth/sessions.service';
import { TokensService } from './auth/tokens.service';
import { BankingController } from './banking/banking.controller';
import { BankingService } from './banking/banking.service';
import { AllowanceRatesController, ExpensePolicyController, ExpensesController } from './expenses/expenses.controller';
import { ExpensePolicyService } from './expenses/expense-policy.service';
import { TaxNoticesController } from './tax-notices/tax-notices.controller';
import { TaxNoticesService } from './tax-notices/tax-notices.service';
import { AccountReconciliationsController } from './account-reconciliations/account-reconciliations.controller';
import { AccountReconciliationsService } from './account-reconciliations/account-reconciliations.service';
import { CostAllocationsController } from './cost-allocations/cost-allocations.controller';
import { CostAllocationsService } from './cost-allocations/cost-allocations.service';
import { AdvanceTaxController } from './advance-tax/advance-tax.controller';
import { GstPaymentsController } from './gst/gst-payments.controller';
import { GstPaymentsService } from './gst/gst-payments.service';
import { AdvanceTaxService } from './advance-tax/advance-tax.service';
import { JournalApprovalsController } from './journal-approvals/journal-approvals.controller';
import { JournalApprovalsService } from './journal-approvals/journal-approvals.service';
import { FinancialTagsController } from './financial-tags/financial-tags.controller';
import { FinancialTagsService } from './financial-tags/financial-tags.service';
import { BillChecksController } from './bill-checks/bill-checks.controller';
import { CommunicationPolicyController } from './communication-policy/communication-policy.controller';
import { CommunicationPolicyService } from './communication-policy/communication-policy.service';
import { ExpenseCategorizationController } from './expense-categorization/expense-categorization.controller';
import { ExpenseCategorizationService } from './expense-categorization/expense-categorization.service';
import { BillChecksService } from './bill-checks/bill-checks.service';
import { AllowancesService } from './expenses/allowances.service';
import { ExpensesService } from './expenses/expenses.service';
import { ExpenseReportController } from './expenses/expense-report.controller';
import { ExpenseReportService } from './expenses/expense-report.service';
import { ExpenseReconciliationController } from './expenses/expense-reconciliation.controller';
import { ExpenseReconciliationService } from './expenses/expense-reconciliation.service';
import { ErrorFilter } from './common/errors';
import { ErrorsService } from './operations/errors.service';
import { FlagsService } from './operations/flags.service';
import { HeartbeatsService } from './operations/heartbeats.service';
import { MaintenanceService } from './operations/maintenance.service';
import { MetricsService } from './operations/metrics.service';
import { OperationsController, OrgFlagsController, StatusController } from './operations/operations.controller';
import { SystemService } from './operations/system.service';
import { ContactsController } from './contacts/contacts.controller';
import { ContactsService } from './contacts/contacts.service';
import { DocumentsService } from './ledgers/documents.service';
import { PurchasesController, SalesController } from './ledgers/ledger.controllers';
import { SubledgerService } from './ledgers/subledger.service';
import { TaxRatesController } from './tax-rates/tax-rates.controller';
import { FxController } from './fx/fx.controller';
import { FxService } from './fx/fx.service';
import { CountryModuleController, CountryModulesCatalogueController } from './country-modules/country-modules.controller';
import { CountryModulesService } from './country-modules/country-modules.service';
import { TaxRatesService } from './tax-rates/tax-rates.service';
import { prismaProvider } from './common/prisma.service';
import { documentStoreProvider } from './common/document-store.service';
import { MovedTables } from './db/moved-table';
import { AppConfig, CONFIG } from './config';
import { GstController } from './gst/gst.controller';
import { GstService } from './gst/gst.service';
import { HealthController } from './health/health.controller';
import { RegionsController } from './regions/regions.controller';
import { AdminController, AnnouncementsController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { PlatformSupportController, SupportController } from './support/support.controller';
import { SupportService } from './support/support.service';
import { PlatformUsageController, UsageController } from './usage/usage.controller';
import { UsageService } from './usage/usage.service';
import { SupportAccessService } from './support/support-access.service';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { PlatformBillingController } from './billing/platform-billing.controller';
import { PlatformBillingService } from './billing/platform-billing.service';
import { PaymentSettingsService } from './billing/payments/payment-settings.service';
import { CouponsService } from './billing/payments/coupons.service';
import { AddOnsService } from './billing/add-ons.service';
import { AiCreditsService } from './billing/ai-credits.service';
import { EnterpriseContractsService } from './billing/enterprise-contracts.service';
import { RenewalsRunnerService } from './billing/payments/renewals-runner.service';
import { PaymentWebhooksController, PlatformPaymentsController, SubscriptionPaymentsController } from './billing/payments/subscription-payments.controller';
import { SubscriptionPaymentsService } from './billing/payments/subscription-payments.service';
import { RegionsService } from './regions/regions.service';
import { JournalsController } from './journals/journals.controller';
import { JournalsService } from './journals/journals.service';
import { InvitationLinksController, OrganizationsController } from './organizations/organizations.controller';
import { InvitationsService } from './organizations/invitations.service';
import { OrganizationsService } from './organizations/organizations.service';
import { ReportViewsController } from './report-views/report-views.controller';
import { ReportViewsService } from './report-views/report-views.service';
import { AuditFindingsController } from './audit-findings/audit-findings.controller';
import { AuditFindingsService } from './audit-findings/audit-findings.service';
import { AuditSamplingController } from './audit-sampling/audit-sampling.controller';
import { AiDecisionsController } from './ai-decisions/ai-decisions.controller';
import { LedgerReplayController } from './ledger-replay/ledger-replay.controller';
import { CollectionPrioritiesController, PaymentPredictionsController } from './payment-predictions/payment-predictions.controller';
import { CollectionPrioritiesService } from './payment-predictions/collection-priorities.service';
import { PaymentFraudController } from './payment-fraud/payment-fraud.controller';
import { PaymentPrioritiesController, PredictivePaymentsController } from './payment-priorities/payment-priorities.controller';
import { PredictivePaymentsService } from './payment-priorities/predictive-payments.service';
import { PaymentPrioritiesService } from './payment-priorities/payment-priorities.service';
import { PaymentPlansController } from './payment-plans/payment-plans.controller';
import { PaymentPlansService } from './payment-plans/payment-plans.service';
import { CustomerBehaviourController } from './customer-behaviour/customer-behaviour.controller';
import { CustomerBehaviourService } from './customer-behaviour/customer-behaviour.service';
import { BankActivityController, CashMovementsController, ReconciliationExceptionsController } from './bank-activity/bank-activity.controller';
import { CashMovementsService } from './bank-activity/cash-movements.service';
import { ReconciliationExceptionsService } from './bank-activity/reconciliation-exceptions.service';
import { BankActivityService } from './bank-activity/bank-activity.service';
import { ExpenseRiskController } from './expense-risk/expense-risk.controller';
import { ExpenseRiskService } from './expense-risk/expense-risk.service';
import { PaymentFraudService } from './payment-fraud/payment-fraud.service';
import { PaymentPredictionsService } from './payment-predictions/payment-predictions.service';
import { LedgerReplayService } from './ledger-replay/ledger-replay.service';
import { AuditEngagementsController } from './audit-engagements/audit-engagements.controller';
import { AuditEngagementsService } from './audit-engagements/audit-engagements.service';
import { AuditEvidenceController } from './audit-evidence/audit-evidence.controller';
import { AuditEvidenceService } from './audit-evidence/audit-evidence.service';
import { AuditorLinksController, AuditorPortalController } from './auditor-portal/auditor-portal.controller';
import { AuditorPortalService } from './auditor-portal/auditor-portal.service';
import { AiDecisionsService } from './ai-decisions/ai-decisions.service';
import { AuditSamplingService } from './audit-sampling/audit-sampling.service';
import { InternalControlsController } from './internal-controls/internal-controls.controller';
import { InternalControlsService } from './internal-controls/internal-controls.service';
import { SegregationOfDutiesController } from './segregation-of-duties/segregation-of-duties.controller';
import { SegregationOfDutiesService } from './segregation-of-duties/segregation-of-duties.service';
import { SetupController } from './setup/setup.controller';
import { SetupService } from './setup/setup.service';
import { DataImportController } from './data-import/data-import.controller';
import { DataImportService } from './data-import/data-import.service';
import { OpeningBalancesController } from './opening-balances/opening-balances.controller';
import { OpeningBalancesService } from './opening-balances/opening-balances.service';
import { PeriodsController } from './periods/periods.controller';
import { PeriodsService } from './periods/periods.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { PayrollController } from './payroll/payroll.controller';
import { LeaveService } from './payroll/leave.service';
import { PayrollService } from './payroll/payroll.service';
import { BudgetsController } from './budgets/budgets.controller';
import { BudgetsService } from './budgets/budgets.service';
import { CashFlowController } from './cash-flow/cash-flow.controller';
import { CashFlowService } from './cash-flow/cash-flow.service';
import { KpisController } from './kpis/kpis.controller';
import { KpisService } from './kpis/kpis.service';
import { AlertsController } from './alerts/alerts.controller';
import { AlertsRunnerService } from './alerts/alerts-runner.service';
import { AlertsService } from './alerts/alerts.service';
import { BankAiController } from './bank-ai/bank-ai.controller';
import { BankAiService } from './bank-ai/bank-ai.service';
import { AiControlController } from './ai-control/ai-control.controller';
import { PlatformAiController } from './ai-control/platform-ai.controller';
import { KeyRotationController } from './security/key-rotation.controller';
import { AccessRulesController } from './security/access-rules.controller';
import { RetentionController } from './retention/retention.controller';
import { SsoSettingsController, SsoSignInController } from './sso/sso.controller';
import { SsoService } from './sso/sso.service';
import { FileScanningController } from './files/file-scanning.controller';
import { FileScannerService } from './files/file-scanner.service';
import { FileVault } from './files/file-vault';
import { RetentionRunnerService } from './retention/retention-runner.service';
import { BackupsController } from './backups/backups.controller';
import { BackupsService } from './backups/backups.service';
import { SecurityMonitorController } from './security-monitor/security-monitor.controller';
import { SecurityMonitorRunnerService } from './security-monitor/security-monitor-runner.service';
import { SecurityMonitorService } from './security-monitor/security-monitor.service';
import { RetentionService } from './retention/retention.service';
import { KeyRotationService } from './security/key-rotation.service';
import { AccessRulesService } from './security/access-rules.service';
import { AiControlService } from './ai-control/ai-control.service';
import { CloseController } from './close/close.controller';
import { FixedAssetsController } from './fixed-assets/fixed-assets.controller';
import { FixedAssetsService } from './fixed-assets/fixed-assets.service';
import { DeferralsController } from './deferrals/deferrals.controller';
import { DeferralsService } from './deferrals/deferrals.service';
import { InvoicePrintController, InvoiceTemplatesController, SignaturesController } from './invoice-templates/invoice-templates.controller';
import { InvoiceTemplatesService } from './invoice-templates/invoice-templates.service';
import { LoansController } from './loans/loans.controller';
import { DepositsController } from './deposits/deposits.controller';
import { CrmController } from './crm/crm.controller';
import { CustomerInsightsController } from './crm/customer-insights.controller';
import { CustomerInsightsService } from './crm/customer-insights.service';
import { RevenueForecastController } from './crm/revenue-forecast.controller';
import { RevenueForecastService } from './crm/revenue-forecast.service';
import { ApiKeyGuard } from './crm-api/api-key.guard';
import { ApiKeysService } from './crm-api/api-keys.service';
import { CrmApiController } from './crm-api/crm-api.controller';
import { CrmConnectionController } from './crm-api/crm-connection.controller';
import { CrmWebhooksRunnerService } from './crm-api/crm-webhooks-runner.service';
import { CrmWebhooksService } from './crm-api/crm-webhooks.service';
import { ContractsController } from './sales-orders/contracts.controller';
import { UsageBillingController } from './sales-orders/usage-billing.controller';
import { CustomerPortalController, CustomerPortalLinksController } from './customer-portal/customer-portal.controller';
import { CustomerPortalService } from './customer-portal/customer-portal.service';
import { VendorInvoicesController, VendorPortalController, VendorPortalLinksController } from './vendor-portal/vendor-portal.controller';
import { VendorPortalService } from './vendor-portal/vendor-portal.service';
import { SupplierTaxController } from './supplier-tax/supplier-tax.controller';
import { SupplierTaxService } from './supplier-tax/supplier-tax.service';
import { RevenueRecognitionController } from './revenue-recognition/revenue-recognition.controller';
import { RevenueRecognitionService } from './revenue-recognition/revenue-recognition.service';
import { UsageBillingService } from './sales-orders/usage-billing.service';
import { ContractsRunnerService } from './sales-orders/contracts-runner.service';
import { BadDebtsController } from './bad-debts/bad-debts.controller';
import { BadDebtsService } from './bad-debts/bad-debts.service';
import { YearEndController } from './year-end/year-end.controller';
import { YearEndService } from './year-end/year-end.service';
import { PaymentBatchesController, VendorBankDetailsController } from './payment-batches/payment-batches.controller';
import { PaymentBatchesService } from './payment-batches/payment-batches.service';
import { PaymentScheduleController } from './payment-batches/payment-schedule.controller';
import { DisputesController } from './disputes/disputes.controller';
import { DisputesService } from './disputes/disputes.service';
import { PaymentScheduleService } from './payment-batches/payment-schedule.service';
import { JournalSuggestionsController } from './journal-suggestions/journal-suggestions.controller';
import { JournalSuggestionsService } from './journal-suggestions/journal-suggestions.service';
import { JournalTemplatesController } from './journal-templates/journal-templates.controller';
import { JournalTemplatesRunnerService } from './journal-templates/journal-templates-runner.service';
import { JournalTemplatesService } from './journal-templates/journal-templates.service';
import { RecurringBillsController } from './recurring-bills/recurring-bills.controller';
import { RecurringBillsRunnerService } from './recurring-bills/recurring-bills-runner.service';
import { RecurringBillsService } from './recurring-bills/recurring-bills.service';
import { ContractsService } from './sales-orders/contracts.service';
import { SalesOrdersController } from './sales-orders/sales-orders.controller';
import { ReportExportsController } from './report-exports/report-exports.controller';
import { ConsolidationController } from './consolidation/consolidation.controller';
import { ConsolidationService } from './consolidation/consolidation.service';
import { IntercompanyService } from './consolidation/intercompany.service';
import { IntegrationsController } from './integrations/integrations.controller';
import { IntegrationsService } from './integrations/integrations.service';
import { CfoController } from './cfo/cfo.controller';
import { CfoService } from './cfo/cfo.service';
import { BenchmarkingController } from './benchmarking/benchmarking.controller';
import { BenchmarkingService } from './benchmarking/benchmarking.service';
import { GraphController } from './graph/graph.controller';
import { GraphService } from './graph/graph.service';
import { DecisionsController } from './decisions/decisions.controller';
import { DisastersController } from './disasters/disasters.controller';
import { DisastersService } from './disasters/disasters.service';
import { ImpactController } from './impact/impact.controller';
import { ImpactService } from './impact/impact.service';
import { OpportunitiesController } from './opportunities/opportunities.controller';
import { OpportunitiesService } from './opportunities/opportunities.service';
import { DashboardsController } from './dashboards/dashboards.controller';
import { DashboardsService } from './dashboards/dashboards.service';
import { ReportDesignerController } from './report-designer/report-designer.controller';
import { ReportDesignerService } from './report-designer/report-designer.service';
import { PoliciesController } from './policies/policies.controller';
import { PoliciesService } from './policies/policies.service';
import { DecisionsService } from './decisions/decisions.service';
import { ForecastLabController } from './forecast-lab/forecast-lab.controller';
import { ForecastLabService } from './forecast-lab/forecast-lab.service';
import { RecoveryController } from './recovery/recovery.controller';
import { RecoveryService } from './recovery/recovery.service';
import { TwinController } from './twin/twin.controller';
import { TwinService } from './twin/twin.service';
import { ReportExportService } from './report-exports/report-exports.service';
import { ReportSchedulesController } from './report-schedules/report-schedules.controller';
import { ReportSchedulesRunnerService } from './report-schedules/report-schedules-runner.service';
import { ReportSchedulesService } from './report-schedules/report-schedules.service';
import { LoansService } from './loans/loans.service';
import { DepositsService } from './deposits/deposits.service';
import { CrmService } from './crm/crm.service';
import { SalesOrdersService } from './sales-orders/sales-orders.service';
import { ProFormaController } from './sales-orders/pro-forma.controller';
import { ProFormaService } from './sales-orders/pro-forma.service';
import { RetainersController } from './sales-orders/retainers.controller';
import { PaymentLinksController, PaymentLinkWebhooksController } from './payment-links/payment-links.controller';
import { PaymentLinksService } from './payment-links/payment-links.service';
import { CustomerOnboardingController, VendorOnboardingController } from './customer-onboarding/customer-onboarding.controller';
import { CustomerOnboardingService } from './customer-onboarding/customer-onboarding.service';
import { VendorPerformanceController } from './vendor-performance/vendor-performance.controller';
import { UnbilledRevenueController } from './unbilled-revenue/unbilled-revenue.controller';
import { UnbilledRevenueService } from './unbilled-revenue/unbilled-revenue.service';
import { VendorRiskController } from './vendor-risk/vendor-risk.controller';
import { VendorRiskService } from './vendor-risk/vendor-risk.service';
import { InternationalPaymentsController } from './international-payments/international-payments.controller';
import { InternationalPaymentsService } from './international-payments/international-payments.service';
import { VendorPerformanceService } from './vendor-performance/vendor-performance.service';
import { RetainersService } from './sales-orders/retainers.service';
import { BillExceptionsController, BillMatchController, PurchaseOrdersController } from './purchase-orders/purchase-orders.controller';
import { BillExceptionsService } from './purchase-orders/bill-exceptions.service';
import { PurchaseOrdersService } from './purchase-orders/purchase-orders.service';
import { DimensionsController } from './dimensions/dimensions.controller';
import { DimensionsService } from './dimensions/dimensions.service';
import { ClosePackService } from './close/close-pack.service';
import { CloseRunnerService } from './close/close-runner.service';
import { CloseService } from './close/close.service';
import { CollectionsController } from './collections/collections.controller';
import { CollectionsService } from './collections/collections.service';
import { CopilotController } from './copilot/copilot.controller';
import { COPILOT_MODEL, CopilotModel, copilotModelFromConfig } from './copilot/copilot.model';
import { CopilotService } from './copilot/copilot.service';
import { CopilotTools } from './copilot/copilot.tools';
import { CopilotActionsService } from './copilot/copilot.actions';
import { ComplianceController } from './compliance/compliance.controller';
import { ComplianceService } from './compliance/compliance.service';
import { EInvoicingController } from './e-invoicing/e-invoicing.controller';
import { EInvoicingService } from './e-invoicing/e-invoicing.service';
import { EWayBillsController } from './e-way-bills/e-way-bills.controller';
import { EWayBillsService } from './e-way-bills/e-way-bills.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { MailerService } from './workflows/email';
import { WorkflowRunnerService } from './workflows/workflow-runner.service';
import { WorkflowsController } from './workflows/workflows.controller';
import { WorkflowsService } from './workflows/workflows.service';
import { WithholdingController } from './withholding/withholding.controller';
import { WithholdingService } from './withholding/withholding.service';

/**
 * Modular monolith root. Domains are separated by folder and service boundary so they
 * can be extracted later; for now they share one process and one Postgres database.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, copilotModel?: CopilotModel | null): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        RegionsController,
        AdminController,
        StatusController,
        OrgFlagsController,
        OperationsController,
        SupportController,
        PlatformSupportController,
        UsageController,
        PlatformUsageController,
        AnnouncementsController,
        BillingController,
        PlatformBillingController,
        SubscriptionPaymentsController,
        PlatformPaymentsController,
        PaymentWebhooksController,
        AuthController,
        OrganizationsController,
        InvitationLinksController,
        AccountsController,
        PeriodsController,
        OpeningBalancesController,
        SetupController,
        ReportViewsController,
        SegregationOfDutiesController,
        InternalControlsController,
        AuditFindingsController,
        AuditSamplingController,
        AiDecisionsController,
        LedgerReplayController,
        PaymentPredictionsController,
        CollectionPrioritiesController,
        PaymentFraudController,
        PaymentPrioritiesController,
        PredictivePaymentsController,
        PaymentPlansController,
        CustomerBehaviourController,
        BankActivityController,
        CashMovementsController,
        ExpenseRiskController,
        ReconciliationExceptionsController,
        AuditEngagementsController,
        AuditEvidenceController,
        AuditorLinksController,
        AuditorPortalController,
        DataImportController,
        JournalsController,
        ReportsController,
        AuditController,
        ContactsController,
        TaxRatesController,
        FxController,
        CountryModulesCatalogueController,
        CountryModuleController,
        SalesController,
        PurchasesController,
        BankingController,
        AttachmentsController,
        ApprovalsController,
        ExpensesController,
        ExpenseReportController,
        ExpenseReconciliationController,
        AllowanceRatesController,
        ExpensePolicyController,
        TaxNoticesController,
        FinancialTagsController,
        AccountReconciliationsController,
        CostAllocationsController,
        AdvanceTaxController,
        GstPaymentsController,
        JournalApprovalsController,
        BillChecksController,
        CommunicationPolicyController,
        ExpenseCategorizationController,
        GstController,
        WithholdingController,
        PayrollController,
        ComplianceController,
        BudgetsController,
        CashFlowController,
        KpisController,
        AlertsController,
        CopilotController,
        CollectionsController,
        BankAiController,
        CloseController,
        AiControlController,
        PlatformAiController,
        KeyRotationController,
        AccessRulesController,
        RetentionController,
        SsoSettingsController,
        SsoSignInController,
        FileScanningController,
        SecurityMonitorController,
        BackupsController,
        FixedAssetsController,
        DeferralsController,
        LoansController,
        DepositsController,
        CrmController,
        CustomerInsightsController,
        RevenueForecastController,
        CrmApiController,
        CrmConnectionController,
        SalesOrdersController,
        ContractsController,
        UsageBillingController,
        RevenueRecognitionController,
        CustomerPortalLinksController,
        CustomerPortalController,
        VendorPortalLinksController,
        VendorInvoicesController,
        VendorPortalController,
        SupplierTaxController,
        JournalTemplatesController,
        JournalSuggestionsController,
        RecurringBillsController,
        BadDebtsController,
        YearEndController,
        PaymentBatchesController,
        PaymentScheduleController,
        DisputesController,
        ProFormaController,
    RetainersController,
    PaymentLinksController,
    CustomerOnboardingController,
    VendorPerformanceController,
    VendorRiskController,
    UnbilledRevenueController,
    InternationalPaymentsController,
    VendorOnboardingController,
    PaymentLinkWebhooksController,
    PurchaseOrdersController,
    BillMatchController,
    BillExceptionsController,
        VendorBankDetailsController,
        InvoiceTemplatesController,
        InvoicePrintController,
        ReportExportsController,
        ReportSchedulesController,
        ConsolidationController,
        TwinController,
        RecoveryController,
        CfoController,
        BenchmarkingController,
        GraphController,
        DecisionsController,
    DisastersController,
    ImpactController,
    OpportunitiesController,
    PoliciesController,
    DashboardsController,
    ReportDesignerController,
        ForecastLabController,
        IntegrationsController,
        SignaturesController,
        DimensionsController,
        EInvoicingController,
        EWayBillsController,
        WorkflowsController,
        TasksController,
      ],
      providers: [
        RegionsService,
        AdminService,
        SupportService,
        SupportAccessService,
        UsageService,
        BillingService,
        PlatformBillingService,
        PaymentSettingsService,
        CouponsService,
        AddOnsService,
        AiCreditsService,
        EnterpriseContractsService,
        SubscriptionPaymentsService,
        RenewalsRunnerService,
        { provide: CONFIG, useValue: config },
        prismaProvider,
        documentStoreProvider,
        MovedTables,
        TokensService,
        AuditService,
        AuthService,
        MfaService,
        DevicesService,
        OrgSecurityService,
        SessionsService,
        LoginThrottleService,
        OrganizationsService,
        InvitationsService,
        AccountsService,
        ChartService,
        PeriodsService,
        OpeningBalancesService,
        SetupService,
        ReportViewsService,
        SegregationOfDutiesService,
        InternalControlsService,
        AuditFindingsService,
        AuditSamplingService,
        AiDecisionsService,
        LedgerReplayService,
        PaymentPredictionsService,
        CollectionPrioritiesService,
        PaymentFraudService,
        PaymentPrioritiesService,
        PredictivePaymentsService,
        PaymentPlansService,
        CustomerBehaviourService,
        BankActivityService,
        CashMovementsService,
        ExpenseRiskService,
        ReconciliationExceptionsService,
        AuditEngagementsService,
        AuditEvidenceService,
        AuditorPortalService,
        DataImportService,
        JournalsService,
        ReportsService,
        SubledgerService,
        ContactsService,
        TaxRatesService,
        FxService,
        CountryModulesService,
        DocumentsService,
        BankingService,
        AttachmentsService,
        ApprovalsService,
        ExpensesService,
        ExpenseReportService,
        ExpenseReconciliationService,
        AllowancesService,
        ExpensePolicyService,
        TaxNoticesService,
        FinancialTagsService,
        AccountReconciliationsService,
        CostAllocationsService,
        AdvanceTaxService,
        GstPaymentsService,
        JournalApprovalsService,
        BillChecksService,
        CommunicationPolicyService,
        ExpenseCategorizationService,
        GstService,
        WithholdingService,
        PayrollService,
        LeaveService,
        ComplianceService,
        BudgetsService,
        CashFlowService,
        KpisService,
        AlertsService,
        AlertsRunnerService,
        CopilotTools,
        CopilotActionsService,
        CopilotService,
        CollectionsService,
        BankAiService,
        CloseService,
        ClosePackService,
        CloseRunnerService,
        AiControlService,
        FixedAssetsService,
        DeferralsService,
        LoansService,
        DepositsService,
        CrmService,
        CustomerInsightsService,
        RevenueForecastService,
        ApiKeysService,
        ApiKeyGuard,
        CrmWebhooksService,
        CrmWebhooksRunnerService,
        SalesOrdersService,
        ContractsService,
        UsageBillingService,
        RevenueRecognitionService,
        CustomerPortalService,
        VendorPortalService,
        SupplierTaxService,
        ContractsRunnerService,
        JournalTemplatesService,
        JournalSuggestionsService,
        KeyRotationService,
        AccessRulesService,
        RetentionService,
        SsoService,
        FileScannerService,
        FileVault,
        SecurityMonitorService,
        SecurityMonitorRunnerService,
        BackupsService,
        BadDebtsService,
        YearEndService,
        PaymentBatchesService,
        PaymentScheduleService,
        DisputesService,
        ProFormaService,
    RetainersService,
    PaymentLinksService,
    CustomerOnboardingService,
    VendorPerformanceService,
    VendorRiskService,
    UnbilledRevenueService,
    InternationalPaymentsService,
    PurchaseOrdersService,
    BillExceptionsService,
        JournalTemplatesRunnerService,
        RetentionRunnerService,
        RecurringBillsService,
        RecurringBillsRunnerService,
        InvoiceTemplatesService,
        ReportExportService,
        ReportSchedulesService,
        ReportSchedulesRunnerService,
        ConsolidationService,
        IntercompanyService,
        TwinService,
        RecoveryService,
        CfoService,
        BenchmarkingService,
        GraphService,
        DecisionsService,
    DisastersService,
    ImpactService,
    OpportunitiesService,
    PoliciesService,
    DashboardsService,
    ReportDesignerService,
        ForecastLabService,
        IntegrationsService,
        DimensionsService,
        { provide: COPILOT_MODEL, useValue: copilotModel === undefined ? copilotModelFromConfig(config) : copilotModel },
        EInvoicingService,
        EWayBillsService,
        TasksService,
        WorkflowRunnerService,
        MailerService,
        WorkflowsService,
        MetricsService,
        MaintenanceService,
        HeartbeatsService,
        FlagsService,
        ErrorsService,
        SystemService,
        // Order matters: rate limiting runs before authentication.
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
