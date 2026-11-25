import { Body, Controller, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { ReceiptReadingService } from './receipt-reading.service';

const FileQuery = z.object({ fileName: z.string().trim().max(255).default('') }).strict();

@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/receipt-reading')
export class ReceiptReadingController {
  constructor(private readonly s: ReceiptReadingService) {}

  /** Read a receipt photo (JPEG, PNG, WebP) or PDF sent as the body; returns what was read, to check before saving. */
  @Post()
  @RequirePermission('expenses.submit')
  @ApiConsumes('application/octet-stream')
  read(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(FileQuery)) q: z.infer<typeof FileQuery>, @Body() body: unknown) {
    return this.s.read(org, user, q.fileName, body);
  }
}
