import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, HandCoins, Landmark, PiggyBank } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Field, InfoRow, KpiCard, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type BankLoansView, type LoanInstallmentRow, type LoanRow } from '@/lib/api'
import { LOAN_STATUSES } from '@/lib/domain/catalog'
import { date, money, parseAmount } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

export function useBankLoans() {
  const company = useCompany()
  return useQuery({
    queryKey: ['bank-loans', company.companyId],
    queryFn: () => api.bankLoans(company.companyId),
  })
}

/** Un indicador del pedido: "2,98", o "—" si no se pudo calcular. */
const ratio = (value: number | null) => (value === null ? '—' : value.toLocaleString('es-AR'))

/** Los indicadores del libro mayor con que el banco evalúa el pedido. */
export function LoanIndicators({ loan }: { loan: Pick<LoanRow, 'liquidity' | 'debt_ratio' | 'sales_share'> }) {
  return (
    <dl>
      <InfoRow label="Liquidez corriente">{ratio(loan.liquidity)}</InfoRow>
      <InfoRow label="Endeudamiento">{ratio(loan.debt_ratio)}</InfoRow>
      <InfoRow label="Cuota sobre las ventas del mes">
        {loan.sales_share === null ? 'Sin ventas en el mes' : `${ratio(loan.sales_share)} %`}
      </InfoRow>
    </dl>
  )
}

const installmentColumns = [
  { key: 'n', header: 'Cuota', cell: (r: LoanInstallmentRow) => <Mono>{r.n}</Mono> },
  { key: 'due', header: 'Vence', cell: (r: LoanInstallmentRow) => date(r.due_on) },
  {
    key: 'principal',
    header: 'Capital',
    align: 'right' as const,
    cell: (r: LoanInstallmentRow) => <span className="tabular">{money(r.principal)}</span>,
  },
  {
    key: 'interest',
    header: 'Intereses',
    align: 'right' as const,
    cell: (r: LoanInstallmentRow) => <span className="tabular">{money(r.interest)}</span>,
  },
  {
    key: 'total',
    header: 'Cuota',
    align: 'right' as const,
    cell: (r: LoanInstallmentRow) => <span className="tabular font-semibold">{money(r.total)}</span>,
  },
  {
    key: 'status',
    header: 'Estado',
    cell: (r: LoanInstallmentRow) =>
      r.status === 'DEBITADA' ? (
        <StatusBadge label={`Debitada el ${date(r.debited_on)}`} badge="success" />
      ) : r.due ? (
        <StatusBadge label="Vencida" badge="warning" />
      ) : (
        <StatusBadge label="Pendiente" badge="neutral" />
      ),
  },
]

function LoanCard({ loan }: { loan: LoanRow }) {
  const status = LOAN_STATUSES[loan.status]
  return (
    <Section
      title={`Préstamo N.º ${loan.number}`}
      description={loan.purpose}
      actions={<StatusBadge label={status.label} badge={status.badge} />}
      bodyClassName="p-0"
    >
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <dl>
          <InfoRow label="Importe">{money(loan.amount)}</InfoRow>
          <InfoRow label="Plazo">{loan.months} cuotas mensuales</InfoRow>
          {loan.rate !== null && <InfoRow label="Tasa nominal anual">{loan.rate.toLocaleString('es-AR')} %</InfoRow>}
          {loan.opening ? (
            <InfoRow label="Vigente desde">{date(loan.granted_on)}, el saldo inicial de la apertura</InfoRow>
          ) : (
            <InfoRow label="Pedido">
              {date(loan.requested_on)}
              {loan.requested_by_name ? ` · ${loan.requested_by_name}` : ''}
            </InfoRow>
          )}
          {loan.evaluated_on && (
            <InfoRow label={loan.status === 'RECHAZADO' ? 'Rechazado' : 'Aprobado'}>
              {date(loan.evaluated_on)} · {loan.evaluated_by_name ?? 'el sistema'}
            </InfoRow>
          )}
          {loan.rejection_reason && <InfoRow label="Motivo">{loan.rejection_reason}</InfoRow>}
          {loan.granted_on && <InfoRow label="Capital que falta">{money(loan.outstanding)}</InfoRow>}
        </dl>
        {/* El de la apertura no tuvo pedido: no tiene indicadores. */}
        {!loan.opening && <LoanIndicators loan={loan} />}
      </div>
      {loan.installments.length > 0 && (
        <DataTable<LoanInstallmentRow>
          rows={loan.installments}
          rowKey={(r) => String(r.n)}
          columns={installmentColumns}
        />
      )}
    </Section>
  )
}

/** Gerencia pide un préstamo: ve en el momento los indicadores con que lo va a evaluar el banco. */
function LoanRequestDialog({
  open,
  onOpenChange,
  view,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  view: BankLoansView
}) {
  const company = useCompany()
  const [amountText, setAmountText] = useState('')
  const [months, setMonths] = useState('12')
  const [purpose, setPurpose] = useState('')
  const amount = parseAmount(amountText)
  const valid = amount > 0 && amount <= view.max_amount
  const preview = useQuery({
    queryKey: ['loan-preview', company.companyId, amount, months],
    queryFn: () => api.loanPreview(company.companyId, amount, Number(months)),
    enabled: open && valid,
  })
  const send = useCommand(() => commands.requestLoan(company.companyId, { amount, months: Number(months), purpose }), {
    success: (r) =>
      r.status === 'SOLICITADO'
        ? `Préstamo N.º ${r.number} pedido: lo evalúa Tesorería desde la bandeja del banco.`
        : r.status === 'VIGENTE'
          ? `El banco aprobó el préstamo N.º ${r.number} y lo acreditó en la cuenta.`
          : `El banco rechazó el préstamo N.º ${r.number}: el motivo está en el préstamo.`,
    onSuccess: () => onOpenChange(false),
  })
  const p = preview.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pedir un préstamo al Banco Aula</DialogTitle>
          <DialogDescription>
            El pedido lleva los indicadores del libro mayor de hoy. Lo evalúa Tesorería, que opera el banco: si lo
            aprueba, el banco acredita el importe y debita una cuota por mes (sistema francés).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Importe" required hint={`Hasta ${money(view.max_amount)}.`}>
            <Input
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              inputMode="decimal"
              placeholder="1.000.000"
            />
          </Field>
          <Field label="Plazo" required>
            <SimpleSelect
              value={months}
              onChange={setMonths}
              options={view.terms.map((t) => ({ value: String(t), label: `${t} cuotas mensuales` }))}
              aria-label="Plazo"
            />
          </Field>
        </div>
        <Field label="Destino" required hint="Para qué lo usa la empresa: capital de trabajo, una máquina, etc.">
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} />
        </Field>
        <div className="rounded-lg border bg-muted/40 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            Lo que verá el banco (con su tasa de referencia, {view.reference_rate} % anual)
          </p>
          {valid && p ? (
            <dl>
              <InfoRow label="Cuota estimada">{money(p.installment)}</InfoRow>
              <InfoRow label="Ventas netas del mes">{money(p.sales)}</InfoRow>
            </dl>
          ) : null}
          {valid && p ? (
            <LoanIndicators loan={p} />
          ) : (
            <p className="py-2 text-sm text-muted-foreground">Escribí el importe para ver los indicadores.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Volver
          </Button>
          <Button disabled={send.isPending || !valid || purpose.trim().length < 3} onClick={() => send.mutate([])}>
            {send.isPending ? 'Enviando…' : 'Pedir el préstamo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Pagos y tesorería → Préstamos: los préstamos de la empresa en el Banco Aula (8c), con su estado, el
 * capital que falta y el cronograma. Gerencia pide uno nuevo viendo los indicadores del libro mayor.
 */
export function LoansPage() {
  const company = useCompany()
  const { data: view, isLoading, error } = useBankLoans()
  const [asking, setAsking] = useState(false)
  const crumbs = [{ label: 'Inicio', to: company.to() }, { label: 'Pagos y tesorería' }, { label: 'Préstamos' }]
  if (isLoading || error || !view) return <Loading error={error} />
  const current = view.loans.filter((l) => l.status === 'VIGENTE')
  const next = current
    .flatMap((l) => l.installments.filter((i) => i.status === 'PENDIENTE').map((i) => ({ loan: l, i })))
    .sort((a, b) => (a.i.due_on < b.i.due_on ? -1 : a.i.due_on > b.i.due_on ? 1 : 0))[0]
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Préstamos"
        description="Los préstamos de la empresa en el Banco Aula. Gerencia los pide con los indicadores del libro mayor, Tesorería (que opera el banco) los evalúa y, si los aprueba, el banco acredita el importe y debita cada cuota al vencer. Contabilidad registra la acreditación y las cuotas desde la conciliación."
        actions={
          company.can('loan.create') && (
            <Button onClick={() => setAsking(true)}>
              <HandCoins /> Pedir un préstamo
            </Button>
          )
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Capital que se debe"
          value={money(current.reduce((s, l) => s + l.outstanding, 0))}
          icon={PiggyBank}
          hint={`${current.length} ${current.length === 1 ? 'préstamo vigente' : 'préstamos vigentes'}`}
        />
        <KpiCard
          label="Próxima cuota"
          value={next ? money(next.i.total) : '—'}
          icon={CalendarClock}
          hint={next ? `Préstamo N.º ${next.loan.number}, vence el ${date(next.i.due_on)}` : 'No hay cuotas por vencer'}
        />
        <KpiCard
          label="Tasa de referencia"
          value={`${view.reference_rate} % anual`}
          icon={Landmark}
          hint="La que propone el banco"
        />
      </div>
      {view.loans.length ? (
        <div className="space-y-4">
          {view.loans.map((loan) => (
            <LoanCard key={loan.id} loan={loan} />
          ))}
        </div>
      ) : (
        <EmptyState icon={HandCoins} title="La empresa no tiene préstamos">
          Gerencia puede pedir uno al Banco Aula.
        </EmptyState>
      )}
      {company.can('loan.create') && <LoanRequestDialog open={asking} onOpenChange={setAsking} view={view} />}
    </>
  )
}

/** En la bandeja: quien opera el banco aprueba (con la tasa y el plazo) o rechaza (con el motivo) un pedido. */
function LoanEvaluation({ loan, view }: { loan: LoanRow; view: BankLoansView }) {
  const company = useCompany()
  const [rate, setRate] = useState(String(view.reference_rate))
  const [months, setMonths] = useState(String(loan.months))
  const [reason, setReason] = useState('')
  const decide = useCommand(
    (approve: boolean) =>
      commands.evaluateLoan(
        loan.id,
        approve ? { approve: true, rate: parseAmount(rate), months: Number(months) } : { approve: false, reason },
      ),
    {
      success: (r) =>
        r.status === 'VIGENTE'
          ? `Préstamo N.º ${loan.number} aprobado: el banco acreditó ${money(loan.amount)}.`
          : `Préstamo N.º ${loan.number} rechazado: Gerencia recibe el motivo.`,
    },
  )
  // Con la separación de funciones, quien pidió el préstamo no lo evalúa (el docente, sí).
  const blocked = loan.own && company.company.settings.sod_enabled && !company.supervisor
  return (
    <div className="grid gap-4 p-4 md:grid-cols-2">
      <div>
        <p className="text-sm font-medium">
          Préstamo N.º {loan.number}: {money(loan.amount)} en {loan.months} cuotas
        </p>
        <p className="text-sm text-muted-foreground">
          {loan.purpose} · pedido el {date(loan.requested_on)}
          {loan.requested_by_name ? ` por ${loan.requested_by_name}` : ''}
        </p>
        <LoanIndicators loan={loan} />
      </div>
      {blocked ? (
        <p className="text-sm text-muted-foreground">Lo pediste vos: lo evalúa otro integrante de Tesorería.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tasa nominal anual (%)">
              <Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Plazo">
              <SimpleSelect
                value={months}
                onChange={setMonths}
                options={view.terms.map((t) => ({ value: String(t), label: `${t} cuotas` }))}
                aria-label="Plazo"
              />
            </Field>
          </div>
          <Button disabled={decide.isPending} onClick={() => decide.mutate([true])}>
            Aprobar y acreditar
          </Button>
          <Field label="Motivo del rechazo">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lo recibe Gerencia" />
          </Field>
          <Button
            variant="outline"
            disabled={decide.isPending || reason.trim().length < 3}
            onClick={() => decide.mutate([false])}
          >
            Rechazar
          </Button>
        </div>
      )}
    </div>
  )
}

/** Las secciones de los préstamos en la bandeja del banco: los pedidos para evaluar y las cuotas vencidas. */
export function LoanTraySections() {
  const company = useCompany()
  const { data: view } = useBankLoans()
  const debit = useCommand(() => commands.debitLoanInstallments(company.companyId), {
    success: (r) => (r.debited === 1 ? 'Cuota debitada de la cuenta.' : `${r.debited} cuotas debitadas de la cuenta.`),
  })
  if (!view) return null
  const waiting = view.loans.filter((l) => l.status === 'SOLICITADO')
  const due = view.loans.flatMap((l) => l.installments.filter((i) => i.due).map((i) => ({ loan: l, i })))
  return (
    <>
      {waiting.length > 0 && (
        <Section
          title="Préstamos para evaluar"
          description="Gerencia los pidió con los indicadores del libro mayor de ese día. Al aprobarlo, el banco acredita el importe con la fecha de hoy y arma el cronograma por sistema francés."
          bodyClassName="p-0 divide-y"
        >
          {waiting.map((loan) =>
            company.can('bank.operate') ? (
              <LoanEvaluation key={loan.id} loan={loan} view={view} />
            ) : (
              <div key={loan.id} className="p-4 text-sm">
                Préstamo N.º {loan.number}: {money(loan.amount)} en {loan.months} cuotas
              </div>
            ),
          )}
        </Section>
      )}
      {due.length > 0 && (
        <Section
          title="Cuotas vencidas"
          description="El banco las debita con la fecha de hoy, en dos movimientos (capital e intereses), aunque no haya fondos. Contabilidad las registra desde la conciliación."
          actions={
            company.can('bank.operate') && (
              <Button disabled={debit.isPending} onClick={() => debit.mutate([])}>
                Debitar las cuotas vencidas
              </Button>
            )
          }
          bodyClassName="p-0"
        >
          <ul className="divide-y text-sm">
            {due.map(({ loan, i }) => (
              <li key={`${loan.id}-${i.n}`} className="flex items-center justify-between gap-3 px-4 py-2">
                <span>
                  Préstamo N.º {loan.number} · cuota {i.n} de {loan.months} · venció el {date(i.due_on)}
                </span>
                <span className="tabular">{money(i.total)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}
