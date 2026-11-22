import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { COMPLIANCE_DOC_KINDS } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ComplianceDocumentsService } from './compliance-documents.service';

const ListQuery = z.object({ kind: z.enum(COMPLIANCE_DOC_KINDS).optional(), key: z.string().max(60).optional(), includeVoid: z.enum(['true', 'false']).optional() }).strict();
const CreateBody = z
  .object({
    kind: z.enum(COMPLIANCE_DOC_KINDS),
    obligationKey: z.string().max(60).nullish(),
    title: z.string().trim().min(1, 'Give the document a title').max(200, 'Keep the title under 200 characters'),
    reference: z.string().max(100, 'Keep the reference under 100 characters').nullish(),
    note: z.string().max(1000, 'Keep the note under 1000 characters').nullish(),
  })
  .strict();
const VoidBody = z.object({ reason: z.string().trim().min(3, 'Say why').max(1000, 'Keep the reason under 1000 characters') }).strict();
const GapsQuery = z.object({ days: z.coerce.number().int().min(30).max(365).default(365) }).strict();

/** Compliance document management (TAX-025). */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/compliance/documents')
export class ComplianceDocumentsController {
  constructor(private readonly docs: ComplianceDocumentsService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.docs.list(org, { kind: q.kind, key: q.key, includeVoid: q.includeVoid === 'true' });
  }

  /** Returns and payments a document can be linked to: due in the last year or the next 30 days. */
  @Get('obligations')
  @RequirePermission('reports.read')
  obligations(@CurrentOrg() org: OrgContext) {
    return this.docs.obligations(org);
  }

  /** Returns marked filed and payments made without their acknowledgement or challan on file. */
  @Get('gaps')
  @RequirePermission('reports.read')
  gaps(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(GapsQuery)) q: z.infer<typeof GapsQuery>) {
    return this.docs.gaps(org, q.days);
  }

  /** Add a document record (then attach its files with entityType COMPLIANCE_DOCUMENT). */
  @Post()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.docs.create(org, user, body);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.get(org, id);
  }

  /** Void a record added by mistake; it is kept, with the reason. */
  @Post(':id/void')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(VoidBody) })
  void(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>) {
    return this.docs.void(org, user, id, body.reason);
  }
}
