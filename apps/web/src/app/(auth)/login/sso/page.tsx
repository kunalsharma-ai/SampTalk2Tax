import { Suspense } from 'react';
import { SsoForm } from '@/components/sso-form';

export const metadata = { title: 'Sign in with single sign-on' };

export default function SsoLoginPage() {
  return (
    <Suspense>
      <SsoForm />
    </Suspense>
  );
}
