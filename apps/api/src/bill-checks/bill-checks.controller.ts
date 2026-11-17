import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { BillChecksService } from './bill-checks.service';

const ListQuery = z.object({ includeReviewed: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });
const ReviewBody = z.object({ note: z.string().trim().min(3, 'Say why the bill is fine').max(1000) });

/** Unusual bill checks (AP-031): purchases.read sees the findings, purchases.manage reviews them. */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/bill-checks')
export class BillChecksController {
  constructor(private readonly checks: BillChecksService) {}

  @Get()
  @RequirePermission('purchases.read')
  worklist(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.checks.worklist(org, q);
  }

  @Get(':documentId')
  @RequirePermission('purchases.read')
  forBill(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) id: string) {
    return this.checks.forBill(org, id);
  }

  @Post(':documentId/review')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.checks.review(org, user.id, id, body.note);
  }
}
