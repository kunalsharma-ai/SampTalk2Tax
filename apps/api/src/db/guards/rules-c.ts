import { appendOnlyRule, changed, changedExcept, changedNe, fail, ne } from './guard';
import { registerGuards } from './index';

/** E-way bills, fixed assets, forecasts, FX, goods receipts, international payments, disputes, revenue recognition, templates, loans, management reports. */
registerGuards({
  // e_way_bill_vehicle_updates_guard
  e_way_bill_vehicle_updates: async (op, _o, n, ctx) => {
    if (op !== 'INSERT') fail('Part B updates cannot be changed or deleted');
    const b = await ctx.db.eWayBill.findFirst({ where: { id: n.e_way_bill_id, status: 'ACTIVE' }, select: { generatedAt: true } });
    if (!b || n.updated_at < b.generatedAt) fail('Part B can be updated only on a live e-way bill, after it was generated');
  },
  // e_way_bills_guard
  e_way_bills: async (op, o, n, ctx) => {
    if (op === 'DELETE') fail('E-way bill records cannot be deleted');
    if (op === 'INSERT') {
      if (!(await ctx.db.document.count({ where: { id: n.document_id, status: 'POSTED', kind: 'INVOICE' } }))) fail('An e-way bill can be recorded only for a posted invoice');
      return;
    }
    if (
      o.status === 'CANCELLED' ||
      ne(n.status, 'CANCELLED') ||
      changed(o, n, ['org_id', 'document_id', 'number', 'generated_at', 'valid_until', 'distance_km', 'vehicle_type', 'transport_mode', 'vehicle_no', 'transporter_id', 'transporter_name', 'trans_doc_no', 'trans_doc_date', 'payload_hash', 'created_by_id', 'created_at'])
    ) {
      fail('An e-way bill record is immutable; record vehicle changes as Part B updates and only its cancellation otherwise');
    }
  },
  // fixed_assets_guard
  fixed_assets: async (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Fixed assets are never deleted');
    if (changedNe(o, n, ['org_id', 'number', 'created_by_id']) || changed(o, n, ['acquisition_entry_id'])) fail('A fixed asset keeps its organisation, number and purchase entry');
    if (o.status === 'DISPOSED') fail('A disposed asset cannot be changed');
    const terms =
      changedNe(o, n, ['cost', 'residual_value', 'method', 'opening_accumulated', 'in_service_date', 'acquisition_date', 'asset_account_id', 'accumulated_account_id', 'expense_account_id']) ||
      changed(o, n, ['useful_life_months', 'annual_rate', 'depreciated_through']);
    if (terms && (await ctx.db.depreciationLine.count({ where: { assetId: o.id } }))) {
      fail('Depreciation has been posted for this asset, so its cost, dates, accounts and depreciation terms are fixed');
    }
  },
  // forecast_lab_runs_immutable
  forecast_lab_runs: appendOnlyRule('saved forecast runs cannot be changed or deleted'),
  // fx_revaluations_no_change
  fx_revaluations: appendOnlyRule('fx_revaluations rows cannot be changed or deleted'),
  // goods_receipt_lines_check
  goods_receipt_lines: async (op, _o, n, ctx) => {
    if (op !== 'INSERT') fail('A goods receipt does not change; cancel it and record it again');
    const r = await ctx.db.goodsReceipt.findFirst({ where: { id: n.receipt_id }, select: { orderId: true } });
    if (!r || !(await ctx.db.purchaseOrderLine.count({ where: { id: n.order_line_id, orderId: r.orderId } }))) fail("A received line is on the receipt's own purchase order");
  },
  // goods_receipts_check
  goods_receipts: async (op, o, n, ctx) => {
    if (op === 'DELETE') fail('Goods receipts are never deleted; cancel them instead');
    if (op === 'INSERT') {
      if (!(await ctx.db.purchaseOrder.count({ where: { id: n.order_id, status: 'ISSUED' } }))) fail('Goods are received only against an issued purchase order');
      return;
    }
    if (o.status === 'CANCELLED' || changedNe(o, n, ['order_id', 'number', 'receipt_date', 'created_by_id'])) fail('A goods receipt does not change; cancel it and record it again');
  },
  // international_payment_items_guard
  international_payment_items: async (_op, o, n, ctx) => {
    const p = await ctx.db.internationalPayment.findFirst({ where: { id: (n ?? o).remittance_id }, select: { status: true } });
    if (p && p.status !== 'DRAFT') fail('The bills of an approved international payment cannot change');
  },
  // international_payments_guard
  international_payments: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') {
      if (o.status !== 'DRAFT') fail('Only a draft international payment can be deleted; cancel it instead');
      return;
    }
    if (['PAID', 'CANCELLED'].includes(o.status)) fail(`This international payment is ${String(o.status).toLowerCase()} and cannot change`);
    if (
      o.status !== 'DRAFT' &&
      changed(o, n, ['contact_id', 'bank_account_id', 'payment_date', 'currency', 'amount', 'purpose_code', 'purpose', 'charges', 'taxable_in_india', 'has_tax_order', 'form15_part', 'needs_15cb', 'form15ca_ack', 'form15cb_number', 'approved_by_id'])
    ) {
      fail('An approved international payment cannot be changed; cancel it and prepare a new one');
    }
    const ok =
      o.status === n.status ||
      (o.status === 'DRAFT' && ['APPROVED', 'CANCELLED'].includes(n.status)) ||
      (o.status === 'APPROVED' && ['SENT', 'CANCELLED'].includes(n.status)) ||
      (o.status === 'SENT' && ['PAID', 'CANCELLED'].includes(n.status));
    if (!ok) fail(`An international payment cannot go from ${o.status} to ${n.status}`);
  },
  // invoice_dispute_events_immutable (updates only; deletes go with the dispute)
  invoice_dispute_events: (op) => {
    if (op === 'UPDATE') fail("A dispute's history cannot be changed");
  },
  // invoice_disputes_check
  invoice_disputes: async (op, o, n, ctx) => {
    if (op === 'DELETE') return;
    if (op === 'UPDATE' && o.status === 'RESOLVED') fail('A resolved dispute cannot be changed');
    if (op === 'UPDATE' && changedNe(o, n, ['document_id', 'contact_id', 'number', 'opened_on'])) fail('A dispute stays on the invoice it was raised for');
    if (!(await ctx.db.document.count({ where: { id: n.document_id, orgId: n.org_id, kind: 'INVOICE', contactId: n.contact_id } }))) fail('A dispute is for a customer invoice, raised for its customer');
    if (n.credit_note_id !== null && !(await ctx.db.document.count({ where: { id: n.credit_note_id, orgId: n.org_id, kind: 'CREDIT_NOTE', status: 'POSTED', contactId: n.contact_id } }))) {
      fail('A dispute is settled by a posted credit note of the same customer');
    }
  },
  // invoice_line_recognition_guard
  invoice_line_recognition: async (op, o, n, ctx) => {
    const doc = await ctx.db.document.findFirst({ where: { id: (n ?? o).document_id }, select: { status: true } });
    const s: string | null = doc?.status ?? null;
    if (op === 'DELETE') {
      if (s === null || (s === 'DRAFT' && o.schedule_id === null)) return;
      fail('Revenue recognition of a posted invoice is kept');
    }
    if (op === 'INSERT') {
      if ((s !== null && s !== 'DRAFT') || n.schedule_id !== null) fail('Revenue recognition is set while the invoice is a draft');
      return;
    }
    if (changedNe(o, n, ['document_id', 'org_id', 'line_no'])) fail('Revenue recognition stays with its invoice line');
    if (o.schedule_id !== null) fail('Revenue recognition of a posted invoice is kept');
    if (s !== null && s !== 'DRAFT' && n.schedule_id === null) fail('Revenue recognition is set while the invoice is a draft');
  },
  // invoice_templates_guard
  invoice_templates: async (op, o, n, ctx) => {
    if (op !== 'UPDATE') return;
    if (o.archived_at === null && n.archived_at !== null && (await ctx.db.document.count({ where: { templateId: o.id, orgId: o.org_id, status: { not: 'VOID' } } }))) {
      fail(`Template ${o.id} is used by documents and cannot be archived`);
    }
  },
  // journal_template_runs_guard
  journal_template_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'UPDATE' && n.journal_entry_id === null && o.journal_entry_id !== null && !changedExcept(o, n, ['journal_entry_id'])) return;
    fail('The run history of a template is append-only');
  },
  // journal_templates_guard
  journal_templates: (op, o, n) => {
    if (op !== 'UPDATE') return;
    if (changedNe(o, n, ['org_id', 'number', 'created_by_id'])) fail('A template keeps its number and creator');
    if (n.next_run_no < o.next_run_no) fail('Runs already made are not undone');
    if (o.next_run_no > 1 && (changed(o, n, ['start_date', 'frequency']) || changedNe(o, n, ['month_end']))) fail('A schedule that has run keeps its start date, frequency and run day');
  },
  // loan_events_guard
  loan_events: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Loan repayments, prepayments and rate changes are never deleted');
    if (
      o.status === 'REVERSED' ||
      ne(n.status, 'REVERSED') ||
      changedNe(o, n, ['org_id', 'loan_id', 'seq', 'kind', 'date', 'principal', 'interest', 'charges', 'balance_before', 'balance_after', 'rate_before', 'rate_after', 'installment_before', 'installment_after', 'created_by_id']) ||
      changed(o, n, ['entry_id'])
    ) {
      fail('A loan event changes only to record its reversal');
    }
  },
  // loans_guard
  loans: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Loans are never deleted');
    if (
      changedNe(o, n, ['org_id', 'number', 'method', 'principal', 'original_rate', 'months', 'disbursement_date', 'first_due_date', 'liability_account_id', 'interest_account_id', 'created_by_id']) ||
      changed(o, n, ['disbursement_entry_id'])
    ) {
      fail('A loan keeps its amount, original rate, term, dates, accounts and opening entry');
    }
  },
  // management_reports_guard
  management_reports: (op, o, n) => {
    if (op === 'INSERT') {
      if (ne(n.status, 'DRAFT')) fail('A management report starts as a draft');
      return;
    }
    if (o.status === 'FINAL') fail(op === 'DELETE' ? 'A final management report cannot be deleted' : 'A final management report is immutable');
    if (op === 'UPDATE' && changedNe(o, n, ['org_id', 'month'])) fail('A management report keeps its organisation and month');
  },
});
