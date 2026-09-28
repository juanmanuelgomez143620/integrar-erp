import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { PackageCheck, PackageOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { ActionDialog } from '@/components/common/dialogs'
import { api, commands, type ReceivableOrder } from '@/lib/api'
import { date, money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

export function ReceiptFormPage() {
  const company = useCompany()
  const { data, isLoading } = useQuery({ queryKey: ['receivable-orders', company.companyId], queryFn: () => api.receivableOrders(company.companyId) })
  if (isLoading || !data) return <Loading />
  return <ReceiptForm orders={data} />
}

function ReceiptForm({ orders }: { orders: ReceivableOrder[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [orderId, setOrderId] = useState(() => orders.find((o) => o.order.display_number === params.get('oc'))?.order.id ?? '')
  const order = orders.find((o) => o.order.id === orderId)
  const [note, setNote] = useState('')
  const [carrier, setCarrier] = useState('')
  const [notes, setNotes] = useState('')
  const [warehouseId, setWarehouseId] = useState(() => order?.order.po?.warehouse_id ?? company.warehouses[0]?.id ?? '')
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    order ? Object.fromEntries(order.lines.map((l) => [l.line.id, String(l.pending).replace('.', ',')])) : {},
  )
  const [confirming, setConfirming] = useState(false)

  // Cuando se elige otra orden de compra, reiniciamos depósito y cantidades con sus
  // valores por defecto. Se ajusta durante el render (no en un efecto aparte) para
  // no mostrar primero el formulario vacío y evitar una cascada extra de renders.
  const [loadedOrderId, setLoadedOrderId] = useState(orderId)
  if (order && orderId !== loadedOrderId) {
    setLoadedOrderId(orderId)
    setWarehouseId(order.order.po?.warehouse_id ?? company.warehouses[0]?.id ?? '')
    setQuantities(Object.fromEntries(order.lines.map((l) => [l.line.id, String(l.pending).replace('.', ',')])))
  }

  const parsed = useMemo(() => Object.fromEntries(Object.entries(quantities).map(([k, v]) => [k, Number(v.replace(',', '.')) || 0])), [quantities])
  const partial = order?.lines.some((l) => (parsed[l.line.id] ?? 0) < l.pending - 1e-9)

  const save = useCommand(
    (confirm: boolean) => commands.createGoodsReceipt(company.companyId, {
      purchase_order_id: orderId,
      warehouse_id: warehouseId,
      supplier_delivery_note: note,
      carrier_name: carrier,
      notes,
      lines: (order?.lines ?? []).map((l) => ({ po_line_id: l.line.id, quantity: parsed[l.line.id] ?? 0 })),
    }, confirm),
    { success: (r) => `${r.display_number} registrada.`, onSuccess: (r) => navigate(company.docPath('GOODS_RECEIPT', r.display_number)) },
  )

  if (!orders.length) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Depósito' }, { label: 'Recepciones', to: company.docPath('GOODS_RECEIPT') }, { label: 'Nueva' }]} title="Registrar recepción" />
        <EmptyState icon={PackageOpen} title="No hay órdenes de compra esperando mercadería">
          Sólo se recibe contra una orden de compra aprobada y enviada al proveedor. Cuando Compras envíe una, vas a tener una tarea en Mi trabajo.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Depósito' }, { label: 'Recepciones', to: company.docPath('GOODS_RECEIPT') }, { label: 'Nueva' }]}
        title="Registrar recepción de mercadería"
        description="Controlá lo que efectivamente llegó contra la orden de compra y el remito del proveedor. Sólo lo recibido ingresa al stock."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Orden de compra y remito">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Orden de compra" required className="sm:col-span-2">
                <SimpleSelect
                  value={orderId}
                  onChange={setOrderId}
                  options={orders.map((o) => ({ value: o.order.id, label: `${o.order.display_number} · ${o.order.supplier_name} · ${o.order.status_info.label}` }))}
                  placeholder="Elegí la orden de compra"
                />
              </Field>
              {order && (
                <>
                  <Field label="N.º de remito del proveedor" required hint="Figura en el remito que acompaña la mercadería.">
                    <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="0003-00004521" />
                  </Field>
                  <Field label="Transportista"><Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Opcional" /></Field>
                  <Field label="Depósito" required>
                    <SimpleSelect value={warehouseId} onChange={setWarehouseId} options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))} />
                  </Field>
                  <Field label="Observaciones"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Estado de la mercadería, faltantes…" /></Field>
                </>
              )}
            </div>
          </Section>
          {order && (
            <Section title="Cantidades recibidas" description={`Entrega comprometida: ${date(order.order.po?.expected_date)} · ${order.order.supplier_name}`}>
              <div className="flex flex-col gap-2">
                {order.lines.map((l) => {
                  const value = parsed[l.line.id] ?? 0
                  const over = value > l.pending + 1e-9
                  return (
                    <div key={l.line.id} className="grid items-center gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_repeat(3,110px)_150px]">
                      <div className="text-sm"><span className="font-mono text-xs font-semibold text-navy">{l.product.code}</span> {l.product.name}</div>
                      <div className="text-xs"><div className="text-muted-foreground">Ordenado</div><div className="tabular">{qty(l.line.quantity, l.product.uom_code)}</div></div>
                      <div className="text-xs"><div className="text-muted-foreground">Ya recibido</div><div className="tabular">{qty(l.line.qty_received)}</div></div>
                      <div className="text-xs"><div className="text-muted-foreground">Pendiente</div><div className="tabular font-semibold">{qty(l.pending)}</div></div>
                      <Field label="Recibido ahora" error={over ? 'Supera lo pendiente' : undefined}>
                        <Input inputMode="decimal" value={quantities[l.line.id] ?? ''} onChange={(e) => setQuantities((q) => ({ ...q, [l.line.id]: e.target.value }))} className={cn('tabular text-right', value < l.pending && 'border-amber-400')} />
                      </Field>
                    </div>
                  )
                })}
              </div>
              {partial && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Recepción parcial: la orden quedará "Recibida parcialmente" y se generará una tarea para recibir el saldo.</p>}
            </Section>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="Al confirmar">
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
              <li>Se suma el stock y se actualiza el costo promedio (PPP).</li>
              <li>Queda un movimiento en el kardex de cada producto.</li>
              <li>La orden de compra pasa a recibida (total o parcial).</li>
              <li>Compras y el sector solicitante reciben una notificación.</li>
            </ul>
          </Section>
          <Button size="lg" disabled={!order || save.isPending} onClick={() => setConfirming(true)}><PackageCheck /> Confirmar recepción</Button>
          <Button variant="outline" disabled={!order || save.isPending} onClick={() => save.mutate([false])}>Guardar borrador</Button>
          <Button variant="ghost" asChild><Link to={company.docPath('GOODS_RECEIPT')}>Cancelar</Link></Button>
        </aside>
      </div>
      {order && (
        <ActionDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Confirmar recepción"
          description={`Ingresarán al stock ${order.lines.filter((l) => (parsed[l.line.id] ?? 0) > 0).map((l) => `${qty(parsed[l.line.id], l.product.uom_code)} de ${l.product.code}`).join(', ')} por un valor de ${money(order.lines.reduce((s, l) => s + (parsed[l.line.id] ?? 0) * l.line.unit_price, 0))}. ${order.order.display_number} quedará ${partial ? 'recibida parcialmente' : 'recibida'}.`}
          confirmLabel="Confirmar e ingresar al stock"
          busy={save.isPending}
          onConfirm={() => save.mutate([true])}
        />
      )}
    </>
  )
}
