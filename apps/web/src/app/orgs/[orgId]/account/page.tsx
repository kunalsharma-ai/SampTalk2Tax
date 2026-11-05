'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { DataRegionCard } from '@/components/data-region';
import { OrganisationTimeZoneCard, PreferencesCard } from '@/components/preferences';
import { PageHeader } from '@/components/shell';
import { useT } from '@/lib/i18n';
import { api } from '@/lib/api';
import { dateTime, describeDevice } from '@/lib/format';
import type { AuthSessionInfo } from '@/lib/types';

const when = (iso: string) => dateTime(iso);

export default function AccountSecurityPage() {
  const qc = useQueryClient();
  const t = useT();
  const sessions = useQuery({ queryKey: ['auth-sessions'], queryFn: () => api<AuthSessionInfo[]>('/v1/auth/sessions') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth-sessions'] });
  const revoke = useMutation({ mutationFn: (id: string) => api<void>(`/v1/auth/sessions/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const revokeOthers = useMutation({ mutationFn: () => api<{ signedOut: number }>('/v1/auth/sessions/revoke-others', { method: 'POST' }), onSuccess: refresh });

  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const change = useMutation({
    mutationFn: () => api<{ otherSessionsSignedOut: number }>('/v1/auth/password', { method: 'PUT', body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } }),
    onSuccess: async () => {
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      await refresh();
    },
  });
  const mismatch = pw.confirm !== '' && pw.confirm !== pw.newPassword;
  const others = (sessions.data ?? []).filter((s) => !s.current);

  return (
    <>
      <PageHeader title={t('Account and preferences')} description={t("Your language and formats, where you are signed in, and your password. These settings are for your own account and apply in every organisation, except the organisation's time zone.")} />
      <PreferencesCard />
      <OrganisationTimeZoneCard />
      <DataRegionCard />
      <Card className="mb-6">
        <CardHeader
          title="Where you're signed in"
          description="Each device stays signed in for up to 30 days, or until it goes 7 days without use. Signing a device out takes effect on its next request."
          actions={
            others.length ? (
              <Button size="sm" variant="secondary" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
                Sign out all other devices
              </Button>
            ) : null
          }
        />
        {revoke.error || revokeOthers.error ? <div className="px-5 pb-3"><Alert title="Could not sign out">{(revoke.error ?? revokeOthers.error)?.message}</Alert></div> : null}
        {revokeOthers.data ? <div className="px-5 pb-3"><Alert tone="positive" title={`Signed out ${revokeOthers.data.signedOut} other device${revokeOthers.data.signedOut === 1 ? '' : 's'}`} /></div> : null}
        <Table>
          <thead><tr><Th>Device</Th><Th>Address</Th><Th>Signed in</Th><Th>Last active</Th><Th>Ends by</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {sessions.isLoading ? <Tr><Td colSpan={6} className="text-fg-muted">Loading…</Td></Tr> : null}
            {(sessions.data ?? []).map((s) => (
              <Tr key={s.id}>
                <Td>
                  <span className="font-medium">{describeDevice(s.userAgent)}</span> {s.current ? <Badge tone="accent">This device</Badge> : null}
                </Td>
                <Td className="text-fg-muted">{s.ipAddress ?? '—'}</Td>
                <Td className="text-fg-muted">{when(s.createdAt)}</Td>
                <Td className="text-fg-muted">{when(s.lastUsedAt)}</Td>
                <Td className="text-fg-muted">{when(s.expiresAt)}</Td>
                <Td className="text-right">
                  {s.current ? null : (
                    <Button size="sm" variant="ghost" aria-label={`Sign out ${describeDevice(s.userAgent)}, signed in ${when(s.createdAt)}`} loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                      Sign out
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Change password" description="Changing your password signs out every other device. At least 12 characters." />
        <form
          className="flex max-w-md flex-col gap-4 px-5 pb-5 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mismatch) change.mutate();
          }}
        >
          {change.error ? <Alert title="Password not changed">{change.error.message}</Alert> : null}
          {change.data ? (
            <Alert tone="positive" title="Password changed">
              {change.data.otherSessionsSignedOut ? `${change.data.otherSessionsSignedOut} other device${change.data.otherSessionsSignedOut === 1 ? ' was' : 's were'} signed out.` : 'No other devices were signed in.'}
            </Alert>
          ) : null}
          <Field label="Current password">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />}</Field>
          <Field label="New password">{(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={12} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />}</Field>
          <Field label="Confirm new password" error={mismatch ? 'The passwords do not match' : undefined}>
            {(p) => <Input {...p} type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />}
          </Field>
          <div>
            <Button type="submit" loading={change.isPending} disabled={mismatch || !pw.currentPassword || !pw.newPassword}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
