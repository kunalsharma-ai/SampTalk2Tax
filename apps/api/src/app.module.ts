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
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
