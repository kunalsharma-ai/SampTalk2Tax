import type { ReactNode } from 'react';
import { SectionHelpProvider } from '@/components/help';
import { Shell } from '@/components/shell';
import { I18nProvider } from '@/lib/i18n';

export default function OrgLayout({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <Shell>
        <SectionHelpProvider>{children}</SectionHelpProvider>
      </Shell>
    </I18nProvider>
  );
}
