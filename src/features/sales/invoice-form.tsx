import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { ActionDialog } from '@/components/common/dialogs'
import { api, commands, type InvoiceableSalesOrder } from '@/lib/api'
import { money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function SalesInvoiceFormPage() {
  const company = useCompany()
  const { data, isLoading, error } = useQuery({
    queryKey: ['invoiceable-sales-orders', company.companyId],
    queryFn: () => api.invoiceableSalesOrders(company.companyId),
  })
  if (isLoading || !data) return <Loading error={error} />
  return <SalesInvoiceForm orders={data} />
}

const pendingOf = (order: InvoiceableSalesOrder | undefined) =>
  order ? Object.fromEntries(order.lines.map((l) => [l.line.id, String(l.pending).replace('.', ',')])) : {}

/** Qué significa cada letra para el cliente. */
const LETTER_HINT = {
  A: 'Factura A: el IVA va discriminado (responsable inscripto o monotributista).',
  B: 'Factura B: el IVA está incluido en los precios (exento o consumidor final).',
  C: 'Factura C: la empresa no es responsable inscripta y no factura IVA.',
} as const

function SalesInvoiceForm({ orders }: { orders: InvoiceableSalesOrder[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [orderId, setOrderId] = useState(
    () => orders.find((o) => o.order.display_number === params.get('pv'))?.order.id ?? '',
  )
  const order = orders.find((o) => o.order.id === orderId)
  const [notes, setNotes] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>(() => pendingOf(order))
  const [confirming, setConfirming] = useState(false)

  // Al elegir otro pedido, las cantidades vuelven a lo entregado sin facturar.
  const [loadedOrderId, setLoadedOrderId] = useState(orderId)
  if (order && orderId !== loadedOrderId) {
    setLoadedOrderId(orderId)
    setQuantities(pendingOf(order))
  }

  const parsed = useMemo(
    () => Object.fromEntries(Object.entries(quantities).map(([k, v]) => [k, Number(v.replace(',', '.')) || 0])),
    [quantities],
  )
  const totals = (order?.lines ?? []).reduce(
    (t, l) => {
      const net = round2((parsed[l.line.id] ?? 0) * l.line.unit_price)
      const tax = round2((net * l.line.vat_rate) / 100)
      return { subtotal: round2(t.subtotal + net), tax: round2(t.tax + tax), total: round2(t.total + net + tax) }
    },
    { subtotal: 0, tax: 0, total: 0 },
  )

  const save = useCommand(
    (register: boolean) =>
      commands.createSalesInvoice(
        company.companyId,
        {
          sales_order_id: orderId,
          notes,
          lines: (order?.lines ?? []).map((l) => ({ so_line_id: l.line.id, quantity: parsed[l.line.id] ?? 0 })),
        },
        register,
      ),
    {
      success: (r) => `${r.display_number} guardada.`,
      onSuccess: (r) => navigate(company.docPath('SALES_INVOICE', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Ventas' },
    { label: 'Facturas de venta', to: company.docPath('SALES_INVOICE') },
    { label: 'Nueva' },
  ]
  if (!orders.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Nueva factura de venta" />
        <EmptyState icon={ReceiptText} title="No hay entregas sin facturar">
          Se factura lo que ya salió del depósito: cuando Depósito despache un remito, el pedido va a aparecer acá.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Nueva factura de venta"
        description="Se factura lo entregado y todavía sin facturar, a los precios del pedido. Al registrarla recibe su número, genera el asiento de venta y la deuda del cliente."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Pedido">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Pedido de venta"
                required
                className="sm:col-span-2"
                hint={order ? LETTER_HINT[order.letter] : undefined}
              >
                <SimpleSelect
                  value={orderId}
                  onChange={setOrderId}
                  options={orders.map((o) => ({
                    value: o.order.id,
                    label: `${o.order.display_number} · ${o.order.customer_name} · factura ${o.letter}`,
                  }))}
                  placeholder="Elegí el pedido"
                />
              </Field>
              {order && (
                <Field label="Observaciones" className="sm:col-span-2">
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
                </Field>
              )}
            </div>
          </Section>
          {order && (
            <Section title="Lo que se factura" description="Como mucho, lo entregado menos lo ya facturado.">
              <div className="flex flex-col gap-2">
                {order.lines.map((l) => {
                  const value = parsed[l.line.id] ?? 0
                  const over = value > l.pending + 1e-9
                  return (
                    <div
                      key={l.line.id}
                      className="grid items-center gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_repeat(3,110px)_150px]"
                    >
                      <div className="text-sm">
                        <span className="font-mono text-xs font-semibold text-navy">{l.product.code}</span>{' '}
                        {l.product.name}
                      </div>
                      <div className="text-xs">
                        <div className="text-muted-foreground">Entregado</div>
                        <div className="tabular">{qty(l.line.qty_delivered, l.product.uom_code)}</div>
                      </div>
                      <div className="text-xs">
                        <div className="text-muted-foreground">Ya facturado</div>
                        <div className="tabular">{qty(l.invoiced)}</div>
                      </div>
                      <div className="text-xs">
                        <div className="text-muted-foreground">Precio unit.</div>
                        <div className="tabular">{money(l.line.unit_price)}</div>
                      </div>
                      <Field label="Se factura" error={over ? 'Supera lo entregado sin facturar' : undefined}>
                        <Input
                          inputMode="decimal"
                          value={quantities[l.line.id] ?? ''}
                          onChange={(e) => setQuantities((q) => ({ ...q, [l.line.id]: e.target.value }))}
                          className={cn('tabular text-right', value < l.pending && 'border-amber-400')}
                        />
                      </Field>
                    </div>
                  )
                })}
              </div>
            </Section>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="Totales">
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal neto</dt>
                <dd className="tabular">{money(totals.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">IVA</dt>
                <dd className="tabular">{money(totals.tax)}</dd>
              </div>
              <div className="flex justify-between border-t pt-1.5 text-base font-semibold text-navy">
                <dt>Total</dt>
                <dd className="tabular">{money(totals.total)}</dd>
              </div>
            </dl>
          </Section>
          <Button size="lg" disabled={!order || save.isPending} onClick={() => setConfirming(true)}>
            <ReceiptText /> Registrar factura
          </Button>
          <Button variant="outline" disabled={!order || save.isPending} onClick={() => save.mutate([false])}>
            Guardar borrador
          </Button>
          <Button variant="ghost" asChild>
            <Link to={company.docPath('SALES_INVOICE')}>Cancelar</Link>
          </Button>
        </aside>
      </div>
      {order && (
        <ActionDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Registrar factura"
          description={`Se emite la factura ${order.letter} a ${order.order.customer_name} por ${money(totals.total)}: recibe su número, se genera el asiento de venta y la deuda queda en la cuenta corriente del cliente.`}
          confirmLabel="Registrar"
          busy={save.isPending}
          onConfirm={() => save.mutate([true])}
        />
      )}
    </>
  )
}
