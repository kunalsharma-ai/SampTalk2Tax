import { appendOnlyRule, changed, changedNe, fail, ne } from './guard';
import { registerGuards } from './index';

/** Accruals, alerts, API keys, bad debts, bank AI, bills, budgets, cash forecasts, CFO reports, the month-end close, collections, compliance. */
registerGuards({
  // accruals_guard
  accruals: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Accruals are never deleted');
    if (o.status === 'CANCELLED' || ne(n.status, 'CANCELLED') || changedNe(o, n, ['org_id', 'number', 'kind', 'month', 'amount', 'pnl_account_id', 'balance_account_id', 'entry_id', 'reversal_entry_id', 'created_by_id'])) {
      fail('An accrual changes only to record that it was cancelled');
    }
  },
  // alert_events_append_only, alert_scans_append_only
  alert_events: appendOnlyRule('Alert history is append-only'),
  alert_scans: appendOnlyRule('Alert history is append-only'),
  // alerts_guard
  alerts: (op, o, n) => {
    if (op === 'INSERT') {
      if (ne(n.status, 'OPEN')) fail('An alert starts open');
      return;
    }
    if (op === 'DELETE') fail('An alert cannot be deleted');
    if (changedNe(o, n, ['org_id', 'rule', 'fingerprint', 'first_seen_at'])) fail('An alert keeps its organisation, check and finding');
    if (n.reopen_count < o.reopen_count) fail("An alert's reopen count only goes up");
  },
  // api_keys_guard
  api_keys: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('An API key is revoked, never deleted');
    if (
      changedNe(o, n, ['org_id', 'name', 'prefix', 'key_hash', 'scopes', 'created_by_id', 'created_at']) ||
      changed(o, n, ['expires_at']) ||
      (o.revoked_at !== null && changed(o, n, ['revoked_at', 'revoked_by_id']))
    ) {
      fail('An API key only records its use or its revocation');
    }
  },
  // bad_debt_provisions_guard
  bad_debt_provisions: appendOnlyRule('A bad-debt provision run is append-only; run a new one to change the allowance'),
  // bad_debt_write_offs_guard
  bad_debt_write_offs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A write-off cannot be deleted; reverse it instead');
    if (
      o.status === 'REVERSED' ||
      ne(n.status, 'REVERSED') ||
      changed(o, n, ['org_id', 'number', 'document_id', 'contact_id', 'date', 'currency', 'amount', 'exchange_rate', 'functional_amount', 'account_id', 'reason', 'journal_entry_id', 'created_by_id'])
    ) {
      fail('A write-off is immutable apart from being reversed once');
    }
  },
  // bank_ai_runs_guard
  bank_ai_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('An AI reconciliation run cannot be removed');
    if (o.status === 'DONE') fail('A finished AI reconciliation run cannot be changed');
    if (changedNe(o, n, ['org_id', 'account_id', 'started_by_id', 'created_at', 'model'])) fail('An AI reconciliation run keeps its account and who started it');
  },
  // bank_ai_suggestions_guard
  bank_ai_suggestions: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('An AI bank suggestion cannot be removed; dismiss it instead');
    if (['ACCEPTED', 'DISMISSED', 'FAILED'].includes(o.status)) fail('An accepted, dismissed or failed AI bank suggestion cannot be changed');
    if (changedNe(o, n, ['org_id', 'run_id', 'statement_line_id', 'context', 'model', 'created_at'])) fail('An AI bank suggestion keeps its line and what the model was shown');
    if (o.status !== 'DRAFTING' && (changed(o, n, ['action', 'proposal', 'resolved', 'confidence', 'reason', 'served_model']) || changedNe(o, n, ['checks']))) {
      fail('What the AI model proposed cannot be changed');
    }
    if (o.status === 'DRAFTING' && !['DRAFTING', 'READY', 'FAILED'].includes(n.status)) fail('A suggestion is proposed before it is decided');
  },
  // bill_match_acceptances_check
  bill_match_acceptances: async (op, o, _n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'UPDATE') fail('A match acceptance cannot be changed');
    if (await ctx.db.document.count({ where: { id: o.document_id } })) fail('A match acceptance cannot be changed');
  },
  // bill_payment_plans_check
  bill_payment_plans: async (op, _o, n, ctx) => {
    if (op === 'DELETE') return;
    if (!(await ctx.db.document.count({ where: { id: n.document_id, orgId: n.org_id, kind: 'BILL' } }))) fail('A payment plan is for a vendor bill');
  },
  // budget_lines_guard
  budget_lines: async (op, o, n, ctx) => {
    const budget = await ctx.db.budget.findFirst({ where: { id: (n ?? o).budget_id }, select: { status: true } });
    if (budget?.status !== 'DRAFT') fail('Budget lines change only while the budget is a draft');
    if (op === 'DELETE') return;
    if (op === 'UPDATE' && changed(o, n, ['budget_id', 'org_id'])) fail('A budget line stays in its budget');
    const acc = await ctx.db.account.findFirst({ where: { id: n.account_id }, select: { type: true, isPostable: true } });
    if (!acc || !['REVENUE', 'EXPENSE'].includes(acc.type) || !acc.isPostable) fail('Budgets hold postable revenue and expense accounts only');
  },
  // budgets_guard
  budgets: (op, o, n) => {
    if (op === 'DELETE') {
      if (o.status !== 'DRAFT') fail('Only draft budgets can be deleted');
      return;
    }
    if (op === 'INSERT') {
      if (n.status !== 'DRAFT') fail('A budget starts as a draft');
      return;
    }
    if (changed(o, n, ['org_id', 'fiscal_year', 'version', 'basis', 'source_budget_id', 'change_percent', 'created_by_id', 'created_at'])) fail("A budget version's year, number and origin never change");
    if (o.status !== 'DRAFT' && changed(o, n, ['name', 'note'])) fail('Only a draft budget can be renamed');
    if (
      changed(o, n, ['status']) &&
      !((o.status === 'DRAFT' && n.status === 'SUBMITTED') || (o.status === 'SUBMITTED' && ['DRAFT', 'APPROVED'].includes(n.status)) || (o.status === 'APPROVED' && n.status === 'SUPERSEDED'))
    ) {
      fail(`A budget cannot move from ${o.status} to ${n.status}`);
    }
    if (['APPROVED', 'SUPERSEDED'].includes(o.status) && changed(o, n, ['submitted_at', 'submitted_by_id', 'approved_at', 'approved_by_id', 'returned_at', 'returned_by_id', 'return_reason'])) {
      fail("An approved budget's history never changes");
    }
  },
  // cash_forecasts_guard
  cash_forecasts: appendOnlyRule('Saved cash forecasts are immutable and cannot be deleted'),
  // cfo_reports_final_guard
  cfo_reports: (op, o) => {
    if (op !== 'INSERT' && o.status === 'FINAL') fail('A final CFO report cannot be changed');
  },
  // close_adjustments_guard
  close_adjustments: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A proposed adjusting entry cannot be removed; reject it instead');
    if (o.status !== 'READY') fail('A posted, rejected or superseded adjusting entry cannot be changed');
    if (changedNe(o, n, ['org_id', 'close_id', 'review_id', 'proposal', 'checks', 'confidence', 'reason', 'created_at']) || changed(o, n, ['resolved'])) {
      fail('What the AI model proposed cannot be changed');
    }
  },
  // close_ai_reviews_guard
  close_ai_reviews: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('An AI close review cannot be removed');
    if (o.status !== 'RUNNING') fail('A finished AI close review cannot be changed');
    if (changedNe(o, n, ['org_id', 'close_id', 'started_by_id', 'context', 'model', 'created_at'])) fail('An AI close review keeps what the model was shown');
  },
  // close_certifications_guard
  close_certifications: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A close certification cannot be removed');
    if (o.reopened_at !== null) fail('A reopened close certification cannot be changed');
    if (changedNe(o, n, ['org_id', 'close_id', 'certified_by_id', 'certified_at', 'checks', 'totals']) || changed(o, n, ['note'])) fail('What a close certification records cannot be changed');
  },
  // collection_drafts_guard
  collection_drafts: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A reminder draft cannot be removed; reject it instead');
    if (['SENT', 'REJECTED', 'FAILED'].includes(o.status)) fail('A sent, rejected or failed reminder cannot be changed');
    if (changedNe(o, n, ['org_id', 'run_id', 'contact_id', 'to_email', 'facts', 'model', 'created_at'])) fail('A reminder keeps the customer, address and facts it was written for');
    if (o.status !== 'DRAFTING' && (changed(o, n, ['ai_subject', 'ai_body', 'risk', 'served_model']) || changedNe(o, n, ['risk_reasons']))) fail('What the AI model wrote cannot be changed');
    if (o.status === 'DRAFTING' && !['DRAFTING', 'READY', 'FAILED'].includes(n.status)) fail('A draft is written before it is decided');
    if (o.status === 'SEND_FAILED' && !['SEND_FAILED', 'SENT'].includes(n.status)) fail('A reminder that failed to send can only be sent again');
    if (n.send_attempts < o.send_attempts) fail('Send attempts only go up');
  },
  // collection_runs_guard
  collection_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A collections run cannot be removed');
    if (o.status === 'DONE') fail('A finished collections run cannot be changed');
    if (changedNe(o, n, ['org_id', 'started_by_id', 'created_at', 'model'])) fail('A collections run keeps who started it and when');
  },
  // compliance_filings_guard
  compliance_filings: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Filing records cannot be deleted; void them instead');
    if (o.status === 'VOID' || n.status !== 'VOID' || changed(o, n, ['org_id', 'obligation_key', 'kind', 'period', 'due_date', 'filed_on', 'reference', 'note', 'created_by_id', 'created_at'])) {
      fail('Filing records are immutable; void them instead');
    }
  },
});
