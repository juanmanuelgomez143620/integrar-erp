import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Wallet } from 'lucide-react'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, KpiCard, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type PayableRow } from '@/lib/api'
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
  if (error) return <Loading error={error} />
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
            </div>
          ))}
          {!data.pending.length && <p className="text-sm text-muted-foreground">No hay facturas pendientes.</p>}
        </Section>
      </div>
    </>
  )
}
