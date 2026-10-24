import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ShoppingCart } from 'lucide-react'
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
import { Field, Section } from '@/components/common/blocks'
import { api, commands, type DocumentDetail, type ProductionOrderView } from '@/lib/api'
import { money, percent, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const head = 'h-9 text-xs font-semibold text-slate-600'

/** Cantidad escrita por el estudiante: "18", "0,4" o "0.4". */
const quantityOf = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : Number.NaN
}

const asInput = (n: number) => String(n).replace('.', ',')

interface DialogProps {
  detail: DocumentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Depósito registra lo que realmente sale de cada material (propone lo previsto). */
export function IssueDialog({ detail, open, onOpenChange }: DialogProps) {
  const { doc, lines } = detail
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, asInput(l.quantity)])),
  )
  const issue = useCommand(
    () =>
      commands.issueProductionOrder(doc.id, {
        lines: lines.map((l) => ({ line_id: l.id, quantity: quantityOf(values[l.id] ?? '0') })),
      }),
    { success: 'Materiales entregados: el consumo pasó a productos en proceso.', onSuccess: () => onOpenChange(false) },
  )
  const invalid = lines.some((l) => !(quantityOf(values[l.id] ?? '') >= 0))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Entregar los materiales de {doc.display_number}</DialogTitle>
          <DialogDescription>
            Registrá lo que realmente sale de cada material: puede ser más que lo previsto (desperdicio) o menos (si
            sobró). El stock baja al costo promedio y el consumo pasa a productos en proceso.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className={head}>Material</TableHead>
                <TableHead className={cn(head, 'text-right')}>Previsto</TableHead>
                <TableHead className={cn(head, 'text-right')}>Disponible</TableHead>
                <TableHead className={cn(head, 'w-36 text-right')}>Sale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => {
                const value = quantityOf(values[l.id] ?? '')
                const over = l.qty_available != null && value > l.qty_available + 1e-9
                return (
                  <TableRow key={l.id}>
                    <TableCell className="text-sm">
                      <span className="font-mono text-xs font-semibold text-navy">{l.product.code}</span>{' '}
                      {l.product.name}
                    </TableCell>
                    <TableCell className="tabular text-right">{qty(l.quantity, l.product.uom_code)}</TableCell>
                    <TableCell className={cn('tabular text-right', over && 'font-medium text-red-700')}>
                      {l.qty_available != null ? qty(Math.max(l.qty_available, 0), l.product.uom_code) : '—'}
                    </TableCell>
                    <TableCell>
                      <Input
                        inputMode="decimal"
                        aria-label={`Sale de ${l.product.code}`}
                        value={values[l.id] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [l.id]: e.target.value }))}
                        className={cn('tabular text-right', !(value >= 0) && 'border-red-500')}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={issue.isPending}>
            Volver
          </Button>
          <Button disabled={invalid || issue.isPending} onClick={() => issue.mutate([])}>
            {issue.isPending ? 'Registrando…' : 'Entregar los materiales'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Producción registra las unidades que salieron bien: entran al stock a su costo real. */
export function FinishDialog({ detail, open, onOpenChange }: DialogProps) {
  const { doc } = detail
  const view = detail.production_order!
  const [value, setValue] = useState(asInput(view.quantity))
  const [hours, setHours] = useState<Record<string, string>>(() =>
    Object.fromEntries(view.operations.map((o) => [o.id, asInput(o.hours_planned)])),
  )
  const units = quantityOf(value)
  const actual = view.operations.map((o) => ({ ...o, hours: quantityOf(hours[o.id] ?? '') }))
  const hoursValid = actual.every((o) => o.hours >= 0)
  const labor = actual.reduce((s, o) => s + round2((o.hours || 0) * o.labor_rate), 0)
  const overhead = actual.reduce((s, o) => s + round2((o.hours || 0) * o.overhead_rate), 0)
  const finish = useCommand(
    () =>
      commands.finishProductionOrder(
        doc.id,
        units,
        actual.map((o) => ({ operation_id: o.id, hours: o.hours })),
      ),
    {
      success: 'Orden terminada: el producto entró al stock a su costo real.',
      onSuccess: () => onOpenChange(false),
    },
  )
  const valid = units > 0 && units <= view.quantity + 1e-9 && hoursValid
  const unitCost = valid ? (view.material_cost + labor + overhead) / units : null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Terminar {doc.display_number}</DialogTitle>
          <DialogDescription>
            Las unidades que salieron bien entran a {view.output_warehouse.name} a su costo real: lo que se consumió más
            la mano de obra y la carga fabril de las horas trabajadas, dividido las unidades terminadas.
          </DialogDescription>
        </DialogHeader>
        <Field
          label={`Unidades terminadas de ${view.product.code} (${view.product.uom_code})`}
          hint={`Se planificaron ${qty(view.quantity, view.product.uom_code)}.`}
          error={value && !valid ? `Entre 0 y ${qty(view.quantity)}.` : undefined}
        >
          <Input
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="tabular text-right"
          />
        </Field>
        {view.operations.length > 0 && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className={head}>Centro de trabajo</TableHead>
                  <TableHead className={cn(head, 'text-right')}>Previstas</TableHead>
                  <TableHead className={cn(head, 'w-32 text-right')}>Trabajadas</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.operations.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="text-sm">
                      <span className="font-mono text-xs font-semibold text-navy">{o.work_center.code}</span>{' '}
                      {o.work_center.name}
                    </TableCell>
                    <TableCell className="tabular text-right">{qty(o.hours_planned)} h</TableCell>
                    <TableCell>
                      <Input
                        inputMode="decimal"
                        aria-label={`Horas trabajadas en ${o.work_center.code}`}
                        value={hours[o.id] ?? ''}
                        onChange={(e) => setHours((h) => ({ ...h, [o.id]: e.target.value }))}
                        className={cn('tabular text-right', !(quantityOf(hours[o.id] ?? '') >= 0) && 'border-red-500')}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <dl className="flex flex-col gap-1 rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Materiales consumidos</dt>
            <dd className="tabular">{money(view.material_cost)}</dd>
          </div>
          {view.operations.length > 0 && (
            <>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Mano de obra directa</dt>
                <dd className="tabular">{hoursValid ? money(labor) : '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Carga fabril</dt>
                <dd className="tabular">{hoursValid ? money(overhead) : '—'}</dd>
              </div>
            </>
          )}
          <div className="flex justify-between font-semibold text-navy">
            <dt>Costo de cada unidad</dt>
            <dd className="tabular">{money(unitCost)}</dd>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <dt>Costo estándar del producto</dt>
            <dd className="tabular">
              {money(view.standard_cost)}
              {unitCost != null &&
                view.standard_cost > 0 &&
                ` (${percent((unitCost / view.standard_cost - 1) * 100, true)})`}
            </dd>
          </div>
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={finish.isPending}>
            Volver
          </Button>
          <Button disabled={!valid || finish.isPending} onClick={() => finish.mutate([])}>
            {finish.isPending ? 'Registrando…' : 'Terminar la orden'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Las horas de la orden en cada centro: previstas y reales, con su costo. */
export function OperationsSection({ view }: { view: ProductionOrderView }) {
  const finished = view.operations.some((o) => o.hours_actual != null)
  const cost = (hours: number | null, o: ProductionOrderView['operations'][number]) =>
    hours == null ? null : round2(round2(hours * o.labor_rate) + round2(hours * o.overhead_rate))
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className={head}>Centro de trabajo</TableHead>
            <TableHead className={cn(head, 'text-right')}>Horas previstas</TableHead>
            <TableHead className={cn(head, 'text-right')}>Mano de obra / h</TableHead>
            <TableHead className={cn(head, 'text-right')}>Carga fabril / h</TableHead>
            <TableHead className={cn(head, 'text-right')}>Costo previsto</TableHead>
            <TableHead className={cn(head, 'text-right')}>Horas reales</TableHead>
            <TableHead className={cn(head, 'text-right')}>Costo real</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.operations.map((o) => (
            <TableRow key={o.id}>
              <TableCell className="text-sm">
                <span className="font-mono text-xs font-semibold text-navy">{o.work_center.code}</span>{' '}
                {o.work_center.name}
              </TableCell>
              <TableCell className="tabular text-right">{qty(o.hours_planned)}</TableCell>
              <TableCell className="tabular text-right">{money(o.labor_rate)}</TableCell>
              <TableCell className="tabular text-right">{money(o.overhead_rate)}</TableCell>
              <TableCell className="tabular text-right">{money(cost(o.hours_planned, o))}</TableCell>
              <TableCell
                className={cn(
                  'tabular text-right',
                  o.hours_actual != null && o.hours_actual > o.hours_planned && 'text-amber-700',
                )}
              >
                {o.hours_actual != null ? qty(o.hours_actual) : '—'}
              </TableCell>
              <TableCell className="tabular text-right">
                {o.hours_actual != null ? money(cost(o.hours_actual, o)) : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        Conversión prevista {money(view.planned_conversion_cost)}
        {finished && view.labor_cost != null && view.overhead_cost != null
          ? ` · aplicada ${money(view.labor_cost + view.overhead_cost)} (mano de obra ${money(view.labor_cost)} y carga fabril ${money(view.overhead_cost)})`
          : ''}
        . Las tarifas son las de los centros al planificar la orden.
      </p>
    </div>
  )
}

/**
 * Los desvíos de la orden contra lo previsto al planificarla (docs/FASE_5_PRODUCCION_Y_COSTOS.md §4):
 * en los materiales, de cantidad (se entregó más o menos, al costo previsto) y de precio (el resto: el
 * costo promedio cambió); en la conversión, de horas (a las tarifas de la orden, que no cambian).
 */
export function VariancesSection({ detail }: { detail: DocumentDetail }) {
  const view = detail.production_order!
  const quantity = round2(
    detail.lines.reduce((s, l) => s + ((l.qty_issued ?? 0) - l.quantity) * (l.planned_unit_cost ?? 0), 0),
  )
  const price = round2(view.material_cost - view.planned_material_cost - quantity)
  const applied = view.labor_cost != null && view.overhead_cost != null ? view.labor_cost + view.overhead_cost : null
  const rows = [
    { label: 'Materiales, de cantidad', hint: 'Lo entregado de más o de menos, al costo previsto.', value: quantity },
    { label: 'Materiales, de precio', hint: 'Lo entregado, a su costo promedio contra el previsto.', value: price },
    ...(applied != null
      ? [
          {
            label: 'Conversión, de horas',
            hint: 'Las horas trabajadas contra las previstas, a las tarifas de la orden.',
            value: round2(applied - view.planned_conversion_cost),
          },
        ]
      : []),
  ]
  const total = round2(rows.reduce((s, r) => s + r.value, 0))
  const tone = (v: number) => (v > 0 ? 'text-red-700' : v < 0 ? 'text-green-700' : 'text-muted-foreground')
  const word = (v: number) => (v > 0 ? 'desfavorable' : v < 0 ? 'favorable' : 'sin desvío')
  return (
    <Section
      title="Desvíos contra lo previsto"
      description="Desfavorable: costó más de lo previsto; favorable: menos. Con los sueldos reales (Fase 6) se ve además cuánto se aplicó de más o de menos."
    >
      <dl className="flex max-w-xl flex-col gap-2 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-4">
            <dt>
              {r.label}
              <div className="text-xs text-muted-foreground">{r.hint}</div>
            </dt>
            <dd className={cn('tabular text-right', tone(r.value))}>
              {money(Math.abs(r.value))}
              <div className="text-xs">{word(r.value)}</div>
            </dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 border-t pt-2 font-semibold text-navy">
          <dt>Desvío de la orden</dt>
          <dd className={cn('tabular text-right', tone(total))}>
            {money(Math.abs(total))} {word(total)}
          </dd>
        </div>
      </dl>
      {view.quantity_produced != null && view.quantity_produced < view.quantity && (
        <p className="mt-3 text-xs text-muted-foreground">
          Salieron bien {qty(view.quantity_produced)} de {qty(view.quantity, view.product.uom_code)}: el costo de cada
          unidad sube aunque no haya desvíos.
        </p>
      )}
    </Section>
  )
}

/**
 * Una orden planificada a la que le faltan materiales: qué falta, qué ya está en
 * camino o pedido, y el pedido a Compras de lo demás (docs/FASE_5_PRODUCCION_Y_COSTOS.md §5).
 */
export function ShortagesNotice({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const navigate = useNavigate()
  const { doc } = detail
  const { data: needs = [] } = useQuery({
    queryKey: ['production-needs', company.companyId, doc.id],
    queryFn: () => api.productionNeeds(company.companyId, [doc.id]),
  })
  const request = useCommand(() => commands.requestProductionMaterials(company.companyId, [doc.id]), {
    success: (r) => `Se generó ${r.display_number} en borrador: revisala y enviala a Compras.`,
    onSuccess: (r) => navigate(company.docPath('PURCHASE_REQUISITION', r.display_number)),
  })
  const missing = needs.filter((n) => n.required > Math.max(n.available, 0))
  if (!missing.length) return null
  const short = missing.some((n) => n.shortage > 0)
  const covering = [...new Map(missing.flatMap((n) => n.covered_by).map((c) => [c.id, c])).values()]
  return (
    <div className="mb-4 flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {short
            ? 'Faltan materiales para liberarla: hay que pedírselos a Compras.'
            : 'Faltan materiales para liberarla, pero ya están pedidos o en camino.'}
        </div>
        <ul className="mt-1 text-xs">
          {missing.map((n) => {
            const uom = n.product.uom_code
            return (
              <li key={n.product.id}>
                <span className="font-mono font-semibold">{n.product.code}</span> {n.product.name}: necesita{' '}
                {qty(n.required, uom)} y hay {qty(Math.max(n.available, 0), uom)} disponibles
                {n.on_order > 0 && `; ${qty(n.on_order, uom)} en camino`}
                {n.requested > 0 && `; ${qty(n.requested, uom)} ya pedidos`}
                {n.shortage > 0 && (
                  <>
                    {' '}
                    — <strong>falta {qty(n.shortage, uom)}</strong>
                  </>
                )}
              </li>
            )
          })}
        </ul>
        {covering.length > 0 && (
          <div className="mt-1 text-xs">
            Lo cubren{' '}
            {covering.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ', '}
                <Link to={c.path} className="font-mono underline">
                  {c.display_number}
                </Link>
              </span>
            ))}
            : cuando llegue lo pedido, se puede liberar.
          </div>
        )}
      </div>
      {short && company.can('purchase_requisition.create') && (
        <Button size="sm" variant="outline" disabled={request.isPending} onClick={() => request.mutate([])}>
          <ShoppingCart /> Pedir a Compras lo que falta
        </Button>
      )}
    </div>
  )
}
