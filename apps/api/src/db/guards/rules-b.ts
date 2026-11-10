import { appendOnlyRule, changed, changedNe, fail, ne } from './guard';
import { registerGuards } from './index';

/** Contracts' meters, the copilot, CRM, customer onboarding and portal, decisions, deferrals, depreciation, dimensions, signatures, e-invoices. */
registerGuards({
  // contract_meters_guard
  contract_meters: async (op, o, n, ctx) => {
    const c = await ctx.db.salesContract.findFirst({ where: { id: (n ?? o).contract_id }, select: { status: true } });
    if (c && ['ENDED', 'CANCELLED'].includes(c.status)) fail("An ended or cancelled contract's meters do not change");
    if (op === 'UPDATE' && changedNe(o, n, ['contract_id', 'org_id', 'code'])) fail('A meter keeps its contract and code');
  },
  // copilot_actions_decided
  copilot_actions: (op, o, n) => {
    if (op !== 'UPDATE') return;
    if (o.status !== 'PROPOSED') fail('a decided assistant action cannot be changed');
    if (changedNe(o, n, ['org_id', 'user_id', 'kind', 'input', 'summary', 'conversation_id'])) fail('only the decision on an assistant action can be recorded');
  },
  // copilot_conversations_guard
  copilot_conversations: (op, o, n) => {
    if (op !== 'UPDATE') return;
    if (changedNe(o, n, ['org_id', 'user_id', 'model', 'toolset_version', 'system_prompt', 'created_at'])) fail('A copilot conversation keeps its owner, model and instructions');
  },
  // copilot_messages_guard
  copilot_messages: (op, o, n) => {
    if (op === 'DELETE') return;
    if (op === 'INSERT') {
      if (n.role === 'ASSISTANT' && ne(n.status, 'PENDING')) fail('A copilot answer starts pending');
      return;
    }
    if (o.status !== 'PENDING') fail('A finished copilot message cannot be changed');
    if (changedNe(o, n, ['org_id', 'conversation_id', 'seq', 'role', 'created_at'])) fail('A copilot message keeps its conversation, place and role');
  },
  // crm_activities_guard
  crm_activities: appendOnlyRule('The CRM activity timeline is append-only'),
  // crm_deals_guard
  crm_deals: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Deals are never deleted; mark them lost instead');
    if (changedNe(o, n, ['org_id', 'number', 'created_by_id']) || changed(o, n, ['lead_id'])) fail('A deal keeps its organisation, number, creator and lead');
  },
  // crm_leads_guard
  crm_leads: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Leads are never deleted; disqualify them instead');
    if (changedNe(o, n, ['org_id', 'number', 'created_by_id'])) fail('A lead keeps its organisation, number and creator');
    if (o.status === 'CONVERTED') fail('A converted lead does not change');
  },
  // customer_onboarding_checks_check
  customer_onboarding_checks: async (op, o, n, ctx) => {
    const ob = await ctx.db.customerOnboarding.findFirst({ where: { id: (n ?? o).onboarding_id }, select: { status: true } });
    if (op === 'DELETE') fail('A customer onboarding check cannot be deleted');
    if (op === 'UPDATE' && changed(o, n, ['onboarding_id', 'requirement_id', 'label', 'needs_file'])) fail('A customer onboarding check keeps what it asks for');
    if (ob && ob.status !== 'OPEN') fail('This customer onboarding is not open; checks can change only while it is in progress');
    if (n.attachment_id !== null) {
      const att = await ctx.db.attachment.findFirst({ where: { id: n.attachment_id }, select: { entityType: true, entityId: true, removedAt: true } });
      if (att && (att.entityType !== 'CUSTOMER_ONBOARDING' || att.entityId !== n.onboarding_id || att.removedAt !== null)) {
        fail('A customer onboarding check needs a file attached to the same onboarding');
      }
    }
  },
  // customer_onboardings_check
  customer_onboardings: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('A customer onboarding cannot be deleted');
    if (changed(o, n, ['contact_id', 'party'])) fail('A customer onboarding keeps its customer');
    if (o.status === 'APPROVED') fail('This customer onboarding is approved and can no longer change');
    if (o.status === 'SUBMITTED' && !['APPROVED', 'REJECTED', 'OPEN'].includes(n.status)) fail('A submitted customer onboarding is approved, rejected or taken back');
    if (o.status === 'SUBMITTED' && n.status === 'SUBMITTED') fail('A submitted customer onboarding cannot change; take it back first');
    if (o.status === 'REJECTED' && n.status !== 'OPEN') fail('A rejected customer onboarding can only be reopened');
  },
  // customer_portal_links_guard
  customer_portal_links: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Customer portal links are never deleted; revoke them');
    if (changedNe(o, n, ['org_id', 'contact_id', 'prefix', 'token_hash', 'created_by_id', 'created_at']) || changed(o, n, ['note', 'expires_at'])) {
      fail('A customer portal link keeps its customer, secret and expiry');
    }
    if (o.revoked_at !== null && changed(o, n, ['revoked_at', 'revoked_by_id'])) fail('A revoked customer portal link stays revoked');
  },
  // decisions_final_guard
  decisions: (op, o) => {
    if (op === 'INSERT') return;
    if (o.status !== 'ACTIVE') fail(`decision ${o.number} is ${String(o.status).toLowerCase()} and cannot be changed`);
  },
  // deferral_lines_guard
  deferral_lines: appendOnlyRule('Release lines are never changed or deleted'),
  // deferral_runs_guard
  deferral_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Release runs are never deleted');
    if (o.status === 'REVERSED' || ne(n.status, 'REVERSED') || changedNe(o, n, ['org_id', 'month', 'total', 'journal_entry_id', 'posted_by_id', 'posted_at'])) {
      fail('A release run changes only to record its reversal');
    }
  },
  // deferral_schedules_guard
  deferral_schedules: async (op, o, n, ctx) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Prepaid and deferred revenue schedules are never deleted');
    if (changedNe(o, n, ['org_id', 'kind', 'number', 'created_by_id']) || changed(o, n, ['initial_entry_id'])) fail('A schedule keeps its organisation, kind, number and opening entry');
    if (o.status === 'ENDED') fail('An ended schedule cannot be changed');
    if (changedNe(o, n, ['amount', 'start_date', 'months', 'method', 'balance_account_id', 'pnl_account_id']) && (await ctx.db.deferralLine.count({ where: { scheduleId: o.id } }))) {
      fail('A release has been posted for this schedule, so its amount, dates, accounts and method are fixed');
    }
  },
  // depreciation_lines_guard
  depreciation_lines: appendOnlyRule('Depreciation lines are never changed or deleted'),
  // depreciation_runs_guard
  depreciation_runs: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Depreciation runs are never deleted');
    if (o.status === 'REVERSED' || ne(n.status, 'REVERSED') || changedNe(o, n, ['org_id', 'month', 'total', 'journal_entry_id', 'posted_by_id', 'posted_at'])) {
      fail('A depreciation run changes only to record its reversal');
    }
  },
  // dimension_values_guard
  dimension_values: (op, o, n) => {
    if (op === 'INSERT') return;
    if (op === 'DELETE') fail('Departments and projects are never deleted; make them inactive instead');
    if (changedNe(o, n, ['org_id', 'type', 'created_by_id'])) fail('A department or project keeps its organisation and type');
  },
  // document_signatures_guard
  document_signatures: async (op, o, n, ctx) => {
    if (op === 'DELETE') fail('Document signatures are withdrawn, never deleted');
    if (op === 'INSERT') {
      const d = await ctx.db.document.findFirst({ where: { id: n.document_id, orgId: n.org_id }, select: { kind: true, status: true } });
      if (d && (!['INVOICE', 'CREDIT_NOTE'].includes(d.kind) || d.status !== 'POSTED')) fail('Only posted invoices and credit notes can be signed');
      const s = await ctx.db.userSignature.findFirst({ where: { id: n.signature_id, orgId: n.org_id }, select: { userId: true, revokedAt: true } });
      if (s && (s.userId !== n.signed_by_id || s.revokedAt !== null)) fail("A document is signed with the signer's own signature in use");
      if (n.withdrawn_at !== null) fail('A new signature cannot start withdrawn');
      return;
    }
    if (
      o.withdrawn_at !== null ||
      n.withdrawn_at === null ||
      changedNe(o, n, ['org_id', 'document_id', 'signature_id', 'signed_by_id', 'signer_name', 'image', 'image_type', 'content_hash', 'signed_at']) ||
      changed(o, n, ['designation', 'user_agent'])
    ) {
      fail('A document signature changes only to be withdrawn');
    }
  },
  // e_invoices_guard
  e_invoices: async (op, o, n, ctx) => {
    if (op === 'DELETE') fail('E-invoice records cannot be deleted');
    if (op === 'INSERT') {
      if (!(await ctx.db.document.count({ where: { id: n.document_id, status: 'POSTED', kind: { in: ['INVOICE', 'CREDIT_NOTE'] } } }))) fail('An IRN can be recorded only for a posted invoice or credit note');
      return;
    }
    if (
      o.status === 'CANCELLED' ||
      ne(n.status, 'CANCELLED') ||
      changed(o, n, ['org_id', 'document_id', 'irn', 'ack_no', 'ack_date', 'signed_qr_code', 'signed_invoice', 'signature_verified', 'payload_hash', 'created_by_id', 'created_at'])
    ) {
      fail('An e-invoice record is immutable; only its cancellation can be recorded');
    }
  },
});
