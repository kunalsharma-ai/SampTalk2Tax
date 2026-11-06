import { Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import { Money } from '@/components/money';
import type { SalesLine } from '@/lib/sales-orders';

type Line = SalesLine & { billed?: string; remaining?: string };

/** The fixed lines of a quotation or sales order; with billing figures for an order. */
export function SalesLinesTable({ lines, currency, subtotal, tax, total }: { lines: Line[]; currency: string; subtotal: string; tax: string; total: string }) {
  const billing = lines.some((l) => l.billed !== undefined);
  return (
    <Card>
      <CardHeader title="Lines" />
      <Table aria-label="Lines">
        <thead>
          <tr>
            <Th>#</Th><Th>Description</Th><Th>Account</Th><Th numeric>Qty</Th>
            {billing ? <><Th numeric>Billed</Th><Th numeric>Left</Th></> : null}
            <Th numeric>Unit price</Th><Th>Tax</Th><Th numeric>Amount</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <Tr key={l.id}>
              <Td className="text-fg-muted">{l.lineNo}</Td>
              <Td>{l.description ?? '—'}{l.hsnCode ? <span className="block text-xs text-fg-muted">HSN/SAC {l.hsnCode}</span> : null}</Td>
              <Td className="text-fg-muted">{l.account ? `${l.account.code} · ${l.account.name}` : '—'}</Td>
              <Td numeric className="num">{l.quantity}</Td>
              {billing ? <><Td numeric className="num">{l.billed}</Td><Td numeric className="num font-medium">{l.remaining}</Td></> : null}
              <Td numeric><Money value={l.unitPrice} currency={currency} /></Td>
              <Td className="text-fg-muted">{l.tax?.name ?? 'No tax'}</Td>
              <Td numeric><Money value={l.netAmount} currency={currency} />{Number(l.taxAmount) ? <p className="text-xs text-fg-muted">+ tax <Money value={l.taxAmount} currency={currency} /></p> : null}</Td>
            </Tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <Td colSpan={billing ? 8 : 6} className="text-right text-sm text-fg-muted"><p>Subtotal</p><p>Tax</p><p className="font-semibold text-fg">Total</p></Td>
            <Td numeric className="text-sm"><p><Money value={subtotal} currency={currency} /></p><p><Money value={tax} currency={currency} /></p><p className="font-semibold"><Money value={total} currency={currency} /></p></Td>
          </tr>
        </tfoot>
      </Table>
    </Card>
  );
}
