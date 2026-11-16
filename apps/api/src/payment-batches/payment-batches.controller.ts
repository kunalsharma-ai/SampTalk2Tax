import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { PaymentBatchesService } from './payment-batches.service';

const Item = z.object({ documentId: z.string().uuid(), amount: decimalString.nullish() }).strict();
const CreateBody = z.object({ bankAccountId: z.string().uuid('Choose the bank account to pay from'), paymentDate: isoDate, memo: z.string().trim().max(400).nullish(), items: z.array(Item).max(500) }).strict();
const UpdateBody = z.object({ bankAccountId: z.string().uuid().optional(), paymentDate: isoDate.optional(), memo: z.string().trim().max(400).nullish(), items: z.array(Item).max(500).optional() }).strict();
const CancelBody = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) }).strict();
const BankBody = z.object({ accountName: z.string().trim().min(1).max(140), accountNumber: z.string().trim().min(1).max(60), ifsc: z.string().trim().max(20), bankName: z.string().trim().max(140).nullish() }).strict();
const IntlBankBody = z
  .object({
    accountName: z.string().trim().min(1).max(140),
    accountNumber: z.string().trim().min(1).max(60),
    swiftBic: z.string().trim().max(20),
    bankCountry: z.string().trim().max(2),
    bankName: z.string().trim().max(140).nullish(),
    bankAddress: z.string().trim().max(300).nullish(),
    routingCode: z.string().trim().max(20).nullish(),
    intermediarySwift: z.string().trim().max(20).nullish(),
  })
  .strict();
const VerifyBody = z.object({ note: z.string().trim().min(3, 'Say how the details were confirmed').max(500) }).strict();
const BillsQuery = z.object({ currency: z.string().regex(/^[A-Z]{3}$/).optional() });

/** Payment batches (AP-014). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/payment-batches')
export class PaymentBatchesController {
  constructor(private readonly batches: PaymentBatchesService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.batches.list(this.org(org));
  }

  /** Posted bills with something left to pay, and whether each is already in an open batch. */
  @Get('payable-bills')
  @RequirePermission('purchases.read')
  bills(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(BillsQuery)) q: z.infer<typeof BillsQuery>) {
    return this.batches.payableBills(this.org(org), q.currency);
  }

  @Get(':batchId')
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Param('batchId', ParseUUIDPipe) id: string) {
    return this.batches.get(this.org(org), id);
  }

  @Post()
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.batches.create(this.org(org), user, body);
  }

  @Patch(':batchId')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('batchId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.batches.update(this.org(org), user, id, body);
  }

  @Delete(':batchId')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('batchId', ParseUUIDPipe) id: string) {
    return this.batches.remove(this.org(org), user, id);
  }

  @Post(':batchId/approve')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('batchId', ParseUUIDPipe) id: string) {
    return this.batches.approve(this.org(org), user, id);
  }

  /** The bank's bulk payment file (CSV) for an approved batch. */
  @Post(':batchId/payment-file')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  async file(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('batchId', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.batches.paymentFile(this.org(org), user, id);
    const body = Buffer.from(f.csv, 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(body);
  }

  /** Record the payments once the bank has made them. */
  @Post(':batchId/paid')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  paid(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('batchId', ParseUUIDPipe) id: string) {
    return this.batches.markPaid(this.org(org), user, id);
  }

  @Post(':batchId/cancel')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(CancelBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('batchId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CancelBody)) body: z.infer<typeof CancelBody>) {
    return this.batches.cancel(this.org(org), user, id, body);
  }

  private org(o: OrgContext) {
    return { id: o.id, role: o.role, functionalCurrency: o.functionalCurrency };
  }
}

/** A vendor's bank details for payments, and their verification (AP-027). */
@ApiTags('contacts')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/contacts/:contactId/bank-details')
export class VendorBankDetailsController {
  constructor(private readonly batches: PaymentBatchesService) {}

  @Get()
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) id: string) {
    return this.batches.bankDetails(this.org(org), id);
  }

  @Put()
  @RequirePermission('contacts.manage')
  @ApiBody({ schema: openApi(BankBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) id: string, @Body(new ZodPipe(BankBody)) body: z.infer<typeof BankBody>) {
    return this.batches.saveBankDetails(this.org(org), user, id, body);
  }

  /** AP-023: the vendor's bank account abroad, replacing any domestic details (verification starts again). */
  @Put('international')
  @RequirePermission('contacts.manage')
  @ApiBody({ schema: openApi(IntlBankBody) })
  saveInternational(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) id: string, @Body(new ZodPipe(IntlBankBody)) body: z.infer<typeof IntlBankBody>) {
    return this.batches.saveInternationalBankDetails(this.org(org), user, id, body);
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(VerifyBody) })
  verify(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VerifyBody)) body: z.infer<typeof VerifyBody>) {
    return this.batches.verifyBankDetails(this.org(org), user, id, body);
  }

  private org(o: OrgContext) {
    return { id: o.id, role: o.role, functionalCurrency: o.functionalCurrency };
  }
}
