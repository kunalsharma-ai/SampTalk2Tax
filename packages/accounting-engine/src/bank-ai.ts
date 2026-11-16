/**
 * AI reconciliation: what the AI model is shown about one unmatched bank statement line,
 * and the checks that whatever it proposes uses only those records and adds up.
 *
 * The model sees short references (L1, D1, C1, account codes), never database ids, so it
 * cannot point at a record it was not shown. A proposal is applied only after a person
 * accepts it, and then through the same matching, receipt and entry code as by hand.
 * No framework or database code. Money is decimal strings.
 */
import { D, Dec } from './money';
import { formatAmountText, formatDateText } from './workflows';

export const BANK_AI_ACTIONS = ['MATCH', 'PAYMENT', 'ENTRY', 'NONE'] as const;
export type BankAiAction = (typeof BANK_AI_ACTIONS)[number];
export const CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Everything the model is shown for one line, with the ids the references stand for. */
export interface BankLineContext {
  currency: string;
  line: { date: string; amount: string; description: string; reference: string | null };
  /** Unmatched posted ledger lines on this bank account near the line's date. */
  ledger: { ref: string; id: string; date: string; amount: string; text: string }[];
  /** Open invoices (money in) or bills (money out). */
  documents: { ref: string; id: string; kind: 'INVOICE' | 'BILL'; number: string; contactRef: string; dueDate: string | null; balance: string; reference: string | null }[];
  contacts: { ref: string; id: string; name: string }[];
  /** Accounts an entry may go to: postable, active, not a bank account or a control account. */
  accounts: { code: string; id: string; name: string; type: string }[];
  /** Earlier bank lines a person turned into entries, newest first: how this business books them. */
  history: { date: string; text: string; amount: string; accountCode: string; accountName: string }[];
}

export interface BankProposalInput {
  action: BankAiAction;
  ledgerRefs?: string[];
  contactRef?: string;
  allocations?: { documentRef: string; amount: string }[];
  accountCode?: string;
  entryDescription?: string;
}

/** A proposal with the references turned back into ids, ready to apply. */
export type ResolvedProposal =
  | { action: 'MATCH'; journalLineIds: string[]; ledger: { ref: string; date: string; amount: string; text: string }[] }
  | { action: 'PAYMENT'; contactId: string; contactName: string; allocations: { documentId: string; number: string; amount: string }[]; unallocated: string }
  | { action: 'ENTRY'; accountId: string; accountCode: string; accountName: string; description: string }
  | { action: 'NONE' };

export interface ProposalCheck {
  ok: boolean;
  label: string;
}

const AMOUNT = /^\d+(\.\d{1,2})?$/;

/**
 * Checks a proposal against what the model was shown: every reference is one it was given,
 * matched ledger lines add up to the bank line, receipts and payments go to one contact's
 * open documents for no more than each still owes, and entries go to an allowed account.
 * Returns the checks and, when they all pass, the proposal with ids.
 */
export function checkProposal(ctx: BankLineContext, p: BankProposalInput): { checks: ProposalCheck[]; resolved: ResolvedProposal | null } {
  const amount = new D(ctx.line.amount);
  const money = (v: Dec | string) => formatAmountText(new D(v).toFixed(2), ctx.currency);
  const checks: ProposalCheck[] = [];
  const ok = () => checks.every((c) => c.ok);

  if (p.action === 'NONE') {
    return { checks: [{ ok: false, label: 'The AI model could not tell what this line is: deal with it by hand' }], resolved: { action: 'NONE' } };
  }

  if (p.action === 'MATCH') {
    const refs = [...new Set(p.ledgerRefs ?? [])];
    const rows = refs.map((r) => ctx.ledger.find((l) => l.ref === r));
    const unknown = refs.filter((_, i) => !rows[i]);
    checks.push({ ok: refs.length > 0 && unknown.length === 0, label: unknown.length ? `Ledger lines it was not shown: ${unknown.join(', ')}` : refs.length ? 'Every ledger line is one it was shown' : 'No ledger lines chosen' });
    const found = rows.filter((r): r is NonNullable<typeof r> => !!r);
    const total = found.reduce<Dec>((s, r) => s.plus(r.amount), new D(0));
    checks.push({ ok: found.length > 0 && total.eq(amount), label: total.eq(amount) ? `The ledger lines add up to the bank line (${money(amount.abs())})` : `The ledger lines add up to ${money(total)}, not ${money(amount)}` });
    return { checks, resolved: ok() ? { action: 'MATCH', journalLineIds: found.map((r) => r.id), ledger: found.map(({ ref, date, amount: a, text }) => ({ ref, date, amount: a, text })) } : null };
  }

  if (p.action === 'PAYMENT') {
    const kind = amount.gt(0) ? 'INVOICE' : 'BILL';
    const contact = ctx.contacts.find((c) => c.ref === p.contactRef);
    checks.push({ ok: !!contact, label: contact ? `${amount.gt(0) ? 'A receipt from' : 'A payment to'} ${contact.name}` : `A contact it was not shown: ${p.contactRef ?? 'none'}` });
    const allocations = p.allocations ?? [];
    const issues: string[] = [];
    const seen = new Set<string>();
    let total = new D(0);
    const resolved: { documentId: string; number: string; amount: string }[] = [];
    for (const a of allocations) {
      const doc = ctx.documents.find((d) => d.ref === a.documentRef);
      if (!doc) issues.push(`${a.documentRef} was not shown`);
      else if (seen.has(doc.ref)) issues.push(`${doc.number} is listed twice`);
      else if (doc.kind !== kind) issues.push(`${doc.number} is ${doc.kind === 'INVOICE' ? 'an invoice' : 'a bill'}, but money ${amount.gt(0) ? 'came in' : 'went out'}`);
      else if (contact && doc.contactRef !== contact.ref) issues.push(`${doc.number} is not ${contact.name}'s`);
      else if (!AMOUNT.test(a.amount) || new D(a.amount).lte(0)) issues.push(`${doc.number}: "${a.amount}" is not an amount`);
      else if (new D(a.amount).gt(doc.balance)) issues.push(`${doc.number} only has ${money(doc.balance)} still to pay`);
      else {
        total = total.plus(a.amount);
        resolved.push({ documentId: doc.id, number: doc.number, amount: new D(a.amount).toFixed(2) });
      }
      if (doc) seen.add(doc.ref);
    }
    checks.push({ ok: issues.length === 0, label: issues.length ? issues.join('; ') : resolved.length ? `Applied to ${resolved.map((r) => r.number).join(', ')}` : 'Not applied to any invoice or bill' });
    const left = amount.abs().minus(total);
    checks.push({ ok: left.gte(0), label: left.gte(0) ? (left.gt(0) ? `${money(left)} left on account` : 'The amounts applied add up to the bank line') : `${money(total)} applied is more than the ${money(amount.abs())} on the bank line` });
    return { checks, resolved: ok() && contact ? { action: 'PAYMENT', contactId: contact.id, contactName: contact.name, allocations: resolved, unallocated: left.toFixed(2) } : null };
  }

  // ENTRY
  const account = ctx.accounts.find((a) => a.code === p.accountCode);
  checks.push({ ok: !!account, label: account ? `Posted to ${account.code} ${account.name}` : `An account it may not use: ${p.accountCode ?? 'none'}` });
  const description = (p.entryDescription ?? '').trim();
  checks.push({ ok: description.length > 0 && description.length <= 200 && !/[\r\n]/.test(description), label: 'A one-line description of up to 200 characters' });
  return { checks, resolved: ok() && account ? { action: 'ENTRY', accountId: account.id, accountCode: account.code, accountName: account.name, description } : null };
}

/** The context as the model reads it: plain text, references instead of ids. */
export function contextForModel(ctx: BankLineContext): string {
  const amt = (v: string) => formatAmountText(new D(v).abs().toFixed(2), ctx.currency);
  const amount = new D(ctx.line.amount);
  const contact = (ref: string) => ctx.contacts.find((c) => c.ref === ref)?.name ?? ref;
  return [
    `Bank statement line: ${formatDateText(ctx.line.date)}, money ${amount.gt(0) ? 'in' : 'out'} ${amt(ctx.line.amount)}, text "${ctx.line.description}"${ctx.line.reference ? `, bank reference "${ctx.line.reference}"` : ''}.`,
    '',
    `Unmatched ledger lines on this bank account (money in is positive):`,
    ...(ctx.ledger.length ? ctx.ledger.map((l) => `- ${l.ref}: ${formatDateText(l.date)}, ${new D(l.amount).gt(0) ? '+' : '-'}${amt(l.amount)}, "${l.text}"`) : ['- none']),
    '',
    `Open ${amount.gt(0) ? 'invoices (customers who owe us)' : 'bills (vendors we owe)'}:`,
    ...(ctx.documents.length ? ctx.documents.map((d) => `- ${d.ref}: ${d.number}, ${contact(d.contactRef)} (${d.contactRef})${d.dueDate ? `, due ${formatDateText(d.dueDate)}` : ''}, still to pay ${amt(d.balance)}${d.reference ? `, reference "${d.reference}"` : ''}`) : ['- none']),
    '',
    `${amount.gt(0) ? 'Customers' : 'Vendors'}: ${ctx.contacts.length ? ctx.contacts.map((c) => `${c.ref} ${c.name}`).join('; ') : 'none'}`,
    '',
    'Accounts an entry may go to (code, name, type):',
    ...ctx.accounts.map((a) => `- ${a.code} ${a.name} (${a.type.toLowerCase()})`),
    '',
    'How earlier bank lines were booked by a person:',
    ...(ctx.history.length ? ctx.history.map((h) => `- "${h.text}", ${new D(h.amount).gt(0) ? '+' : '-'}${amt(h.amount)} → ${h.accountCode} ${h.accountName}`) : ['- none yet']),
  ].join('\n');
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const WORD = /[a-z0-9]+(?:-[a-z0-9]+)*/g;
const STOP = new Set(['the', 'and', 'for', 'from', 'neft', 'imps', 'rtgs', 'upi', 'ref', 'inr', 'pvt', 'ltd', 'payment', 'transfer', 'cr', 'dr', 'to', 'by']);
export const textWords = (s: string) => new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)));

/** Orders candidate records for a line: shared words first, then closeness in amount, then in date. */
export function rankCandidates<T extends { amount: string; date: string | null; text: string }>(line: { amount: string; date: string; description: string; reference: string | null }, rows: T[], limit: number): T[] {
  const words = textWords(`${line.description} ${line.reference ?? ''}`);
  const target = new D(line.amount).abs();
  const scored = rows.map((r) => {
    const shared = [...textWords(r.text)].filter((w) => words.has(w)).length;
    return { r, shared, gap: new D(r.amount).abs().minus(target).abs(), days: r.date ? Math.abs(day(r.date) - day(line.date)) : 9999 };
  });
  scored.sort((a, b) => b.shared - a.shared || a.gap.cmp(b.gap) || a.days - b.days);
  return scored.slice(0, limit).map((s) => s.r);
}
