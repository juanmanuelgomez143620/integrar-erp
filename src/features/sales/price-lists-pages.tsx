import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Pencil, Percent, Plus, Tags, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Field, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect, SimpleSelect } from '@/components/common/pickers'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type PriceListDetail, type PriceListRow } from '@/lib/api'
import { PRODUCT_TYPES } from '@/lib/domain/catalog'
import { money, parseAmount, percent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const head = 'h-9 text-xs font-semibold text-slate-600'

/** Porcentaje escrito por el estudiante: "8", "-10" o "2,5". */
const percentOf = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : Number.NaN
}

const crumbs = (company: ReturnType<typeof useCompany>, extra: { label: string; to?: string }[] = []) => [
  { label: 'Inicio', to: company.to() },
  { label: 'Ventas' },
  { label: 'Listas de precios', to: extra.length ? company.to('ventas/listas-de-precios') : undefined },
  ...extra,
]

/** Las listas de precios de la empresa: a cada cliente se le proponen los precios de la suya. */
export function PriceListsPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['price-lists', company.companyId],
    queryFn: () => api.priceLists(company.companyId),
  })
  return (
    <>
      <PageHeader
        crumbs={crumbs(company)}
        title="Listas de precios"
        description="El precio sin IVA de cada producto en cada lista. A cada cliente se le propone el de su lista (se asigna en su ficha); si no tiene, el precio de venta del producto."
        actions={
          company.can('price_list.create') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> Nueva lista
            </Button>
          ) : undefined
        }
      />
      <DataTable<PriceListRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.list.id}
        search={(r) => `${r.list.code} ${r.list.name}`}
        searchPlaceholder="Buscar lista…"
        onRowClick={(r) => navigate(company.to(`ventas/listas-de-precios/${r.list.code}`))}
        empty="Todavía no hay listas de precios: los clientes reciben el precio de venta de cada producto."
        columns={[
          { key: 'code', header: 'Código', sort: (r) => r.list.code, cell: (r) => <Mono>{r.list.code}</Mono> },
          {
            key: 'name',
            header: 'Lista',
            sort: (r) => r.list.name,
            cell: (r) => (
              <div>
                <div className="font-medium">{r.list.name}</div>
                {r.list.description && <div className="text-xs text-muted-foreground">{r.list.description}</div>}
              </div>
            ),
          },
          { key: 'items', header: 'Productos', align: 'right', sort: (r) => r.items, cell: (r) => r.items },
          { key: 'customers', header: 'Clientes', align: 'right', sort: (r) => r.customers, cell: (r) => r.customers },
          {
            key: 'status',
            header: 'Estado',
            cell: (r) =>
              r.list.is_active ? (
                <StatusBadge label="Activa" badge="success" />
              ) : (
                <StatusBadge label="Inactiva" badge="neutral" />
              ),
          },
        ]}
      />
      {creating && <NewListDialog lists={data} open={creating} onOpenChange={setCreating} />}
    </>
  )
}

function NewListDialog({
  lists,
  open,
  onOpenChange,
}: {
  lists: PriceListRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [copyFrom, setCopyFrom] = useState('SALE_PRICE')
  const [percent, setPercent] = useState('0')
  const pct = percentOf(percent)
  const create = useCommand(
    () =>
      commands.createPriceList(company.companyId, {
        code,
        name,
        description,
        copy_from: copyFrom,
        percent: Number.isFinite(pct) ? pct : 0,
      }),
    {
      success: (r) => `Se creó la lista ${r.code}.`,
      onSuccess: (r) => navigate(company.to(`ventas/listas-de-precios/${r.code}`)),
    },
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva lista de precios</DialogTitle>
          <DialogDescription>
            Se arma copiando los precios de venta de los productos (o los de otra lista), con un porcentaje si hace
            falta: por ejemplo, la mayorista con un 10 % menos.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <Field label="Código" required hint="Hasta 12 letras o números.">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Descripción" className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opcional" />
          </Field>
          <Field label="Precios iniciales" className="sm:col-span-2">
            <SimpleSelect
              value={copyFrom}
              onChange={setCopyFrom}
              emptyLabel="Ninguno: la lista empieza vacía"
              options={[
                { value: 'SALE_PRICE', label: 'Los precios de venta de los productos' },
                ...lists.map((r) => ({ value: r.list.id, label: `Los de la lista ${r.list.code} · ${r.list.name}` })),
              ]}
            />
          </Field>
          {copyFrom && (
            <Field
              label="Porcentaje"
              className="sm:col-span-2"
              hint="Negativo para bajar: −10 es un 10 % menos."
              error={!Number.isFinite(pct) ? 'Escribí un número, por ejemplo -10 u 8,5.' : undefined}
            >
              <Input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Volver
          </Button>
          <Button
            disabled={
              create.isPending || !code.trim() || name.trim().length < 2 || (!!copyFrom && !Number.isFinite(pct))
            }
            onClick={() => create.mutate([])}
          >
            {create.isPending ? 'Creando…' : 'Crear lista'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Una lista de precios: el precio de cada producto, los clientes que la tienen y los ajustes. */
export function PriceListPage() {
  const company = useCompany()
  const { code = '' } = useParams()
  const { data, isLoading, error } = useQuery({
    queryKey: ['price-list', company.companyId, code],
    queryFn: () => api.priceList(company.companyId, code),
  })
  if (isLoading || error) return <Loading error={error} />
  if (!data) return <EmptyState icon={Tags} title={`No se encontró la lista ${code}`} />
  return <PriceListView detail={data} />
}

function PriceListView({ detail }: { detail: PriceListDetail }) {
  const company = useCompany()
  const { list } = detail
  const canEdit = company.can('price_list.update')
  const [editing, setEditing] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState({ product_id: '', price: '' })

  const setPrice = useCommand(
    (productId: string, value: number | null) =>
      commands.setPriceListPrice(company.companyId, list.id, productId, value),
    {
      success: 'Listo. El cambio quedó en la auditoría.',
      onSuccess: () => {
        setPrices({})
        setAdding({ product_id: '', price: '' })
      },
    },
  )
  const toggle = useCommand(() => commands.setPriceListActive(company.companyId, list.id, !list.is_active), {
    success: list.is_active ? 'La lista quedó inactiva.' : 'La lista quedó activa.',
  })
  const addPrice = parseAmount(adding.price)
  const missing = detail.missing.find((p) => p.id === adding.product_id)

  return (
    <>
      <PageHeader
        crumbs={crumbs(company, [{ label: list.name }])}
        title={list.name}
        meta={
          <>
            <Mono>{list.code}</Mono>
            {list.is_active ? (
              <StatusBadge label="Activa" badge="success" />
            ) : (
              <StatusBadge label="Inactiva" badge="neutral" />
            )}
          </>
        }
        description={list.description || 'Precios sin IVA de los productos que se venden.'}
        actions={
          canEdit ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Editar
              </Button>
              <Button variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate([])}>
                {list.is_active ? 'Desactivar' : 'Activar'}
              </Button>
              <Button disabled={!detail.items.length} onClick={() => setAdjusting(true)}>
                <Percent /> Actualizar por porcentaje
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Section title={`Precios (${detail.items.length})`} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className={head}>Producto</TableHead>
                  <TableHead className={cn(head, 'text-right')}>Precio de venta</TableHead>
                  <TableHead className={cn(head, 'text-right')}>Precio de la lista</TableHead>
                  <TableHead className={cn(head, 'text-right')}>Diferencia</TableHead>
                  {canEdit && <TableHead className={head} />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.items.map((i) => {
                  const draft = prices[i.product.id]
                  const value = draft === undefined ? i.unit_price : parseAmount(draft)
                  const changed = draft !== undefined && value !== i.unit_price
                  const diff = i.product.sale_price ? i.unit_price / i.product.sale_price - 1 : null
                  return (
                    <TableRow key={i.product.id}>
                      <TableCell className="text-sm">
                        <Link to={company.to(`productos/${i.product.code}`)} className="hover:underline">
                          <span className="font-mono text-xs font-semibold text-navy">{i.product.code}</span>{' '}
                          {i.product.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {PRODUCT_TYPES[i.product.product_type]}
                          {!i.product.is_active && ' · inactivo'}
                        </div>
                      </TableCell>
                      <TableCell className="tabular text-right">{money(i.product.sale_price)}</TableCell>
                      <TableCell className="text-right">
                        {canEdit ? (
                          <div className="flex items-center justify-end gap-2">
                            <Input
                              inputMode="decimal"
                              aria-label={`Precio de ${i.product.code}`}
                              value={draft ?? String(i.unit_price).replace('.', ',')}
                              onChange={(e) => setPrices((p) => ({ ...p, [i.product.id]: e.target.value }))}
                              className="tabular h-8 w-32 text-right"
                            />
                            {changed && (
                              <Button
                                size="sm"
                                disabled={setPrice.isPending || !(value > 0)}
                                onClick={() => setPrice.mutate([i.product.id, value])}
                              >
                                Guardar
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="tabular">{money(i.unit_price)}</span>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'tabular text-right text-xs',
                          diff != null && diff < 0 ? 'text-amber-700' : 'text-muted-foreground',
                        )}
                      >
                        {diff == null ? '—' : percent(diff * 100, true)}
                      </TableCell>
                      {canEdit && (
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Sacar ${i.product.code} de la lista`}
                            disabled={setPrice.isPending}
                            onClick={() => setPrice.mutate([i.product.id, null])}
                          >
                            <Trash2 />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
                {!detail.items.length && (
                  <TableRow>
                    <TableCell colSpan={canEdit ? 5 : 4} className="py-8 text-center text-sm text-muted-foreground">
                      La lista todavía no tiene productos: a sus clientes se les propone el precio de venta.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {canEdit && detail.missing.length > 0 && (
            <div className="grid items-end gap-2 border-t p-3 sm:grid-cols-[1fr_140px_auto]">
              <Field label="Agregar un producto">
                <ProductSelect
                  products={detail.missing}
                  value={adding.product_id}
                  aria-label="Producto para agregar"
                  onChange={(id) => {
                    const p = detail.missing.find((x) => x.id === id)
                    setAdding({ product_id: id, price: p?.sale_price ? String(p.sale_price).replace('.', ',') : '' })
                  }}
                />
              </Field>
              <Field label="Precio (sin IVA)">
                <Input
                  inputMode="decimal"
                  value={adding.price}
                  onChange={(e) => setAdding((a) => ({ ...a, price: e.target.value }))}
                  className="tabular text-right"
                />
              </Field>
              <Button
                disabled={!missing || !(addPrice > 0) || setPrice.isPending}
                onClick={() => setPrice.mutate([adding.product_id, addPrice])}
              >
                <Plus /> Agregar
              </Button>
            </div>
          )}
        </Section>
        <aside className="flex flex-col gap-4">
          <Section title={`Clientes con esta lista (${detail.customers.length})`} bodyClassName="flex flex-col gap-2">
            {detail.customers.map((c) => (
              <div key={c.id} className="text-sm">
                <Mono>{c.code}</Mono> {c.legal_name}
                {!c.is_active && <span className="text-xs text-muted-foreground"> · inactivo</span>}
              </div>
            ))}
            {!detail.customers.length && (
              <p className="text-sm text-muted-foreground">
                Ningún cliente la tiene todavía: se asigna en la ficha de cada cliente (Maestros → Clientes).
              </p>
            )}
          </Section>
          <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            Los pedidos y presupuestos ya cargados no cambian cuando se actualiza la lista: guardan el precio con que se
            cargaron.
          </section>
        </aside>
      </div>
      {editing && <EditListDialog detail={detail} open={editing} onOpenChange={setEditing} />}
      {adjusting && <AdjustListDialog detail={detail} open={adjusting} onOpenChange={setAdjusting} />}
    </>
  )
}

function EditListDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: PriceListDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const [name, setName] = useState(detail.list.name)
  const [description, setDescription] = useState(detail.list.description)
  const save = useCommand(() => commands.updatePriceList(company.companyId, detail.list.id, { name, description }), {
    success: 'Se guardó la lista.',
    onSuccess: () => onOpenChange(false),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar {detail.list.code}</DialogTitle>
          <DialogDescription>El código no cambia: es el que se ve en las fichas de los clientes.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Descripción">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opcional" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Volver
          </Button>
          <Button disabled={save.isPending || name.trim().length < 2} onClick={() => save.mutate([])}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AdjustListDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: PriceListDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const [percent, setPercent] = useState('')
  const pct = percentOf(percent)
  const valid = Number.isFinite(pct) && pct !== 0
  const sample = detail.items[0]
  const adjust = useCommand(() => commands.adjustPriceList(company.companyId, detail.list.id, pct), {
    success: 'Se actualizaron los precios de la lista.',
    onSuccess: () => onOpenChange(false),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Actualizar {detail.list.code} por porcentaje</DialogTitle>
          <DialogDescription>
            Cambia el precio de los {detail.items.length} productos de la lista, redondeado al centavo. Por ejemplo, +8
            por la inflación del mes o −5 por una promoción.
          </DialogDescription>
        </DialogHeader>
        <Field
          label="Porcentaje"
          hint={
            valid && sample
              ? `Ejemplo: ${sample.product.code} pasa de ${money(sample.unit_price)} a ${money(Math.round(sample.unit_price * (100 + pct)) / 100)}.`
              : 'Negativo para bajar los precios.'
          }
          error={percent.trim() && !Number.isFinite(pct) ? 'Escribí un número, por ejemplo 8 o -5.' : undefined}
        >
          <Input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adjust.isPending}>
            Volver
          </Button>
          <Button disabled={adjust.isPending || !valid} onClick={() => adjust.mutate([])}>
            {adjust.isPending ? 'Actualizando…' : 'Actualizar precios'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
