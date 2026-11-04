import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { DECISION_CATEGORIES, KPI_DEFINITIONS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { type DecisionInput, DecisionsService, type ReviewInput } from './decisions.service';

const isoDate = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `Enter ${what} as YYYY-MM-DD`);
const text = (max: number, what: string) => z.string().trim().max(max, `Keep ${what} under ${max} characters`);
const category = z.enum(DECISION_CATEGORIES.map((c) => c.key) as [string, ...string[]], { message: 'Choose a category' });
const DecisionBody = z
  .object({
    title: text(200, 'the title').min(1, 'Give the decision a title'),
    decision: text(4000, 'the decision').min(1, 'Say what was decided'),
    context: text(4000, 'the context').nullish(),
    category,
    tags: z.array(z.string().trim().min(1).max(40, 'Keep each tag under 40 characters')).max(10, 'Use at most 10 tags').default([]),
    decidedOn: isoDate('the decision date'),
    decidedBy: text(200, 'who decided').nullish(),
    reviewDue: isoDate('the review date').nullish(),
    assumptions: z.array(z.object({ text: text(1000, 'each assumption').min(1, 'An assumption cannot be empty') }).strict()).max(30, 'Record at most 30 assumptions').default([]),
    outcomes: z
      .array(
        z
          .object({
            kpi: z.enum(KPI_DEFINITIONS.map((k) => k.key) as [string, ...string[]], { message: 'Choose a measure from the list' }),
            comparator: z.enum(['AT_LEAST', 'AT_MOST'], { message: 'Choose at least or at most' }),
            target: z.string().trim().regex(/^-?\d{1,13}(\.\d{1,6})?$/, 'Enter the target as a number'),
            measureMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter the month to measure as YYYY-MM'),
          })
          .strict(),
      )
      .max(12, 'Expect at most 12 outcomes')
      .default([]),
    sourceType: z.enum(['SCENARIO', 'RECOVERY_PLAN']).nullish(),
    sourceId: z.string().uuid().nullish(),
  })
  .strict();
const UpdateBody = DecisionBody.omit({ sourceType: true, sourceId: true });
const ReviewBody = z
  .object({
    verdict: z.enum(['WORKED', 'PARTLY', 'DID_NOT_WORK'], { message: 'Choose whether the decision worked' }),
    outcomeNotes: text(4000, 'what happened').nullish(),
    lessons: text(4000, 'the lessons').min(1, 'Write down what was learned'),
    assumptions: z.array(z.object({ held: z.boolean().nullable(), note: text(1000, 'each note').nullish() }).strict()).max(30),
  })
  .strict();
const WithdrawBody = z.object({ reason: text(1000, 'the reason').min(1, 'Say why the decision is withdrawn') }).strict();
const ListQuery = z
  .object({
    q: z.string().max(200).optional(),
    category: category.optional(),
    status: z.enum(['ACTIVE', 'REVIEWED', 'WITHDRAWN']).optional(),
    verdict: z.enum(['WORKED', 'PARTLY', 'DID_NOT_WORK']).optional(),
  })
  .strict();
const DraftQuery = z.object({ sourceType: z.enum(['SCENARIO', 'RECOVERY_PLAN']), sourceId: z.string().uuid() }).strict();

/**
 * Financial decision memory. Reading needs reports.read; recording, editing, reviewing and
 * withdrawing need decisions.manage (owners, admins, accountants, approvers).
 */
@ApiTags('decisions')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/decisions')
export class DecisionsController {
  constructor(private readonly svc: DecisionsService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.svc.list(org.id, q);
  }

  @Get('meta')
  @RequirePermission('reports.read')
  meta() {
    return this.svc.meta();
  }

  @Get('draft')
  @RequirePermission('decisions.manage')
  draft(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(DraftQuery)) q: z.infer<typeof DraftQuery>) {
    return this.svc.draft(org.id, q.sourceType, q.sourceId);
  }

  @Post()
  @RequirePermission('decisions.manage')
  @ApiBody({ schema: openApi(DecisionBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DecisionBody)) b: z.infer<typeof DecisionBody>) {
    return this.svc.create(org.id, user, b as DecisionInput);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(org.id, id);
  }

  @Put(':id')
  @RequirePermission('decisions.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.svc.update(org.id, user, id, b as DecisionInput);
  }

  @Post(':id/review')
  @HttpCode(200)
  @RequirePermission('decisions.manage')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReviewBody)) b: z.infer<typeof ReviewBody>) {
    return this.svc.review(org.id, user, id, b as ReviewInput);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequirePermission('decisions.manage')
  @ApiBody({ schema: openApi(WithdrawBody) })
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(WithdrawBody)) b: z.infer<typeof WithdrawBody>) {
    return this.svc.withdraw(org.id, user, id, b.reason);
  }
}
