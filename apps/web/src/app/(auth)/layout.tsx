import type { ReactNode } from 'react';
import { Logo } from '@/components/brand';
import { MaintenanceBanner } from '@/components/maintenance-banner';

const POINTS = [
  { title: 'Talk', text: 'Ask about your books in plain words and get answers that show the reports behind them.' },
  { title: 'File', text: 'GST, TDS/TCS, payroll and e-invoices worked out from your ledger, with a calendar of every due date.' },
  { title: 'Relax', text: 'A double-entry ledger that refuses unbalanced postings, and an audit trail you can verify.' },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden className="t2t-aurora pointer-events-none absolute inset-0" />
        <div className="relative">
          <Logo size="xl" animated />
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Talk to your numbers.
            <br />
            <span className="bg-[image:var(--t2t-gradient-brand)] bg-clip-text text-transparent">Trust every one of them.</span>
          </h1>
          <ul className="mt-8 space-y-4">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 min-w-14 items-center justify-center rounded-full border border-accent/30 bg-accent/10 px-2 text-xs font-semibold text-accent">{p.title}</span>
                <span className="text-sm text-fg-muted">{p.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-fg-faint">Talk2Tax prepares your returns and working papers; it does not file anything with tax authorities.</p>
      </section>
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 overflow-hidden rounded-[var(--t2t-radius-md)] empty:hidden">
            <MaintenanceBanner />
          </div>
          <div className="mb-8 lg:hidden">
            <Logo size="lg" animated />
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
