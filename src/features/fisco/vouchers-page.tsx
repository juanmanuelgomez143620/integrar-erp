import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { BadgeCheck } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Field, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type AuthorizedVoucher } from '@/lib/api'
import { DOC_STATUSES } from '@/lib/domain/catalog'
import { date, money, todayAR } from '@/lib/format'
import { useCompany } from '@/app/company'
import { periodLabel } from '@/features/hr/payroll'

/**
 * Fisco simulado → Comprobantes autorizados (8d.2): las facturas de venta que el fisco autorizó en un
 * mes, por código. Cada factura recibe el suyo al registrarse, en el momento.
 */
export function AuthorizedVouchersPage() {
  const company = useCompany()
  const [params, setParams] = useSearchParams()
  const month = params.get('mes') ?? todayAR().slice(0, 7)
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  const { data, error } = useQuery({
    queryKey: ['authorized-vouchers', company.companyId, month],
    queryFn: () => api.authorizedVouchers(company.companyId, month),
    enabled: valid,
  })
  const total = (data ?? []).filter((v) => v.status !== 'ANULADA').reduce((s, v) => s + v.total, 0)
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Fisco simulado' },
          { label: 'Comprobantes autorizados' },
        ]}
        title="Comprobantes autorizados"
        description="El registro del fisco simulado: cada factura de venta recibe, al registrarse, un código de autorización simulado (SIM-, la fecha y el correlativo de la empresa) que vence a los 10 días. Anular la factura no borra su código."
      />
      <Section>
        <Field label="Mes">
          <Input
            type="month"
            value={month}
            max={todayAR().slice(0, 7)}
            onChange={(e) =>
              setParams(
                (p) => {
                  p.set('mes', e.target.value)
                  return p
                },
                { replace: true },
              )
            }
          />
        </Field>
      </Section>
      <div className="mt-4">
        {!valid ? null : !data ? (
          <Loading error={error} />
        ) : data.length ? (
          <Section
            title={`${data.length === 1 ? '1 comprobante autorizado' : `${data.length} comprobantes autorizados`} en ${periodLabel(month)}`}
            description={`Total, sin las facturas anuladas: ${money(total)}.`}
            bodyClassName="p-0"
          >
            <DataTable<AuthorizedVoucher>
              rows={data}
              rowKey={(r) => r.document_id}
              search={(r) => `${r.authorization_code} ${r.invoice_label} ${r.customer_name} ${r.customer_cuit}`}
              columns={[
                { key: 'code', header: 'Código', cell: (r) => <Mono>{r.authorization_code}</Mono> },
                { key: 'date', header: 'Fecha', cell: (r) => date(r.date) },
                { key: 'due', header: 'Vence', cell: (r) => date(r.authorization_due) },
                {
                  key: 'invoice',
                  header: 'Factura',
                  cell: (r) => (
                    <Link className="underline" to={company.docPath('SALES_INVOICE', r.display_number)}>
                      {r.invoice_label}
                    </Link>
                  ),
                },
                {
                  key: 'customer',
                  header: 'Cliente',
                  cell: (r) => (
                    <span className="whitespace-normal">
                      {r.customer_name}
                      {r.customer_cuit && (
                        <span className="block text-xs text-muted-foreground">{r.customer_cuit}</span>
                      )}
                    </span>
                  ),
                },
                { key: 'total', header: 'Total', align: 'right', cell: (r) => money(r.total) },
                {
                  key: 'status',
                  header: 'Estado',
                  cell: (r) => {
                    const s = DOC_STATUSES.SALES_INVOICE[r.status]
                    return <StatusBadge label={s?.label ?? r.status} badge={s?.badge ?? 'neutral'} />
                  },
                },
              ]}
            />
          </Section>
        ) : (
          <EmptyState icon={BadgeCheck} title={`El fisco no autorizó facturas en ${periodLabel(month)}`} />
        )}
      </div>
    </>
  )
}
