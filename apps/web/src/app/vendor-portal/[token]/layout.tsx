import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Vendor portal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function VendorPortalLayout({ children }: { children: ReactNode }) {
  return children;
}
