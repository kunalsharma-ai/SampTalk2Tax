import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { REVIEW_ASPECTS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { VendorPerformanceService } from './vendor-performance.service';

const id = z.string().uuid('Not a valid id');
const PeriodQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const ReviewBody = z
  .object({
    aspect: z.enum(REVIEW_ASPECTS),
    rating: z.number().int(),
    note: z.string().max(2000).nullish(),
    orderId: id.nullish(),
    reviewDate: isoDate.nullish(),
  })
  .strict();
const WithdrawBody = z.object({ reason: z.string().trim().min(1, 'Say why the review is withdrawn').max(500) }).strict();

@ApiTags('vendor performance')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases')
export class VendorPerformanceController {
  constructor(private readonly perf: VendorPerformanceService) {}

  /** Every vendor's scorecard for a period (default: the twelve months to today). */
  @Get('vendor-performance')
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    return this.perf.list(org, q);
  }

  /** One vendor's scorecard, order deliveries and reviews. */
  @Get('vendors/:contactId/performance')
  @RequirePermission('purchases.read')
  detail(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', new ZodPipe(id)) contactId: string, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    return this.perf.detail(org, { id: user.id }, contactId, q);
  }

  /** Rate a vendor from 1 to 5 on one aspect, optionally for one purchase order. */
  @Post('vendors/:contactId/reviews')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', new ZodPipe(id)) contactId: string, @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.perf.review(org, { id: user.id }, contactId, body);
  }

  /** The author withdraws a review; it stays on record but no longer counts. */
  @Post('vendors/:contactId/reviews/:reviewId/withdraw')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(WithdrawBody) })
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', new ZodPipe(id)) contactId: string, @Param('reviewId', new ZodPipe(id)) reviewId: string, @Body(new ZodPipe(WithdrawBody)) body: z.infer<typeof WithdrawBody>) {
    return this.perf.withdraw(org, { id: user.id }, contactId, reviewId, body.reason);
  }
}
