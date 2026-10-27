import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableRow } from '@/components/ui/table'
import { Field, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { commands, type DocumentDetail } from '@/lib/api'
import type { TaxCode } from '@/lib/domain/types'
import { date, lastMonthAR, money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { TreasuryPayDialog } from '@/features/payables/treasury-pay-dialog'
import { periodLabel } from '@/features/hr/payroll'

/** Lo que se resta (sin mostrar "-$ 0,00" cuando es cero). */
const minus = (amount: number) => (amount ? -amount : 0)

/** "IVA de 09/2026": el título de una declaración. */
export const taxTitle = (tax: TaxCode, period: string) =>
  `${tax === 'IVA' ? 'IVA' : 'Ingresos brutos'} de ${periodLabel(period)}`

/** De dónde sale lo que se paga o queda a favor: los libros IVA del mes (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §2). */
export function TaxReturnSection({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const view = detail.tax_return!
  const result = view.tax_amount - view.credits - view.previous_balance
  const book = (libro: 'ventas' | 'compras') => company.to(`impuestos/libros-iva?mes=${view.period}&libro=${libro}`)
  const row = (label: string, amount: number, hint?: string) => (
    <TableRow>
      <TableCell className="text-sm">
        {label}
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </TableCell>
      <TableCell className="tabular text-right">{money(amount)}</TableCell>
    </TableRow>
  )
  return (
    <Section
      title="Liquidación del impuesto"
      description={`Sale de los libros IVA de ${periodLabel(view.period)}: el IVA que se facturó a los clientes menos el que facturaron los proveedores con letra A, y el saldo a favor que dejó la declaración anterior.`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link to={book('ventas')}>
              <BookOpen /> Libro IVA ventas
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to={book('compras')}>
              <BookOpen /> Libro IVA compras
            </Link>
          </Button>
        </div>
      }
      bodyClassName="p-0"
    >
      <Table>
        <TableBody>
          {row('Débito fiscal del mes', view.tax_amount, 'IVA de las facturas de venta del mes (las anuladas restan)')}
          {row('Crédito fiscal del mes', minus(view.credits), 'IVA de las facturas de proveedores con letra A del mes')}
          {row('Saldo a favor de la declaración anterior', minus(view.previous_balance))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-sm font-semibold text-navy">
              {result > 0 ? 'Saldo a pagar' : 'Saldo a favor para el mes siguiente'}
            </TableCell>
            <TableCell className="tabular text-right font-semibold text-navy">{money(Math.abs(result))}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </Section>
  )
}

/** Impuestos prepara la declaración de un mes terminado. */
export function TaxReturnFormPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const [period, setPeriod] = useState(lastMonthAR())
  const [notes, setNotes] = useState('')
  const create = useCommand(() => commands.createTaxReturn(company.companyId, { tax: 'IVA', period, notes }), {
    success: (r) => `${r.display_number} preparada: revisala y presentala.`,
    onSuccess: (r) => navigate(company.docPath('TAX_RETURN', r.display_number)),
  })
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Impuestos' },
          { label: 'Declaraciones de impuestos', to: company.docPath('TAX_RETURN') },
          { label: 'Nueva' },
        ]}
        title="Nueva declaración de IVA"
        description="Se calcula con los libros IVA del mes, que tiene que haber terminado: el débito fiscal de las ventas menos el crédito fiscal de las compras y el saldo a favor de la declaración anterior. Simulada: el fisco no es real."
      />
      <Section className="max-w-xl">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Impuesto">
            <Input value="IVA" readOnly className="bg-muted/40" />
          </Field>
          <Field label="Mes" required hint="Los meses van en orden, desde la primera declaración.">
            <Input type="month" value={period} max={lastMonthAR()} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
          <Field label="Observaciones" className="sm:col-span-2">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Opcional" />
          </Field>
        </div>
        <div className="mt-4 flex gap-2">
          <Button disabled={!period || create.isPending} onClick={() => create.mutate([])}>
            {create.isPending ? 'Preparando…' : 'Preparar la declaración'}
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancelar
          </Button>
        </div>
      </Section>
    </>
  )
}

/** Tesorería paga el saldo de la declaración al fisco (simulado). */
export function TaxReturnPayDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: DocumentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const view = detail.tax_return!
  return (
    <TreasuryPayDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Pagar ${detail.doc.display_number}`}
      description={`El ${taxTitle(view.tax, view.period)}: ${money(view.amount_due)}, que vence el ${date(view.due_date)}.`}
      amount={view.amount_due}
      pay={(accountId) => commands.payTaxReturn(detail.doc.id, accountId)}
      success="Impuesto pagado: la declaración quedó pagada."
    />
  )
}
