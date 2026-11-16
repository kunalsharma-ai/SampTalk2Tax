import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { ApprovalsController } from './approvals/approvals.controller';
import { ApprovalsService } from './approvals/approvals.service';
import { AttachmentsController } from './attachments/attachments.controller';
import { AttachmentsService } from './attachments/attachments.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/guards';
import { LoginThrottleService } from './auth/login-throttle.service';
import { RateLimitGuard } from './auth/rate-limit';
import { SessionsService } from './auth/sessions.service';
import { TokensService } from './auth/tokens.service';
import { BankingController } from './banking/banking.controller';
import { BankingService } from './banking/banking.service';
import { ExpensesController } from './expenses/expenses.controller';
import { ExpensesService } from './expenses/expenses.service';
import { ErrorFilter } from './common/errors';
import { ContactsController } from './contacts/contacts.controller';
import { ContactsService } from './contacts/contacts.service';
import { DocumentsService } from './ledgers/documents.service';
import { PurchasesController, SalesController } from './ledgers/ledger.controllers';
import { SubledgerService } from './ledgers/subledger.service';
import { TaxRatesController } from './tax-rates/tax-rates.controller';
import { TaxRatesService } from './tax-rates/tax-rates.service';
import { prismaProvider } from './common/prisma.service';
import { AppConfig, CONFIG } from './config';
import { GstController } from './gst/gst.controller';
import { GstService } from './gst/gst.service';
import { HealthController } from './health/health.controller';
import { JournalsController } from './journals/journals.controller';
import { JournalsService } from './journals/journals.service';
import { InvitationLinksController, OrganizationsController } from './organizations/organizations.controller';
import { InvitationsService } from './organizations/invitations.service';
import { OrganizationsService } from './organizations/organizations.service';
import { PeriodsController } from './periods/periods.controller';
import { PeriodsService } from './periods/periods.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { PayrollController } from './payroll/payroll.controller';
import { PayrollService } from './payroll/payroll.service';
import { BudgetsController } from './budgets/budgets.controller';
import { BudgetsService } from './budgets/budgets.service';
import { CashFlowController } from './cash-flow/cash-flow.controller';
import { CashFlowService } from './cash-flow/cash-flow.service';
import { KpisController } from './kpis/kpis.controller';
import { KpisService } from './kpis/kpis.service';
import { AlertsController } from './alerts/alerts.controller';
import { AlertsService } from './alerts/alerts.service';
import { CollectionsController } from './collections/collections.controller';
import { CollectionsService } from './collections/collections.service';
import { CopilotController } from './copilot/copilot.controller';
import { COPILOT_MODEL, CopilotModel, copilotModelFromConfig } from './copilot/copilot.model';
import { CopilotService } from './copilot/copilot.service';
import { CopilotTools } from './copilot/copilot.tools';
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
        AuthController,
        OrganizationsController,
        InvitationLinksController,
        AccountsController,
        PeriodsController,
        JournalsController,
        ReportsController,
        AuditController,
        ContactsController,
        TaxRatesController,
        SalesController,
        PurchasesController,
        BankingController,
        AttachmentsController,
        ApprovalsController,
        ExpensesController,
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
        EInvoicingController,
        EWayBillsController,
        WorkflowsController,
        TasksController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        prismaProvider,
        TokensService,
        AuditService,
        AuthService,
        SessionsService,
        LoginThrottleService,
        OrganizationsService,
        InvitationsService,
        AccountsService,
        PeriodsService,
        JournalsService,
        ReportsService,
        SubledgerService,
        ContactsService,
        TaxRatesService,
        DocumentsService,
        BankingService,
        AttachmentsService,
        ApprovalsService,
        ExpensesService,
        GstService,
        WithholdingService,
        PayrollService,
        ComplianceService,
        BudgetsService,
        CashFlowService,
        KpisService,
        AlertsService,
        CopilotTools,
        CopilotService,
        CollectionsService,
        { provide: COPILOT_MODEL, useValue: copilotModel === undefined ? copilotModelFromConfig(config) : copilotModel },
        EInvoicingService,
        EWayBillsService,
        TasksService,
        WorkflowRunnerService,
        MailerService,
        WorkflowsService,
        // Order matters: rate limiting runs before authentication.
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
