import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { IMPORT_KINDS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { DataImportService } from './data-import.service';

/** A CSV of up to 2,000 rows; 2 MB is far more than that needs. */
const ImportBody = z.object({ csv: z.string().min(1).max(2_000_000), date: isoDate.optional() });
const Kind = z.enum(IMPORT_KINDS);

@ApiTags('data-import')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/imports')
export class DataImportController {
  constructor(private readonly imports: DataImportService) {}

  /** What can be imported, its columns and a template, and which of them this role may import. */
  @Get()
  @RequirePermission('accounts.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.imports.overview(org);
  }

  /** Checks a file against the books and says what an import would do, row by row. Writes nothing. */
  @Post(':kind/preview')
  @HttpCode(200)
  @RequirePermission('accounts.read')
  @ApiBody({ schema: openApi(ImportBody) })
  preview(@CurrentOrg() org: OrgContext, @Param('kind', new ZodPipe(Kind)) kind: z.infer<typeof Kind>, @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>) {
    return this.imports.preview(org, kind, body);
  }

  /** Imports a file with no problems. Each kind needs its own permission, checked in the service. */
  @Post(':kind')
  @RequirePermission('accounts.read')
  @ApiBody({ schema: openApi(ImportBody) })
  run(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('kind', new ZodPipe(Kind)) kind: z.infer<typeof Kind>, @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>) {
    return this.imports.run(org, user, kind, body);
  }
}
