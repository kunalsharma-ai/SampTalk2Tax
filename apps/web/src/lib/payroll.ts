/** "2026-10" → "October 2026". */
export function monthLabel(period: string) {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function lastDay(period: string) {
  const [y, m] = period.split('-').map(Number);
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

export const LIABILITY_HINT = {
  NET_PAY: 'Transfer to employees',
  PF: 'EPFO ECR challan',
  ESI: 'ESIC challan',
  PT: 'State professional tax',
  TDS: 'Income-tax challan (s.392)',
} as const;
