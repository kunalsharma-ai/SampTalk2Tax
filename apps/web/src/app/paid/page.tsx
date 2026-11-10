import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Payment received · Talk2Tax' };

/**
 * Where a customer lands after paying (or leaving) a payment link. Open to anyone and shows only
 * what the address carries: the books are updated from the gateway's own signed notice, not from
 * this page.
 */
export default async function PaidPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : null);
  const ref = one('ref');
  const reference = ref && /^PL-\d{4,}$/.test(ref) ? ref : null;
  const status = one('razorpay_payment_link_status');
  const paid = status === 'paid';
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4">
      <div className="w-full max-w-md rounded-[var(--t2t-radius-lg)] border border-line bg-surface p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-fg">{paid ? 'Thank you for your payment' : 'Payment link'}</h1>
        <p className="mt-3 text-sm text-fg-muted">
          {paid
            ? 'The payment gateway has your payment. The business you paid is told by the gateway directly, and your invoice is marked paid once they confirm it.'
            : 'If you completed the payment, the business you paid is told by the gateway directly. If you left before paying, open the link again to pay.'}
        </p>
        {reference ? <p className="mt-4 text-sm">Reference <span className="num font-medium">{reference}</span></p> : null}
        <p className="mt-6 text-xs text-fg-faint">You can close this page.</p>
      </div>
    </main>
  );
}
