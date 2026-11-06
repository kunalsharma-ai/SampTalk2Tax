import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { RECURRING_FREQUENCIES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { JournalTemplatesService } from './journal-templates.service';

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const Line = z
  .object({
    accountId: z.string().uuid('Choose an account'),
    debit: decimalString.nullish(),
    credit: decimalString.nullish(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
    description: text(500),
    departmentId: z.string().uuid().nullish(),
    projectId: z.string().uuid().nullish(),
  })
  .strict();
const Schedule = z
  .object({
    frequency: z.enum(RECURRING_FREQUENCIES),
    startDate: isoDate,
    endDate: isoDate.nullish(),
    monthEnd: z.boolean().default(false),
    postMode: z.enum(['DRAFT', 'POST']).default('DRAFT'),
  })
  .strict();
const TemplateBody = z
  .object({
    name: z.string().trim().min(1, 'Give the template a name').max(120),
    description: text(500),
    journalType: z.enum(['STANDARD', 'ADJUSTING']).default('STANDARD'),
    memo: text(1000),
    reference: text(100),
    lines: z.array(Line).min(2, 'A template needs at least two lines').max(500),
    schedule: Schedule.nullish(),
  })
  .strict();
const FromJournalBody = z.object({ name: z.string().trim().min(1, 'Give the template a name').max(120) }).strict();
const UseBody = z.object({ date: isoDate, post: z.boolean().default(false) }).strict();
const ResumeBody = z.object({ skipMissed: z.boolean().default(false) }).strict();
const ListQuery = z.object({ view: z.enum(['active', 'scheduled', 'archived', 'all']).optional() });

/** Journal templates (GL-012) and recurring journals (GL-007). */
@ApiTags('journals')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/journal-templates')
export class JournalTemplatesController {
  constructor(private readonly templates: JournalTemplatesService) {}

  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.templates.list(org, q.view);
  }

  /** Make every scheduled run that has fallen due, for every template of the organisation (the runner also does this). */
  @Post('run-due')
  @HttpCode(200)
  @RequirePermission('journals.create')
  async runDueAll(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.templates.runOrg(org, user);
  }

  @Post()
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(TemplateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(TemplateBody)) body: z.infer<typeof TemplateBody>) {
    return this.templates.create(org, user, body);
  }

  /** Save an existing manual journal's lines as a template. */
  @Post('from-journal/:entryId')
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(FromJournalBody) })
  fromJournal(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('entryId', ParseUUIDPipe) entryId: string, @Body(new ZodPipe(FromJournalBody)) body: z.infer<typeof FromJournalBody>) {
    return this.templates.fromJournal(org, user, entryId, body.name);
  }

  @Get(':id')
  @RequirePermission('journals.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(org, id);
  }

  @Put(':id')
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(TemplateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TemplateBody)) body: z.infer<typeof TemplateBody>) {
    return this.templates.update(org, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('journals.create')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.templates.remove(org, user, id);
  }

  /** Make a journal from the template, dated `date`: a draft, or posted with `post` (needs journals.post). */
  @Post(':id/use')
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(UseBody) })
  use(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UseBody)) body: z.infer<typeof UseBody>) {
    return this.templates.use(org, user, id, body);
  }

  @Post(':id/run-due')
  @HttpCode(200)
  @RequirePermission('journals.create')
  runNow(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.runNow(org, user, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission('journals.create')
  pause(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.setSchedule(org, user, id, 'pause');
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(ResumeBody) })
  resume(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ResumeBody)) body: z.infer<typeof ResumeBody>) {
    return this.templates.setSchedule(org, user, id, 'resume', body);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequirePermission('journals.create')
  end(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.setSchedule(org, user, id, 'end');
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('journals.create')
  archive(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.setArchived(org, user, id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission('journals.create')
  restore(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.setArchived(org, user, id, false);
  }
}
