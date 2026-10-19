import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, Banknote, Landmark, TrendingUp, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, KpiCard, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type IssuedCheque, type PayableRow, type TreasuryAccountRow } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import { date, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

const crumbs = (company: ReturnType<typeof useCompany>, extra: { label: string; to?: string }[] = []) => [
  { label: 'Inicio', to: company.to() },
  { label: 'Pagos y tesorería' },
  { label: 'Cuentas corrientes', to: extra.length ? company.to('pagos/proveedores') : undefined },
  ...extra,
]

/** Saldo con cada proveedor: la deuda sale de las facturas registradas menos lo pagado. */
export function PayablesPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['payables', company.companyId],
    queryFn: () => api.payables(company.companyId),
  })
  const total = data.reduce((s, r) => s + r.balance, 0)
  const overdue = data.reduce((s, r) => s + r.overdue, 0)
  return (
    <>
      <PageHeader
        crumbs={crumbs(company)}
        title="Cuentas corrientes de proveedores"
        description="Lo que la empresa le debe a cada proveedor. El saldo no se edita: sale de las facturas registradas y de los pagos."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard label="Deuda con proveedores" value={money(total)} icon={Wallet} />
        <KpiCard
          label="Vencida"
          value={money(overdue)}
          tone={overdue > 0 ? 'danger' : 'default'}
          hint="Facturas con el vencimiento ya pasado"
        />
        <KpiCard label="Proveedores con saldo" value={data.filter((r) => r.balance > 0).length} />
      </div>
      <DataTable<PayableRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.supplier.id}
        search={(r) => `${r.supplier.code} ${r.supplier.legal_name} ${r.supplier.tax_id}`}
        searchPlaceholder="Buscar proveedor…"
        onRowClick={(r) => navigate(company.to(`pagos/proveedores/${r.supplier.code}`))}
        empty="Todavía no hay facturas de proveedores registradas."
        columns={[
          { key: 'code', header: 'Código', sort: (r) => r.supplier.code, cell: (r) => <Mono>{r.supplier.code}</Mono> },
          {
            key: 'name',
            header: 'Proveedor',
            sort: (r) => r.supplier.legal_name,
            cell: (r) => <span className="font-medium">{r.supplier.legal_name}</span>,
          },
          { key: 'invoices', header: 'Facturas pendientes', align: 'right', cell: (r) => r.invoices },
          { key: 'due', header: 'Próximo vencimiento', sort: (r) => r.next_due ?? '', cell: (r) => date(r.next_due) },
          {
            key: 'overdue',
            header: 'Vencido',
            align: 'right',
            cell: (r) => (
              <span className={cn('tabular', r.overdue > 0 && 'font-semibold text-red-700')}>
                {r.overdue ? money(r.overdue) : '—'}
              </span>
            ),
          },
          {
            key: 'balance',
            header: 'Saldo',
            align: 'right',
            sort: (r) => r.balance,
            cell: (r) => <span className="tabular font-semibold">{money(r.balance)}</span>,
          },
        ]}
      />
    </>
  )
}

/** Cajas y bancos: el saldo de cada una sale del libro mayor y no se edita. */
export function TreasuryPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['treasury-accounts', company.companyId],
    queryFn: () => api.treasuryAccounts(company.companyId),
  })
  const total = data.reduce((s, r) => s + r.balance, 0)
  const canLedger = company.can('ledger.read')
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Pagos y tesorería' }, { label: 'Cajas y bancos' }]}
        title="Cajas y bancos"
        description="El dinero de la empresa. El saldo de cada caja y cada banco sale del libro mayor: no se edita. Para abrir otra cuenta bancaria, Contabilidad la agrega en el plan de cuentas, dentro de Caja y bancos."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={company.to('pagos/flujo-de-fondos')}>
                <TrendingUp /> Flujo de fondos
              </Link>
            </Button>
            {company.can('funds_transfer.create') && (
              <Button asChild>
                <Link to={company.docPath('FUNDS_TRANSFER', 'nueva')}>
                  <ArrowLeftRight /> Transferir entre cuentas
                </Link>
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard label="Disponible en total" value={money(total)} icon={Landmark} />
      </div>
      <DataTable<TreasuryAccountRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.account.id}
        onRowClick={canLedger ? (r) => navigate(company.to(`contabilidad/mayor?cuenta=${r.account.id}`)) : undefined}
        empty="La empresa no tiene cuentas de caja ni de banco."
        columns={[
          { key: 'code', header: 'Cuenta', sort: (r) => r.account.code, cell: (r) => <Mono>{r.account.code}</Mono> },
          {
            key: 'name',
            header: 'Caja o banco',
            sort: (r) => r.account.name,
            cell: (r) => (
              <div>
                <span className="font-medium">{r.account.name}</span>{' '}
                {!r.account.is_active && <StatusBadge label="Desactivada" badge="neutral" />}
                {r.account.description && (
                  <div className="text-xs whitespace-normal text-muted-foreground">{r.account.description}</div>
                )}
              </div>
            ),
          },
          {
            key: 'balance',
            header: 'Saldo',
            align: 'right',
            sort: (r) => r.balance,
            cell: (r) => (
              <span className={cn('tabular font-semibold', r.balance < 0 && 'text-red-700')}>{money(r.balance)}</span>
            ),
          },
        ]}
      />
      {canLedger && (
        <p className="mt-3 text-sm text-muted-foreground">
          Tocá una cuenta para ver sus movimientos en el libro mayor.
        </p>
      )}
    </>
  )
}

const CHEQUE_BADGE = {
  PENDIENTE: ['Pendiente de débito', 'warning'],
  DEBITADO: ['Debitado', 'success'],
  ANULADO: ['Anulado', 'neutral'],
} as const

/** Cheques emitidos: los pagos con cheque y si el banco ya los debitó (según las conciliaciones). */
export function IssuedChequesPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['issued-cheques', company.companyId],
    queryFn: () => api.issuedCheques(company.companyId),
  })
  const pending = data.filter((c) => c.status === 'PENDIENTE')
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Pagos y tesorería' }, { label: 'Cheques emitidos' }]}
        title="Cheques emitidos"
        description="Los pagos con cheque propio. Un cheque está pendiente de débito hasta que una conciliación bancaria lo encuentra en el extracto: mientras tanto, el saldo del banco es menor al que muestra el extracto."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Pendientes de débito"
          value={money(pending.reduce((s, c) => s + c.amount, 0))}
          hint={`${pending.length} cheque${pending.length === 1 ? '' : 's'}`}
          icon={Banknote}
        />
      </div>
      <DataTable<IssuedCheque>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(c) => c.payment.id}
        search={(c) => `${c.number} ${c.supplier_name} ${c.payment.display_number}`}
        searchPlaceholder="Buscar por número, proveedor u orden de pago…"
        onRowClick={(c) => navigate(c.payment.path)}
        empty="Todavía no se pagó ninguna orden con cheque."
        columns={[
          { key: 'number', header: 'Cheque N.º', sort: (c) => c.number, cell: (c) => <Mono>{c.number}</Mono> },
          { key: 'date', header: 'Fecha', sort: (c) => c.date, cell: (c) => date(c.date) },
          {
            key: 'supplier',
            header: 'A la orden de',
            sort: (c) => c.supplier_name,
            cell: (c) => <span className="font-medium">{c.supplier_name}</span>,
          },
          { key: 'op', header: 'Orden de pago', cell: (c) => <Mono>{c.payment.display_number}</Mono> },
          { key: 'bank', header: 'Banco', cell: (c) => <span className="text-xs">{c.account.name}</span> },
          {
            key: 'status',
            header: 'Estado',
            cell: (c) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusBadge label={CHEQUE_BADGE[c.status][0]} badge={CHEQUE_BADGE[c.status][1]} />
                {c.reconciliation && (
                  <Link
                    to={c.reconciliation.path}
                    className="font-mono text-xs hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.reconciliation.display_number}
                  </Link>
                )}
              </span>
            ),
          },
          {
            key: 'amount',
            header: 'Importe',
            align: 'right',
            sort: (c) => c.amount,
            cell: (c) => <span className="tabular font-semibold">{money(c.amount)}</span>,
          },
        ]}
      />
    </>
  )
}

/** Cuenta corriente de un proveedor: facturas y pagos con saldo acumulado, y lo pendiente. */
export function SupplierAccountPage() {
  const company = useCompany()
  const { code = '' } = useParams()
  const suppliers = useQuery({
    queryKey: ['suppliers', company.companyId],
    queryFn: () => api.suppliers(company.companyId),
  })
  const supplier = suppliers.data?.find((s) => s.code === code)
  const { data, isLoading, error } = useQuery({
    enabled: !!supplier,
    queryKey: ['supplier-account', company.companyId, supplier?.id],
    queryFn: () => api.supplierAccount(company.companyId, supplier!.id),
  })
  if (suppliers.isLoading || (supplier && isLoading) || error || suppliers.error)
    return <Loading error={error ?? suppliers.error} />
  if (!supplier || !data) return <EmptyState icon={Wallet} title={`No se encontró el proveedor ${code}`} />
  return (
    <>
      <PageHeader
        crumbs={crumbs(company, [{ label: data.supplier.legal_name }])}
        title={data.supplier.legal_name}
        meta={<Mono>{data.supplier.code}</Mono>}
        description={`CUIT ${data.supplier.tax_id || '—'} (simulado) · ${VAT_CONDITIONS[data.supplier.vat_condition]} · plazo de pago ${
          data.supplier.payment_terms_days ? `${data.supplier.payment_terms_days} días` : 'contado'
        }`}
        actions={
          data.balance > 0 && company.can('payment_order.create') ? (
            <Button asChild>
              <Link to={`${company.docPath('PAYMENT_ORDER', 'nueva')}?proveedor=${data.supplier.code}`}>
                <Banknote /> Preparar orden de pago
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Section
          title="Movimientos"
          description="Haber: facturas (aumentan la deuda). Debe: pagos (la cancelan)."
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-slate-600">
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Comprobante</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                  <th className="px-3 py-2 text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {data.movements.map((m) => (
                  <tr key={m.document_id} className="border-b">
                    <td className="px-3 py-2 whitespace-nowrap">{date(m.date)}</td>
                    <td className="px-3 py-2">
                      <Link to={m.path} className="font-mono text-xs text-brand-blue hover:underline">
                        {m.display_number}
                      </Link>{' '}
                      <span className="text-xs text-muted-foreground">{m.description}</span>
                    </td>
                    <td className="tabular px-3 py-2 text-right">{m.debit ? money(m.debit) : ''}</td>
                    <td className="tabular px-3 py-2 text-right">{m.credit ? money(m.credit) : ''}</td>
                    <td className="tabular px-3 py-2 text-right">{money(m.balance)}</td>
                  </tr>
                ))}
                {!data.movements.length && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                      Sin movimientos.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="font-semibold text-navy">
                  <td className="px-3 py-2" colSpan={4}>
                    Saldo a pagar
                  </td>
                  <td className="tabular px-3 py-2 text-right">{money(data.balance)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>
        <Section title="Facturas pendientes" bodyClassName="flex flex-col gap-3">
          {data.pending.map((i) => (
            <div key={i.id} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <Link to={i.path} className="font-mono text-xs font-semibold text-navy hover:underline">
                  {i.display_number}
                </Link>
                {i.overdue ? (
                  <StatusBadge label="Vencida" badge="danger" />
                ) : (
                  <StatusBadge label="A vencer" badge="info" />
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Factura {i.invoice_label} · vence {date(i.due_date)}
              </div>
              <div className="tabular font-medium">{money(i.pending)}</div>
              {i.paid > 0 && (
                <div className="text-xs text-muted-foreground">
                  Pagado {money(i.paid)} de {money(i.total)}
                </div>
              )}
            </div>
          ))}
          {!data.pending.length && <p className="text-sm text-muted-foreground">No hay facturas pendientes.</p>}
        </Section>
      </div>
    </>
  )
}
