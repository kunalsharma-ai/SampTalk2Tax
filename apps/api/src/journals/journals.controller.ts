import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { hasPermission } from '@talk2tax/security';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { JournalsService } from './journals.service';

const Line = z.object({
  accountId: z.uuid(),
  debit: decimalString.optional(),
  credit: decimalString.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  exchangeRate: decimalString.optional(),
  description: z.string().max(500).optional(),
  dimensions: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(100)).optional(),
  departmentId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
});
const JournalBody = z.object({
  date: isoDate,
  type: z.enum(['STANDARD', 'ADJUSTING', 'OPENING', 'CLOSING', 'RECURRING']).default('STANDARD'),
  memo: z.string().max(1000).optional(),
  reference: z.string().max(100).optional(),
  lines: z.array(Line).min(2).max(5000),
});
const CreateBody = JournalBody.extend({ post: z.boolean().default(false) });
const ReverseBody = z.object({ date: isoDate, memo: z.string().max(1000).optional() });
const ListQuery = z.object({
  status: z.enum(['DRAFT', 'POSTED']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/).optional();

@ApiTags('journals')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/journals')
export class JournalsController {
  constructor(private readonly journals: JournalsService) {}

  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.journals.list(org.id, q);
  }

  @Get(':entryId')
  @RequirePermission('journals.read')
  get(@CurrentOrg() org: OrgContext, @Param('entryId', ParseUUIDPipe) id: string) {
    return this.journals.get(org.id, id);
  }

  @Post()
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(CreateBody) })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retry-safe key (8-128 chars). Same key + same body returns the original entry.' })
  async create(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = new ZodPipe(IdempotencyKey).transform(rawKey);
    const { post, ...input } = body;
    if (post) this.assert(org, 'post');
    const result = await this.journals.create(org, user, input, { post, idempotencyKey: key });
    res.status(result.replayed ? 200 : 201);
    if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
    return result.entry;
  }

  @Put(':entryId')
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(JournalBody) })
  update(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('entryId', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(JournalBody)) body: z.infer<typeof JournalBody>,
  ) {
    return this.journals.updateDraft(org, user, id, body);
  }

  @Delete(':entryId')
  @HttpCode(204)
  @RequirePermission('journals.create')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('entryId', ParseUUIDPipe) id: string) {
    await this.journals.deleteDraft(org.id, user, id);
  }

  @Post(':entryId/post')
  @HttpCode(200)
  @RequirePermission('journals.post')
  post(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('entryId', ParseUUIDPipe) id: string) {
    return this.journals.postDraft(org, user, id);
  }

  @Post(':entryId/reverse')
  @RequirePermission('journals.reverse')
  @ApiBody({ schema: openApi(ReverseBody) })
  reverse(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('entryId', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReverseBody)) body: z.infer<typeof ReverseBody>,
  ) {
    return this.journals.reverse(org, user, id, body);
  }

  private assert(org: OrgContext, what: 'post') {
    // Creating-and-posting in one call needs journals.post as well as journals.create.
    if (what === 'post' && !hasPermission(org.role, 'journals.post')) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `Your role (${org.role}) does not have journals.post` });
    }
  }
}
