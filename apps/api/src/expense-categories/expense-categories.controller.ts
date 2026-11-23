import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ExpenseCategoriesService } from './expense-categories.service';

const ListQuery = z.object({ all: z.enum(['true', 'false']).optional() }).strict();
const CategoryBody = z
  .object({
    name: z.string().trim().min(1, 'Give the category a name').max(60),
    description: z.string().trim().max(500).nullish(),
    accountId: z.uuid('Choose the expense account the category posts to'),
    taxRateId: z.uuid().nullish(),
    receipt: z.enum(['POLICY', 'ALWAYS']),
  })
  .strict();

/** Expense categories (EXP-005). */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly categories: ExpenseCategoriesService) {}

  /** The active categories; finance sees archived ones too with ?all=true, and everyone with expenses.read sees recent use. */
  @Get()
  @RequirePermission('expenses.submit')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.categories.list(org, { all: q.all === 'true' });
  }

  @Post()
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(CategoryBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CategoryBody)) b: z.infer<typeof CategoryBody>) {
    return this.categories.create(org, user.id, b);
  }

  @Put(':categoryId')
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(CategoryBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('categoryId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CategoryBody)) b: z.infer<typeof CategoryBody>) {
    return this.categories.update(org, user.id, id, b);
  }

  @Post(':categoryId/archive')
  @HttpCode(200)
  @RequirePermission('expenses.reimburse')
  archive(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('categoryId', ParseUUIDPipe) id: string) {
    return this.categories.setActive(org, user.id, id, false);
  }

  @Post(':categoryId/restore')
  @HttpCode(200)
  @RequirePermission('expenses.reimburse')
  restore(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('categoryId', ParseUUIDPipe) id: string) {
    return this.categories.setActive(org, user.id, id, true);
  }
}
