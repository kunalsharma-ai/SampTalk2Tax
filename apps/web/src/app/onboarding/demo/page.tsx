'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { countryModule } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/brand';
import { PageHelp } from '@/components/help';
import { api, ApiError } from '@/lib/api';

interface DemoProfileRow {
  key: string;
  title: string;
  summary: string;
  orgName: string;
  countryCode: string;
  currency: string;
  customers: number;
  vendors: number;
  projects: number;
  staff: number;
  payroll: boolean;
  salesTax: string | null;
}
interface DemoBuilt {
  organisation: { id: string; name: string };
  status: 'READY' | 'FAILED' | 'BUILDING';
  failure: string | null;
}

/**
 * Explore a demonstration organisation (DEMO-001 to DEMO-007): six made-up companies, each built
 * into an organisation you own with six months of synthetic books, clearly labelled as such.
 */
export default function DemoOrganisationsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const profiles = useQuery({ queryKey: ['demo-profiles'], queryFn: () => api<{ profiles: DemoProfileRow[]; perPerson: number }>('/v1/demo-organisations/profiles') });
  const create = useMutation({
    mutationFn: (profile: string) => api<DemoBuilt>('/v1/demo-organisations', { method: 'POST', body: { profile } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['orgs'] });
      router.replace(`/orgs/${r.organisation.id}/demo`);
    },
  });
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-12">
      <Logo size="lg" className="self-start" />
      <div className="mt-8 flex items-center gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Explore a demonstration organisation</h1>
        <PageHelp title="Explore a demonstration organisation" />
      </div>
      <p className="mt-2 max-w-3xl text-sm text-fg-muted">
        Pick a made-up company to try Talk2Tax with six months of books already in it: customers, vendors, invoices, bills, payments, journals, projects, staff, a bank statement, tax set-up and a
        budget. Everything is synthetic and labelled so; none of it describes a real business, person or tax registration. You own the organisation and can change anything in it.
      </p>
      <div className="mt-6 grid gap-4">
        <Alert tone="warning" title="Synthetic data only">
          Every name ends in (synthetic), the organisation&apos;s name ends in (SYNTHETIC DATA), and registration numbers are made up. Do not use a demonstration organisation for real books. You can
          make up to {profiles.data?.perPerson ?? 3}.
        </Alert>
        {create.error ? <Alert title="Could not create the demonstration organisation">{create.error instanceof ApiError ? create.error.message : 'Try again.'}</Alert> : null}
        {profiles.error ? <Alert title="Could not load the demonstration companies">Try again.</Alert> : null}
      </div>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Demonstration companies">
        {(profiles.data?.profiles ?? []).map((p) => (
          <li key={p.key} data-testid={`demo-${p.key}`}>
            <Card className="flex h-full flex-col p-5">
              <h2 className="text-base font-semibold">{p.title}</h2>
              <p className="mt-1 text-xs text-fg-faint">{p.orgName}</p>
              <p className="mt-3 flex flex-wrap gap-1.5">
                <Badge tone="accent">{countryModule(p.countryCode).name}</Badge>
                <Badge>{p.currency}</Badge>
                {p.salesTax ? <Badge>{p.salesTax}</Badge> : null}
                {p.payroll ? <Badge tone="violet">Payroll</Badge> : null}
              </p>
              <p className="mt-3 flex-1 text-sm text-fg-muted">{p.summary}</p>
              <p className="mt-3 text-xs text-fg-faint">
                {p.customers} customers, {p.vendors} vendors, {p.projects} projects, {p.staff} staff
              </p>
              <Button
                className="mt-4 self-start"
                loading={create.isPending && create.variables === p.key}
                disabled={create.isPending}
                onClick={() => create.mutate(p.key)}
                aria-label={`Create the ${p.title} demonstration`}
              >
                Create this demo
              </Button>
            </Card>
          </li>
        ))}
      </ul>
      {create.isPending ? (
        <p role="status" className="mt-4 text-sm text-fg-muted">
          Posting six months of synthetic books through the ordinary services. This takes about half a minute.
        </p>
      ) : null}
      <p className="mt-8 text-sm">
        <Link className="text-accent hover:underline" href="/onboarding">
          Set up your own organisation instead
        </Link>
      </p>
    </main>
  );
}
