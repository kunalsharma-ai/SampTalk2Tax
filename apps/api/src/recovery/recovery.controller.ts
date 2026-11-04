import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { RecoveryService } from './recovery.service';

const baselineMonths = z.union([z.literal(3), z.literal(6), z.literal(12)]);
const horizonMonths = z.number().int().min(1, 'Choose a horizon from 1 to 60 months').max(60, 'Choose a horizon from 1 to 60 months');
const OptionsQuery = z.object({ baselineMonths: z.coerce.number().pipe(baselineMonths).default(6), horizonMonths: z.coerce.number().pipe(horizonMonths).default(12) }).strict();
const name = z.string().trim().min(1, 'Give the plan a name').max(120, 'Keep the name under 120 characters');
const description = z.string().trim().max(1000).nullish();
const CreateBody = z.object({ name, description, baselineMonths, horizonMonths }).strict();
const UpdateBody = z.object({ name: name.optional(), description, status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).optional() }).strict();
const AddBody = z.object({ optionKey: z.string().trim().min(1).max(40) }).strict();
const ActionBody = z
  .object({
    status: z.enum(['PLANNED', 'IN_PROGRESS', 'DONE', 'DROPPED']).optional(),
    ownerId: z.string().uuid('Choose an owner from the list').nullish(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the due date as YYYY-MM-DD').nullish(),
    note: z.string().max(2000, 'Keep notes under 2000 characters').nullish(),
  })
  .strict();

/**
 * The financial recovery planner. Reading options and plans needs reports.read; building plans
 * needs scenarios.manage. Nothing here posts, pays, borrows or contacts anyone.
 */
@ApiTags('recovery')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/recovery')
export class RecoveryController {
  constructor(private readonly svc: RecoveryService) {}

  @Get('options')
  @RequirePermission('reports.read')
  options(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(OptionsQuery)) q: z.infer<typeof OptionsQuery>) {
    return this.svc.options(org.id, q as { baselineMonths: 3 | 6 | 12; horizonMonths: number });
  }

  @Get('plans')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org.id);
  }

  @Post('plans')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.create(org.id, user, b as z.infer<typeof CreateBody> & { baselineMonths: 3 | 6 | 12 });
  }

  @Get('plans/:id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(org.id, id);
  }

  @Put('plans/:id')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.svc.update(org.id, user, id, b);
  }

  @Delete('plans/:id')
  @RequirePermission('scenarios.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(org.id, user, id);
  }

  @Post('plans/:id/actions')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(AddBody) })
  addAction(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AddBody)) b: z.infer<typeof AddBody>) {
    return this.svc.addAction(org.id, user, id, b.optionKey);
  }

  @Put('plans/:id/actions/:actionId')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(ActionBody) })
  updateAction(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('actionId', ParseUUIDPipe) actionId: string, @Body(new ZodPipe(ActionBody)) b: z.infer<typeof ActionBody>) {
    return this.svc.updateAction(org.id, user, id, actionId, b);
  }

  @Delete('plans/:id/actions/:actionId')
  @RequirePermission('scenarios.manage')
  removeAction(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('actionId', ParseUUIDPipe) actionId: string) {
    return this.svc.removeAction(org.id, user, id, actionId);
  }

  /** Copies the plan into a digital-twin scenario (for refining and approval in the war room). */
  @Post('plans/:id/scenario')
  @HttpCode(201)
  @RequirePermission('scenarios.manage')
  toScenario(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.toScenario(org.id, user, id);
  }
}
