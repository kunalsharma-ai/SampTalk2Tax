import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { I18nProvider } from '@/lib/i18n';

export default function OrgLayout({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <Shell>{children}</Shell>
    </I18nProvider>
  );
}
