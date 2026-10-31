export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <defs>
          <linearGradient id="t2t-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#12c2e9" />
            <stop offset=".55" stopColor="#6366f1" />
            <stop offset="1" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="#0e1833" />
        <path d="M8 10h16M16 10v13M11 18l5 5 5-5" stroke="url(#t2t-g)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {compact ? null : (
        <span className="text-[15px] font-semibold tracking-tight text-fg">
          Talk<span className="bg-[image:var(--t2t-gradient-brand)] bg-clip-text text-transparent">2</span>Tax
        </span>
      )}
    </span>
  );
}
