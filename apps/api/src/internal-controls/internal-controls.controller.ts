import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { CONTROL_AREAS, CONTROL_FREQUENCIES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { InternalControlsService } from './internal-controls.service';

const ControlBody = z
  .object({
    title: z.string().trim().min(1, 'Name the control').max(120, 'Keep the title under 120 characters'),
    objective: z.string().trim().min(1, 'Say what the control is for').max(500, 'Keep the objective under 500 characters'),
    area: z.enum(CONTROL_AREAS),
    frequency: z.enum(CONTROL_FREQUENCIES),
    ownerId: z.uuid(),
    active: z.boolean().optional(),
  })
  .strict();
const CreateBody = z.union([z.object({ templateId: z.string().max(40), ownerId: z.uuid() }).strict(), ControlBody]);
const periodKey = z.string().regex(/^(\d{4}-(0[1-9]|1[0-2])|\d{4}-Q[1-4]|FY\d{4})$/, 'Use 2026-10, 2026-Q2 or FY2026');
const CheckBody = z.object({ period: periodKey }).strict();
const TestBody = z.object({ period: periodKey, result: z.enum(['PASS', 'FAIL']).optional(), notes: z.string().max(1000, 'Keep the notes under 1000 characters').nullish() }).strict();

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/controls')
export class InternalControlsController {
  constructor(private readonly controls: InternalControlsService) {}

  /** The controls register: each control's owner, the period due for testing and where it stands, and library controls not yet added. */
  @Get()
  @RequirePermission('audit.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.controls.list(org, user);
  }

  @Post()
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.controls.create(org, user, body as never);
  }

  @Get(':id')
  @RequirePermission('audit.read')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.controls.get(org, user, id);
  }

  @Put(':id')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(ControlBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ControlBody)) body: z.infer<typeof ControlBody>) {
    return this.controls.update(org, user, id, body);
  }

  /** Runs the automatic check for a period and shows the outcome, without recording a test. */
  @Post(':id/check')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(CheckBody) })
  check(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CheckBody)) body: z.infer<typeof CheckBody>) {
    return this.controls.runCheck(org, id, body.period);
  }

  @Post(':id/tests')
  @RequirePermission('audit.read')
  @ApiBody({ schema: openApi(TestBody) })
  test(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TestBody)) body: z.infer<typeof TestBody>) {
    return this.controls.recordTest(org, user, id, body);
  }
}
