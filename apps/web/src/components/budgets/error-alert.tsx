'use client';
import { Alert } from '@talk2tax/ui';
import { ApiError } from '@/lib/api';

export function ErrorAlert({ title, error }: { title: string; error: Error | null }) {
  if (!error) return null;
  return (
    <Alert title={title}>
      {error.message}
      {error instanceof ApiError && error.issues.length > 1 ? <ul className="mt-1 list-inside list-disc">{error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
    </Alert>
  );
}
