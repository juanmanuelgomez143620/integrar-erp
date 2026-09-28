import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect, SimpleSelect } from '@/components/common/pickers'
import { api, commands, type RequisitionInput } from '@/lib/api'
import { PRIORITIES } from '@/lib/domain/catalog'
import type { Priority } from '@/lib/domain/types'
import { qty } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

interface LineState {
  key: string
  product_id: string
  quantity: string
  notes: string
}

const newLine = (product_id = '', quantity = ''): LineState => ({ key: crypto.randomUUID(), product_id, quantity, notes: '' })

export function RequisitionFormPage() {
  const { number } = useParams()
  const company = useCompany()
  const editing = !!number
  const { data: products = [] } = useQuery({ queryKey: ['products', company.companyId], queryFn: () => api.products(company.companyId) })
  const { data: existing, isLoading } = useQuery({
    queryKey: ['document', company.companyId, 'PURCHASE_REQUISITION', number],
    queryFn: () => api.document(company.companyId, 'PURCHASE_REQUISITION', number!),
    enabled: editing,
  })
  if (!products.length || (editing && isLoading)) return <Loading />
  return <RequisitionForm products={products} existing={editing ? existing ?? null : null} />
}

function RequisitionForm({ products, existing }: {
  products: Awaited<ReturnType<typeof api.products>>
  existing: Awaited<ReturnType<typeof api.document>> | null
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const active = products.filter((p) => p.is_active)

  // Precarga desde una alerta de stock mínimo (?producto=MP-004): se calcula una
  // sola vez, al montar. Si fuera un efecto disparado por `products`, cada vez que
  // la lista se vuelva a consultar (por ejemplo tras guardar cualquier documento)
  // pisaría lo que el estudiante ya haya escrito en el formulario.
  const [preload] = useState(() => {
    if (existing) return null
    const code = params.get('producto')
    return code ? (products.find((x) => x.code === code) ?? null) : null
  })

  const [priority, setPriority] = useState<Priority>(existing?.doc.pr?.priority ?? (preload ? 'ALTA' : 'NORMAL'))
  const [neededBy, setNeededBy] = useState(existing?.doc.pr?.needed_by ?? '')
  const [reason, setReason] = useState(
    existing?.doc.pr?.reason ??
      (preload
        ? `Reposición: ${preload.code} ${preload.name} está por debajo del stock mínimo (hay ${qty(preload.stock, preload.uom_code)}, mínimo ${qty(preload.min_stock, preload.uom_code)}).`
        : ''),
  )
  const [notes, setNotes] = useState(existing?.doc.notes ?? '')
  const [lines, setLines] = useState<LineState[]>(() =>
    existing
      ? existing.lines.map((l) => ({ key: l.id, product_id: l.product.id, quantity: String(l.quantity), notes: l.notes }))
      : preload
        ? [newLine(preload.id, String(preload.reorder_qty ?? Math.max(preload.min_stock - preload.stock, 1)))]
        : [newLine()],
  )

  const input = (): RequisitionInput => ({
    needed_by: neededBy || null,
    priority,
    reason,
    notes,
    lines: lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity.replace(',', '.')), notes: l.notes })),
  })

  const save = useCommand(
    async (submit: boolean) => {
      if (existing) {
        await commands.updateRequisition(existing.doc.id, input())
        if (submit) await commands.submitRequisition(existing.doc.id)
        return existing.doc.display_number
      }
      return (await commands.createRequisition(company.companyId, input(), submit)).display_number
    },
    {
      success: (n) => `${n} guardada.`,
      onSuccess: (n) => navigate(company.docPath('PURCHASE_REQUISITION', n)),
    },
  )

  const update = (key: string, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Compras' },
          { label: 'Solicitudes de compra', to: company.docPath('PURCHASE_REQUISITION') },
          { label: existing ? existing.doc.display_number : 'Nueva' },
        ]}
        title={existing ? `Editar ${existing.doc.display_number}` : 'Nueva solicitud de compra'}
        description="Pedile a Compras lo que tu sector necesita. Justificá la necesidad: Compras decide cómo y a quién comprar."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-4">
          <Section title="Datos de la solicitud">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Prioridad">
                <SimpleSelect value={priority} onChange={setPriority} options={(Object.keys(PRIORITIES) as Priority[]).map((p) => ({ value: p, label: PRIORITIES[p] }))} />
              </Field>
              <Field label="Necesaria para" hint="Fecha en la que el sector necesita contar con los materiales.">
                <Input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
              </Field>
              <Field label="Motivo" required className="sm:col-span-2" hint="¿Para qué se necesita? Ej.: producción de 20 placares para el pedido de Hogar Colonial.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
              </Field>
              <Field label="Observaciones" className="sm:col-span-2">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
              </Field>
            </div>
          </Section>
          <Section title="Productos solicitados" actions={<Button size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, newLine()])}><Plus /> Agregar ítem</Button>}>
            <div className="flex flex-col gap-3">
              {lines.map((l, i) => {
                const p = products.find((x) => x.id === l.product_id)
                return (
                  <div key={l.key} className="grid items-start gap-2 rounded-lg border p-3 sm:grid-cols-[24px_1fr_140px_1fr_auto]">
                    <span className="pt-2 text-xs text-muted-foreground">{i + 1}</span>
                    <div>
                      <ProductSelect products={active} value={l.product_id} onChange={(id) => update(l.key, { product_id: id })} />
                      {p && p.is_stockable && (
                        <p className={p.below_min ? 'mt-1 text-xs text-red-700' : 'mt-1 text-xs text-muted-foreground'}>
                          Stock actual {qty(p.stock, p.uom_code)} · mínimo {qty(p.min_stock, p.uom_code)}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} placeholder="Cantidad" className="tabular text-right" />
                      <span className="w-9 text-xs text-muted-foreground">{p?.uom_code}</span>
                    </div>
                    <Input value={l.notes} onChange={(e) => update(l.key, { notes: e.target.value })} placeholder="Observaciones (opcional)" />
                    <Button variant="ghost" size="icon" aria-label="Quitar ítem" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button>
                  </div>
                )
              })}
            </div>
          </Section>
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="¿Qué pasa al enviarla?">
            <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
              <li>Compras recibe una tarea en <span className="font-medium text-foreground">Mi trabajo</span> y una notificación.</li>
              <li>Compras la incluye en una orden de compra a un proveedor, o la rechaza con motivo.</li>
              <li>Vas a ser notificado cuando el material ingrese al stock.</li>
            </ol>
          </Section>
          <Button size="lg" disabled={save.isPending} onClick={() => save.mutate([true])}><Send /> Guardar y enviar a Compras</Button>
          <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate([false])}>Guardar borrador</Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>Cancelar</Button>
        </aside>
      </div>
    </>
  )
}
