'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Logo } from '@/components/brand';
import { api, signOut } from '@/lib/api';
import { date } from '@/lib/format';
import type { InvitationPreview } from '@/lib/types';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invitation', token], queryFn: () => api<InvitationPreview>(`/v1/invitations/${token}`), retry: false });
  const accept = useMutation({
    mutationFn: () => api<{ orgId: string }>(`/v1/invitations/${token}/accept`, { method: 'POST' }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['orgs'] });
      router.replace(`/orgs/${r.orgId}`);
    },
  });
  const inv = q.data;
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-12">
      <div className="mb-8"><Logo size="lg" animated /></div>
      <Card className="p-6">
        {q.isLoading ? <p className="text-sm text-fg-muted">Loading the invitation…</p> : null}
        {q.error ? <Alert title="Invitation not found">{q.error.message}</Alert> : null}
        {inv ? (
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-sm text-fg-muted">{inv.invitedBy ? `${inv.invitedBy} invited you to join` : 'You are invited to join'}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{inv.organization.name}</h1>
              <p className="mt-2 text-sm">
                as <Badge tone="violet">{inv.role.toLowerCase()}</Badge> {inv.organization.isDemo ? <Badge tone="warning">Synthetic demo data</Badge> : null}
              </p>
            </div>
            {inv.alreadyMember ? (
              <Alert tone="positive" title="You are already a member">
                <Link className="text-accent hover:underline" href={`/orgs/${inv.organization.id}`}>Open {inv.organization.name}</Link>
              </Alert>
            ) : inv.status !== 'PENDING' ? (
              <Alert title={`This invitation has ${inv.status === 'EXPIRED' ? 'expired' : `been ${inv.status.toLowerCase()}`}`}>Ask whoever invited you for a new link.</Alert>
            ) : !inv.forYou ? (
              <Alert tone="warning" title={`This invitation is for ${inv.email}`}>
                You are signed in with a different email. <button className="text-accent underline" onClick={() => void signOut()}>Sign out</button> and sign in or create an account with {inv.email}.
              </Alert>
            ) : (
              <>
                <p className="text-sm text-fg-muted">For {inv.email}. The link works until {date(inv.expiresAt.slice(0, 10))}.</p>
                {accept.error ? <Alert title="Could not join">{accept.error.message}</Alert> : null}
                <div><Button loading={accept.isPending} onClick={() => accept.mutate()}>Join {inv.organization.name}</Button></div>
              </>
            )}
          </div>
        ) : null}
      </Card>
    </main>
  );
}
