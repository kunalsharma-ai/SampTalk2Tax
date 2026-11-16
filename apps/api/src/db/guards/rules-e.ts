import { appendOnlyRule, changed, changedNe, differs, fail, ne } from './guard';
import { registerGuards } from './index';

const named = (table: string) => appendOnlyRule(`${table} rows cannot be changed or deleted`);

/** Sales orders and quotes, subscriptions, support access, tasks, tax rates, usage, signatures, vendors, withholding, workflows, year-end closes. */
registerGuards({
  // sales_order_billings_guard
  sales_order_billings: async (op, o, _n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'UPDATE') fail('An order billing never changes');
    // Removed only together with its draft invoice (the cascade runs after the document is gone).
    if (await ctx.db.document.count({ where: { id: o.document_id } })) fail('An order billing goes only with its draft invoice');
  },
  // sales_order_lines_guard
  sales_order_lines: appendOnlyRule("A sales order's lines never change"),
  // sales_order_milestones_check
  sales_order_milestones: async (op, o, n, ctx) => {
    if (op === 'INSERT' || o.document_id === null) return;
    const d = await ctx.db.document.findFirst({ where: { id: o.document_id }, select: { status: true } });
    if (!d || d.status === 'VOID') return;
    if (op === 'DELETE' || changed(o, n, ['percent', 'name', 'order_id']) || (differs(n.document_id, o.document_id) && n.document_id !== null)) {
      fail('This milestone is invoiced; void or delete its invoice first');
    }
  },
  // sales_order_progress_claims_guard
  sales_order_progress_claims: (op) => {
    if (op === 'UPDATE') fail('A progress claim cannot be changed');
  },
  // sales_orders_guard, sales_orders_billing_method_check
  sales_orders: async (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Sales orders are never deleted; cancel them instead');
    if (changedNe(o, n, ['org_id', 'number', 'contact_id', 'total', 'subtotal', 'tax_total', 'created_by_id']) || changed(o, n, ['quote_id'])) {
      fail('A sales order keeps its customer, figures and number');
    }
    if (o.status === 'CANCELLED') fail('A cancelled sales order does not change');
    if (changed(o, n, ['billing_method'])) {
      const billed = await ctx.db.salesOrderBilling.findMany({ where: { orderId: n.id }, select: { documentId: true } });
      if (billed.length && (await ctx.db.document.count({ where: { id: { in: billed.map((b) => b.documentId) }, status: { not: 'VOID' } } }))) {
        fail('Part of this order is billed; the billing method can no longer change');
      }
    }
  },
  // sales_quote_lines_guard
  sales_quote_lines: async (_op, o, n, ctx) => {
    const q = await ctx.db.salesQuote.findFirst({ where: { id: (n ?? o).quote_id }, select: { status: true } });
    if (q && q.status !== 'DRAFT') fail("Only a draft quotation's lines change");
  },
  // sales_quotes_guard
  sales_quotes: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') {
      if (ne(o.status, 'DRAFT')) fail('Only a draft quotation can be deleted');
      return;
    }
    if (changedNe(o, n, ['org_id', 'number', 'revision', 'created_by_id']) || changed(o, n, ['previous_id'])) fail('A quotation keeps its number, revision and creator');
    // Sending a revision supersedes the quotation before it, even a declined one; nothing else changes after an answer.
    if (['ACCEPTED', 'SUPERSEDED'].includes(o.status) || (o.status === 'DECLINED' && (ne(n.status, 'SUPERSEDED') || changed(o, n, ['decline_reason', 'decided_at'])))) {
      fail('An accepted, declined or superseded quotation does not change');
    }
    if (o.status === 'SENT' && (changedNe(o, n, ['contact_id', 'total', 'subtotal', 'issue_date', 'valid_until']) || changed(o, n, ['terms']))) fail('A sent quotation does not change; revise it instead');
  },
  // subscription_events_immutable
  subscription_events: appendOnlyRule('Subscription history cannot be changed or deleted'),
  // subscription_invoices_final
  subscription_invoices: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Subscription invoices cannot be deleted');
    if (ne(o.status, 'OPEN')) fail(`A ${String(o.status).toLowerCase()} subscription invoice cannot be changed`);
    if (changedNe(o, n, ['subtotal', 'total', 'currency', 'org_id', 'reference'])) fail('The amount of a subscription invoice cannot be changed');
  },
  // supplier_gstin_checks_guard
  supplier_gstin_checks: appendOnlyRule('GST portal checks are kept as recorded; record a new check instead'),
  // support_access_grants_final
  support_access_grants: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('support access grants cannot be deleted');
    if (o.revoked_at !== null || changed(o, n, ['org_id', 'ticket_id', 'reason', 'granted_by', 'created_at', 'expires_at'])) fail('a support access grant can only be revoked, once');
  },
  // support_access_views_append_only, support_messages_append_only
  support_access_views: named('support_access_views'),
  support_messages: named('support_messages'),
  // tasks_guard
  tasks: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A task cannot be removed; cancel it instead');
    if (ne(o.status, 'OPEN')) fail('A closed task cannot be changed');
    if (changedNe(o, n, ['org_id', 'created_at']) || changed(o, n, ['workflow_run_id', 'created_by_id', 'link_type', 'link_id'])) fail('A task keeps where it came from');
  },
  // tax_rates_guard
  tax_rates: (op, o, n) => {
    if (op === 'UPDATE' && changed(o, n, ['rate', 'kind', 'gst_category', 'org_id'])) fail("A tax rate's percentage and kind cannot change; create a new rate instead");
  },
  // twin_scenario_versions_immutable
  twin_scenario_versions: (op) => {
    if (op === 'UPDATE') fail('Scenario versions cannot be changed');
  },
  // unbilled_revenue_dismissals_guard
  unbilled_revenue_dismissals: appendOnlyRule('Unbilled revenue dismissals are kept as recorded; bring the finding back instead'),
  // usage_events_append_only
  usage_events: named('usage_events'),
  // usage_records_guard
  usage_records: async (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') {
      if (!(await ctx.db.salesContract.count({ where: { id: o.contract_id } }))) return;
      fail('Usage is never deleted; void it instead');
    }
    if (changedNe(o, n, ['org_id', 'contract_id', 'meter_id', 'usage_date', 'quantity', 'source', 'created_by_id', 'created_at']) || changed(o, n, ['reference', 'note'])) {
      fail('Recorded usage does not change; void it and record it again');
    }
    if (o.voided_at !== null) fail('Voided usage does not change');
    if (o.period_no !== null && differs(n.period_no, o.period_no)) fail('Billed usage stays with its period');
    if (n.voided_at !== null && o.period_no !== null) fail('Billed usage cannot be voided');
  },
  // user_signatures_guard
  user_signatures: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Signatures are revoked, never deleted');
    if (
      o.revoked_at !== null ||
      n.revoked_at === null ||
      changedNe(o, n, ['org_id', 'user_id', 'kind', 'signer_name', 'image', 'image_type', 'image_sha256', 'created_at']) ||
      changed(o, n, ['designation'])
    ) {
      fail('A signature changes only to be revoked');
    }
  },
  // vendor_bank_detail_changes_guard
  vendor_bank_detail_changes: appendOnlyRule('Bank-detail change history is append-only'),
  // vendor_bank_details_guard
  vendor_bank_details: (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Vendor bank details cannot be deleted; replace them instead');
    if (changed(o, n, ['account_name', 'account_number', 'ifsc', 'bank_name', 'kind', 'swift_bic', 'bank_country', 'bank_address', 'routing_code', 'intermediary_swift'])) {
      // The trigger cleared these itself; the write now has to (new details are never verified by the same write).
      if (n.verified_by_id !== null || n.verified_at !== null || n.verification_note !== null) fail('New bank details are never verified by the same write');
    } else if (n.verified_by_id !== null && n.verified_by_id === n.changed_by_id && !ctx.allowed('allow_self_verify')) {
      fail('Bank details must be verified by someone other than the person who changed them');
    }
  },
  // vendor_portal_links_guard
  vendor_portal_links: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Vendor portal links are never deleted; revoke them');
    if (changedNe(o, n, ['org_id', 'contact_id', 'prefix', 'token_hash', 'created_by_id', 'created_at']) || changed(o, n, ['note', 'expires_at'])) {
      fail('A vendor portal link keeps its vendor, secret and expiry');
    }
    if (o.revoked_at !== null && changed(o, n, ['revoked_at', 'revoked_by_id'])) fail('A revoked vendor portal link stays revoked');
  },
  // vendor_portal_submissions_guard
  vendor_portal_submissions: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Invoices sent through the vendor portal are never deleted');
    if (
      changedNe(o, n, ['org_id', 'contact_id', 'link_id', 'invoice_number', 'number_key', 'invoice_date', 'currency', 'amount', 'created_at']) ||
      changed(o, n, ['purchase_order_id', 'note'])
    ) {
      fail('An invoice sent through the vendor portal stays as it was sent');
    }
    // The file can be added once, while the invoice is still waiting.
    if (o.content !== null && changed(o, n, ['content', 'sha256', 'file_name'])) fail('The file of a sent invoice cannot be replaced');
    if (o.content === null && n.content !== null && ne(o.status, 'RECEIVED')) fail('A file can be added only while the invoice is waiting');
    if (ne(o.status, 'RECEIVED') && (changedNe(o, n, ['status']) || changed(o, n, ['document_id', 'decided_at', 'decided_by_id', 'reject_reason']))) fail('A sent invoice is decided once');
  },
  // vendor_reviews_check
  vendor_reviews: async (op, o, n, ctx) => {
    if (op === 'DELETE') fail('A vendor review cannot be deleted; withdraw it instead');
    if (op === 'UPDATE') {
      if (o.withdrawn_at !== null) fail('This vendor review has been withdrawn');
      if (changed(o, n, ['contact_id', 'order_id', 'review_date', 'aspect', 'rating', 'note', 'created_by_id', 'created_at'])) fail('A vendor review is never edited; withdraw it and write a new one');
      return;
    }
    const c = await ctx.db.contact.findFirst({ where: { id: n.contact_id, orgId: n.org_id }, select: { isVendor: true } });
    if (c && c.isVendor === false) fail('Only a vendor can be reviewed');
    if (n.order_id !== null && !(await ctx.db.purchaseOrder.count({ where: { id: n.order_id, orgId: n.org_id, contactId: n.contact_id } }))) {
      fail('A review can only refer to a purchase order from the same vendor');
    }
  },
  // vendor_risk_reviews_guard
  vendor_risk_reviews: appendOnlyRule('Vendor risk reviews are kept as recorded; record a new review instead'),
  // withholding_deposit_items_guard
  withholding_deposit_items: async (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Deposit items cannot be deleted');
    if (!o.active || n.active || changed(o, n, ['org_id', 'deposit_id', 'document_id', 'amount']) || !(await ctx.db.withholdingDeposit.count({ where: { id: o.deposit_id, status: 'VOID' } }))) {
      fail('Deposit items only change when their deposit is voided');
    }
  },
  // withholding_deposits_guard
  withholding_deposits: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail(`Deposit ${o.id} cannot be deleted; void it instead`);
    if (
      o.status === 'VOID' ||
      ne(n.status, 'VOID') ||
      changed(o, n, ['org_id', 'kind', 'number', 'deposit_date', 'bank_account_id', 'challan_reference', 'tax_amount', 'interest_amount', 'interest_account_id', 'journal_entry_id'])
    ) {
      fail(`Deposit ${o.id} is immutable; void it instead`);
    }
  },
  // withholding_sections_guard
  withholding_sections: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Withholding sections cannot be deleted; deactivate them');
    if (changed(o, n, ['org_id', 'kind', 'code', 'rate', 'rate_individual_huf', 'rate_no_pan', 'single_threshold', 'aggregate_threshold', 'threshold_window', 'threshold_basis', 'valid_from'])) {
      fail("A withholding section's rates and thresholds cannot change; create a new section instead");
    }
  },
  // workflow_action_runs_guard
  workflow_action_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A workflow action cannot be removed');
    if (changedNe(o, n, ['org_id', 'run_id', 'position', 'type', 'input', 'created_at'])) fail('A workflow action keeps what it was asked to do');
    if (['SUCCEEDED', 'SKIPPED'].includes(o.status)) fail('A finished workflow action cannot be changed');
    if (o.status === 'FAILED' && !['FAILED', 'PENDING'].includes(n.status)) fail('A failed workflow action can only be retried');
    if (n.attempts < o.attempts) fail('Attempts only go up');
  },
  // workflow_cursors_guard
  workflow_cursors: (op, o, n) => {
    if (op === 'UPDATE' && BigInt(String(n.last_event_id)) < BigInt(String(o.last_event_id))) fail('The workflow cursor only moves forward');
  },
  // workflow_runs_guard
  workflow_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A workflow run cannot be removed');
    if (!['RUNNING', 'FAILED'].includes(o.status)) fail('A finished workflow run cannot be changed');
    // A failed run is changed only when one of its deliveries is retried.
    if (o.status === 'FAILED' && ne(n.status, 'RUNNING')) fail('A failed workflow run can only be retried');
    if (changedNe(o, n, ['org_id', 'workflow_id', 'version', 'trigger', 'facts', 'conditions', 'created_at']) || changed(o, n, ['event_id', 'occurrence_key'])) {
      fail('A workflow run keeps what it ran on');
    }
  },
  // workflow_versions_guard
  workflow_versions: appendOnlyRule('A workflow version cannot be changed or removed'),
  // workflows_guard
  workflows: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A workflow cannot be removed; turn it off instead');
    if (changedNe(o, n, ['org_id', 'created_by_id', 'created_at']) || n.current_version < o.current_version) fail('A workflow keeps its organisation, author and history');
  },
  // year_end_closes_guard
  year_end_closes: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A year-end close cannot be deleted; reopen the year instead');
    if (
      o.status === 'REVERSED' ||
      ne(n.status, 'REVERSED') ||
      changed(o, n, ['org_id', 'number', 'fiscal_year', 'closing_date', 'retained_earnings_account_id', 'profit', 'to_retained_earnings', 'accounts', 'journal_entry_id', 'memo', 'created_by_id'])
    ) {
      fail('A year-end close is immutable apart from being reversed once');
    }
  },
});
