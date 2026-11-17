import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { DISPUTE_OUTCOMES, DISPUTE_REASONS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { DisputeOrg, DisputesService } from './disputes.service';

const ListQuery = z.object({ status: z.enum(['open', 'resolved', 'all']).optional(), documentId: z.string().uuid().optional(), contactId: z.string().uuid().optional() });
const Fields = {
  amount: decimalString.nullish(),
  reason: z.enum(DISPUTE_REASONS),
  description: z.string().trim().min(1).max(1000),
  ownerId: z.string().uuid().nullish(),
  targetDate: isoDate.nullish(),
};
const RaiseBody = z.object({ documentId: z.string().uuid(), ...Fields }).strict();
const UpdateBody = z.object(Fields).strict();
const NoteBody = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
const ResolveBody = z.object({ outcome: z.enum(DISPUTE_OUTCOMES), creditNoteId: z.string().uuid().nullish(), note: z.string().trim().min(1).max(1000) }).strict();

/** Customer invoice disputes (AR-025). */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.disputes.list(this.org(org), q);
  }

  @Post()
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(RaiseBody) })
  raise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RaiseBody)) body: z.infer<typeof RaiseBody>) {
    return this.disputes.raise(this.org(org), user, body);
  }

  @Get(':id')
  @RequirePermission('sales.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.disputes.get(this.org(org), id);
  }

  @Put(':id')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.disputes.update(this.org(org), user, id, body);
  }

  @Post(':id/notes')
  @HttpCode(201)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(NoteBody) })
  note(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.disputes.note(this.org(org), user, id, body.body);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ResolveBody) })
  resolve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ResolveBody)) body: z.infer<typeof ResolveBody>) {
    return this.disputes.resolve(this.org(org), user, id, body);
  }

  private org(o: OrgContext): DisputeOrg {
    return { id: o.id, role: o.role, functionalCurrency: o.functionalCurrency };
  }
}
