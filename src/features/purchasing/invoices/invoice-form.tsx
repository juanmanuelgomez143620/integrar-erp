import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { ActionDialog } from '@/components/common/dialogs'
import { api, commands, type InvoiceableOrder } from '@/lib/api'
import { addDays, date, money, qty, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const number = (s: string) => Number(s.trim().replace(',', '.')) || 0
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function InvoiceFormPage() {
  const company = useCompany()
  const orders = useQuery({
    queryKey: ['invoiceable-orders', company.companyId],
    queryFn: () => api.invoiceableOrders(company.companyId),
  })
  const suppliers = useQuery({
    queryKey: ['suppliers', company.companyId],
    queryFn: () => api.suppliers(company.companyId),
  })
  if (!orders.data || !suppliers.data) return <Loading error={orders.error ?? suppliers.error} />
  return <InvoiceForm orders={orders.data} suppliers={suppliers.data} />
}

function InvoiceForm({
  orders,
  suppliers,
}: {
  orders: InvoiceableOrder[]
  suppliers: Awaited<ReturnType<typeof api.suppliers>>
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [orderId, setOrderId] = useState(
    () => orders.find((o) => o.order.display_number === params.get('oc'))?.order.id ?? '',
  )
  const order = orders.find((o) => o.order.id === orderId)
  const supplier = suppliers.find((s) => s.id === order?.order.supplier_id)
  const letter = supplier?.vat_condition === 'RESPONSABLE_INSCRIPTO' ? 'A' : 'C'
  // El vencimiento sale del plazo de pago pactado en la orden de compra.
  const terms = order?.order.po?.payment_terms_days ?? 0
  const [pos, setPos] = useState('')
  const [num, setNum] = useState('')
  const [issued, setIssued] = useState(todayAR())
  const [notes, setNotes] = useState('')
  // La percepción de ingresos brutos que cobra el proveedor, si la hay (Fase 7b).
  const [perception, setPerception] = useState('')
  const defaults = (o: InvoiceableOrder | undefined) =>
    Object.fromEntries(
      (o?.lines ?? []).map((l) => [
        l.line.id,
        { quantity: String(l.pending).replace('.', ','), price: String(l.line.unit_price).replace('.', ',') },
      ]),
    )
  const [values, setValues] = useState<Record<string, { quantity: string; price: string }>>(() => defaults(order))
  const [confirming, setConfirming] = useState(false)

  // Al elegir otra orden se cargan sus cantidades pendientes de facturar y sus precios.
  const [loadedOrderId, setLoadedOrderId] = useState(orderId)
  if (order && orderId !== loadedOrderId) {
    setLoadedOrderId(orderId)
    setValues(defaults(order))
  }

  const rows = (order?.lines ?? []).map((l) => {
    const v = values[l.line.id] ?? { quantity: '', price: '' }
    const quantity = number(v.quantity)
    const price = number(v.price)
    const subtotal = round2(quantity * price)
    const tax = letter === 'A' ? round2((subtotal * l.line.vat_rate) / 100) : 0
    return { ...l, quantity, price, subtotal, tax }
  })
  const subtotal = round2(rows.reduce((s, r) => s + r.subtotal, 0))
  const tax = round2(rows.reduce((s, r) => s + r.tax, 0))
  const perceived = perception.trim() ? number(perception) : 0
  const total = round2(subtotal + tax + (perceived || 0))

  const save = useCommand(
    (register: boolean) =>
      commands.createSupplierInvoice(
        company.companyId,
        {
          purchase_order_id: orderId,
          point_of_sale: pos,
          invoice_number: num,
          document_date: issued,
          notes,
          lines: rows.map((r) => ({ po_line_id: r.line.id, quantity: r.quantity, unit_price: r.price })),
          perception: perceived,
        },
        register,
      ),
    {
      success: (r) => `${r.display_number} guardada.`,
      onSuccess: (r) => navigate(company.docPath('SUPPLIER_INVOICE', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Compras' },
    { label: 'Facturas de proveedores', to: company.docPath('SUPPLIER_INVOICE') },
    { label: 'Nueva' },
  ]
  if (!orders.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Registrar factura de proveedor" />
        <EmptyState icon={FileText} title="No hay mercadería recibida sin facturar">
          La factura se controla contra la orden de compra y lo que efectivamente llegó: cuando Depósito registre una
          recepción, la orden va a aparecer acá.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Registrar factura de proveedor"
        description="Control por oposición: se factura lo recibido (no lo pedido) y al precio pactado en la orden de compra. Si el proveedor cobra otro precio, la diferencia queda a la vista."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Orden de compra y comprobante del proveedor">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label="Orden de compra" required className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
                <SimpleSelect
                  value={orderId}
                  onChange={setOrderId}
                  options={orders.map((o) => ({
                    value: o.order.id,
                    label: `${o.order.display_number} · ${o.order.supplier_name}`,
                  }))}
                  placeholder="Elegí la orden de compra"
                />
              </Field>
              {order && supplier && (
                <>
                  <div className="rounded-lg bg-muted/60 px-3 py-2 text-sm sm:col-span-2 lg:col-span-1 xl:col-span-2">
                    <span className="font-semibold">Factura {letter}</span> ·{' '}
                    {letter === 'A'
                      ? 'el proveedor es responsable inscripto: el IVA va discriminado y es crédito fiscal.'
                      : 'el proveedor no es responsable inscripto: el IVA no se discrimina y forma parte del costo.'}
                  </div>
                  <Field label="Punto de venta" required hint="Por ejemplo, 00003.">
                    <Input value={pos} onChange={(e) => setPos(e.target.value)} inputMode="numeric" maxLength={5} />
                  </Field>
                  <Field label="Número" required hint="Por ejemplo, 00012874.">
                    <Input value={num} onChange={(e) => setNum(e.target.value)} inputMode="numeric" maxLength={8} />
                  </Field>
                  <Field
                    label="Fecha de emisión"
                    required
                    hint={`Vence el ${date(addDays(issued || todayAR(), terms))} (${
                      terms ? `${terms} días` : 'contado'
                    }, según la orden de compra).`}
                  >
                    <Input type="date" value={issued} max={todayAR()} onChange={(e) => setIssued(e.target.value)} />
                  </Field>
                  <Field label="Observaciones">
                    <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
                  </Field>
                </>
              )}
            </div>
          </Section>
          {order && (
            <Section
              title="Lo que factura el proveedor"
              description="Cantidades pendientes de facturar: lo recibido menos lo ya facturado."
            >
              <div className="flex flex-col gap-2">
                {rows.map((r) => {
                  const over = r.quantity > r.pending + 1e-9
                  const priceDiff = round2(r.price - r.line.unit_price)
                  return (
                    <div
                      key={r.line.id}
                      className="grid items-start gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_120px_140px] lg:grid-cols-1 xl:grid-cols-[1fr_120px_140px]"
                    >
                      <div className="text-sm">
                        <span className="font-mono text-xs font-semibold text-navy">{r.product.code}</span>{' '}
                        {r.product.name}
                        <div className="mt-1 text-xs text-muted-foreground">
                          Recibido {qty(r.line.qty_received, r.product.uom_code)} · facturado {qty(r.invoiced)} ·
                          pendiente <span className="font-semibold text-foreground">{qty(r.pending)}</span>
                        </div>
                      </div>
                      <Field label="Cantidad" error={over ? 'Supera lo pendiente' : undefined}>
                        <Input
                          inputMode="decimal"
                          value={values[r.line.id]?.quantity ?? ''}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [r.line.id]: { ...v[r.line.id], quantity: e.target.value } }))
                          }
                          className="tabular text-right"
                        />
                      </Field>
                      <Field
                        label="Precio unitario"
                        hint={
                          priceDiff
                            ? `OC: ${money(r.line.unit_price)} (${priceDiff > 0 ? '+' : ''}${money(priceDiff)})`
                            : 'Igual a la OC'
                        }
                      >
                        <Input
                          inputMode="decimal"
                          value={values[r.line.id]?.price ?? ''}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [r.line.id]: { ...v[r.line.id], price: e.target.value } }))
                          }
                          className={cn('tabular text-right', priceDiff && 'border-amber-400')}
                        />
                      </Field>
                    </div>
                  )
                })}
              </div>
              <div className="mt-4 ml-auto grid w-full max-w-xs gap-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal neto</span>
                  <span className="tabular">{money(subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">IVA {letter === 'A' ? '' : '(no discriminado)'}</span>
                  <span className="tabular">{money(tax)}</span>
                </div>
                <Field
                  label="Percepción de ingresos brutos"
                  hint="Si el proveedor la cobra en la factura: se descuenta del impuesto del mes."
                  error={!(perceived >= 0) ? 'Un importe de cero o más.' : undefined}
                >
                  <Input
                    inputMode="decimal"
                    value={perception}
                    onChange={(e) => setPerception(e.target.value)}
                    placeholder="0,00"
                    className="tabular text-right"
                  />
                </Field>
                <div className="flex justify-between border-t pt-1 font-semibold text-navy">
                  <span>Total</span>
                  <span className="tabular">{money(total)}</span>
                </div>
              </div>
            </Section>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="Al registrar">
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
              <li>Se controla otra vez que no se facture más de lo recibido.</li>
              <li>Se genera el asiento de compra en el libro diario (imputación automática).</li>
              <li>La deuda queda en la cuenta corriente del proveedor, con su vencimiento.</li>
            </ul>
          </Section>
          <Button size="lg" disabled={!order || save.isPending} onClick={() => setConfirming(true)}>
            <ReceiptText /> Registrar factura
          </Button>
          <Button variant="outline" disabled={!order || save.isPending} onClick={() => save.mutate([false])}>
            Guardar borrador
          </Button>
          <Button variant="ghost" asChild>
            <Link to={company.docPath('SUPPLIER_INVOICE')}>Cancelar</Link>
          </Button>
        </aside>
      </div>
      {order && (
        <ActionDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Registrar factura"
          description={`Factura ${letter} de ${order.order.supplier_name} por ${money(total)}. Se genera el asiento de compra y la deuda con el proveedor.`}
          confirmLabel="Registrar"
          busy={save.isPending}
          onConfirm={() => save.mutate([true])}
        />
      )}
    </>
  )
}
