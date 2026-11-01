import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { ContactsService } from './contacts.service';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const Fields = {
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320).nullable().optional(),
  phone: optionalText(50),
  taxId: optionalText(50),
  /** India GST: GSTIN (the state is taken from it). */
  gstin: z.string().trim().max(20).nullable().optional(),
  /** India GST state code for an unregistered contact (default place of supply). */
  stateCode: z.string().regex(/^\d{2}$/).nullable().optional(),
  /** India: PAN. Taken from the GSTIN when there is one; decides TDS/TCS rates. */
  pan: z.string().trim().max(10).nullable().optional(),
  /** Default TDS section (vendors) or TCS section (customers) for new documents. */
  withholdingSectionId: z.uuid().nullable().optional(),
  address: optionalText(1000),
  /** City or locality, and the six-digit PIN code (needed for e-invoices). */
  city: optionalText(50),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'A PIN code is six digits').nullable().optional(),
  isCustomer: z.boolean().optional(),
  isVendor: z.boolean().optional(),
  paymentTermsDays: z.number().int().min(0).max(3650).optional(),
  creditLimit: decimalString.nullable().optional(),
};
const CreateBody = z.object(Fields).refine((b) => b.isCustomer || b.isVendor, 'A contact must be a customer, a vendor or both');
const UpdateBody = z.object({ ...Fields, name: Fields.name.optional(), isActive: z.boolean().optional() }).strict();
const ListQuery = z.object({
  role: z.enum(['customer', 'vendor']).optional(),
  q: z.string().max(100).optional(),
  includeInactive: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
const StatementQuery = z.object({ ledger: z.enum(['SALES', 'PURCHASES']), from: isoDate.optional(), to: isoDate.optional() });

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission('contacts.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.contacts.list(org, q);
  }

  @Get(':contactId')
  @RequirePermission('contacts.read')
  get(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) id: string) {
    return this.contacts.get(org, id);
  }

  @Get(':contactId/statement')
  @RequirePermission('contacts.read')
  statement(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) id: string, @Query(new ZodPipe(StatementQuery)) q: z.infer<typeof StatementQuery>) {
    return this.contacts.statement(org, id, q);
  }

  @Post()
  @RequirePermission('contacts.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.contacts.create(org, user, body);
  }

  @Patch(':contactId')
  @RequirePermission('contacts.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('contactId', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ) {
    return this.contacts.update(org, user, id, body);
  }
}
