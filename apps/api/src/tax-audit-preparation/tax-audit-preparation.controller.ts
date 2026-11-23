import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { AUDIT_PREP_CHECK_KEYS } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { TaxAuditPreparationService } from './tax-audit-preparation.service';

const year = z.string().regex(/^\d{4}-\d{2}$/, 'A financial year such as 2025-26');
const Note = z.object({ note: z.string().max(2000) }).strict();
const Reopen = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/**
 * Tax audit preparation (TAX-051): readiness checks for a financial year before the tax audit,
 * notes to the auditor, marking the year ready and reopening it, and the checklist as CSV.
 */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/audit-preparation')
export class TaxAuditPreparationController {
  constructor(private readonly s: TaxAuditPreparationService) {}

  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(z.object({ year: year.optional() }).strict())) q: { year?: string }) {
    return this.s.get(org, q.year);
  }

  @Get('export')
  @RequirePermission('reports.read')
  exportCsv(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(z.object({ year: year.optional() }).strict())) q: { year?: string }) {
    return this.s.exportCsv(org, user, q.year);
  }

  @Put(':year/notes/:key')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(Note) })
  note(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('year', new ZodPipe(year)) y: string, @Param('key', new ZodPipe(z.enum(AUDIT_PREP_CHECK_KEYS))) key: (typeof AUDIT_PREP_CHECK_KEYS)[number], @Body(new ZodPipe(Note)) body: z.infer<typeof Note>) {
    return this.s.note(org, user, y, key, body.note);
  }

  @Post(':year/ready')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  ready(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('year', new ZodPipe(year)) y: string) {
    return this.s.markReady(org, user, y);
  }

  @Post(':year/reopen')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(Reopen) })
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('year', new ZodPipe(year)) y: string, @Body(new ZodPipe(Reopen)) body: z.infer<typeof Reopen>) {
    return this.s.reopen(org, user, y, body.reason);
  }
}
