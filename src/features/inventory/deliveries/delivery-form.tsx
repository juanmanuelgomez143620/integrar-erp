import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { PackageOpen, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { ActionDialog } from '@/components/common/dialogs'
import { api, commands, type DispatchableOrder } from '@/lib/api'
import { date, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

export function DeliveryFormPage() {
  const company = useCompany()
  const { data, isLoading, error } = useQuery({
    queryKey: ['dispatchable-orders', company.companyId],
    queryFn: () => api.dispatchableOrders(company.companyId),
  })
  if (isLoading || !data) return <Loading error={error} />
  return <DeliveryForm orders={data} />
}

const pendingOf = (order: DispatchableOrder | undefined) =>
  order ? Object.fromEntries(order.lines.map((l) => [l.line.id, String(l.pending).replace('.', ',')])) : {}

function DeliveryForm({ orders }: { orders: DispatchableOrder[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [orderId, setOrderId] = useState(
    () => orders.find((o) => o.order.display_number === params.get('pv'))?.order.id ?? '',
  )
  const order = orders.find((o) => o.order.id === orderId)
  const [carrier, setCarrier] = useState('')
  const [notes, setNotes] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>(() => pendingOf(order))
  const [confirming, setConfirming] = useState(false)

  // Al elegir otro pedido, las cantidades vuelven a lo que falta entregar (ajuste durante el render,
  // como en la recepción, para no mostrar primero el formulario vacío).
  const [loadedOrderId, setLoadedOrderId] = useState(orderId)
  if (order && orderId !== loadedOrderId) {
    setLoadedOrderId(orderId)
    setQuantities(pendingOf(order))
  }

  const parsed = useMemo(
    () => Object.fromEntries(Object.entries(quantities).map(([k, v]) => [k, Number(v.replace(',', '.')) || 0])),
    [quantities],
  )
  const partial = order?.lines.some((l) => (parsed[l.line.id] ?? 0) < l.pending - 1e-9)

  const save = useCommand(
    (confirm: boolean) =>
      commands.createDeliveryNote(
        company.companyId,
        {
          sales_order_id: orderId,
          carrier_name: carrier,
          notes,
          lines: (order?.lines ?? []).map((l) => ({ so_line_id: l.line.id, quantity: parsed[l.line.id] ?? 0 })),
        },
        confirm,
      ),
    {
      success: (r) => `${r.display_number} guardado.`,
      onSuccess: (r) => navigate(company.docPath('DELIVERY_NOTE', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Depósito' },
    { label: 'Remitos', to: company.docPath('DELIVERY_NOTE') },
    { label: 'Nuevo' },
  ]
  if (!orders.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Preparar remito" />
        <EmptyState icon={PackageOpen} title="No hay pedidos de venta para despachar">
          Sólo se despacha contra un pedido de venta confirmado. Cuando Ventas confirme uno, vas a tener una tarea en Mi
          trabajo.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Preparar remito"
        description="Prepará la mercadería reservada del pedido y controlala contra el remito. Al despacharlo baja el stock y se registra el costo de lo vendido."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Pedido y transporte">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pedido de venta" required className="sm:col-span-2">
                <SimpleSelect
                  value={orderId}
                  onChange={setOrderId}
                  options={orders.map((o) => ({
                    value: o.order.id,
                    label: `${o.order.display_number} · ${o.order.customer_name} · ${o.order.status_info.label}`,
                  }))}
                  placeholder="Elegí el pedido"
                />
              </Field>
              {order && (
                <>
                  <Field label="Transportista" hint="Quién lleva la mercadería (opcional).">
                    <Input
                      value={carrier}
                      onChange={(e) => setCarrier(e.target.value)}
                      placeholder="Transporte propio"
                      maxLength={80}
                    />
                  </Field>
                  <Field label="Observaciones">
                    <Input
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Embalaje, horario de entrega…"
                    />
                  </Field>
                </>
              )}
            </div>
          </Section>
          {order && (
            <Section
              title="Lo que sale"
              description={`Sale de ${order.warehouse.name}${order.order.so?.delivery_date ? ` · entrega pedida: ${date(order.order.so.delivery_date)}` : ''}`}
            >
              <div className="flex flex-col gap-2">
                {order.lines.map((l) => {
                  const value = parsed[l.line.id] ?? 0
                  const over = value > l.pending + 1e-9
                  const short = l.on_hand != null && value > l.on_hand + 1e-9
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
                        <div className="text-muted-foreground">Pedido</div>
                        <div className="tabular">{qty(l.line.quantity, l.product.uom_code)}</div>
                      </div>
                      <div className="text-xs">
                        <div className="text-muted-foreground">Falta entregar</div>
                        <div className="tabular font-semibold">{qty(l.pending)}</div>
                      </div>
                      <div className="text-xs">
                        <div className="text-muted-foreground">En el depósito</div>
                        <div className="tabular">{l.on_hand == null ? 'Servicio' : qty(l.on_hand)}</div>
                      </div>
                      <Field
                        label="Sale ahora"
                        error={over ? 'Supera lo que falta' : short ? 'No hay tanto en el depósito' : undefined}
                      >
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
              {partial && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Entrega parcial: el pedido quedará "Entregado parcialmente" y lo que falta sigue reservado.
                </p>
              )}
            </Section>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="Al despachar">
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
              <li>Baja el stock al costo promedio (PPP) y queda en el kardex.</li>
              <li>Se libera la reserva de lo que salió.</li>
              <li>Se registra el asiento del costo de lo vendido.</li>
              <li>Ventas recibe el aviso para facturar.</li>
            </ul>
          </Section>
          <Button size="lg" disabled={!order || save.isPending} onClick={() => setConfirming(true)}>
            <Truck /> Despachar
          </Button>
          <Button variant="outline" disabled={!order || save.isPending} onClick={() => save.mutate([false])}>
            Guardar en preparación
          </Button>
          <Button variant="ghost" asChild>
            <Link to={company.docPath('DELIVERY_NOTE')}>Cancelar</Link>
          </Button>
        </aside>
      </div>
      {order && (
        <ActionDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Despachar"
          description={`Salen ${order.lines
            .filter((l) => (parsed[l.line.id] ?? 0) > 0)
            .map((l) => `${qty(parsed[l.line.id], l.product.uom_code)} de ${l.product.code}`)
            .join(', ')} para ${order.order.customer_name}. ${order.order.display_number} quedará ${
            partial ? 'entregado parcialmente' : 'entregado'
          }.`}
          confirmLabel="Despachar y descontar del stock"
          busy={save.isPending}
          onConfirm={() => save.mutate([true])}
        />
      )}
    </>
  )
}
