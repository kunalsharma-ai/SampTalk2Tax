import type { ReactNode } from 'react';
import { Logo } from '@/components/brand';
import { MaintenanceBanner } from '@/components/maintenance-banner';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Logo />
        <div className="max-w-md">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Sampledge Talk2Tax</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight">
            Talk to your numbers.
            <br />
            <span className="bg-[image:var(--t2t-gradient-brand)] bg-clip-text text-transparent">Trust every one of them.</span>
          </h1>
          <ul className="mt-8 space-y-3 text-sm text-fg-muted">
            <li>• Double-entry ledger that refuses unbalanced or edited postings</li>
            <li>• Tamper-evident audit trail you can verify</li>
            <li>• Live trial balance, P&amp;L and balance sheet</li>
          </ul>
        </div>
        <p className="text-xs text-fg-faint">AI features, tax and payroll are on the roadmap and are not part of this build.</p>
        <div aria-hidden className="pointer-events-none absolute -right-40 top-1/3 size-[480px] rounded-full bg-[image:var(--t2t-gradient-brand)] opacity-20 blur-3xl" />
      </section>
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 overflow-hidden rounded-[var(--t2t-radius-md)] empty:hidden">
            <MaintenanceBanner />
          </div>
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
