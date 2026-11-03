'use client';
import Link from 'next/link';
import { useOrg } from '@/lib/org';

/** "Settings → Integrations", linking to where owners and admins set up AI and email. */
export function IntegrationsLink() {
  const { orgId } = useOrg();
  return (
    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/settings/integrations`}>
      Settings → Integrations
    </Link>
  );
}
