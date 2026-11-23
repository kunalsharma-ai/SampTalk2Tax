/**
 * The same receipt file claimed twice (EXP-018). Every attached file is kept with its SHA-256, so
 * the exact file on an expense claim can be found on another claim, or on a supplier bill the
 * business already paid. A different photo of the same receipt is not caught here; the date and
 * amount checks (possibleDuplicateLines, the expense risk view) look for those.
 */
export interface ClaimFile {
  claimId: string;
  sha256: string;
  fileName: string;
}

/** Another record holding a file: a claim that counts, or a supplier bill that is not void. */
export interface FileHolder {
  sha256: string;
  kind: 'EXPENSE_CLAIM' | 'BILL';
  id: string;
  /** "CLM-0004, Ravi Kumar" or "Bill BILL-0012". */
  label: string;
}

export interface SharedReceiptFile {
  fileName: string;
  on: FileHolder[];
}

/** Claim statuses whose files count as claimed: submitted or further, not drafts, rejected or void. */
export const CLAIMED_FILE_STATUSES = ['SUBMITTED', 'APPROVED', 'REIMBURSED'] as const;

/**
 * For each claim, its files that are also on another holder (never itself), one entry per file,
 * holders in the order given and each named once.
 */
export function sharedReceiptFiles(files: readonly ClaimFile[], holders: readonly FileHolder[]): Map<string, SharedReceiptFile[]> {
  const bySha = new Map<string, FileHolder[]>();
  for (const h of holders) bySha.set(h.sha256, [...(bySha.get(h.sha256) ?? []), h]);
  const out = new Map<string, SharedReceiptFile[]>();
  const seen = new Set<string>();
  for (const f of files) {
    const key = `${f.claimId}|${f.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const on: FileHolder[] = [];
    for (const h of bySha.get(f.sha256) ?? []) {
      if (h.kind === 'EXPENSE_CLAIM' && h.id === f.claimId) continue;
      if (!on.some((x) => x.kind === h.kind && x.id === h.id)) on.push(h);
    }
    if (on.length) out.set(f.claimId, [...(out.get(f.claimId) ?? []), { fileName: f.fileName, on }]);
  }
  return out;
}

/** "receipt.jpg is also on CLM-0004, Ravi Kumar and Bill BILL-0012". */
export function describeSharedReceiptFile(s: SharedReceiptFile): string {
  const names = s.on.map((h) => h.label);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
  return `${s.fileName} is also on ${list}`;
}
