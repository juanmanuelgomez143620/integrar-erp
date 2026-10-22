import { useState } from 'react'
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
import { Field } from '@/components/common/blocks'
import { commands, type DocumentDetail } from '@/lib/api'
import { money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'

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
  const units = quantityOf(value)
  const finish = useCommand(() => commands.finishProductionOrder(doc.id, units), {
    success: 'Orden terminada: el producto entró al stock a su costo real.',
    onSuccess: () => onOpenChange(false),
  })
  const valid = units > 0 && units <= view.quantity + 1e-9
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Terminar {doc.display_number}</DialogTitle>
          <DialogDescription>
            Las unidades que salieron bien entran a {view.output_warehouse.name} a su costo real: lo que se consumió
            dividido las unidades terminadas.
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
        <dl className="flex flex-col gap-1 rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Materiales consumidos</dt>
            <dd className="tabular">{money(view.material_cost)}</dd>
          </div>
          <div className="flex justify-between font-semibold text-navy">
            <dt>Costo de cada unidad</dt>
            <dd className="tabular">{valid ? money(view.material_cost / units) : '—'}</dd>
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
