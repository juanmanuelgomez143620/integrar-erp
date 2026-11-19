import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { BookOpen } from 'lucide-react'
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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { commands, type DocumentDetail } from '@/lib/api'
import { FISCO_DEFAULTS, IIBB_DEFAULT_PCT } from '@/lib/domain/catalog'
import type { TaxCode } from '@/lib/domain/types'
import { date, lastMonthAR, money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
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

/**
 * La declaración en el fisco simulado (Fase 8e.1): si espera que la reciba, el acuse con que la aceptó
 * o el motivo con que la observó, y el control cruzado que hizo con los comprobantes que autorizó. Desde
 * la 8e.2, el pago: los intereses a la fecha si venció, la orden en el Banco Aula y la imputación.
 */
export function TaxReturnFiscoSection({ detail }: { detail: DocumentDetail }) {
  const { doc } = detail
  const tr = doc.tr
  const view = detail.tax_return
  if (!tr?.presented_at) return null
  const iva = tr.tax === 'IVA'
  const declared = iva ? tr.tax_amount : (tr.base ?? 0)
  const matches = tr.control_amount !== null && Math.abs(declared - tr.control_amount) < 0.005
  const reception =
    doc.status === 'ENVIADA' ? (
      'Enviada: espera que el fisco la reciba (la recibe un integrante de Impuestos que no la preparó ni la presentó).'
    ) : doc.status === 'OBSERVADA' ? (
      <>
        Observada el {date(tr.received_on)} con este motivo: «{doc.status_reason}». Hay que anularla y presentarla de
        nuevo.
      </>
    ) : tr.transaction_code ? (
      <>
        Aceptada el {date(tr.received_on)} con el acuse <span className="font-mono">{tr.transaction_code}</span>
        {tr.received_by ? '' : ' (la recibió el sistema)'}.
      </>
    ) : doc.status === 'ANULADA' ? (
      'Anulada.'
    ) : (
      'Presentada antes de que existiera el fisco simulado: no tiene acuse.'
    )
  const order = view?.bank_order
  const late = view?.interest_to_date
  const payment =
    !view || view.amount_due <= 0 ? null : doc.status === 'PRESENTADA' ? (
      late ? (
        <>
          Venció el {date(view.due_date)}: a hoy suma {money(late.interest)} de intereses resarcitorios ({late.days}{' '}
          {late.days === 1 ? 'día' : 'días'} de atraso, {FISCO_DEFAULTS.interest_rate} % mensual), que se pagan con el
          impuesto.
        </>
      ) : (
        <>Vence el {date(view.due_date)}: después, se paga con intereses resarcitorios.</>
      )
    ) : doc.status === 'PAGO_EN_BANCO' ? (
      order?.status === 'RECHAZADO' ? (
        <>
          El Banco Aula rechazó la orden N.º {order.seq} por falta de fondos
          {order.processed_on ? ` el ${date(order.processed_on)}` : ''}: el fisco no imputó nada. Tesorería la reenvía
          desde la bandeja del banco cuando haya fondos.
        </>
      ) : (
        <>
          Enviado al Banco Aula el {date(view.paid_on)}
          {order ? ` (orden N.º ${order.seq})` : ''}: el fisco lo imputa cuando el banco procesa la orden.
        </>
      )
    ) : view.imputed_on ? (
      <>
        Imputado el {date(view.imputed_on)}: {money(view.amount_due + view.interest)}
        {view.interest > 0 && <> (con {money(view.interest)} de intereses resarcitorios)</>}
        {order?.transaction_number && (
          <>
            , transacción <span className="font-mono">{order.transaction_number}</span> del Banco Aula
          </>
        )}
        .
      </>
    ) : null
  return (
    <Section
      title="En el fisco simulado"
      description="Al presentarla, la declaración va al fisco, que la controla con los comprobantes de venta que autorizó en el mes y la acepta con un acuse o la observa con el motivo."
    >
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[180px_1fr]">
        <dt className="text-muted-foreground">Recepción</dt>
        <dd>{reception}</dd>
        {tr.control_amount !== null && (
          <>
            <dt className="text-muted-foreground">Control cruzado</dt>
            <dd>
              {iva ? 'Débito fiscal declarado' : 'Base declarada'}: {money(declared)}. {iva ? 'IVA' : 'Ventas netas'} de
              los comprobantes autorizados del mes (menos los anulados en el mes): {money(tr.control_amount)}.{' '}
              {matches ? 'Coinciden.' : 'No coinciden.'}
            </dd>
          </>
        )}
        {payment && (
          <>
            <dt className="text-muted-foreground">Pago</dt>
            <dd>{payment}</dd>
          </>
        )}
      </dl>
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

/**
 * Tesorería paga el saldo de la declaración (Fase 8e.2): por transferencia desde el Banco Aula, con los
 * intereses resarcitorios si ya venció. El fisco lo imputa cuando el banco procesa la orden.
 */
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
  const late = view.interest_to_date
  const total = view.amount_due + (late?.interest ?? 0)
  const run = useCommand(() => commands.payTaxReturn(detail.doc.id), {
    success: 'Pago enviado al Banco Aula: el fisco lo imputa cuando el banco procesa la orden.',
    onSuccess: () => onOpenChange(false),
  })
  const row = (label: string, amount: number, strong = false) => (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold text-navy' : ''}`}>
      <span>{label}</span>
      <span className="tabular">{money(amount)}</span>
    </div>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pagar {detail.doc.display_number}</DialogTitle>
          <DialogDescription>
            {view.tax === 'IVA' ? 'El IVA' : 'Ingresos brutos'} de {periodLabel(view.period)}, que vence el{' '}
            {date(view.due_date)}. Sale por transferencia desde la cuenta de la empresa en el Banco Aula: se registra el
            asiento del pago y la orden llega al banco; el fisco lo imputa cuando el banco la procesa.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 text-sm">
          {row('Saldo de la declaración', view.amount_due)}
          {late && (
            <>
              {row(
                `Intereses resarcitorios (${late.days} ${late.days === 1 ? 'día' : 'días'} de atraso, ${FISCO_DEFAULTS.interest_rate} % mensual)`,
                late.interest,
              )}
            </>
          )}
          {row('Total de la transferencia', total, true)}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            Volver
          </Button>
          <Button disabled={run.isPending} onClick={() => run.mutate([])}>
            {run.isPending ? 'Procesando…' : `Pagar ${money(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * La multa del fisco (Fase 8f.2): por qué se aplicó, cuánto es y hasta cuándo vale la reducción, y el
 * pago (la orden en el banco o la imputación).
 */
export function TaxFineSection({ detail }: { detail: DocumentDetail }) {
  const { doc } = detail
  const view = detail.tax_fine
  if (!view) return null
  const order = view.bank_order
  const payment =
    doc.status === 'NOTIFICADA' ? (
      <>
        Sin pagar: {money(view.reduced_amount)} (la mitad) hasta el {date(view.reduction_until)}; después,{' '}
        {money(view.amount)}.
      </>
    ) : doc.status === 'PAGO_EN_BANCO' ? (
      order?.status === 'RECHAZADO' ? (
        <>
          El Banco Aula rechazó la orden N.º {order.seq} por falta de fondos: Tesorería la reenvía desde la bandeja del
          banco cuando haya fondos.
        </>
      ) : (
        <>
          Enviado al Banco Aula el {date(view.paid_on)}
          {order ? ` (orden N.º ${order.seq})` : ''}: {money(view.amount_due)}. El fisco lo imputa cuando el banco
          procesa la orden.
        </>
      )
    ) : (
      <>
        Imputado el {date(view.imputed_on)}: {money(view.amount_due)}
        {order?.transaction_number && (
          <>
            , transacción <span className="font-mono">{order.transaction_number}</span> del Banco Aula
          </>
        )}
        .
      </>
    )
  return (
    <Section
      title="Multa por presentar fuera de término"
      description="El fisco la aplica en el momento en que acepta una declaración presentada después de su vencimiento, una por impuesto y mes. Si se paga dentro de los 15 días de notificada, se paga la mitad (simulada: a validar)."
    >
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[180px_1fr]">
        <dt className="text-muted-foreground">Declaración</dt>
        <dd>
          <Link to={view.tax_return.path} className="font-medium text-primary hover:underline">
            {view.tax_return.display_number}
          </Link>{' '}
          ({taxTitle(view.tax, view.period)}): vencía el {date(view.due_date)} y se presentó el{' '}
          {date(view.presented_on)}.
        </dd>
        <dt className="text-muted-foreground">Importe</dt>
        <dd>
          {money(view.amount)}; {money(view.reduced_amount)} si se paga hasta el {date(view.reduction_until)}.
        </dd>
        <dt className="text-muted-foreground">Pago</dt>
        <dd>{payment}</dd>
      </dl>
    </Section>
  )
}

/** Tesorería paga la multa por transferencia desde el Banco Aula (Fase 8f.2). */
export function TaxFinePayDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: DocumentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const view = detail.tax_fine!
  const reduced = view.amount_due < view.amount
  const run = useCommand(() => commands.payTaxFine(detail.doc.id), {
    success: 'Pago enviado al Banco Aula: el fisco lo imputa cuando el banco procesa la orden.',
    onSuccess: () => onOpenChange(false),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pagar {detail.doc.display_number}</DialogTitle>
          <DialogDescription>
            La multa por presentar fuera de término {view.tax_return.display_number} ({taxTitle(view.tax, view.period)}
            ). Sale por transferencia desde la cuenta de la empresa en el Banco Aula: se registra el asiento del pago y
            la orden llega al banco; el fisco lo imputa cuando el banco la procesa.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 text-sm">
          <div className="flex justify-between gap-4">
            <span>Multa</span>
            <span className="tabular">{money(view.amount)}</span>
          </div>
          {reduced && (
            <div className="flex justify-between gap-4">
              <span>Reducción a la mitad (hasta el {date(view.reduction_until)})</span>
              <span className="tabular">{money(view.amount_due - view.amount)}</span>
            </div>
          )}
          <div className="flex justify-between gap-4 font-semibold text-navy">
            <span>Total de la transferencia</span>
            <span className="tabular">{money(view.amount_due)}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            Volver
          </Button>
          <Button disabled={run.isPending} onClick={() => run.mutate([])}>
            {run.isPending ? 'Procesando…' : `Pagar ${money(view.amount_due)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
