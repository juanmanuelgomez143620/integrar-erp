import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Clock, Inbox, Landmark, Scale, Vault } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable, type Column } from '@/components/common/data-table'
import { EmptyState, InfoRow, KpiCard, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type BankAccountView, type BankMovementRow } from '@/lib/api'
import { BANK_MODES } from '@/lib/domain/catalog'
import { periodLabel } from '@/features/hr/payroll'
import { date, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { StatementSection } from './bank-statement'
import { LoanTraySections } from './loans-page'

function useBankAccount() {
  const company = useCompany()
  return useQuery({
    queryKey: ['bank-account', company.companyId],
    queryFn: () => api.bankAccount(company.companyId),
  })
}

/** La operación de la empresa: un enlace si quien mira la puede leer. */
function SourceCell({ row }: { row: BankMovementRow }) {
  if (!row.source) return <span className="text-muted-foreground">—</span>
  return (
    <Link to={row.source.path} className="font-mono text-xs text-brand-blue hover:underline">
      {row.source.display_number}
    </Link>
  )
}

const amountColumns: Column<BankMovementRow>[] = [
  {
    key: 'debit',
    header: 'Débito',
    align: 'right',
    cell: (r) => <span className="tabular">{r.direction === 'DEBITO' ? money(r.amount) : ''}</span>,
  },
  {
    key: 'credit',
    header: 'Crédito',
    align: 'right',
    cell: (r) => <span className="tabular">{r.direction === 'CREDITO' ? money(r.amount) : ''}</span>,
  },
]

/** El concepto de una orden y, si es un cheque, su número y cuándo se presenta al cobro. */
function OrderConcept({ row }: { row: BankMovementRow }) {
  return (
    <div className="whitespace-normal">
      {row.concept}
      {row.cheque_number && (
        <div className="text-xs text-muted-foreground">
          Cheque N.º {row.cheque_number} · {row.unpresented ? 'se presenta al cobro' : 'presentado'} el{' '}
          {date(row.presented_on)}
        </div>
      )}
    </div>
  )
}

/** Lo que llegó al banco y todavía no procesó. */
function pendingColumns(withSource: boolean): Column<BankMovementRow>[] {
  return [
    { key: 'seq', header: 'Orden', cell: (r) => <Mono>N.º {r.seq}</Mono> },
    { key: 'received', header: 'Llegó', cell: (r) => date(r.received_on) },
    { key: 'concept', header: 'Concepto', cell: (r) => <OrderConcept row={r} /> },
    {
      key: 'ordered_by',
      header: 'Envió',
      cell: (r) => (
        <span className="whitespace-normal">
          {r.ordered_by_name ?? '—'}
          {r.own && (
            <>
              {' '}
              <StatusBadge label="Vos" badge="info" />
            </>
          )}
        </span>
      ),
    },
    ...(withSource
      ? [{ key: 'source', header: 'Operación', cell: (r: BankMovementRow) => <SourceCell row={r} /> }]
      : []),
    ...amountColumns,
  ]
}

/** Lo que el banco rechazó por falta de fondos: la empresa anula la operación o, con fondos, la reenvía. */
function rejectedColumns(action?: Column<BankMovementRow>): Column<BankMovementRow>[] {
  return [
    { key: 'seq', header: 'Orden', cell: (r) => <Mono>N.º {r.seq}</Mono> },
    { key: 'rejected', header: 'Rechazada', cell: (r) => date(r.processed_on) },
    { key: 'concept', header: 'Concepto', cell: (r) => <OrderConcept row={r} /> },
    { key: 'source', header: 'Operación', cell: (r) => <SourceCell row={r} /> },
    {
      key: 'amount',
      header: 'Importe',
      align: 'right',
      cell: (r) => <span className="tabular">{money(r.amount)}</span>,
    },
    ...(action ? [action] : []),
  ]
}

const REJECTED_HELP =
  'El banco no las debitó (superaban el saldo más el acuerdo de descubierto) y cobró la comisión por rechazo. Tesorería anula la operación y vuelve a pagar o, cuando haya fondos, la reenvía: vuelve a la bandeja y la procesa otro integrante de Tesorería.'

/** Lo procesado, con el saldo de cada momento: como en un extracto. */
function movementColumns(withSource: boolean): Column<BankMovementRow>[] {
  return [
    { key: 'date', header: 'Fecha', sort: (r) => r.processed_on ?? '', cell: (r) => date(r.processed_on) },
    {
      key: 'transaction',
      header: 'Transacción',
      cell: (r) => (r.transaction_number ? <Mono>{r.transaction_number}</Mono> : '—'),
    },
    {
      key: 'concept',
      header: 'Concepto',
      cell: (r) => (
        <div className="whitespace-normal">
          {r.concept}
          {r.origin === 'BANCO' && (
            <>
              {' '}
              {/* Lo que el banco hizo por su cuenta: un cargo, o un préstamo y sus cuotas (8c). */}
              {r.charge === 'PRESTAMO' ? (
                <StatusBadge label="Préstamo" badge="info" />
              ) : r.charge === 'CUOTA_CAPITAL' || r.charge === 'CUOTA_INTERES' ? (
                <StatusBadge label="Cuota de préstamo" badge="info" />
              ) : (
                <StatusBadge label="Cargo del banco" badge="warning" />
              )}
            </>
          )}
          {r.processed_by_name && <div className="text-xs text-muted-foreground">Procesó {r.processed_by_name}</div>}
        </div>
      ),
    },
    ...(withSource
      ? [{ key: 'source', header: 'Operación', cell: (r: BankMovementRow) => <SourceCell row={r} /> }]
      : []),
    ...amountColumns,
    {
      key: 'balance',
      header: 'Saldo',
      align: 'right',
      cell: (r) => (
        <span className={cn('tabular font-semibold', (r.balance ?? 0) < 0 && 'text-red-700')}>
          {money(r.balance ?? 0)}
        </span>
      ),
    },
  ]
}

function AccountData({ view }: { view: BankAccountView }) {
  const { account } = view
  return (
    <Section title="La cuenta" description="Datos de formato propio del Banco Aula: no son los de un banco real.">
      <dl>
        <InfoRow label="Cuenta corriente">
          <Mono>{account.number}</Mono>
        </InfoRow>
        <InfoRow label="Clave bancaria simulada">
          <Mono>{account.bank_key}</Mono>
        </InfoRow>
        <InfoRow label="Alias">
          <Mono>{account.alias}</Mono>
        </InfoRow>
        <InfoRow label="Abierta el">{date(account.opened_on)}</InfoRow>
        <InfoRow label="Acuerdo de descubierto">{money(account.overdraft_limit)}</InfoRow>
        <InfoRow label="Comisión de mantenimiento">{money(account.monthly_fee)} por mes</InfoRow>
        <InfoRow label="Intereses por descubierto">{account.overdraft_rate} % mensual</InfoRow>
        <InfoRow label="En los libros">
          {account.ledger.code} {account.ledger.name}
        </InfoRow>
        <InfoRow label="Quién opera el banco">{BANK_MODES[view.mode].label}</InfoRow>
      </dl>
    </Section>
  )
}

/**
 * Pagos y tesorería → Banco Aula: la cuenta de la empresa vista desde el banco (el homebanking). El
 * saldo según el banco sale de lo que procesó; lo enviado que todavía no procesó espera aparte.
 */
export function HomeBankingPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const { data: view, isLoading, error } = useBankAccount()
  const crumbs = [{ label: 'Inicio', to: company.to() }, { label: 'Pagos y tesorería' }, { label: 'Banco Aula' }]
  if (isLoading || error) return <Loading error={error} />
  if (!view)
    return (
      <>
        <PageHeader crumbs={crumbs} title="Banco Aula" />
        <EmptyState icon={Vault} title="La empresa no tiene cuenta en el Banco Aula">
          La cuenta se abre con la cuenta contable Banco cuenta corriente.
        </EmptyState>
      </>
    )
  const pendingNet = view.pending.reduce((s, r) => s + (r.direction === 'CREDITO' ? r.amount : -r.amount), 0)
  const difference = view.book_balance - view.balance
  const canLedger = company.can('ledger.read')
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Banco Aula"
        description="La cuenta corriente de la empresa en el banco del aula. Cada pago, cobro, depósito o transferencia que mueve el banco le llega como una orden, y recién cuando el banco la procesa entra en la cuenta. Por eso el saldo según el banco puede no coincidir con el de libros: la conciliación explica la diferencia."
        actions={
          company.can('bank.operate') && (
            <Button asChild>
              <Link to={company.to('pagos/banco-aula/bandeja')}>
                <Inbox /> Bandeja del banco
              </Link>
            </Button>
          )
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Saldo según el banco"
          value={money(view.balance)}
          icon={Landmark}
          hint="Lo que el banco ya procesó"
        />
        <KpiCard
          label="Saldo según libros"
          value={money(view.book_balance)}
          icon={Scale}
          to={canLedger ? company.to(`contabilidad/mayor?cuenta=${view.account.ledger.id}`) : undefined}
          hint={
            difference === 0
              ? 'Coincide con el banco'
              : `${money(Math.abs(difference))} ${difference > 0 ? 'más' : 'menos'} que el banco`
          }
        />
        <KpiCard
          label="Enviado sin procesar"
          value={view.pending.length}
          icon={Clock}
          tone={view.pending.length ? 'warning' : 'default'}
          hint={view.pending.length ? `Neto ${money(pendingNet)}` : 'El banco procesó todo'}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <Section
            title="Enviado al banco, sin procesar"
            description="Las órdenes que la empresa mandó y el banco todavía no procesó: todavía no están en la cuenta."
            bodyClassName="p-0"
          >
            <DataTable<BankMovementRow>
              rows={view.pending}
              rowKey={(r) => r.id}
              empty="El banco procesó todo lo que envió la empresa."
              columns={pendingColumns(true)}
            />
          </Section>
          {view.rejected.length > 0 && (
            <Section title="Rechazadas por falta de fondos" description={REJECTED_HELP} bodyClassName="p-0">
              <DataTable<BankMovementRow> rows={view.rejected} rowKey={(r) => r.id} columns={rejectedColumns()} />
            </Section>
          )}
          <Section
            title="Movimientos de la cuenta"
            description="Lo que el banco procesó, del más reciente al más viejo."
            bodyClassName="p-0"
          >
            <DataTable<BankMovementRow>
              rows={view.movements}
              rowKey={(r) => r.id}
              onRowClick={(r) => r.source && navigate(r.source.path)}
              empty="Todavía no hay movimientos."
              pageSize={25}
              columns={movementColumns(true)}
            />
          </Section>
          <StatementSection />
        </div>
        <AccountData view={view} />
      </div>
    </>
  )
}

/**
 * Pagos y tesorería → Banco Aula → Bandeja: Tesorería opera el banco y procesa las órdenes que mandó
 * la empresa, de a una o todas juntas, con la fecha de hoy; quien envió una orden no la procesa
 * (SoD-12). Si el docente lo pide, el banco las procesa solo.
 */
export function BankTrayPage() {
  const company = useCompany()
  const { data: view, isLoading, error } = useBankAccount()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const process = useCommand((ids: string[]) => commands.processBankOrders(company.companyId, ids), {
    success: (r) =>
      [
        r.processed === 1
          ? 'Orden procesada: ya está en la cuenta.'
          : r.processed
            ? `${r.processed} órdenes procesadas.`
            : '',
        r.rejected === 1
          ? 'El banco rechazó una orden por falta de fondos.'
          : r.rejected
            ? `El banco rechazó ${r.rejected} órdenes por falta de fondos.`
            : '',
      ]
        .filter(Boolean)
        .join(' '),
    onSuccess: () => setSelected(new Set()),
  })
  const resend = useCommand((id: string) => commands.resendBankOrder(company.companyId, id), {
    success: (r) =>
      r.status === 'PENDIENTE'
        ? 'Orden reenviada: espera en la bandeja.'
        : r.status === 'PROCESADO'
          ? 'Orden reenviada: el banco la procesó.'
          : 'El banco la volvió a rechazar: sigue sin fondos.',
  })
  const closeMonth = useCommand((period: string) => commands.closeBankMonth(company.companyId, period), {
    success: (r) =>
      `Mes cerrado: el banco debitó ${money(Math.round((r.fee + r.tax + r.interest) * 100) / 100)} entre comisión, impuesto e intereses.`,
  })
  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Pagos y tesorería' },
    { label: 'Banco Aula', to: company.to('pagos/banco-aula') },
    { label: 'Bandeja' },
  ]
  if (isLoading || error) return <Loading error={error} />
  if (!view)
    return (
      <>
        <PageHeader crumbs={crumbs} title="Bandeja del Banco Aula" />
        <EmptyState icon={Vault} title="La empresa no tiene cuenta en el Banco Aula" />
      </>
    )
  const pending = view.pending
  // Con la separación de funciones, quien envió una orden no la procesa (el docente, sí).
  const blocked = (r: BankMovementRow) => r.own && company.company.settings.sod_enabled && !company.supervisor
  // Un cheque que todavía no se presentó no entra en "todas": se procesa antes sólo si se lo elige.
  const processable = pending.filter((r) => !blocked(r) && !r.unpresented).map((r) => r.id)
  const chosen = pending.filter((r) => selected.has(r.id) && !blocked(r)).map((r) => r.id)
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Bandeja del Banco Aula"
        description={`Tesorería opera el banco de ${company.company.legal_name}: procesa las órdenes que llegaron (pagos, cobros, depósitos y transferencias), que entran en la cuenta con la fecha de hoy y un número de transacción. Quien envió una orden no la procesa: lo hace otro integrante de Tesorería.`}
      />
      {view.mode === 'AUTOMATICO' && (
        <div className="mb-4 rounded-xl border border-brand-blue/30 bg-brand-blue-soft/40 px-4 py-3 text-sm text-navy">
          {BANK_MODES.AUTOMATICO.label}: {BANK_MODES.AUTOMATICO.description.toLowerCase()} El docente puede volver a
          dejarlo en manos de Tesorería en el panel docente.
        </div>
      )}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Órdenes pendientes"
          value={pending.length}
          icon={Clock}
          tone={pending.length ? 'warning' : 'default'}
        />
        <KpiCard
          label="Saldo de la cuenta"
          value={money(view.balance)}
          icon={Landmark}
          hint={`Cuenta ${view.account.number}`}
        />
        <KpiCard label="Acuerdo de descubierto" value={money(view.account.overdraft_limit)} />
      </div>
      <div className="space-y-4">
        <Section
          title="Cierre del mes"
          description={`Al cerrar un mes, el banco debita la comisión de mantenimiento (${money(view.account.monthly_fee)}), el impuesto a los débitos y créditos (0,6 % de lo que movieron las órdenes del mes) y, si la cuenta estuvo en descubierto, los intereses (${view.account.overdraft_rate} % mensual). Contabilidad los registra desde la conciliación.`}
        >
          {view.to_close ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>
                <span className="font-medium">{periodLabel(view.to_close)}</span> terminó y todavía no se cerró.
              </span>
              {company.can('bank.operate') && (
                <Button disabled={closeMonth.isPending} onClick={() => closeMonth.mutate([view.to_close!])}>
                  Cerrar {periodLabel(view.to_close)}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No hay meses para cerrar: el próximo se cierra cuando termine.
            </p>
          )}
        </Section>
        <LoanTraySections />
        <Section
          title="Órdenes pendientes"
          description="En el orden en que llegaron. Se procesan con la fecha de hoy, cada una con el saldo que dejó la anterior: si una saca más que el saldo más el acuerdo de descubierto, el banco la rechaza. Un cheque entra cuando el proveedor lo presenta al cobro (tres días después del pago); antes, sólo si lo elegís."
          bodyClassName="p-0"
          actions={
            company.can('bank.operate') &&
            pending.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!chosen.length || process.isPending}
                  onClick={() => process.mutate([chosen])}
                >
                  Procesar seleccionadas{chosen.length ? ` (${chosen.length})` : ''}
                </Button>
                <Button
                  disabled={!processable.length || process.isPending}
                  onClick={() => process.mutate([processable])}
                >
                  Procesar todas{processable.length < pending.length ? ` las que podés (${processable.length})` : ''}
                </Button>
              </div>
            )
          }
        >
          <DataTable<BankMovementRow>
            rows={pending}
            rowKey={(r) => r.id}
            empty="No hay órdenes pendientes."
            columns={[
              ...(company.can('bank.operate')
                ? [
                    {
                      key: 'pick',
                      header: <span className="sr-only">Elegir</span>,
                      cell: (r: BankMovementRow) => (
                        <Checkbox
                          checked={selected.has(r.id) && !blocked(r)}
                          disabled={blocked(r)}
                          onCheckedChange={(v) => toggle(r.id, v === true)}
                          aria-label={`Elegir la orden N.º ${r.seq}`}
                          title={
                            blocked(r)
                              ? 'La enviaste vos: la procesa otro integrante de Tesorería.'
                              : r.unpresented
                                ? 'Todavía no se presentó al cobro: elegilo si el proveedor ya lo depositó.'
                                : undefined
                          }
                        />
                      ),
                    },
                  ]
                : []),
              ...pendingColumns(false),
            ]}
          />
        </Section>
        {view.rejected.length > 0 && (
          <Section title="Rechazadas por falta de fondos" description={REJECTED_HELP} bodyClassName="p-0">
            <DataTable<BankMovementRow>
              rows={view.rejected}
              rowKey={(r) => r.id}
              columns={rejectedColumns(
                company.can('bank.operate')
                  ? {
                      key: 'resend',
                      header: <span className="sr-only">Reenviar</span>,
                      align: 'right',
                      cell: (r) => (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resend.isPending}
                          onClick={() => resend.mutate([r.id])}
                        >
                          Reenviar
                        </Button>
                      ),
                    }
                  : undefined,
              )}
            />
          </Section>
        )}
        <Section
          title="Procesadas"
          description="Los movimientos de la cuenta, del más reciente al más viejo."
          bodyClassName="p-0"
        >
          <DataTable<BankMovementRow>
            rows={view.movements}
            rowKey={(r) => r.id}
            empty="Todavía no hay movimientos."
            pageSize={25}
            columns={movementColumns(false)}
          />
        </Section>
      </div>
    </>
  )
}
