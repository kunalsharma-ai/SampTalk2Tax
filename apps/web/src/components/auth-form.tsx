'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, session } from '@/lib/api';

const loginSchema = z.object({ email: z.email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });
const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: z.email('Enter a valid email'),
  password: z.string().min(12, 'Use at least 12 characters').max(256),
});

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [error, setError] = useState<string | null>(null);
  const schema = mode === 'login' ? loginSchema : registerSchema;
  const form = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(schema as typeof registerSchema) });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await session(mode, values);
      const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      router.replace(mode === 'register' ? '/onboarding' : safeNext);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  });

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
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
      <p className="mt-6 text-sm text-fg-muted">
        {mode === 'login' ? (
          <>
            New to Talk2Tax?{' '}
            <Link className="text-accent hover:underline" href="/register">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <Link className="text-accent hover:underline" href="/login">
              Sign in
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
