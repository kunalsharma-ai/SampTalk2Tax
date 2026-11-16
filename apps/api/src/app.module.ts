import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/guards';
import { TokensService } from './auth/tokens.service';
import { ErrorFilter } from './common/errors';
import { ContactsController } from './contacts/contacts.controller';
import { ContactsService } from './contacts/contacts.service';
import { DocumentsService } from './ledgers/documents.service';
import { PurchasesController, SalesController } from './ledgers/ledger.controllers';
import { SubledgerService } from './ledgers/subledger.service';
import { TaxRatesController } from './tax-rates/tax-rates.controller';
import { TaxRatesService } from './tax-rates/tax-rates.service';
import { PrismaService } from './common/prisma.service';
import { AppConfig, CONFIG } from './config';
import { HealthController } from './health/health.controller';
import { JournalsController } from './journals/journals.controller';
import { JournalsService } from './journals/journals.service';
import { OrganizationsController } from './organizations/organizations.controller';
import { OrganizationsService } from './organizations/organizations.service';
import { PeriodsController } from './periods/periods.controller';
import { PeriodsService } from './periods/periods.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';

/**
 * Modular monolith root. Domains are separated by folder and service boundary so they
 * can be extracted later; for now they share one process and one Postgres database.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        OrganizationsController,
        AccountsController,
        PeriodsController,
        JournalsController,
        ReportsController,
        AuditController,
        ContactsController,
        TaxRatesController,
        SalesController,
        PurchasesController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        PrismaService,
        TokensService,
        AuditService,
        AuthService,
        OrganizationsService,
        AccountsService,
        PeriodsService,
        JournalsService,
        ReportsService,
        SubledgerService,
        ContactsService,
        TaxRatesService,
        DocumentsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
