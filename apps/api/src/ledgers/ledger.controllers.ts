import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, Type } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Ledger } from '@talk2tax/accounting-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { OrganizationsService } from '../organizations/organizations.service';
import { DocumentsService } from './documents.service';
import { SubledgerService } from './subledger.service';

const Line = z.object({
  accountId: z.uuid(),
  description: z.string().max(500).optional(),
  quantity: decimalString,
  unitPrice: decimalString,
  taxRateId: z.uuid().nullable().optional(),
  /** India GST: HSN or SAC code (4, 6 or 8 digits). */
  hsnCode: z.string().trim().max(8).nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
});
const kinds = { SALES: ['INVOICE', 'CREDIT_NOTE'], PURCHASES: ['BILL', 'VENDOR_CREDIT'] } as const;

function schemas(ledger: Ledger) {
  const DocumentBody = z.object({
    kind: z.enum(kinds[ledger]),
    contactId: z.uuid(),
    issueDate: isoDate,
    dueDate: isoDate.optional(),
    reference: z.string().trim().max(100).nullable().optional(),
    memo: z.string().max(1000).nullable().optional(),
    /** India GST: state code of the place of supply (96 = outside India). Defaults from the contact (sales) or the registration (purchases). */
    placeOfSupply: z.string().regex(/^\d{2}$/).nullable().optional(),
    /** India GST reverse charge (purchases only): the organisation pays the GST, not the supplier. */
    reverseCharge: z.boolean().optional(),
    /** TDS section (bills) or TCS section (invoices). */
    withholdingSectionId: z.uuid().nullable().optional(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code').nullable().optional(),
    exchangeRate: z.string().trim().max(30).nullable().optional(),
    lines: z.array(Line).min(1).max(500),
  });
  return {
    DocumentBody,
    CreateBody: DocumentBody.extend({ post: z.boolean().default(false), overrideCreditLimit: z.boolean().optional() }),
    PostBody: z.object({ overrideCreditLimit: z.boolean().default(false) }),
    VoidBody: z.object({ date: isoDate.optional(), reason: z.string().trim().min(3).max(500) }),
    ApplyCreditBody: z.object({ creditDocumentId: z.uuid(), amount: decimalString }),
    ListQuery: z.object({
      kind: z.enum(kinds[ledger]).optional(),
      view: z.enum(['all', 'draft', 'open', 'overdue', 'paid', 'void']).default('all'),
      contactId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    Allocation: z.array(z.object({ documentId: z.uuid(), amount: decimalString })).max(200),
    PaymentBody: z.object({
      contactId: z.uuid(),
      date: isoDate,
      bankAccountId: z.uuid(),
      amount: decimalString,
      currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code').nullable().optional(),
      exchangeRate: z.string().trim().max(30).nullable().optional(),
      reference: z.string().trim().max(100).nullable().optional(),
      memo: z.string().max(1000).nullable().optional(),
      allocations: z.array(z.object({ documentId: z.uuid(), amount: decimalString })).max(200).default([]),
    }),
    AllocateBody: z.object({ allocations: z.array(z.object({ documentId: z.uuid(), amount: decimalString })).min(1).max(200) }),
    PaymentListQuery: z.object({
      contactId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    AgeingQuery: z.object({ asOf: isoDate.optional() }),
  };
}
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/).optional();

/**
 * One controller class per ledger, built from the same definition so sales and
 * purchases always behave the same way. Routes:
 *   /v1/orgs/:orgId/sales/...      invoices, credit notes, receipts, receivables ageing
 *   /v1/orgs/:orgId/purchases/...  bills, vendor credits, payments, payables ageing
 */
function ledgerController(ledger: Ledger, path: 'sales' | 'purchases'): Type<unknown> {
  const s = schemas(ledger);
  const read = `${path}.read` as const;
  const manage = `${path}.manage` as const;
  type S = typeof s;

  @ApiTags(path)
  @ApiBearerAuth()
  @Controller(`v1/orgs/:orgId/${path}`)
  class LedgerController {
    constructor(
      readonly docs: DocumentsService,
      readonly subledger: SubledgerService,
      readonly orgs: OrganizationsService,
    ) {}

    @Get('documents')
    @RequirePermission(read)
    list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(s.ListQuery)) q: z.infer<S['ListQuery']>) {
      return this.docs.list(org, ledger, q);
    }

    @Get('documents/:documentId')
    @RequirePermission(read)
    get(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) id: string) {
      return this.docs.get(org, ledger, id);
    }

    @Post('documents')
    @RequirePermission(manage)
    @ApiBody({ schema: openApi(s.CreateBody) })
    create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(s.CreateBody)) body: z.infer<S['CreateBody']>) {
      const { post, overrideCreditLimit, ...input } = body;
      return this.docs.create(org, user, ledger, input, { post, overrideCreditLimit });
    }

    @Put('documents/:documentId')
    @RequirePermission(manage)
    @ApiBody({ schema: openApi(s.DocumentBody) })
    update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(s.DocumentBody)) body: z.infer<S['DocumentBody']>) {
      return this.docs.updateDraft(org, user, ledger, id, body);
    }

    @Delete('documents/:documentId')
    @HttpCode(204)
    @RequirePermission(manage)
    async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string) {
      await this.docs.deleteDraft(org, user, ledger, id);
    }

    /** Posting (approving) needs journals.post as well, so an APPROVER can post drafts prepared by an accountant. */
    @Post('documents/:documentId/post')
    @HttpCode(200)
    @RequirePermission(read)
    @ApiBody({ schema: openApi(s.PostBody) })
    post(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(s.PostBody)) body: z.infer<S['PostBody']>) {
      return this.docs.post(org, user, ledger, id, body.overrideCreditLimit);
    }

    @Post('documents/:documentId/void')
    @HttpCode(200)
    @RequirePermission(manage)
    @ApiBody({ schema: openApi(s.VoidBody) })
    void(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(s.VoidBody)) body: z.infer<S['VoidBody']>) {
      return this.docs.void(org, user, ledger, id, { date: body.date ?? todayIso(), reason: body.reason });
    }

    @Post('documents/:documentId/apply-credit')
    @HttpCode(200)
    @RequirePermission(manage)
    @ApiBody({ schema: openApi(s.ApplyCreditBody) })
    applyCredit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(s.ApplyCreditBody)) body: z.infer<S['ApplyCreditBody']>) {
      return this.docs.applyCredit(org, user, ledger, id, body);
    }

    @Get('payments')
    @RequirePermission(read)
    listPayments(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(s.PaymentListQuery)) q: z.infer<S['PaymentListQuery']>) {
      return this.docs.listPayments(org, ledger, q);
    }

    @Get('payments/:paymentId')
    @RequirePermission(read)
    getPayment(@CurrentOrg() org: OrgContext, @Param('paymentId', ParseUUIDPipe) id: string) {
      return this.docs.getPayment(org, ledger, id);
    }

    @Post('payments')
    @RequirePermission(manage)
    @ApiBody({ schema: openApi(s.PaymentBody) })
    @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retry-safe key (8-128 chars). Same key + same body returns the original payment.' })
    async createPayment(
      @CurrentOrg() org: OrgContext,
      @CurrentUser() user: AuthUser,
      @Body(new ZodPipe(s.PaymentBody)) body: z.infer<S['PaymentBody']>,
      @Headers('idempotency-key') rawKey: string | undefined,
      @Res({ passthrough: true }) res: Response,
    ) {
      const key = new ZodPipe(IdempotencyKey).transform(rawKey);
      const result = await this.docs.createPayment(org, user, ledger, body, key);
      res.status(result.replayed ? 200 : 201);
      if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
      return result.payment;
    }

    @Post('payments/:paymentId/allocate')
    @HttpCode(200)
    @RequirePermission(manage)
    @ApiBody({ schema: openApi(s.AllocateBody) })
    allocate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('paymentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(s.AllocateBody)) body: z.infer<S['AllocateBody']>) {
      return this.docs.allocatePayment(org, user, ledger, id, body.allocations);
    }

    @Post('payments/:paymentId/void')
    @HttpCode(200)
    @RequirePermission(manage)
    @ApiBody({ schema: openApi(s.VoidBody) })
    voidPayment(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('paymentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(s.VoidBody)) body: z.infer<S['VoidBody']>) {
      return this.docs.voidPayment(org, user, ledger, id, { date: body.date ?? todayIso(), reason: body.reason });
    }

    @Post('allocations/:allocationId/remove')
    @HttpCode(200)
    @RequirePermission(manage)
    removeAllocation(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('allocationId', ParseUUIDPipe) id: string) {
      return this.docs.removeAllocation(org, user, ledger, id);
    }

    @Get('ageing')
    @RequirePermission(read)
    async ageing(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(s.AgeingQuery)) q: z.infer<S['AgeingQuery']>) {
      const o = await this.orgs.get(org.id);
      return this.subledger.ageing({ ...o }, ledger, q.asOf ?? todayIso());
    }
  }
  Object.defineProperty(LedgerController, 'name', { value: ledger === 'SALES' ? 'SalesController' : 'PurchasesController' });
  return LedgerController;
}

export const SalesController = ledgerController('SALES', 'sales');
export const PurchasesController = ledgerController('PURCHASES', 'purchases');
