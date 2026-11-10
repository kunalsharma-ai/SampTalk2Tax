import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Customer portal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function PortalLayout({ children }: { children: ReactNode }) {
  return children;
}
