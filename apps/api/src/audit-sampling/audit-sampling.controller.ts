import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { MAX_SAMPLE_SIZE, SAMPLE_METHODS, SAMPLE_POPULATIONS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AuditSamplingService } from './audit-sampling.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const DrawBody = z
  .object({
    name: z.string().trim().min(1, 'Name the sample').max(120, 'Keep the name under 120 characters'),
    population: z.enum(SAMPLE_POPULATIONS),
    from: isoDate,
    to: isoDate,
    method: z.enum(SAMPLE_METHODS),
    size: z.number().int().min(1).max(MAX_SAMPLE_SIZE, `Sample at most ${MAX_SAMPLE_SIZE} items`),
    threshold: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Give the threshold as an amount, such as 50000').optional(),
    seed: z.string().trim().max(80, 'Keep the seed under 80 characters').optional(),
  })
  .strict();
const ResultBody = z.object({ result: z.enum(['OK', 'EXCEPTION']), note: z.string().max(1000, 'Keep the note under 1000 characters').nullish() }).strict();

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/audit-samples')
export class AuditSamplingController {
  constructor(private readonly samples: AuditSamplingService) {}

  @Get()
  @RequirePermission('audit.read')
  list() {
    return this.samples.list();
  }

  /** Draws a sample from posted journals, bills, invoices or supplier payments, and keeps it with its seed. */
  @Post()
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(DrawBody) })
  draw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DrawBody)) body: z.infer<typeof DrawBody>) {
    return this.samples.draw(org, user, body);
  }

  /** One sample, with whether drawing it again from its seed gives the same items. */
  @Get(':id')
  @RequirePermission('audit.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.samples.get(id);
  }

  /** Records one item's result, once. */
  @Post(':id/items/:refId/result')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(ResultBody) })
  record(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('refId', ParseUUIDPipe) refId: string, @Body(new ZodPipe(ResultBody)) body: z.infer<typeof ResultBody>) {
    return this.samples.record(org, user, id, refId, body);
  }
}
