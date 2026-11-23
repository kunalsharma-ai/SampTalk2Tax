import { D, dec } from './money';
import type { TaxAuthority, TaxNoticeStatus } from './tax-notices';

/**
 * Tax notice analysis (TAX-050): what kind of notice an entered notice is, from its authority and
 * section, what it usually asks for, by when, how to reply, what to gather, and (for an income-tax
 * demand) the interest building up while it stays unpaid. Every rule below names the provision it
 * comes from; a notice whose section is not in the table is left unrecognised rather than guessed.
 * Sections are those of the CGST Act, 2017 and the Income-tax Act, 1961: notices issued under the
 * Income-tax Act, 2025 carry different section numbers and are not recognised by section here; the
 * user can still choose the type.
 */
export interface NoticeChecklistItem {
  key: string;
  label: string;
}

export interface NoticeType {
  key: string;
  authorities: readonly TaxAuthority[];
  /** Normalised sections (lower case, no spaces, no "section"/"u/s"). */
  sections: readonly string[];
  /** Form names the notice is known by, where one form means one type (e.g. ASMT-10). */
  forms?: readonly string[];
  title: string;
  what: string;
  /** Usual days from receipt to reply; null when the notice itself sets the date. */
  replyWithinDays: number | null;
  howToReply: string;
  /** Interest that runs on an unpaid demand. */
  interest: 'INCOME_TAX_220_2' | null;
  checklist: readonly NoticeChecklistItem[];
  source: string;
}

const item = (key: string, label: string): NoticeChecklistItem => ({ key, label });
const GST_SCN_CHECKLIST = [
  item('statement', 'Get the show cause notice and its statement of the tax demanded (DRC-01) from the GST portal'),
  item('working', 'Work out the tax, interest and penalty proposed against your own books for the period'),
  item('decide', 'Decide what to accept (and pay through DRC-03) and what to contest'),
  item('reply', 'Prepare the reply in DRC-06 with supporting documents'),
  item('hearing', 'Ask for a personal hearing if you contest any part'),
];

/** Notice types recognised by section. */
export const NOTICE_TYPES: readonly NoticeType[] = [
  {
    key: 'GST_46',
    authorities: ['GST'],
    sections: ['46'],
    forms: ['gstr-3a'],
    title: 'Notice to a return defaulter (GSTR-3A)',
    what: 'A return was not filed by its due date. If it is still not filed, the officer may assess the tax to the best of judgement under section 62.',
    replyWithinDays: 15,
    howToReply: 'File the pending return with tax, interest and late fee; there is no separate reply form.',
    interest: null,
    checklist: [item('identify', 'Identify the return and period named in the notice'), item('file', 'File the pending return with tax, interest and late fee'), item('arn', 'Keep the filing acknowledgement (ARN) with the notice')],
    source: 'CGST Act, 2017, s.46; CGST Rules, rule 68 (GSTR-3A)',
  },
  {
    key: 'GST_61',
    authorities: ['GST'],
    sections: ['61'],
    forms: ['asmt-10'],
    title: 'Scrutiny of returns (ASMT-10)',
    what: 'The officer found discrepancies in your returns for the period and asks you to explain them.',
    replyWithinDays: 30,
    howToReply: 'Reply in ASMT-11 on the GST portal, explaining each discrepancy or accepting it and paying through DRC-03.',
    interest: null,
    checklist: [
      item('discrepancies', 'List each discrepancy raised in ASMT-10'),
      item('outward', 'Reconcile outward supplies between GSTR-1 and GSTR-3B for the period'),
      item('itc', 'Reconcile input tax credit claimed with GSTR-2B'),
      item('pay', 'Pay any tax you accept, with interest, through DRC-03'),
      item('reply', 'File the explanation in ASMT-11'),
    ],
    source: 'CGST Act, 2017, s.61; CGST Rules, rule 99',
  },
  {
    key: 'GST_73',
    authorities: ['GST'],
    sections: ['73'],
    title: 'Show cause notice: tax not paid or short paid (not fraud)',
    what: 'The officer proposes tax not paid, short paid, wrongly refunded or input tax credit wrongly availed, with interest and penalty, for a reason other than fraud. It applies to periods up to 2023-24.',
    replyWithinDays: 30,
    howToReply: 'Reply in DRC-06 on the GST portal, or pay the amount with interest through DRC-03.',
    interest: null,
    checklist: GST_SCN_CHECKLIST,
    source: 'CGST Act, 2017, s.73; CGST Rules, rules 142 and 142(4)',
  },
  {
    key: 'GST_74',
    authorities: ['GST'],
    sections: ['74'],
    title: 'Show cause notice: fraud or suppression',
    what: 'The officer proposes tax not paid or input tax credit wrongly availed by reason of fraud, wilful misstatement or suppression of facts, with interest and a higher penalty. It applies to periods up to 2023-24.',
    replyWithinDays: 30,
    howToReply: 'Reply in DRC-06 on the GST portal. Take professional advice before replying.',
    interest: null,
    checklist: GST_SCN_CHECKLIST,
    source: 'CGST Act, 2017, s.74; CGST Rules, rule 142',
  },
  {
    key: 'GST_74A',
    authorities: ['GST'],
    sections: ['74a'],
    title: 'Show cause notice for 2024-25 onwards',
    what: 'The officer proposes tax not paid, short paid or input tax credit wrongly availed for a period from 2024-25, with interest and penalty; fraud or suppression raises the penalty.',
    replyWithinDays: 30,
    howToReply: 'Reply in DRC-06 on the GST portal, or pay the amount with interest through DRC-03.',
    interest: null,
    checklist: GST_SCN_CHECKLIST,
    source: 'CGST Act, 2017, s.74A; CGST Rules, rule 142',
  },
  {
    key: 'IT_139_9',
    authorities: ['INCOME_TAX'],
    sections: ['139(9)'],
    title: 'Defective return',
    what: 'The return you filed is treated as defective. If the defect is not removed in time, the return is treated as never filed.',
    replyWithinDays: 15,
    howToReply: 'Respond on the e-filing portal under pending actions, correcting the defect (usually by filing a corrected return in response).',
    interest: null,
    checklist: [item('defect', 'Read the defect and the error code in the notice'), item('correct', 'Prepare the corrected return or the missing schedule'), item('respond', 'Respond on the e-filing portal before the deadline'), item('ack', 'Keep the acknowledgement with the notice')],
    source: 'Income-tax Act, 1961, s.139(9)',
  },
  {
    key: 'IT_143_1A',
    authorities: ['INCOME_TAX'],
    sections: ['143(1)(a)', '143(1)'],
    title: 'Proposed adjustment while processing the return',
    what: 'The return is being processed and the department proposes adjustments (for example a mismatch with Form 26AS or the audit report). Without a reply the adjustments are made.',
    replyWithinDays: 30,
    howToReply: 'Agree or disagree with each adjustment on the e-filing portal, with reasons.',
    interest: null,
    checklist: [item('adjustments', 'List each proposed adjustment'), item('compare', 'Compare with the return, Form 26AS/AIS and the audit report'), item('respond', 'Agree or disagree with each on the e-filing portal')],
    source: 'Income-tax Act, 1961, s.143(1)(a)',
  },
  {
    key: 'IT_142_1',
    authorities: ['INCOME_TAX'],
    sections: ['142(1)'],
    title: 'Inquiry before assessment',
    what: 'The assessing officer asks for documents, accounts or information, or for a return to be filed.',
    replyWithinDays: null,
    howToReply: 'Submit what is asked through e-proceedings on the e-filing portal by the date in the notice.',
    interest: null,
    checklist: [item('list', 'List everything the notice asks for'), item('gather', 'Gather the accounts, ledgers and documents'), item('submit', 'Submit through e-proceedings by the date in the notice')],
    source: 'Income-tax Act, 1961, s.142(1)',
  },
  {
    key: 'IT_143_2',
    authorities: ['INCOME_TAX'],
    sections: ['143(2)'],
    title: 'Scrutiny assessment',
    what: 'The return has been selected for scrutiny; the assessing officer will examine it and may ask further questions.',
    replyWithinDays: null,
    howToReply: 'Respond through e-proceedings on the e-filing portal by the date in the notice.',
    interest: null,
    checklist: [item('issues', 'Note the issues the case was selected for'), item('papers', 'Prepare the books, audit report and working papers for those issues'), item('represent', 'Decide who will represent you'), item('submit', 'Submit replies through e-proceedings by each date')],
    source: 'Income-tax Act, 1961, s.143(2)',
  },
  {
    key: 'IT_148A',
    authorities: ['INCOME_TAX'],
    sections: ['148a', '148a(b)'],
    title: 'Show cause before reopening an assessment',
    what: 'The assessing officer has information suggesting income escaped assessment and asks why the assessment should not be reopened.',
    replyWithinDays: null,
    howToReply: 'Reply through e-proceedings by the date in the notice, with evidence on the information relied on.',
    interest: null,
    checklist: [item('information', 'Get the information the officer relies on'), item('evidence', 'Gather evidence that the income was assessed or is not income'), item('reply', 'Reply through e-proceedings by the date in the notice')],
    source: 'Income-tax Act, 1961, s.148A',
  },
  {
    key: 'IT_148',
    authorities: ['INCOME_TAX'],
    sections: ['148'],
    title: 'Notice to reassess income',
    what: 'The assessment for the year is being reopened; you are asked to file a return for that year.',
    replyWithinDays: null,
    howToReply: 'File the return for the year on the e-filing portal within the time in the notice.',
    interest: null,
    checklist: [item('order', 'Get the order under section 148A that preceded the notice'), item('return', 'Prepare and file the return for the year'), item('reasons', 'Ask for the reasons if they were not supplied')],
    source: 'Income-tax Act, 1961, s.148',
  },
  {
    key: 'IT_156',
    authorities: ['INCOME_TAX'],
    sections: ['156'],
    title: 'Notice of demand',
    what: 'Tax, interest or penalty is payable. If it is not paid within 30 days, simple interest of 1% for every month or part of a month runs until it is paid.',
    replyWithinDays: 30,
    howToReply: 'Pay through challan ITNS 280 (or agree to adjust it against a refund); if you disagree, respond on the e-filing portal and consider rectification or appeal.',
    interest: 'INCOME_TAX_220_2',
    checklist: [item('order', 'Get the order the demand comes from'), item('verify', 'Check the demand against your computation'), item('pay', 'Pay, or seek a stay or rectification, before the deadline'), item('challan', 'Keep the challan with the notice')],
    source: 'Income-tax Act, 1961, s.156; s.220(1) and (2)',
  },
  {
    key: 'IT_245',
    authorities: ['INCOME_TAX'],
    sections: ['245', '245(1)'],
    title: 'Proposed adjustment of a refund against a demand',
    what: 'The department proposes to set a refund due to you against an outstanding demand.',
    replyWithinDays: 30,
    howToReply: 'Agree, disagree or partly agree on the e-filing portal under outstanding demands.',
    interest: null,
    checklist: [item('demand', 'Identify the outstanding demand and its year'), item('check', 'Check whether it is correct, paid or stayed'), item('respond', 'Respond on the e-filing portal')],
    source: 'Income-tax Act, 1961, s.245',
  },
  {
    key: 'TDS_200A',
    authorities: ['TDS', 'INCOME_TAX'],
    sections: ['200a'],
    title: 'Intimation on processing a TDS statement',
    what: 'Processing your TDS statement found defaults: short deduction, short payment, interest under section 201(1A) or a late filing fee under section 234E.',
    replyWithinDays: null,
    howToReply: 'Download the justification report from TRACES, pay what is due and file a correction statement for errors.',
    interest: null,
    checklist: [item('report', 'Download the justification report from TRACES'), item('compare', 'Compare each default with your TDS register'), item('pay', 'Pay the amount due through challan'), item('correct', 'File a correction statement for errors in the statement')],
    source: 'Income-tax Act, 1961, s.200A; s.201(1A); s.234E',
  },
];

/** "u/s 143(1)(a)", "Section 74A", "sec. 61" → "143(1)(a)", "74a", "61". */
export function normaliseSection(section: string | null | undefined): string {
  return (section ?? '')
    .toLowerCase()
    .replace(/u\/s|under section|section|sec\.?|s\./g, '')
    .replace(/\s+/g, '')
    .replace(/^[.:-]+/, '');
}

/** The notice type matched by authority and section (or a form that names one type), or null. */
export function recogniseNotice(authority: TaxAuthority, section: string | null | undefined): NoticeType | null {
  const s = normaliseSection(section);
  if (!s) return null;
  const bare = s.replace(/-/g, '');
  return NOTICE_TYPES.find((t) => t.authorities.includes(authority) && (t.sections.includes(s) || (t.forms ?? []).some((f) => f.replace(/-/g, '') === bare))) ?? null;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

/** Months or parts of months from `from` through `to`, both included (0 when `to` is before `from`). */
export function noticeMonthsOrPart(from: string, to: string): number {
  let n = 0; // not money
  while (addMonths(from, n) <= to) n += 1;
  return n;
}

export interface NoticeAnalysisInput {
  authority: TaxAuthority;
  section: string | null;
  status: TaxNoticeStatus;
  receivedOn: string;
  responseDue: string | null;
  demand: string | null;
  /** A type the user chose, overriding recognition by section. */
  chosenType: string | null;
  checked: readonly string[];
}

export interface NoticeAnalysis {
  type: NoticeType | null;
  recognisedBy: 'SECTION' | 'CHOSEN' | null;
  /** The reply deadline in use, where it came from, and the usual one by the rule. */
  deadline: { date: string; source: 'NOTICE' | 'RULE' } | null;
  usualDeadline: string | null;
  interest: { from: string; months: number; ratePerMonth: string; amount: string; note: string } | null;
  checklist: (NoticeChecklistItem & { done: boolean })[];
  progress: { done: number; total: number };
  warnings: string[];
}

/** The analysis of one notice as entered, on `today`. */
export function analyseNotice(n: NoticeAnalysisInput, today: string): NoticeAnalysis {
  const chosen = n.chosenType ? (NOTICE_TYPES.find((t) => t.key === n.chosenType) ?? null) : null;
  const bySection = recogniseNotice(n.authority, n.section);
  const type = chosen ?? bySection;
  const warnings: string[] = [];
  if (!type) warnings.push(n.section ? `Section ${n.section} is not one this analysis knows for ${n.authority === 'INCOME_TAX' ? 'income tax' : n.authority} notices; choose the type if you know it.` : 'Enter the section the notice is issued under, or choose the type, to analyse it.');
  if (chosen && bySection && chosen.key !== bySection.key) warnings.push(`The section entered suggests "${bySection.title}", but "${chosen.title}" was chosen.`);
  const usualDeadline = type?.replyWithinDays ? addDays(n.receivedOn, type.replyWithinDays) : null;
  const deadline = n.responseDue ? { date: n.responseDue, source: 'NOTICE' as const } : usualDeadline ? { date: usualDeadline, source: 'RULE' as const } : null;
  if (n.responseDue && usualDeadline && n.responseDue > usualDeadline) warnings.push(`The reply date entered (${n.responseDue}) is later than the usual ${type!.replyWithinDays} days from receipt (${usualDeadline}); check the date on the notice or any extension granted.`);
  if (!n.responseDue && usualDeadline) warnings.push(`No reply date is entered; ${usualDeadline} is ${type!.replyWithinDays} days from receipt. Enter the date on the notice if it differs.`);
  if (!deadline && type && n.status === 'OPEN') warnings.push('This kind of notice sets its own date: enter the reply date from the notice.');

  let interest: NoticeAnalysis['interest'] = null;
  if (type?.interest === 'INCOME_TAX_220_2' && n.demand && dec(n.demand).gt(0) && n.status === 'OPEN') {
    const due = n.responseDue ?? addDays(n.receivedOn, 30);
    const from = addDays(due, 1);
    const months = noticeMonthsOrPart(from, today);
    if (months > 0) {
      interest = {
        from,
        months,
        ratePerMonth: '1',
        amount: dec(n.demand).times(months).div(100).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2),
        note: 'An estimate: 1% simple interest for each month or part of a month after the due date on the amount demanded, until paid (section 220(2)). The department works it out on the amount rounded down to the nearest hundred rupees.',
      };
    }
  }
  const done = new Set(n.checked);
  const checklist = (type?.checklist ?? []).map((c) => ({ ...c, done: done.has(c.key) }));
  return { type, recognisedBy: chosen ? 'CHOSEN' : bySection ? 'SECTION' : null, deadline, usualDeadline, interest, checklist, progress: { done: checklist.filter((c) => c.done).length, total: checklist.length }, warnings };
}
