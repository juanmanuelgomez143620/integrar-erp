import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Info, Plus, Send, ShieldAlert, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect, SimpleSelect } from '@/components/common/pickers'
import { api, commands, type SalesCustomer, type SellableProduct } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import { addDays, money, parseAmount, qty, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

interface LineState {
  key: string
  product_id: string
  quantity: string
  unit_price: string
}

/** Cantidad: acepta "1,5" y "1.5" (en una cantidad, "1.500" puede ser 1,5 kg). */
const num = (s: string) => {
  const t = String(s).trim()
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? n : 0
}
/** Precio: además, los puntos de miles ("1.300.000"). */
const price = (s: string) => {
  const n = parseAmount(s)
  return Number.isFinite(n) ? n : 0
}
const numInput = (n: number) => String(Math.round(n * 10000) / 10000).replace('.', ',')
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Validez que se propone para un presupuesto (QUOTE_VALIDITY_DAYS en el motor). */
const QUOTE_VALIDITY_DAYS = 15

const newLine = (): LineState => ({ key: crypto.randomUUID(), product_id: '', quantity: '', unit_price: '' })

/** El precio que se propone: el de la lista del cliente o, si no lo tiene, el de venta del producto. */
const proposedPrice = (p: SellableProduct, customer: SalesCustomer | undefined) =>
  p.list_prices.find((x) => x.price_list_id === customer?.price_list?.id)?.unit_price ?? p.sale_price ?? 0

type Mode = 'order' | 'quote'

export function SalesOrderFormPage() {
  return <SalesDocumentFormPage mode="order" />
}

export function SalesQuoteFormPage() {
  return <SalesDocumentFormPage mode="quote" />
}

function SalesDocumentFormPage({ mode }: { mode: Mode }) {
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
  return <SalesDocumentForm mode={mode} customers={customers.data} catalog={catalog.data} />
}

function SalesDocumentForm({
  mode,
  customers,
  catalog,
}: {
  mode: Mode
  customers: SalesCustomer[]
  catalog: SellableProduct[]
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const quote = mode === 'quote'
  // El depósito que propone: donde hay más mercadería para vender.
  const [warehouseId, setWarehouseId] = useState(() => {
    const stockIn = (id: string) =>
      catalog.reduce((s, p) => s + (p.stock.find((x) => x.warehouse_id === id)?.on_hand ?? 0), 0)
    return [...company.warehouses].sort((a, b) => stockIn(b.id) - stockIn(a.id))[0]?.id ?? ''
  })
  const [customerId, setCustomerId] = useState('')
  const [terms, setTerms] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [validUntil, setValidUntil] = useState(() => addDays(todayAR(), QUOTE_VALIDITY_DAYS))
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineState[]>([newLine()])

  const customer = customers.find((c) => c.id === customerId)
  const productById = (id: string) => catalog.find((p) => p.id === id)
  const warehouse = company.warehouses.find((w) => w.id === warehouseId)
  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  /** Al cambiar de cliente se proponen los precios de su lista en los ítems que no se tocaron. */
  const changeCustomer = (id: string) => {
    const next = customers.find((x) => x.id === id)
    setCustomerId(id)
    if (next) setTerms(String(next.payment_terms_days))
    setLines((ls) =>
      ls.map((l) => {
        const p = productById(l.product_id)
        return p && price(l.unit_price) === proposedPrice(p, customer)
          ? { ...l, unit_price: numInput(proposedPrice(p, next)) }
          : l
      }),
    )
  }

  // Neto e IVA por ítem, redondeados como en el documento.
  const totals = lines.reduce(
    (t, l) => {
      const p = productById(l.product_id)
      if (!p) return t
      const net = round2(num(l.quantity) * price(l.unit_price))
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

  const input = () => ({
    customer_id: customerId,
    warehouse_id: warehouseId,
    payment_terms_days: Number(terms || 0),
    customer_reference: reference,
    notes,
    lines: lines
      .filter((l) => l.product_id)
      .map((l) => ({ product_id: l.product_id, quantity: num(l.quantity), unit_price: price(l.unit_price) })),
  })
  const save = useCommand(
    (go: boolean) =>
      quote
        ? commands.createSalesQuote(company.companyId, { ...input(), valid_until: validUntil }, go)
        : commands.createSalesOrder(company.companyId, { ...input(), delivery_date: deliveryDate || null }, go),
    {
      success: (r) => `${r.display_number} guardado.`,
      onSuccess: (r) => navigate(company.docPath(quote ? 'SALES_QUOTE' : 'SALES_ORDER', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Ventas' },
    quote
      ? { label: 'Presupuestos', to: company.docPath('SALES_QUOTE') }
      : { label: 'Pedidos de venta', to: company.docPath('SALES_ORDER') },
    { label: 'Nuevo' },
  ]
  const title = quote ? 'Nuevo presupuesto' : 'Nuevo pedido de venta'
  if (!customers.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title={title} />
        <EmptyState icon={Users} title="No hay clientes activos">
          Para vender, primero hay que dar de alta al cliente en Maestros → Clientes.
        </EmptyState>
      </>
    )
  }

  const ready = !!customerId && !!warehouseId && lines.some((l) => l.product_id) && (!quote || !!validUntil)

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={title}
        description={
          quote
            ? 'Cotizale al cliente lo que pide, con los precios de su lista y hasta cuándo vale la oferta. Si lo acepta, se genera el pedido de venta.'
            : 'Cargá lo que compra el cliente. Al confirmarlo se controlan el stock disponible y su crédito, y la mercadería queda reservada para la entrega.'
        }
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
                        customer.price_list ? `lista ${customer.price_list.name}` : 'precios de venta'
                      } · ${
                        customer.credit_limit == null
                          ? 'sin límite de crédito'
                          : `límite de crédito ${money(customer.credit_limit)}, usa ${money(customer.credit_used)}`
                      }`
                    : 'Se proponen su condición de pago y los precios de su lista.'
                }
              >
                <SimpleSelect
                  value={customerId}
                  onChange={changeCustomer}
                  options={customers.map((c) => ({ value: c.id, label: `${c.code} · ${c.legal_name}` }))}
                  placeholder="Elegí el cliente"
                />
              </Field>
              <Field
                label="Entrega desde"
                required
                hint={quote ? 'El depósito que pasa al pedido.' : 'Ahí se controla y se reserva el stock.'}
              >
                <SimpleSelect
                  value={warehouseId}
                  onChange={setWarehouseId}
                  options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))}
                />
              </Field>
              {quote ? (
                <Field label="Válido hasta" required hint={`Se proponen ${QUOTE_VALIDITY_DAYS} días.`}>
                  <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
                </Field>
              ) : (
                <Field label="Fecha de entrega pedida">
                  <Input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                </Field>
              )}
              <Field label="Condición de pago (días)" hint="0 = contado">
                <Input
                  inputMode="numeric"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
              <Field
                label="Referencia del cliente"
                hint={quote ? 'Por ejemplo, su pedido de precios.' : 'Por ejemplo, el número de su orden de compra.'}
              >
                <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
              </Field>
              <Field label="Observaciones" className="sm:col-span-2">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
              </Field>
            </div>
          </Section>

          <Section
            title="Ítems"
            description="Precios sin IVA: se propone el de la lista del cliente o, si no tiene, el precio de venta de cada producto."
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
                const unit = price(l.unit_price)
                const list = p ? proposedPrice(p, customer) : 0
                const stock = p?.stock.find((s) => s.warehouse_id === warehouseId)
                const short = !quote && !!p && p.is_stockable && q > (stock?.available ?? 0) + 1e-9
                const discount = list > 0 && unit > 0 && unit < list ? 1 - unit / list : 0
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
                          update(l.key, { product_id: id, unit_price: numInput(np ? proposedPrice(np, customer) : 0) })
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
                        {p &&
                          list > 0 &&
                          ` · ${customer?.price_list && list !== p.sale_price ? `precio de la lista ${customer.price_list.code}` : 'precio de venta'} ${money(list)}`}
                        {discount > 0 && (
                          <span className="text-amber-700"> · bonificación {Math.round(discount * 1000) / 10} %</span>
                        )}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="tabular font-medium text-foreground">{money(round2(q * unit))}</span>
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
            {quote ? (
              <div className="mt-3 flex gap-2 rounded-lg bg-brand-blue-soft/70 px-3 py-2 text-xs text-slate-700">
                <Info className="mt-0.5 size-4 shrink-0 text-brand-blue" />
                <span>
                  El presupuesto no reserva stock ni controla el crédito: eso pasa al confirmar el pedido que se genera
                  cuando el cliente lo acepta.
                </span>
              </div>
            ) : (
              customer && (
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
              )
            )}
          </Section>
          <Button size="lg" disabled={!ready || save.isPending} onClick={() => save.mutate([true])}>
            {quote ? (
              <>
                <Send /> Enviar al cliente
              </>
            ) : (
              <>
                <CheckCircle2 /> Confirmar pedido
              </>
            )}
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
