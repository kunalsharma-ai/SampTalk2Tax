import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { TaxDocumentsService } from './tax-documents.service';

const FileQuery = z.object({ fileName: z.string().trim().max(255).default('document.pdf') }).strict();
const TextBody = z.object({ text: z.string().max(200_000, 'Paste at most 200,000 characters'), fileName: z.string().trim().max(255).nullish() }).strict();
const ReviewBody = z.object({ note: z.string().trim().max(1000).default('') }).strict();

/** Tax document interpretation (TAX-043): TDS certificates, annual tax statements, GST challans and 1099s read and explained. */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/document-readings')
export class TaxDocumentsController {
  constructor(private readonly s: TaxDocumentsService) {}

  @Get()
  @RequirePermission('reports.read')
  list() {
    return this.s.list();
  }

  /** Send the PDF's bytes as the body (Content-Type: application/pdf or application/octet-stream). */
  @Post('file')
  @RequirePermission('accounts.manage')
  @ApiConsumes('application/octet-stream')
  readFile(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(FileQuery)) q: z.infer<typeof FileQuery>, @Body() body: unknown) {
    return this.s.readFile(org, user, q.fileName, body);
  }

  @Post('text')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(TextBody) })
  readText(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(TextBody)) b: z.infer<typeof TextBody>) {
    return this.s.readText(org, user, b.text, b.fileName ?? null);
  }

  @Get(':readingId')
  @RequirePermission('reports.read')
  get(@Param('readingId', ParseUUIDPipe) id: string) {
    return this.s.get(id);
  }

  /** Marks the document reviewed once someone has acted on it, with an optional note. */
  @Post(':readingId/review')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('readingId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReviewBody)) b: z.infer<typeof ReviewBody>) {
    return this.s.review(org, user, id, b.note);
  }
}
