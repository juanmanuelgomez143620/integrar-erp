import { Link } from 'react-router'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Section } from '@/components/common/blocks'
import type { ReconciliationLineView, ReconciliationView } from '@/lib/api'
import { date, money } from '@/lib/format'
import { cn } from '@/lib/utils'

const head = 'h-9 text-xs font-semibold text-slate-600'

/** Movimientos del mayor de un banco; con `onToggle`, cada uno se marca si figura en el extracto. */
export function MovementTable({
  lines,
  selected,
  onToggle,
  empty,
}: {
  lines: ReconciliationLineView[]
  selected?: Set<string>
  onToggle?: (lineId: string, checked: boolean) => void
  empty: string
}) {
  if (!lines.length) return <p className="p-4 text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            {onToggle && <TableHead className={cn(head, 'w-10')}>En el extracto</TableHead>}
            <TableHead className={head}>Fecha</TableHead>
            <TableHead className={head}>Asiento</TableHead>
            <TableHead className={head}>Detalle</TableHead>
            <TableHead className={cn(head, 'text-right')}>Entra</TableHead>
            <TableHead className={cn(head, 'text-right')}>Sale</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.line_id} className={cn(selected?.has(l.line_id) && 'bg-brand-blue-soft/50')}>
              {onToggle && (
                <TableCell>
                  <Checkbox
                    checked={selected?.has(l.line_id) ?? false}
                    onCheckedChange={(v) => onToggle(l.line_id, v === true)}
                    aria-label={`Figura en el extracto: ${l.description}`}
                  />
                </TableCell>
              )}
              <TableCell className="text-sm whitespace-nowrap">{date(l.date)}</TableCell>
              <TableCell className="text-sm">
                <Link to={l.path} className="font-mono text-xs hover:underline">
                  {l.display_number}
                </Link>
                <span className="ml-1 text-xs text-muted-foreground">N.º {l.entry_number}</span>
              </TableCell>
              <TableCell className="min-w-56 text-sm whitespace-normal">{l.description}</TableCell>
              <TableCell className="tabular text-right">{l.debit ? money(l.debit) : ''}</TableCell>
              <TableCell className="tabular text-right">{l.credit ? money(l.credit) : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Detalle de una conciliación: lo que figuraba en el extracto y lo que quedó pendiente. */
export function ReconciliationLines({ view }: { view: ReconciliationView }) {
  return (
    <div className="flex flex-col gap-4">
      <Section
        title={`Pendientes al ${date(view.statement_date)} (${view.pending.length})`}
        description="Registrados en los libros pero todavía no en el extracto: entradas sin acreditar y pagos (cheques, transferencias) sin debitar. Explican la diferencia de saldos."
        bodyClassName="p-0"
      >
        <MovementTable lines={view.pending} empty="No quedó nada pendiente: libros y extracto coinciden." />
      </Section>
      <Section
        title={`Figuraban en el extracto (${view.reconciled.length})`}
        description="Movimientos del mayor que el banco ya había registrado."
        bodyClassName="p-0"
      >
        <MovementTable lines={view.reconciled} empty="Ningún movimiento nuevo figuraba en el extracto." />
      </Section>
    </div>
  )
}
