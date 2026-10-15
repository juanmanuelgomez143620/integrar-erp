import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList, Plus, Send, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect, SimpleSelect } from '@/components/common/pickers'
import {
  api,
  commands,
  type DocumentDetail,
  type PendingRequisitionLine,
  type ProductRow,
  type PurchaseOrderInput,
} from '@/lib/api'
import { PRIORITIES, ROLES, VAT_RATES } from '@/lib/domain/catalog'
import type { Supplier } from '@/lib/domain/types'
import { money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

interface LineState {
  key: string
  product_id: string
  requisition_line_id: string | null
  requisition_label: string | null
  max: number | null
  quantity: string
  unit_price: string
  vat_rate: number
}

/** Acepta "1.300,50" (es-AR) y "1300.50". */
const num = (s: string) => {
  const t = String(s).trim()
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? n : 0
}
const numInput = (n: number) => String(Math.round(n * 10000) / 10000).replace('.', ',')

export function OrderFormPage() {
  const { number } = useParams()
  const company = useCompany()
  const editing = !!number
  const products = useQuery({
    queryKey: ['products', company.companyId],
    queryFn: () => api.products(company.companyId),
  })
  const suppliers = useQuery({
    queryKey: ['suppliers', company.companyId],
    queryFn: () => api.suppliers(company.companyId),
  })
  const pending = useQuery({
    queryKey: ['pending-requisitions', company.companyId],
    queryFn: () => api.pendingRequisitionLines(company.companyId),
  })
  const existing = useQuery({
    queryKey: ['document', company.companyId, 'PURCHASE_ORDER', number],
    queryFn: () => api.document(company.companyId, 'PURCHASE_ORDER', number!),
    enabled: editing,
  })
  if (!products.data || !suppliers.data || !pending.data || (editing && !existing.data))
    return <Loading error={products.error ?? suppliers.error ?? pending.error ?? existing.error} />
  return (
    <OrderForm
      products={products.data}
      suppliers={suppliers.data}
      pending={pending.data}
      existing={existing.data ?? null}
    />
  )
}

function OrderForm({
  products,
  suppliers,
  pending,
  existing,
}: {
  products: ProductRow[]
  suppliers: Supplier[]
  pending: PendingRequisitionLine[]
  existing: DocumentDetail | null
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const defaultWarehouse = company.warehouses[0]?.id ?? ''

  const [supplierId, setSupplierId] = useState(existing?.doc.supplier_id ?? '')
  const [expected, setExpected] = useState(existing?.doc.po?.expected_date ?? '')
  const [warehouseId, setWarehouseId] = useState(existing?.doc.po?.warehouse_id ?? defaultWarehouse)
  const [terms, setTerms] = useState(String(existing?.doc.po?.payment_terms_days ?? 30))
  const [delivery, setDelivery] = useState(existing?.doc.po?.delivery_terms ?? 'Entrega en planta Eldorado')
  const [notes, setNotes] = useState(existing?.doc.notes ?? '')
  const [lines, setLines] = useState<LineState[]>(() =>
    existing
      ? existing.lines.map((l) => ({
          key: l.id,
          product_id: l.product.id,
          requisition_line_id: l.requisition_line_id ?? null,
          requisition_label: l.requisition_label ?? null,
          max: l.requisition_max ?? null,
          quantity: numInput(l.quantity),
          unit_price: numInput(l.unit_price ?? 0),
          vat_rate: l.vat_rate ?? 21,
        }))
      : [],
  )

  const productById = (id: string) => products.find((p) => p.id === id)

  const addFromRequisition = (p: PendingRequisitionLine) => {
    setLines((ls) => {
      if (ls.some((l) => l.requisition_line_id === p.line.id)) return ls
      return [
        ...ls,
        {
          key: crypto.randomUUID(),
          product_id: p.product.id,
          requisition_line_id: p.line.id,
          requisition_label: p.requisition.display_number,
          max: p.pending,
          quantity: numInput(p.pending),
          unit_price: numInput(productById(p.product.id)?.avg_cost ?? p.product.standard_cost),
          vat_rate: p.product.vat_rate,
        },
      ]
    })
    if (!supplierId && p.product.default_supplier_id) {
      setSupplierId(p.product.default_supplier_id)
      const s = suppliers.find((x) => x.id === p.product.default_supplier_id)
      if (s) setTerms(String(s.payment_terms_days))
    }
    if (p.product.default_warehouse_id) setWarehouseId(p.product.default_warehouse_id)
  }

  // ?sc=SC-00002 → precargar todas sus líneas pendientes
  useEffect(() => {
    const sc = params.get('sc')
    if (!sc || existing) return
    pending.filter((p) => p.requisition.display_number === sc).forEach(addFromRequisition)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const toggle = (p: PendingRequisitionLine, checked: boolean) => {
    if (checked) addFromRequisition(p)
    else setLines((ls) => ls.filter((l) => l.requisition_line_id !== p.line.id))
  }

  const totals = useMemo(() => {
    let subtotal = 0
    let tax = 0
    for (const l of lines) {
      const s = Math.round(num(l.quantity) * num(l.unit_price) * 100) / 100
      subtotal += s
      tax += Math.round(s * l.vat_rate) / 100
    }
    return { subtotal, tax, total: subtotal + tax }
  }, [lines])

  const rule = company.approval_rules
    .filter((r) => r.doc_type === 'PURCHASE_ORDER')
    .find((r) => totals.total >= r.min_amount && (r.max_amount == null || totals.total <= r.max_amount))

  const input = (): PurchaseOrderInput => ({
    supplier_id: supplierId,
    expected_date: expected || null,
    warehouse_id: warehouseId,
    payment_terms_days: Number(terms) || 0,
    delivery_terms: delivery,
    notes,
    lines: lines.map((l) => ({
      product_id: l.product_id,
      requisition_line_id: l.requisition_line_id,
      quantity: num(l.quantity),
      unit_price: num(l.unit_price),
      vat_rate: l.vat_rate,
    })),
  })

  const save = useCommand(
    async (submit: boolean) => {
      let id: string
      let display: string
      if (existing) {
        await commands.updatePurchaseOrder(existing.doc.id, input())
        id = existing.doc.id
        display = existing.doc.display_number
      } else {
        const r = await commands.createPurchaseOrder(company.companyId, input())
        id = r.id
        display = r.display_number
      }
      if (submit) await commands.submitPurchaseOrder(id)
      return display
    },
    { success: (n) => `${n} guardada.`, onSuccess: (n) => navigate(company.docPath('PURCHASE_ORDER', n)) },
  )

  const byRequisition = useMemo(() => {
    const map = new Map<string, PendingRequisitionLine[]>()
    for (const p of pending)
      map.set(p.requisition.display_number, [...(map.get(p.requisition.display_number) ?? []), p])
    return [...map.entries()]
  }, [pending])

  const supplier = suppliers.find((s) => s.id === supplierId)

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Compras' },
          { label: 'Órdenes de compra', to: company.docPath('PURCHASE_ORDER') },
          { label: existing ? existing.doc.display_number : 'Nueva' },
        ]}
        title={existing ? `Editar ${existing.doc.display_number}` : 'Nueva orden de compra'}
        description="Transformá las necesidades de los sectores en un compromiso formal con un proveedor: qué, cuánto, a qué precio, cuándo y dónde entregar."
      />

      <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
        {!existing && (
          <Section
            title="Solicitudes pendientes"
            description="Marcá los ítems que vas a comprar a este proveedor."
            bodyClassName="p-0"
          >
            {byRequisition.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No hay solicitudes pendientes. Podés armar una orden igual agregando ítems a mano.
              </p>
            ) : (
              <div className="max-h-[560px] divide-y overflow-y-auto">
                {byRequisition.map(([label, items]) => (
                  <div key={label} className="p-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 font-mono text-sm font-semibold text-navy">
                        <ClipboardList className="size-3.5" />
                        {label}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {items[0].requisition.sector_name} · {PRIORITIES[items[0].requisition.pr!.priority]}
                      </span>
                    </div>
                    <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">{items[0].requisition.pr?.reason}</p>
                    {items.map((p) => {
                      const checked = lines.some((l) => l.requisition_line_id === p.line.id)
                      return (
                        <label
                          key={p.line.id}
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/60',
                            checked && 'bg-brand-blue-soft/60',
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => toggle(p, v === true)}
                            className="mt-0.5"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="font-mono text-xs font-semibold">{p.product.code}</span> {p.product.name}
                            <span className="block text-xs text-muted-foreground">
                              Pendiente: {qty(p.pending, p.product.uom_code)}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        <div className={cn('grid gap-4 lg:grid-cols-[1fr_300px]', existing && 'xl:col-span-2')}>
          <div className="flex min-w-0 flex-col gap-4">
            <Section title="Proveedor y condiciones">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Proveedor"
                  required
                  className="sm:col-span-2"
                  hint={
                    supplier
                      ? `${supplier.category} · entrega habitual en ${supplier.lead_time_days ?? '—'} días · ${supplier.city}`
                      : 'Se sugiere el proveedor habitual del primer producto.'
                  }
                >
                  <SimpleSelect
                    value={supplierId}
                    onChange={(v) => {
                      setSupplierId(v)
                      const s = suppliers.find((x) => x.id === v)
                      if (s) setTerms(String(s.payment_terms_days))
                    }}
                    options={suppliers
                      .filter((s) => s.is_active)
                      .map((s) => ({ value: s.id, label: `${s.code} · ${s.legal_name}` }))}
                    placeholder="Elegí el proveedor"
                  />
                </Field>
                <Field label="Fecha de entrega comprometida">
                  <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
                </Field>
                <Field label="Depósito de destino" required>
                  <SimpleSelect
                    value={warehouseId}
                    onChange={setWarehouseId}
                    options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))}
                  />
                </Field>
                <Field label="Condición de pago (días)" hint="0 = contado">
                  <Input
                    inputMode="numeric"
                    value={terms}
                    onChange={(e) => setTerms(e.target.value.replace(/\D/g, ''))}
                  />
                </Field>
                <Field label="Condiciones de entrega">
                  <Input value={delivery} onChange={(e) => setDelivery(e.target.value)} />
                </Field>
                <Field label="Observaciones" className="sm:col-span-2">
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
                </Field>
              </div>
            </Section>

            <Section
              title="Ítems"
              actions={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setLines((ls) => [
                      ...ls,
                      {
                        key: crypto.randomUUID(),
                        product_id: '',
                        requisition_line_id: null,
                        requisition_label: null,
                        max: null,
                        quantity: '',
                        unit_price: '',
                        vat_rate: 21,
                      },
                    ])
                  }
                >
                  <Plus /> Ítem sin solicitud
                </Button>
              }
            >
              {lines.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Marcá ítems de las solicitudes pendientes o agregá un ítem a mano.
                </p>
              )}
              <div className="flex flex-col gap-3">
                {lines.map((l) => {
                  const p = productById(l.product_id)
                  const q = num(l.quantity)
                  const over = l.max != null && q > l.max + 1e-9
                  return (
                    <div key={l.key} className="rounded-lg border p-3">
                      <div className="grid items-start gap-2 md:grid-cols-[1fr_120px_140px_90px]">
                        <div>
                          <ProductSelect
                            products={products.filter((x) => x.is_active)}
                            value={l.product_id}
                            disabled={!!l.requisition_line_id}
                            onChange={(id) => {
                              const np = productById(id)
                              update(l.key, {
                                product_id: id,
                                unit_price: numInput(np?.avg_cost ?? 0),
                                vat_rate: np?.vat_rate ?? 21,
                              })
                            }}
                          />
                          {l.requisition_label && (
                            <p className="mt-1 text-xs text-brand-blue">
                              Atiende {l.requisition_label}
                              {l.max != null ? ` · pendiente ${qty(l.max, p?.uom_code)}` : ''}
                            </p>
                          )}
                        </div>
                        <Field label="Cantidad" error={over ? 'Supera lo pendiente' : undefined}>
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
                        <Field label="IVA">
                          <SimpleSelect
                            value={String(l.vat_rate)}
                            onChange={(v) => update(l.key, { vat_rate: Number(v) })}
                            options={VAT_RATES.map((r) => ({
                              value: String(r),
                              label: `${String(r).replace('.', ',')} %`,
                            }))}
                          />
                        </Field>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                        <span>{p ? `${p.uom_code} · último costo ${money(p.avg_cost)}` : ''}</span>
                        <span className="flex items-center gap-3">
                          <span className="tabular font-medium text-foreground">{money(q * num(l.unit_price))}</span>
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
              {rule && lines.length > 0 && (
                <div className="mt-3 flex gap-2 rounded-lg bg-brand-blue-soft/70 px-3 py-2 text-xs text-slate-700">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-blue" />
                  <span>
                    La aprueba <span className="font-semibold">{ROLES[rule.approver_role].name}</span>.{' '}
                    {rule.description}
                  </span>
                </div>
              )}
            </Section>
            <Button size="lg" disabled={save.isPending || !lines.length} onClick={() => save.mutate([true])}>
              <Send /> Guardar y enviar a aprobación
            </Button>
            <Button variant="outline" disabled={save.isPending || !lines.length} onClick={() => save.mutate([false])}>
              Guardar borrador
            </Button>
            <Button variant="ghost" onClick={() => navigate(-1)}>
              Cancelar
            </Button>
          </aside>
        </div>
      </div>
    </>
  )
}
