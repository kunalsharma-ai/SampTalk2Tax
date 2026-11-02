import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { DimensionsService } from './dimensions.service';

const type = z.enum(['DEPARTMENT', 'PROJECT']);
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const Fields = {
  code: z.string().trim().min(1, 'Give it a code').max(20, 'Keep the code to 20 characters'),
  name: z.string().trim().min(1, 'Give it a name').max(120, 'Keep the name under 120 characters'),
  description: text(500),
  customer: text(200),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
};
const CreateBody = z.object({ type, ...Fields }).strict();
const UpdateBody = z.object({ ...Fields, isActive: z.boolean() }).strict();
const ListQuery = z.object({ type: type.optional() }).strict();
const ProfitQuery = z.object({ type, from: isoDate, to: isoDate, includeInactive: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }).strict();

@ApiTags('dimensions')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/dimensions')
export class DimensionsController {
  constructor(private readonly dims: DimensionsService) {}

  /** Departments and projects, with how many journal lines use each. */
  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.dims.list(org, q.type);
  }

  /** Profit and loss for a period with a column per department or project. */
  @Get('profit')
  @RequirePermission('reports.read')
  profit(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ProfitQuery)) q: z.infer<typeof ProfitQuery>) {
    return this.dims.profit(org, q);
  }

  @Post()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.dims.create(org, user, b);
  }

  /** Change a department or project; make it inactive to stop new lines using it. */
  @Put(':id')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(z.string().uuid('Not an id'))) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.dims.update(org, user, id, b);
  }
}
