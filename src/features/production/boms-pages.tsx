import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Factory, Info, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Field, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect } from '@/components/common/pickers'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type BomDetail, type BomRow } from '@/lib/api'
import { BOM_COMPONENT_TYPES, PRODUCT_TYPES } from '@/lib/domain/catalog'
import { money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const head = 'h-9 text-xs font-semibold text-slate-600'

const crumbs = (company: ReturnType<typeof useCompany>, extra: { label: string; to?: string }[] = []) => [
  { label: 'Inicio', to: company.to() },
  { label: 'Producción' },
  { label: 'Listas de materiales', to: extra.length ? company.to('produccion/listas-de-materiales') : undefined },
  ...extra,
]

/** Cantidad escrita por el estudiante: "18", "0,4" o "0.4" (hasta 3 decimales). */
const quantityOf = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : Number.NaN
}

/** Los productos terminados y su lista de materiales: la fórmula de cada uno. */
export function BomsPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['boms', company.companyId],
    queryFn: () => api.boms(company.companyId),
  })
  return (
    <>
      <PageHeader
        crumbs={crumbs(company)}
        title="Listas de materiales"
        description="La fórmula de cada producto terminado: qué materias primas e insumos lleva y cuánto de cada uno por unidad. Cada orden de producción copia la lista al planificarse."
      />
      <DataTable<BomRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.product.id}
        search={(r) => `${r.product.code} ${r.product.name}`}
        searchPlaceholder="Buscar producto…"
        onRowClick={(r) => navigate(company.to(`produccion/listas-de-materiales/${r.product.code}`))}
        empty="No hay productos terminados: se dan de alta en Maestros → Productos."
        columns={[
          {
            key: 'code',
            header: 'Código',
            sort: (r) => r.product.code,
            cell: (r) => <Mono>{r.product.code}</Mono>,
          },
          { key: 'name', header: 'Producto', sort: (r) => r.product.name, cell: (r) => r.product.name },
          {
            key: 'components',
            header: 'Componentes',
            align: 'right',
            sort: (r) => r.components,
            cell: (r) => r.components || '—',
          },
          {
            key: 'cost',
            header: 'Materiales por unidad',
            align: 'right',
            sort: (r) => r.material_cost,
            cell: (r) => <span className="tabular">{r.bom ? money(r.material_cost) : '—'}</span>,
          },
          {
            key: 'status',
            header: 'Estado',
            cell: (r) =>
              !r.bom ? (
                <StatusBadge label="Sin lista" badge="warning" />
              ) : r.bom.is_active ? (
                <StatusBadge label="Activa" badge="success" />
              ) : (
                <StatusBadge label="Inactiva" badge="neutral" />
              ),
          },
        ]}
      />
    </>
  )
}

interface DraftLine {
  key: number
  component_id: string
  quantity: string
}

let nextKey = 1

/** La lista de un producto: sus componentes con el costo estimado, y su edición. */
export function BomPage() {
  const company = useCompany()
  const { code = '' } = useParams()
  const { data, isLoading, error } = useQuery({
    queryKey: ['bom', company.companyId, code],
    queryFn: () => api.bom(company.companyId, code),
  })
  const [editing, setEditing] = useState(false)
  if (isLoading || error) return <Loading error={error} />
  if (!data) {
    return (
      <>
        <PageHeader crumbs={crumbs(company, [{ label: code }])} title={code} />
        <EmptyState icon={Layers} title="No es un producto terminado">
          Sólo los productos terminados tienen lista de materiales.
        </EmptyState>
      </>
    )
  }
  return editing ? (
    <BomEditor detail={data} onDone={() => setEditing(false)} />
  ) : (
    <BomView detail={data} onEdit={() => setEditing(true)} />
  )
}

function BomView({ detail, onEdit }: { detail: BomDetail; onEdit: () => void }) {
  const company = useCompany()
  const { product, bom, lines } = detail
  const canWrite = company.can(bom ? 'bom.update' : 'bom.create')
  const setActive = useCommand((active: boolean) => commands.setBomActive(company.companyId, bom!.id, active), {
    success: 'Listo. El cambio quedó registrado en la auditoría.',
  })
  const share = product.standard_cost > 0 ? Math.round((detail.material_cost / product.standard_cost) * 100) : null
  return (
    <>
      <PageHeader
        crumbs={crumbs(company, [{ label: product.code }])}
        title={
          <span>
            <span className="font-mono">{product.code}</span> {product.name}
          </span>
        }
        meta={
          !bom ? (
            <StatusBadge label="Sin lista" badge="warning" />
          ) : bom.is_active ? (
            <StatusBadge label="Activa" badge="success" />
          ) : (
            <StatusBadge label="Inactiva" badge="neutral" />
          )
        }
        actions={
          <>
            {bom && company.can('bom.update') && (
              <Button
                variant="outline"
                disabled={setActive.isPending}
                onClick={() => setActive.mutate([!bom.is_active])}
              >
                {bom.is_active ? 'Desactivar' : 'Activar'}
              </Button>
            )}
            {canWrite && product.is_active && (
              <Button variant={bom ? 'outline' : 'default'} onClick={onEdit}>
                {bom ? (
                  <>
                    <Pencil /> Modificar
                  </>
                ) : (
                  <>
                    <Plus /> Armar la lista
                  </>
                )}
              </Button>
            )}
            {bom?.is_active && company.can('production_order.create') && (
              <Button asChild>
                <Link to={`${company.docPath('PRODUCTION_ORDER', 'nueva')}?producto=${product.code}`}>
                  <Factory /> Planificar una orden
                </Link>
              </Button>
            )}
          </>
        }
      />
      {!bom ? (
        <EmptyState icon={Layers} title="Todavía no tiene lista de materiales">
          Sin lista no se pueden planificar órdenes de producción de este producto.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {detail.open_orders > 0 && (
            <div className="flex gap-2 rounded-lg bg-brand-blue-soft/70 px-3 py-2 text-sm text-slate-700">
              <Info className="mt-0.5 size-4 shrink-0 text-brand-blue" />
              <span>
                Hay {detail.open_orders} {detail.open_orders === 1 ? 'orden' : 'órdenes'} de este producto en curso: si
                se modifica la lista, no cambian (cada una guardó la suya al planificarse).
              </span>
            </div>
          )}
          <Section
            title="Componentes por unidad"
            description="El costo de cada material es su costo promedio en el depósito (o el estándar, si todavía no hay stock)."
          >
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead className={cn(head, 'w-10')}>#</TableHead>
                    <TableHead className={head}>Componente</TableHead>
                    <TableHead className={head}>Tipo</TableHead>
                    <TableHead className={cn(head, 'text-right')}>Por unidad</TableHead>
                    <TableHead className={cn(head, 'text-right')}>Costo unit.</TableHead>
                    <TableHead className={cn(head, 'text-right')}>Costo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.line_no}>
                      <TableCell className="text-xs text-muted-foreground">{l.line_no}</TableCell>
                      <TableCell className="text-sm">
                        <Link to={company.to(`productos/${l.component.code}`)} className="hover:underline">
                          <span className="font-mono text-xs font-semibold text-navy">{l.component.code}</span>{' '}
                          {l.component.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{PRODUCT_TYPES[l.component.product_type]}</TableCell>
                      <TableCell className="tabular text-right">{qty(l.quantity, l.component.uom_code)}</TableCell>
                      <TableCell className="tabular text-right">{money(l.unit_cost)}</TableCell>
                      <TableCell className="tabular text-right">{money(l.line_cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5} className="text-right text-sm font-semibold">
                      Materiales de una unidad
                    </TableCell>
                    <TableCell className="tabular text-right font-semibold">{money(detail.material_cost)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Costo estándar del producto: {money(product.standard_cost)}
              {share !== null && ` (los materiales son el ${share} %; el resto es la mano de obra y la carga fabril)`}.
              {bom.notes && ` Observaciones: ${bom.notes}`}
            </p>
          </Section>
        </div>
      )}
    </>
  )
}

function BomEditor({ detail, onDone }: { detail: BomDetail; onDone: () => void }) {
  const company = useCompany()
  const { product, bom } = detail
  const { data: products = [] } = useQuery({
    queryKey: ['products', company.companyId],
    queryFn: () => api.products(company.companyId),
  })
  const components = products.filter((p) => p.is_active && BOM_COMPONENT_TYPES.includes(p.product_type))
  const [lines, setLines] = useState<DraftLine[]>(() =>
    detail.lines.length
      ? detail.lines.map((l) => ({
          key: nextKey++,
          component_id: l.component.id,
          quantity: String(l.quantity).replace('.', ','),
        }))
      : [{ key: nextKey++, component_id: '', quantity: '' }],
  )
  const [notes, setNotes] = useState(bom?.notes ?? '')
  const update = (key: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const save = useCommand(
    () =>
      commands.saveBom(company.companyId, {
        product_id: product.id,
        notes,
        lines: lines
          .filter((l) => l.component_id)
          .map((l) => ({ component_id: l.component_id, quantity: quantityOf(l.quantity) })),
      }),
    { success: 'Lista guardada.', onSuccess: onDone },
  )
  const filled = lines.filter((l) => l.component_id)
  const ready = filled.length > 0 && filled.every((l) => quantityOf(l.quantity) > 0)
  return (
    <>
      <PageHeader
        crumbs={crumbs(company, [
          { label: product.code, to: company.to(`produccion/listas-de-materiales/${product.code}`) },
          { label: bom ? 'Modificar' : 'Armar' },
        ])}
        title={
          <span>
            Lista de materiales de <span className="font-mono">{product.code}</span> {product.name}
          </span>
        }
        description="Cuánto lleva cada unidad de cada materia prima e insumo. Las órdenes ya cargadas no cambian."
      />
      <div className="flex max-w-3xl flex-col gap-4">
        <Section
          title="Componentes por unidad"
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLines((ls) => [...ls, { key: nextKey++, component_id: '', quantity: '' }])}
            >
              <Plus /> Agregar componente
            </Button>
          }
        >
          <div className="flex flex-col gap-2">
            {lines.map((l) => {
              const c = components.find((x) => x.id === l.component_id)
              const q = quantityOf(l.quantity)
              return (
                <div key={l.key} className="grid items-start gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_140px_auto]">
                  <ProductSelect
                    products={components.filter(
                      (x) => x.id === l.component_id || !lines.some((other) => other.component_id === x.id),
                    )}
                    value={l.component_id}
                    onChange={(id) => update(l.key, { component_id: id })}
                    placeholder="Elegí la materia prima o el insumo"
                  />
                  <Field
                    label={c ? `Por unidad (${c.uom_code})` : 'Por unidad'}
                    error={l.quantity && !(q > 0) ? 'Mayor que cero' : undefined}
                  >
                    <Input
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) => update(l.key, { quantity: e.target.value })}
                      className="tabular text-right"
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Quitar componente"
                    className="mt-6"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )
            })}
          </div>
        </Section>
        <Section title="Observaciones">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Opcional" />
        </Section>
        <div className="flex gap-2">
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate([])}>
            {save.isPending ? 'Guardando…' : 'Guardar lista'}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancelar
          </Button>
        </div>
      </div>
    </>
  )
}
