import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Plus, ShieldAlert, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect, SimpleSelect } from '@/components/common/pickers'
import { api, commands, type SalesCustomer, type SellableProduct } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import { money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

interface LineState {
  key: string
  product_id: string
  quantity: string
  unit_price: string
}

/** Acepta "1.300,50" (es-AR) y "1300.50". */
const num = (s: string) => {
  const t = String(s).trim()
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? n : 0
}
const numInput = (n: number) => String(Math.round(n * 10000) / 10000).replace('.', ',')
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

const newLine = (): LineState => ({ key: crypto.randomUUID(), product_id: '', quantity: '', unit_price: '' })

export function SalesOrderFormPage() {
  const company = useCompany()
  const customers = useQuery({
    queryKey: ['sales-customers', company.companyId],
    queryFn: () => api.salesCustomers(company.companyId),
  })
  const catalog = useQuery({
    queryKey: ['sales-catalog', company.companyId],
    queryFn: () => api.salesCatalog(company.companyId),
  })
  if (!customers.data || !catalog.data) return <Loading error={customers.error ?? catalog.error} />
  return <SalesOrderForm customers={customers.data} catalog={catalog.data} />
}

function SalesOrderForm({ customers, catalog }: { customers: SalesCustomer[]; catalog: SellableProduct[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  // El depósito que propone: donde hay más mercadería para vender.
  const [warehouseId, setWarehouseId] = useState(() => {
    const stockIn = (id: string) =>
      catalog.reduce((s, p) => s + (p.stock.find((x) => x.warehouse_id === id)?.on_hand ?? 0), 0)
    return [...company.warehouses].sort((a, b) => stockIn(b.id) - stockIn(a.id))[0]?.id ?? ''
  })
  const [customerId, setCustomerId] = useState('')
  const [terms, setTerms] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineState[]>([newLine()])

  const customer = customers.find((c) => c.id === customerId)
  const productById = (id: string) => catalog.find((p) => p.id === id)
  const warehouse = company.warehouses.find((w) => w.id === warehouseId)
  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  // Neto e IVA por ítem, redondeados como en el pedido.
  const totals = lines.reduce(
    (t, l) => {
      const p = productById(l.product_id)
      if (!p) return t
      const net = round2(num(l.quantity) * num(l.unit_price))
      const tax = round2((net * p.vat_rate) / 100)
      return {
        subtotal: round2(t.subtotal + net),
        tax: round2(t.tax + tax),
        total: round2(t.total + net + tax),
      }
    },
    { subtotal: 0, tax: 0, total: 0 },
  )

  const used = customer ? customer.credit_used + totals.total : 0
  const overCredit = !!customer && customer.credit_limit != null && used > customer.credit_limit + 1e-9

  const save = useCommand(
    (confirm: boolean) =>
      commands.createSalesOrder(
        company.companyId,
        {
          customer_id: customerId,
          warehouse_id: warehouseId,
          delivery_date: deliveryDate || null,
          payment_terms_days: Number(terms || 0),
          customer_reference: reference,
          notes,
          lines: lines
            .filter((l) => l.product_id)
            .map((l) => ({ product_id: l.product_id, quantity: num(l.quantity), unit_price: num(l.unit_price) })),
        },
        confirm,
      ),
    {
      success: (r) => `${r.display_number} guardado.`,
      onSuccess: (r) => navigate(company.docPath('SALES_ORDER', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Ventas' },
    { label: 'Pedidos de venta', to: company.docPath('SALES_ORDER') },
    { label: 'Nuevo' },
  ]
  if (!customers.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Nuevo pedido de venta" />
        <EmptyState icon={Users} title="No hay clientes activos">
          Para vender, primero hay que dar de alta al cliente en Maestros → Clientes.
        </EmptyState>
      </>
    )
  }

  const ready = !!customerId && !!warehouseId && lines.some((l) => l.product_id)

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Nuevo pedido de venta"
        description="Cargá lo que compra el cliente. Al confirmarlo se controlan el stock disponible y su crédito, y la mercadería queda reservada para la entrega."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Cliente y condiciones">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Cliente"
                required
                className="sm:col-span-2"
                hint={
                  customer
                    ? `${VAT_CONDITIONS[customer.vat_condition]} · ${
                        customer.credit_limit == null
                          ? 'sin límite de crédito'
                          : `límite de crédito ${money(customer.credit_limit)}, usa ${money(customer.credit_used)}`
                      }`
                    : 'Se propone su condición de pago.'
                }
              >
                <SimpleSelect
                  value={customerId}
                  onChange={(v) => {
                    setCustomerId(v)
                    const c = customers.find((x) => x.id === v)
                    if (c) setTerms(String(c.payment_terms_days))
                  }}
                  options={customers.map((c) => ({ value: c.id, label: `${c.code} · ${c.legal_name}` }))}
                  placeholder="Elegí el cliente"
                />
              </Field>
              <Field label="Entrega desde" required hint="Ahí se controla y se reserva el stock.">
                <SimpleSelect
                  value={warehouseId}
                  onChange={setWarehouseId}
                  options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))}
                />
              </Field>
              <Field label="Fecha de entrega pedida">
                <Input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
              </Field>
              <Field label="Condición de pago (días)" hint="0 = contado">
                <Input
                  inputMode="numeric"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
              <Field label="Referencia del cliente" hint="Por ejemplo, el número de su orden de compra.">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
              </Field>
              <Field label="Observaciones" className="sm:col-span-2">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
              </Field>
            </div>
          </Section>

          <Section
            title="Ítems"
            description="Precios sin IVA: se propone el precio de venta de cada producto."
            actions={
              <Button size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus /> Agregar ítem
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {lines.map((l) => {
                const p = productById(l.product_id)
                const q = num(l.quantity)
                const price = num(l.unit_price)
                const stock = p?.stock.find((s) => s.warehouse_id === warehouseId)
                const short = !!p && p.is_stockable && q > (stock?.available ?? 0) + 1e-9
                const discount = p?.sale_price && price > 0 && price < p.sale_price ? 1 - price / p.sale_price : 0
                return (
                  <div key={l.key} className="rounded-lg border p-3">
                    <div className="grid items-start gap-2 md:grid-cols-[1fr_120px_150px]">
                      <ProductSelect
                        products={catalog.filter(
                          (x) => x.id === l.product_id || !lines.some((other) => other.product_id === x.id),
                        )}
                        value={l.product_id}
                        aria-label="Producto"
                        onChange={(id) => {
                          const np = productById(id)
                          update(l.key, { product_id: id, unit_price: numInput(np?.sale_price ?? 0) })
                        }}
                      />
                      <Field
                        label="Cantidad"
                        error={short ? `Hay ${qty(Math.max(stock?.available ?? 0, 0))} disponibles` : undefined}
                      >
                        <Input
                          inputMode="decimal"
                          value={l.quantity}
                          onChange={(e) => update(l.key, { quantity: e.target.value })}
                          className="tabular text-right"
                        />
                      </Field>
                      <Field label="Precio unit. (neto)">
                        <Input
                          inputMode="decimal"
                          value={l.unit_price}
                          onChange={(e) => update(l.key, { unit_price: e.target.value })}
                          className="tabular text-right"
                        />
                      </Field>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {p &&
                          (p.is_stockable
                            ? `Disponible en ${warehouse?.name ?? 'el depósito'}: ${qty(Math.max(stock?.available ?? 0, 0), p.uom_code)}${stock?.reserved ? ` (hay ${qty(stock.on_hand)} y ${qty(stock.reserved)} están reservados)` : ''}`
                            : 'Servicio: no lleva stock')}
                        {p?.sale_price != null && ` · precio de venta ${money(p.sale_price)}`}
                        {discount > 0 && (
                          <span className="text-amber-700"> · bonificación {Math.round(discount * 1000) / 10} %</span>
                        )}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="tabular font-medium text-foreground">{money(round2(q * price))}</span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Quitar ítem"
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>
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
            {customer && (
              <div
                className={cn(
                  'mt-3 flex gap-2 rounded-lg px-3 py-2 text-xs',
                  overCredit ? 'bg-amber-50 text-amber-900' : 'bg-brand-blue-soft/70 text-slate-700',
                )}
              >
                {overCredit ? (
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand-blue" />
                )}
                <span>
                  {overCredit
                    ? `Con este pedido usaría ${money(used)} de su crédito de ${money(customer.credit_limit)}: al confirmarlo va a Gerencia para que lo autorice.`
                    : customer.credit_limit == null
                      ? 'El cliente no tiene límite de crédito.'
                      : `Dentro del crédito: usaría ${money(used)} de ${money(customer.credit_limit)}.`}
                </span>
              </div>
            )}
          </Section>
          <Button size="lg" disabled={!ready || save.isPending} onClick={() => save.mutate([true])}>
            <CheckCircle2 /> Confirmar pedido
          </Button>
          <Button variant="outline" disabled={!ready || save.isPending} onClick={() => save.mutate([false])}>
            Guardar borrador
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancelar
          </Button>
        </aside>
      </div>
    </>
  )
}
