import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Factory, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { api, commands, type ProducibleProduct } from '@/lib/api'
import { money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const head = 'h-9 text-xs font-semibold text-slate-600'
const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000

/** Cantidad escrita por el estudiante: "10", "2,5" o "2.5". */
const quantityOf = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : Number.NaN
}

/** El depósito de los materiales que más se repite entre los componentes (o el primero de la empresa). */
function materialsWarehouseOf(p: ProducibleProduct, fallback: string) {
  const counts = new Map<string, number>()
  for (const c of p.components)
    if (c.component.default_warehouse_id)
      counts.set(c.component.default_warehouse_id, (counts.get(c.component.default_warehouse_id) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback
}

/** Producción planifica una orden: el producto, cuántas unidades y de qué depósito salen los materiales. */
export function ProductionOrderFormPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const {
    data: catalog = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['production-catalog', company.companyId],
    queryFn: () => api.productionCatalog(company.companyId),
  })
  const [productId, setProductId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [materialsWarehouse, setMaterialsWarehouse] = useState('')
  const [outputWarehouse, setOutputWarehouse] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const fallback = company.warehouses[0]?.id ?? ''

  // El producto de la dirección (?producto=PT-001), una vez que se cargó lo que se puede fabricar.
  const wanted = params.get('producto')
  const selected =
    catalog.find((p) => p.id === productId) ?? (productId ? undefined : catalog.find((p) => p.code === wanted))
  const product = selected
  const materials = materialsWarehouse || (product ? materialsWarehouseOf(product, fallback) : '')
  const output = outputWarehouse || product?.default_warehouse_id || fallback
  const { data: bom } = useQuery({
    queryKey: ['bom', company.companyId, product?.code],
    queryFn: () => api.bom(company.companyId, product!.code),
    enabled: !!product,
  })

  const q = quantityOf(quantity)
  const rows = (product?.components ?? []).map((c) => {
    const needed = q > 0 ? round3(c.quantity * q) : 0
    const stock = c.stock.find((s) => s.warehouse_id === materials)
    const available = stock?.available ?? 0
    return { ...c, needed, stock, available, short: needed > available + 1e-9 }
  })
  const shortages = rows.filter((r) => r.short)
  const save = useCommand(
    (release: boolean) =>
      commands.createProductionOrder(
        company.companyId,
        {
          product_id: product!.id,
          quantity: q,
          materials_warehouse_id: materials,
          output_warehouse_id: output,
          due_date: dueDate || null,
          notes,
        },
        release,
      ),
    {
      success: (r) => `${r.display_number} guardada.`,
      onSuccess: (r) => navigate(company.docPath('PRODUCTION_ORDER', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Producción' },
    { label: 'Órdenes de producción', to: company.docPath('PRODUCTION_ORDER') },
    { label: 'Nueva' },
  ]
  if (isLoading || error) return <Loading error={error} />
  if (!catalog.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Nueva orden de producción" />
        <EmptyState icon={Layers} title="No hay productos con lista de materiales activa">
          Para planificar una orden, primero Producción arma la lista de materiales del producto (Producción → Listas de
          materiales).
        </EmptyState>
      </>
    )
  }
  const ready = !!product && q > 0 && !!materials && !!output

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Nueva orden de producción"
        description="Qué se fabrica y cuántas unidades. La orden copia la lista de materiales del producto; al liberarla se controla que haya materiales y quedan reservados para Depósito."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Qué se fabrica">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Producto" required className="sm:col-span-2">
                <SimpleSelect
                  value={product?.id ?? ''}
                  onChange={(id) => {
                    setProductId(id)
                    setMaterialsWarehouse('')
                    setOutputWarehouse('')
                  }}
                  options={catalog.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
                  placeholder="Elegí el producto terminado"
                />
              </Field>
              <Field
                label={product ? `Cantidad (${product.uom_code})` : 'Cantidad'}
                required
                error={quantity && !(q > 0) ? 'Escribí una cantidad mayor que cero.' : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="tabular text-right"
                />
              </Field>
              <Field label="Fecha prevista de terminación">
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
              <Field label="Materiales desde" required hint="Ahí se controlan y se reservan.">
                <SimpleSelect
                  value={materials}
                  onChange={setMaterialsWarehouse}
                  options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))}
                />
              </Field>
              <Field label="El producto entra a" required>
                <SimpleSelect
                  value={output}
                  onChange={setOutputWarehouse}
                  options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))}
                />
              </Field>
              <Field label="Observaciones" className="sm:col-span-2">
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                  placeholder="Opcional"
                />
              </Field>
            </div>
          </Section>

          {product && (
            <Section
              title="Materiales"
              description="Lo que lleva según la lista de materiales, contra lo disponible en el depósito (lo que hay menos lo reservado para otras órdenes)."
            >
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead className={head}>Material</TableHead>
                      <TableHead className={cn(head, 'text-right')}>Por unidad</TableHead>
                      <TableHead className={cn(head, 'text-right')}>Necesario</TableHead>
                      <TableHead className={cn(head, 'text-right')}>Disponible</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.component.id}>
                        <TableCell className="text-sm">
                          <span className="font-mono text-xs font-semibold text-navy">{r.component.code}</span>{' '}
                          {r.component.name}
                        </TableCell>
                        <TableCell className="tabular text-right">{qty(r.quantity, r.component.uom_code)}</TableCell>
                        <TableCell className="tabular text-right font-medium">
                          {qty(r.needed, r.component.uom_code)}
                        </TableCell>
                        <TableCell className={cn('tabular text-right', r.short && 'font-medium text-red-700')}>
                          {qty(Math.max(r.available, 0), r.component.uom_code)}
                          {!!r.stock?.reserved && (
                            <div className="text-xs text-muted-foreground">
                              hay {qty(r.stock.on_hand)}, {qty(r.stock.reserved)} reservados
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Section>
          )}
        </div>

        <aside className="flex flex-col gap-3">
          <Section title="Costo previsto">
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Materiales por unidad</dt>
                <dd className="tabular">{bom ? money(bom.material_cost) : '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Conversión por unidad</dt>
                <dd className="tabular">{bom ? money(bom.conversion_cost) : '—'}</dd>
              </div>
              <div className="flex justify-between border-t pt-1.5 text-base font-semibold text-navy">
                <dt>Costo de la orden</dt>
                <dd className="tabular">
                  {bom && q > 0 ? money(Math.round((bom.material_cost + bom.conversion_cost) * q * 100) / 100) : '—'}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              Es una estimación: el costo real sale de lo que Depósito entregue (al costo promedio de ese momento) y de
              las horas que se trabajen en cada centro.
            </p>
            {product && (
              <div
                className={cn(
                  'mt-3 flex gap-2 rounded-lg px-3 py-2 text-xs',
                  shortages.length ? 'bg-amber-50 text-amber-900' : 'bg-brand-blue-soft/70 text-slate-700',
                )}
              >
                {shortages.length ? (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand-blue" />
                )}
                <span>
                  {shortages.length
                    ? `Faltan materiales (${shortages.map((s) => s.component.code).join(', ')}): se puede guardar planificada y liberarla cuando lleguen.`
                    : 'Alcanzan los materiales: al liberarla quedan reservados.'}
                </span>
              </div>
            )}
          </Section>
          <Button
            size="lg"
            disabled={!ready || shortages.length > 0 || save.isPending}
            onClick={() => save.mutate([true])}
          >
            <Factory /> Planificar y liberar
          </Button>
          <Button variant="outline" disabled={!ready || save.isPending} onClick={() => save.mutate([false])}>
            Guardar planificada
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancelar
          </Button>
        </aside>
      </div>
    </>
  )
}
