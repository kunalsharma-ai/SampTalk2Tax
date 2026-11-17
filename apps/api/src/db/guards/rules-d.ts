import { appendOnlyRule, changed, changedExcept, changedNe, differs, fail, ne } from './guard';
import { registerGuards } from './index';

/** Payroll, payment batches and links, month-end closes, pro formas, purchase orders, recurring bills, retainers, salary structures, sales contracts. */
registerGuards({
  // pay_runs_guard
  pay_runs: async (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') {
      if (ne(o.status, 'DRAFT')) fail(`Pay run ${o.number} is posted; void it instead`);
      return;
    }
    if (changed(o, n, ['org_id', 'number', 'period'])) fail("A pay run's number and month never change");
    if (o.status === 'DRAFT') {
      if (n.status === 'VOID') fail('A draft pay run is deleted, not voided');
      return;
    }
    if (o.status === 'VOID' || ne(n.status, 'VOID') || changed(o, n, ['pay_date', 'gross', 'deductions', 'net', 'employer_cost', 'journal_entry_id', 'posted_at', 'posted_by_id'])) {
      fail(`Posted pay run ${o.number} is immutable; void it instead`);
    }
    if (await ctx.db.payrollRemittance.count({ where: { payRunId: o.id, status: 'POSTED' } })) fail(`Pay run ${o.number} has payments recorded against it; void them first`);
  },
  // payment_batch_items_guard
  payment_batch_items: async (op, o, n, ctx) => {
    const b = await ctx.db.paymentBatch.findFirst({ where: { id: (n ?? o).batch_id }, select: { status: true } });
    if (!b) return; // the batch itself is being deleted
    if (op === 'UPDATE' && !changed(o, n, ['batch_id', 'document_id', 'contact_id', 'amount']) && (o.payment_id === null || (n.payment_id !== null && !differs(n.payment_id, o.payment_id)))) {
      return; // linking the payment, or closing the item
    }
    if (b.status !== 'DRAFT') fail('Payment batch items change only while the batch is a draft');
  },
  // payment_batches_guard
  payment_batches: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') {
      if (ne(o.status, 'DRAFT')) fail('Only a draft payment batch can be deleted; cancel it instead');
      return;
    }
    if (['PAID', 'CANCELLED'].includes(o.status)) fail('A paid or cancelled payment batch is final');
    if (o.status === 'APPROVED' && changed(o, n, ['bank_account_id', 'payment_date', 'currency', 'created_by_id', 'approved_by_id', 'approved_at'])) {
      fail('An approved payment batch cannot be changed; cancel it and prepare a new one');
    }
  },
  // payment_links_check
  payment_links: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A payment link cannot be deleted; cancel it instead');
    if (ne(o.status, 'OPEN') && changedExcept(o, n, [])) fail(`This payment link is ${String(o.status).toLowerCase()} and cannot change`);
    if (changed(o, n, ['document_id', 'provider', 'gateway_ref', 'amount', 'currency', 'number'])) fail('A payment link keeps its invoice, gateway and amount');
  },
  // payroll_remittances_guard
  payroll_remittances: async (op, o, n, ctx) => {
    if (op === 'DELETE') fail(`Payroll payment ${o.number} cannot be deleted; void it instead`);
    if (op === 'INSERT') {
      if (!(await ctx.db.payRun.count({ where: { id: n.pay_run_id, status: 'POSTED' } }))) fail('Payments can be recorded only against a posted pay run');
      return;
    }
    if (o.status === 'VOID' || ne(n.status, 'VOID') || changed(o, n, ['org_id', 'pay_run_id', 'liability', 'number', 'date', 'bank_account_id', 'reference', 'amount', 'journal_entry_id'])) {
      fail(`Payroll payment ${o.number} is immutable; void it instead`);
    }
  },
  // payslips_guard
  payslips: async (op, o, n, ctx) => {
    if (await ctx.db.payRun.count({ where: { id: (n ?? o).pay_run_id, status: { not: 'DRAFT' } } })) fail('Payslips of a posted pay run cannot change');
    if (op === 'UPDATE' && changed(o, n, ['pay_run_id', 'employee_id', 'org_id'])) fail('A payslip cannot move to another pay run or employee');
  },
  // period_closes_guard
  period_closes: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A month-end close cannot be removed');
    if (changedNe(o, n, ['org_id', 'period_id', 'started_by_id', 'created_at'])) fail('A month-end close keeps its period and who started it');
  },
  // policy_versions_immutable
  policy_versions: appendOnlyRule('policy versions cannot be changed or deleted'),
  // pro_forma_invoice_lines_check
  pro_forma_invoice_lines: async (_op, o, n, ctx) => {
    const p = await ctx.db.proFormaInvoice.findFirst({ where: { id: (n ?? o).pro_forma_id }, select: { status: true } });
    // No parent: a draft is being deleted, and its lines go with it.
    if (p && p.status !== 'DRAFT') fail('A pro forma invoice is fixed once issued');
  },
  // pro_forma_invoices_check
  pro_forma_invoices: async (op, o, n, ctx) => {
    if (op === 'DELETE') {
      if (ne(o.status, 'DRAFT')) fail('Only a draft pro forma invoice can be deleted');
      return;
    }
    if (op === 'UPDATE' && ne(o.status, 'DRAFT') && (changed(o, n, ['contact_id', 'issue_date', 'valid_until', 'subtotal', 'tax_total', 'total', 'place_of_supply', 'terms', 'number']) || o.status === 'CANCELLED')) {
      fail('A pro forma invoice is fixed once issued');
    }
    if (n.invoice_id !== null && !(await ctx.db.document.count({ where: { id: n.invoice_id, orgId: n.org_id, kind: 'INVOICE', contactId: n.contact_id } }))) {
      fail('A pro forma invoice is invoiced to its own customer');
    }
  },
  // purchase_order_lines_check
  purchase_order_lines: async (_op, o, n, ctx) => {
    const po = await ctx.db.purchaseOrder.findFirst({ where: { id: (n ?? o).order_id }, select: { status: true } });
    if (po && po.status !== 'DRAFT') fail('A purchase order is fixed once issued');
  },
  // purchase_orders_check
  purchase_orders: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') {
      if (ne(o.status, 'DRAFT')) fail('Only a draft purchase order can be deleted');
      return;
    }
    if (changedNe(o, n, ['number', 'created_by_id', 'org_id'])) fail('A purchase order keeps its number and creator');
    if (['CLOSED', 'CANCELLED'].includes(o.status)) fail('A closed or cancelled purchase order does not change');
    if (
      ne(o.status, 'DRAFT') &&
      (n.status === 'DRAFT' ||
        changedNe(o, n, ['contact_id', 'order_date', 'currency', 'subtotal', 'tax_total', 'total', 'match_mode', 'price_tolerance_percent', 'quantity_tolerance_percent']) ||
        changed(o, n, ['place_of_supply', 'terms']))
    ) {
      fail('A purchase order is fixed once issued');
    }
  },
  // recurring_bill_runs_guard
  recurring_bill_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'UPDATE' && n.document_id === null && o.document_id !== null && !changedExcept(o, n, ['document_id'])) return;
    fail('The run history of a recurring bill is append-only');
  },
  // recurring_bills_guard
  recurring_bills: (op, o, n) => {
    if (op !== 'UPDATE') return;
    if (changedNe(o, n, ['org_id', 'number', 'created_by_id'])) fail('A recurring bill keeps its number and creator');
    if (n.next_run_no < o.next_run_no) fail('Recurring bill runs already made are not undone');
    if (o.next_run_no > 1 && changedNe(o, n, ['start_date', 'frequency', 'month_end', 'contact_id'])) fail('A recurring bill that has run keeps its vendor, start date, frequency and run day');
  },
  // report_runs_final
  report_runs: (op, o) => {
    if (op !== 'INSERT' && o.status === 'FINAL') fail('a final report cannot be changed or deleted');
  },
  // retainer_receipts_check
  retainer_receipts: async (op, _o, n, ctx) => {
    if (op !== 'INSERT') fail('A retainer receipt cannot be changed or removed; void the receipt instead');
    const r = await ctx.db.retainer.findFirst({ where: { id: n.retainer_id }, select: { status: true, contactId: true } });
    const p = await ctx.db.payment.findFirst({ where: { id: n.payment_id }, select: { kind: true, contactId: true, status: true } });
    if (ne(r?.status, 'ACTIVE')) fail('This retainer is closed');
    if (ne(p?.kind, 'RECEIPT') || ne(p?.contactId, r?.contactId) || ne(p?.status, 'POSTED')) fail("A retainer receipt must be a posted receipt from the retainer's customer");
  },
  // retainers_check
  retainers: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A retainer cannot be deleted; close it instead');
    if (o.status === 'CLOSED') fail('This retainer is closed');
    if (changed(o, n, ['contact_id', 'number'])) fail('A retainer keeps its customer and number');
  },
  // revenue_forecasts_guard
  revenue_forecasts: appendOnlyRule('A saved revenue forecast never changes'),
  // salary_components_guard
  salary_components: async (op, o, n, ctx) => {
    if (op === 'UPDATE') fail('Salary components cannot change; add a revision from a later month');
    const sid = (n ?? o).structure_id;
    if (await ctx.db.payslip.count({ where: { structureId: sid } })) fail(`Salary structure ${sid} is used by a payslip; add a revision from a later month`);
  },
  // salary_structures_guard
  salary_structures: (op, o) => {
    if (op === 'UPDATE') fail(`Salary structure ${o.id} cannot change; add a revision from a later month`);
  },
  // sales_contract_events_guard
  sales_contract_events: async (op, o, _n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE' && !(await ctx.db.salesContract.count({ where: { id: o.contract_id } }))) return;
    fail('The contract history is append-only');
  },
  // sales_contract_lines_guard
  sales_contract_lines: async (_op, o, n, ctx) => {
    // No parent while a draft contract is being deleted with its lines.
    const c = await ctx.db.salesContract.findFirst({ where: { id: (n ?? o).contract_id }, select: { status: true } });
    if (c && ['ENDED', 'CANCELLED'].includes(c.status)) fail("An ended or cancelled contract's lines do not change");
  },
  // sales_contract_periods_guard
  sales_contract_periods: async (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Contract periods are never deleted');
    if (changedNe(o, n, ['contract_id', 'org_id', 'period_no', 'period_start', 'period_end', 'status'])) fail('A contract period does not change');
    if (differs(n.document_id, o.document_id) && n.document_id !== null && o.document_id !== null && !(await ctx.db.document.count({ where: { id: o.document_id, status: 'VOID' } }))) {
      fail('A period is billed again only after its invoice is voided or deleted');
    }
  },
  // sales_contracts_guard
  sales_contracts: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') {
      if (ne(o.status, 'DRAFT')) fail('Only a draft contract can be deleted');
      return;
    }
    if (changedNe(o, n, ['org_id', 'number', 'created_by_id'])) fail('A contract keeps its number and creator');
    if (o.status === 'CANCELLED') fail('A cancelled contract does not change');
    if (ne(o.status, 'DRAFT') && (changedNe(o, n, ['contact_id', 'start_date', 'frequency', 'timing']) || n.status === 'DRAFT')) fail('An active contract keeps its customer and billing schedule');
    if (n.next_period_no < o.next_period_no) fail('Billed periods are not undone');
  },
});
