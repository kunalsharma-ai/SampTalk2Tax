import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { BillReaderService } from './bill-reader.service';

const FileQuery = z.object({ fileName: z.string().trim().max(255).default('bill.pdf') }).strict();
const TextBody = z.object({ text: z.string().max(200_000, 'Paste at most 200,000 characters'), fileName: z.string().trim().max(255).nullish() }).strict();
const LinkBody = z.object({ documentId: z.uuid() }).strict();
const DiscardBody = z.object({ reason: z.string().trim().max(500).default('') }).strict();

/** The bill reader (AP-025): a supplier's bill read from a PDF or pasted text, reviewed, then saved as a bill. */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/bill-reader')
export class BillReaderController {
  constructor(private readonly s: BillReaderService) {}

  @Get()
  @RequirePermission('purchases.read')
  list() {
    return this.s.list();
  }

  /** Send the PDF's bytes as the body (Content-Type: application/pdf or application/octet-stream). */
  @Post('file')
  @RequirePermission('purchases.manage')
  @ApiConsumes('application/octet-stream')
  readFile(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(FileQuery)) q: z.infer<typeof FileQuery>, @Body() body: unknown) {
    return this.s.readFile(org, user, q.fileName, body);
  }

  @Post('text')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(TextBody) })
  readText(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(TextBody)) b: z.infer<typeof TextBody>) {
    return this.s.readText(org, user, b.text, b.fileName ?? null);
  }

  @Get(':readingId')
  @RequirePermission('purchases.read')
  get(@Param('readingId', ParseUUIDPipe) id: string) {
    return this.s.get(id);
  }

  /** After the bill is saved from the reading: links them and attaches the PDF to the bill. */
  @Post(':readingId/link')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(LinkBody) })
  link(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('readingId', ParseUUIDPipe) id: string, @Body(new ZodPipe(LinkBody)) b: z.infer<typeof LinkBody>) {
    return this.s.link(org, user, id, b.documentId);
  }

  @Post(':readingId/discard')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(DiscardBody) })
  discard(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('readingId', ParseUUIDPipe) id: string, @Body(new ZodPipe(DiscardBody)) b: z.infer<typeof DiscardBody>) {
    return this.s.discard(org, user, id, b.reason);
  }
}
