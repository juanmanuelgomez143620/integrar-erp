import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, CircleCheck, Plus, Printer, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, Field, Loading } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api } from '@/lib/api'
import { ACCOUNT_TYPES } from '@/lib/domain/catalog'
import { money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { JournalTable, LedgerTable, TrialBalanceTable } from './books'
import { AccountSelect, ContraryBadge, RangePicker, useAccounts, useBookRange, type DateRange } from './shared'

const crumbs = (company: ReturnType<typeof useCompany>, label: string) => [
  { label: 'Inicio', to: company.to() },
  { label: 'Contabilidad' },
  { label },
]

function PrintButton({ book, range, extra = '' }: { book: string; range: DateRange; extra?: string }) {
  const company = useCompany()
  return (
    <Button variant="outline" asChild>
      <Link to={company.to(`contabilidad/imprimir/${book}?desde=${range.from}&hasta=${range.to}${extra}`)}>
        <Printer /> Imprimir
      </Link>
    </Button>
  )
}

export function JournalPage() {
  const company = useCompany()
  const [range, setRange] = useBookRange()
  const { data, isLoading, error } = useQuery({
    queryKey: ['journal-book', company.companyId, range.from, range.to],
    queryFn: () => api.journalBook(company.companyId, range.from, range.to),
  })
  return (
    <>
      <PageHeader
        crumbs={crumbs(company, 'Libro diario')}
        title="Libro diario"
        description="Todos los asientos registrados, en orden correlativo. Es el registro cronológico de la contabilidad: lo que entra acá ya no se borra."
        actions={
          <>
            <PrintButton book="diario" range={range} />
            {company.can('journal_entry.create') && (
              <Button asChild>
                <Link to={company.docPath('JOURNAL_ENTRY', 'nuevo')}>
                  <Plus /> Nuevo asiento
                </Link>
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4">
        <RangePicker range={range} onChange={setRange} />
      </div>
      {isLoading || !data ? (
        <Loading error={error} />
      ) : data.entries.length ? (
        <div className="overflow-x-auto rounded-xl border bg-card p-2">
          <JournalTable book={data} />
        </div>
      ) : (
        <EmptyState icon={BookOpen} title="No hay asientos registrados en estas fechas" />
      )}
    </>
  )
}

export function LedgerPage() {
  const company = useCompany()
  const [params, setParams] = useSearchParams()
  const accountId = params.get('cuenta') ?? ''
  const accounts = useAccounts()
  const [range, setRange] = useBookRange()
  const { data, isLoading, error } = useQuery({
    enabled: !!accountId,
    queryKey: ['ledger', company.companyId, accountId, range.from, range.to],
    queryFn: () => api.ledger(company.companyId, accountId, range.from, range.to),
  })
  const setAccount = (id: string) =>
    setParams(
      (current) => {
        const p = new URLSearchParams(current)
        p.set('cuenta', id)
        return p
      },
      { replace: true },
    )
  const account = data?.account
  return (
    <>
      <PageHeader
        crumbs={crumbs(company, 'Libro mayor')}
        title="Libro mayor"
        description="Los movimientos de una cuenta, uno por uno, con su saldo acumulado. Es la forma de saber cuánto hay en Caja o cuánto se le debe a los proveedores."
        actions={accountId ? <PrintButton book="mayor" range={range} extra={`&cuenta=${accountId}`} /> : undefined}
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field label="Cuenta" className="w-full max-w-md">
          {accounts.data ? (
            <AccountSelect accounts={accounts.data} value={accountId} onChange={setAccount} includeInactive />
          ) : (
            <span className="text-sm text-muted-foreground">Cargando…</span>
          )}
        </Field>
        <RangePicker range={range} onChange={setRange} />
      </div>
      {!accountId ? (
        <EmptyState icon={BookOpen} title="Elegí una cuenta para ver su mayor" />
      ) : isLoading || !data || !account ? (
        <Loading error={error} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs text-muted-foreground">{account.code}</span>
            <span className="font-semibold text-navy">{account.name}</span>
            <span className="text-muted-foreground">
              · {ACCOUNT_TYPES[account.account_type]} · saldo normal{' '}
              {account.normal_side === 'DEBE' ? 'deudor' : 'acreedor'}
            </span>
            {account.contrary && <ContraryBadge />}
          </div>
          {account.description && <p className="mb-3 text-sm text-muted-foreground">{account.description}</p>}
          <div className="overflow-x-auto rounded-xl border bg-card p-2">
            <LedgerTable ledger={data} from={range.from} />
          </div>
        </>
      )}
    </>
  )
}

export function TrialBalancePage() {
  const company = useCompany()
  const [range, setRange] = useBookRange()
  const { data, isLoading, error } = useQuery({
    queryKey: ['trial-balance', company.companyId, range.from, range.to],
    queryFn: () => api.trialBalance(company.companyId, range.from, range.to),
  })
  const contrary = data?.rows.filter((r) => r.contrary) ?? []
  return (
    <>
      <PageHeader
        crumbs={crumbs(company, 'Sumas y saldos')}
        title="Balance de sumas y saldos"
        description="Control de la partida doble: si todo se registró por partida doble, las sumas del debe y del haber coinciden, y también los saldos deudores y acreedores."
        actions={<PrintButton book="sumas-y-saldos" range={range} />}
      />
      <div className="mb-4">
        <RangePicker range={range} onChange={setRange} />
      </div>
      {isLoading || !data ? (
        <Loading error={error} />
      ) : !data.rows.length ? (
        <EmptyState icon={BookOpen} title="No hay movimientos en estas fechas" />
      ) : (
        <>
          <div
            className={cn(
              'mb-3 flex gap-2 rounded-lg border px-3 py-2.5 text-sm',
              data.balanced ? 'border-green-200 bg-green-50 text-green-900' : 'border-red-200 bg-red-50 text-red-900',
            )}
          >
            {data.balanced ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            )}
            <div>
              {data.balanced
                ? `Balancea: las sumas coinciden (${money(data.totals.debit)}) y también los saldos (${money(data.totals.debit_balance)}).`
                : 'No balancea: revisá los asientos del período.'}
              {contrary.length > 0 && (
                <div className="mt-1 text-red-800">
                  {contrary.length === 1 ? 'Una cuenta tiene' : `${contrary.length} cuentas tienen`} saldo contrario a
                  su naturaleza: {contrary.map((r) => r.name).join(', ')}. Revisá si falta o sobra un asiento.
                </div>
              )}
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border bg-card p-2">
            <TrialBalanceTable balance={data} />
          </div>
        </>
      )}
    </>
  )
}
