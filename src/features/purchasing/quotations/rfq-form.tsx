import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList, Plus, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect, SimpleSelect } from '@/components/common/pickers'
import { api, commands, type PendingRequisitionLine, type ProductRow, type RfqInput } from '@/lib/api'
import { PRIORITIES } from '@/lib/domain/catalog'
import type { Supplier } from '@/lib/domain/types'
import { addDays, qty, todayAR } from '@/lib/format'
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
  notes: string
}

/** Acepta "1.300,5" (es-AR) y "1300.5". */
const num = (s: string) => {
  const t = String(s).trim()
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? n : 0
}
const numInput = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',')

export function RfqFormPage() {
  const company = useCompany()
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
  if (!products.data || !suppliers.data || !pending.data)
    return <Loading error={products.error ?? suppliers.error ?? pending.error} />
  return <RfqForm products={products.data} suppliers={suppliers.data} pending={pending.data} />
}

function RfqForm({
  products,
  suppliers,
  pending,
}: {
  products: ProductRow[]
  suppliers: Supplier[]
  pending: PendingRequisitionLine[]
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [due, setDue] = useState(addDays(todayAR(), 5))
  const [warehouseId, setWarehouseId] = useState(company.warehouses[0]?.id ?? '')
  const [notes, setNotes] = useState('')
  const [invited, setInvited] = useState<string[]>([])
  const [lines, setLines] = useState<LineState[]>([])

  const active = suppliers.filter((s) => s.is_active)

  const addFromRequisition = (p: PendingRequisitionLine) => {
    setLines((ls) =>
      ls.some((l) => l.requisition_line_id === p.line.id)
        ? ls
        : [
            ...ls,
            {
              key: crypto.randomUUID(),
              product_id: p.product.id,
              requisition_line_id: p.line.id,
              requisition_label: p.requisition.display_number,
              max: p.pending,
              quantity: numInput(p.pending),
              notes: p.line.notes,
            },
          ],
    )
    // El proveedor habitual del producto queda invitado; se suman otros para comparar.
    const usual = p.product.default_supplier_id
    if (usual && active.some((s) => s.id === usual)) setInvited((ids) => (ids.includes(usual) ? ids : [...ids, usual]))
    if (p.product.default_warehouse_id) setWarehouseId(p.product.default_warehouse_id)
  }

  // ?sc=SC-00002 → precargar todas sus líneas pendientes
  useEffect(() => {
    const sc = params.get('sc')
    if (!sc) return
    pending.filter((p) => p.requisition.display_number === sc).forEach(addFromRequisition)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const toggleLine = (p: PendingRequisitionLine, checked: boolean) => {
    if (checked) addFromRequisition(p)
    else setLines((ls) => ls.filter((l) => l.requisition_line_id !== p.line.id))
  }
  const toggleSupplier = (id: string, checked: boolean) =>
    setInvited((ids) => (checked ? [...ids, id] : ids.filter((x) => x !== id)))

  const input = (): RfqInput => ({
    response_due: due,
    warehouse_id: warehouseId,
    notes,
    supplier_ids: invited,
    lines: lines.map((l) => ({
      product_id: l.product_id,
      quantity: num(l.quantity),
      requisition_line_id: l.requisition_line_id,
      notes: l.notes,
    })),
  })

  const save = useCommand((send: boolean) => commands.createRfq(company.companyId, input(), send), {
    success: (r) => `${r.display_number} guardada.`,
    onSuccess: (r) => navigate(company.docPath('RFQ', r.display_number)),
  })

  const byRequisition = new Map<string, PendingRequisitionLine[]>()
  for (const p of pending)
    byRequisition.set(p.requisition.display_number, [...(byRequisition.get(p.requisition.display_number) ?? []), p])

  const ready = lines.length > 0 && invited.length >= 2

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Compras' },
          { label: 'Solicitudes de cotización', to: company.docPath('RFQ') },
          { label: 'Nueva' },
        ]}
        title="Nueva solicitud de cotización"
        description="Antes de comprar, pedí precio a varios proveedores: qué necesitás, cuánto y hasta cuándo pueden responder."
      />

      <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
        <Section title="Solicitudes pendientes" description="Marcá los ítems que vas a cotizar." bodyClassName="p-0">
          {byRequisition.size === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No hay solicitudes pendientes. Podés pedir cotización igual agregando ítems a mano.
            </p>
          ) : (
            <div className="max-h-[560px] divide-y overflow-y-auto">
              {[...byRequisition.entries()].map(([label, items]) => (
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
                          onCheckedChange={(v) => toggleLine(p, v === true)}
                          aria-label={`Cotizar ${p.product.code} de ${label}`}
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

        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Section title="Plazo y entrega">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Responden hasta" required hint="Fecha límite para que manden su cotización.">
                  <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
                </Field>
                <Field label="Depósito de entrega" required>
                  <SimpleSelect
                    value={warehouseId}
                    onChange={setWarehouseId}
                    options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))}
                  />
                </Field>
                <Field label="Observaciones" className="sm:col-span-2">
                  <Input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Opcional: por ejemplo, calidad o marca pedida"
                  />
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
                        notes: '',
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
                  const p = products.find((x) => x.id === l.product_id)
                  const over = l.max != null && num(l.quantity) > l.max + 1e-9
                  return (
                    <div key={l.key} className="rounded-lg border p-3">
                      <div className="grid items-start gap-2 md:grid-cols-[1fr_120px]">
                        <div>
                          <ProductSelect
                            products={products.filter((x) => x.is_active)}
                            value={l.product_id}
                            disabled={!!l.requisition_line_id}
                            onChange={(id) => update(l.key, { product_id: id })}
                            aria-label="Producto"
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
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          value={l.notes}
                          onChange={(e) => update(l.key, { notes: e.target.value })}
                          placeholder="Especificación para el proveedor (opcional)"
                          aria-label="Especificación"
                          className="h-8 text-xs"
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">{p?.uom_code}</span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Quitar ítem"
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          </div>

          <aside className="flex flex-col gap-3">
            <Section
              title="Proveedores invitados"
              description="Al menos dos: la idea es comparar sus ofertas."
              bodyClassName="p-0"
            >
              <div className="max-h-[420px] divide-y overflow-y-auto">
                {active.map((s) => (
                  <label
                    key={s.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-muted/60',
                      invited.includes(s.id) && 'bg-brand-blue-soft/60',
                    )}
                  >
                    <Checkbox
                      checked={invited.includes(s.id)}
                      onCheckedChange={(v) => toggleSupplier(s.id, v === true)}
                      aria-label={`Invitar a ${s.legal_name}`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      {s.legal_name}
                      <span className="block text-xs text-muted-foreground">
                        {s.category} · {s.city}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Section>
            <Button size="lg" disabled={save.isPending || !ready} onClick={() => save.mutate([true])}>
              <Send /> Guardar y enviar a los proveedores
            </Button>
            <Button variant="outline" disabled={save.isPending || !ready} onClick={() => save.mutate([false])}>
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
