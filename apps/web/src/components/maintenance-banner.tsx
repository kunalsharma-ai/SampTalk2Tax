'use client';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useServiceStatus } from '@/lib/operations';

/** Shown at the top of every page while maintenance is scheduled or in progress. */
export function MaintenanceBanner() {
  const status = useServiceStatus();
  const t = useT();
  const m = status.data?.maintenance;
  if (!m) return null;
  return (
    <p role="alert" data-testid="maintenance-banner" className={m.state === 'IN_PROGRESS' ? 'border-b border-warning/40 bg-warning/15 px-4 py-2 text-center text-sm text-fg print:hidden' : 'border-b border-accent/30 bg-accent/10 px-4 py-2 text-center text-sm text-fg print:hidden'}>
      {m.state === 'IN_PROGRESS'
        ? m.expectedEndAt
          ? t('Maintenance in progress: {message} You can read and export your records; changes are paused until about {until}.', { message: m.message, until: dateTime(m.expectedEndAt) })
          : t('Maintenance in progress: {message} You can read and export your records; changes are paused until it ends.', { message: m.message })
        : t('Planned maintenance from {from}: {message} Changes will be paused while it runs.', { from: dateTime(m.startsAt), message: m.message })}
    </p>
  );
}
