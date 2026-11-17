'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, session } from '@/lib/api';
import { PageHelp } from '@/components/help';

const loginSchema = z.object({ email: z.email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });
const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: z.email('Enter a valid email'),
  password: z.string().min(12, 'Use at least 12 characters').max(256),
});

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  const carry = next ? `?next=${encodeURIComponent(next)}` : '';
  const [error, setError] = useState<string | null>(null);
  const schema = mode === 'login' ? loginSchema : registerSchema;
  const form = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(schema as typeof registerSchema), defaultValues: { email: params.get('email') ?? '' } });
  const { errors, isSubmitting } = form.formState;

  // Two-step sign-in: after a right password the API waits for a code from the person's app.
  const [codeStep, setCodeStep] = useState(false);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);

  const finish = () => {
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    // A new account goes to onboarding unless it came from an invitation link.
    router.replace(mode === 'register' && !safeNext.startsWith('/invite/') ? '/onboarding' : safeNext);
    router.refresh();
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const r = await session(mode, values);
      if (r.mfaRequired) {
        setCodeStep(true);
        return;
      }
      finish();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  });

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      await session('code', { code });
      finish();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_CHALLENGE_EXPIRED') {
        setCodeStep(false);
        setCode('');
        form.setValue('password', '');
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSending(false);
    }
  };

  if (codeStep) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Two-step sign-in</h2>
          <PageHelp title="Two-step sign-in" />
        </div>
        <p className="mt-1 text-sm text-fg-muted">Open your authenticator app and type the 6-digit code it shows for Talk2Tax. Lost your phone? Type one of your recovery codes instead.</p>
        <form onSubmit={sendCode} className="mt-8 flex flex-col gap-4" noValidate>
          {error ? <Alert title="Sign-in failed">{error}</Alert> : null}
          <Field label="Code" hint="6 digits from the app, or a recovery code like ABCD-EFGH-JKLM.">
            {(p) => <Input {...p} autoFocus inputMode="text" autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Button type="submit" loading={sending} disabled={code.trim().length < 6} className="mt-2">
            Verify and sign in
          </Button>
        </form>
        <p className="mt-6 text-sm text-fg-muted">
          <button type="button" className="text-accent hover:underline" onClick={() => { setCodeStep(false); setCode(''); setError(null); }}>
            Start again with another account
          </button>
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
        <PageHelp title={mode === 'login' ? 'Sign in' : 'Create your account'} />
      </div>
      <p className="mt-1 text-sm text-fg-muted">{mode === 'login' ? 'Welcome back to your finance workspace.' : 'Set up your workspace in a minute.'}</p>
      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" noValidate>
        {error ? <Alert title={mode === 'login' ? 'Sign-in failed' : 'Could not create account'}>{error}</Alert> : null}
        {mode === 'register' ? (
          <Field label="Full name" error={errors.name?.message}>
            {(p) => <Input {...p} autoComplete="name" {...form.register('name')} />}
          </Field>
        ) : null}
        <Field label="Email" error={errors.email?.message}>
          {(p) => <Input {...p} type="email" autoComplete="email" {...form.register('email')} />}
        </Field>
        <Field label="Password" error={errors.password?.message} hint={mode === 'register' ? 'At least 12 characters.' : undefined}>
          {(p) => <Input {...p} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} {...form.register('password')} />}
        </Field>
        <Button type="submit" loading={isSubmitting} className="mt-2">
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
      {/* Not prefetched: once the form signs you in, the proxy sends /login and /register to "/", and a
          prefetch that ends up there answers 404 (Next.js 16 prefetches each segment separately). */}
      <p className="mt-6 text-sm text-fg-muted">
        {mode === 'login' ? (
          <>
            New to Talk2Tax?{' '}
            <Link className="text-accent hover:underline" href={`/register${carry}`} prefetch={false}>
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <Link className="text-accent hover:underline" href={`/login${carry}`} prefetch={false}>
              Sign in
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
