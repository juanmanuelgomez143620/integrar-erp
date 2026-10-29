import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { commands, type DocumentDetail } from '@/lib/api'
import { IIBB_DEFAULT_PCT } from '@/lib/domain/catalog'
import type { TaxCode } from '@/lib/domain/types'
import { date, lastMonthAR, money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { TreasuryPayDialog } from '@/features/payables/treasury-pay-dialog'
import { periodLabel, rate } from '@/features/hr/payroll'

/** Lo que se resta (sin mostrar "-$ 0,00" cuando es cero). */
const minus = (amount: number) => (amount ? -amount : 0)

const numberOf = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : Number.NaN
}

/** "IVA de 09/2026": el título de una declaración. */
export const taxTitle = (tax: TaxCode, period: string) =>
  `${tax === 'IVA' ? 'IVA' : 'Ingresos brutos'} de ${periodLabel(period)}`

/**
 * De dónde sale lo que se paga o queda a favor (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md
 * §2 y §3): en el IVA, los libros IVA del mes; en ingresos brutos, las ventas netas del mes y
 * las percepciones y retenciones sufridas.
 */
export function TaxReturnSection({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const view = detail.tax_return!
  const iva = view.tax === 'IVA'
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
  const bookLink = (libro: 'ventas' | 'compras') => (
    <Button size="sm" variant="outline" asChild>
      <Link to={book(libro)}>
        <BookOpen /> Libro IVA {libro}
      </Link>
    </Button>
  )
  return (
    <Section
      title="Liquidación del impuesto"
      description={
        iva
          ? `Sale de los libros IVA de ${periodLabel(view.period)}: el IVA que se facturó a los clientes menos el que facturaron los proveedores con letra A, y el saldo a favor que dejó la declaración anterior.`
          : `La alícuota de la empresa (${rate(view.rate ?? 0)}) sobre las ventas netas de ${periodLabel(view.period)} (el neto gravado y lo exento del libro IVA ventas), menos las percepciones y retenciones sufridas en el mes y el saldo a favor que dejó la declaración anterior.`
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {bookLink('ventas')}
          {iva && bookLink('compras')}
        </div>
      }
      bodyClassName="p-0"
    >
      <Table>
        <TableBody>
          {iva ? (
            <>
              {row(
                'Débito fiscal del mes',
                view.tax_amount,
                'IVA de las facturas de venta del mes (las anuladas restan)',
              )}
              {row(
                'Crédito fiscal del mes',
                minus(view.credits),
                'IVA de las facturas de proveedores con letra A del mes',
              )}
            </>
          ) : (
            <>
              {row(
                'Ventas netas del mes',
                view.base ?? 0,
                'Neto gravado y exento de las facturas de venta del mes (las anuladas restan)',
              )}
              {row(`Impuesto: ${rate(view.rate ?? 0)} de las ventas netas`, view.tax_amount)}
              {row(
                'Percepciones y retenciones del mes',
                minus(view.credits),
                'Las que cobraron los proveedores en sus facturas y las que retuvieron los clientes al pagar',
              )}
            </>
          )}
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
      {!iva && view.withholdings.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-9 text-xs">Fecha</TableHead>
              <TableHead className="h-9 text-xs">Comprobante</TableHead>
              <TableHead className="h-9 text-xs">De quién</TableHead>
              <TableHead className="h-9 text-right text-xs">Importe</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.withholdings.map((w) => (
              <TableRow key={`${w.source.id}-${w.sign}`}>
                <TableCell className="text-sm">{date(w.entry_date)}</TableCell>
                <TableCell className="text-sm">
                  <Link to={w.source.path} className="font-medium text-primary hover:underline">
                    {w.source.display_number}
                  </Link>
                  {w.voucher !== w.source.display_number && (
                    <span className="text-muted-foreground"> · factura {w.voucher}</span>
                  )}
                  {w.sign < 0 && <span className="text-muted-foreground"> · anulada</span>}
                </TableCell>
                <TableCell className="text-sm">
                  {w.counterparty}
                  <div className="text-xs text-muted-foreground">
                    {w.kind === 'PERCEPCION' ? 'Percepción del proveedor' : 'Retención del cliente'}
                  </div>
                </TableCell>
                <TableCell className="tabular text-right">{money(w.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

const TAX_OPTIONS: { value: TaxCode; label: string }[] = [
  { value: 'IVA', label: 'IVA' },
  { value: 'IIBB', label: 'Ingresos brutos' },
]

/** Impuestos prepara la declaración de un mes terminado. */
export function TaxReturnFormPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const [tax, setTax] = useState<TaxCode>('IVA')
  const [period, setPeriod] = useState(lastMonthAR())
  const [notes, setNotes] = useState('')
  const create = useCommand(() => commands.createTaxReturn(company.companyId, { tax, period, notes }), {
    success: (r) => `${r.display_number} preparada: revisala y presentala.`,
    onSuccess: (r) => navigate(company.docPath('TAX_RETURN', r.display_number)),
  })
  const iibbPct = company.company.settings.iibb_pct ?? IIBB_DEFAULT_PCT
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Impuestos' },
          { label: 'Declaraciones de impuestos', to: company.docPath('TAX_RETURN') },
          { label: 'Nueva' },
        ]}
        title="Nueva declaración de impuestos"
        description="Se prepara para un mes que ya terminó. IVA: el débito fiscal de las ventas menos el crédito fiscal de las compras (los libros IVA). Ingresos brutos: la alícuota sobre las ventas netas, menos las percepciones y retenciones sufridas. En los dos, menos el saldo a favor de la declaración anterior. Simulada: el fisco no es real."
      />
      <Section className="max-w-xl">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Impuesto"
            required
            hint={
              tax === 'IIBB'
                ? `Alícuota de la empresa: ${rate(iibbPct)} (la cambia el docente).`
                : 'Débito menos crédito.'
            }
          >
            <SimpleSelect value={tax} onChange={setTax} options={TAX_OPTIONS} aria-label="Impuesto" />
          </Field>
          <Field label="Mes" required hint="Los meses van en orden, desde la primera declaración de cada impuesto.">
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
      description={`${view.tax === 'IVA' ? 'El IVA' : 'Ingresos brutos'} de ${periodLabel(view.period)}: ${money(view.amount_due)}, que vence el ${date(view.due_date)}.`}
      amount={view.amount_due}
      pay={(accountId) => commands.payTaxReturn(detail.doc.id, accountId)}
      success="Impuesto pagado: la declaración quedó pagada."
    />
  )
}

/** El docente fija la alícuota de ingresos brutos de la empresa (a validar). */
export function IibbRateSection() {
  const company = useCompany()
  const current = company.company.settings.iibb_pct ?? IIBB_DEFAULT_PCT
  const [value, setValue] = useState(() => String(current).replace('.', ','))
  const parsed = numberOf(value)
  const valid = parsed >= 0 && parsed <= 100
  const save = useCommand(() => commands.updateCompanySettings(company.companyId, { iibb_pct: parsed }), {
    success: 'Alícuota guardada: se usa en las declaraciones nuevas de ingresos brutos.',
  })
  return (
    <Section
      title="Impuestos"
      description="La alícuota de ingresos brutos simplificado sobre las ventas netas de cada mes (a validar: simulada, sin el detalle por actividad ni el convenio entre provincias). Cada declaración guarda la suya: cambiarla no altera las ya preparadas."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Ingresos brutos (%)"
          hint="Sobre las ventas netas de IVA del mes."
          error={!valid ? 'De 0 a 100.' : undefined}
        >
          <Input
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="tabular text-right"
          />
        </Field>
      </div>
      <Button
        className="mt-3"
        disabled={!valid || parsed === current || save.isPending}
        onClick={() => save.mutate([])}
      >
        {save.isPending ? 'Guardando…' : 'Guardar la alícuota'}
      </Button>
    </Section>
  )
}
