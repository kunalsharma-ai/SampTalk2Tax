'use client';
import { Alert, Button, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PageHelp } from '@/components/help';

/** Single sign-on (SEC-006): the work email decides the organisation and its identity provider. */
export function SsoForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Enter your work email');
    setBusy(true);
    try {
      const res = await fetch('/api/session/sso', { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ email: email.trim() }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.url !== 'string') throw new Error(typeof body.message === 'string' ? body.message : 'Single sign-on could not start. Try again.');
      window.location.assign(body.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Sign in with single sign-on</h2>
        <PageHelp title="Sign in with single sign-on" />
      </div>
      <p className="mt-1 text-sm text-fg-muted">Enter your work email. You will sign in with your organisation&apos;s identity provider, such as Microsoft, Google or Okta.</p>
      <form onSubmit={start} className="mt-8 flex flex-col gap-4" noValidate>
        {error ? <Alert title="Sign-in failed">{error}</Alert> : null}
        <Field label="Work email">{(p) => <Input {...p} type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Button type="submit" loading={busy} className="mt-2">
          Continue
        </Button>
      </form>
      <p className="mt-6 text-sm text-fg-muted">
        <Link className="text-accent hover:underline" href="/login" prefetch={false}>
          Sign in with a password instead
        </Link>
      </p>
    </div>
  );
}
