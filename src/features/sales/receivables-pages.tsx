import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { HandCoins, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, KpiCard, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type AgingKey, type ReceivableRow } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import { date, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

const crumbs = (company: ReturnType<typeof useCompany>, extra: { label: string; to?: string }[] = []) => [
  { label: 'Inicio', to: company.to() },
  { label: 'Ventas' },
  { label: 'Cuentas corrientes de clientes', to: extra.length ? company.to('ventas/clientes') : undefined },
  ...extra,
]

/** Tramos de la antigüedad de saldos, según los días que lleva vencida cada factura. */
const AGING: [AgingKey, string][] = [
  ['A_VENCER', 'A vencer'],
  ['DE_1_A_30', '1 a 30 días'],
  ['DE_31_A_60', '31 a 60 días'],
  ['DE_61_A_90', '61 a 90 días'],
  ['MAS_DE_90', 'Más de 90 días'],
]

/** Botón para registrar un cobro (sólo quien cobra: Tesorería). */
function CollectButton({ customerCode }: { customerCode?: string }) {
  const company = useCompany()
  if (!company.can('customer_receipt.create')) return null
  const to = company.docPath('CUSTOMER_RECEIPT', 'nuevo')
  return (
    <Button asChild>
      <Link to={customerCode ? `${to}?cliente=${customerCode}` : to}>
        <HandCoins /> Registrar cobro
      </Link>
    </Button>
  )
}

/** Lo que debe cada cliente: sale de las facturas de venta registradas menos lo cobrado. */
export function ReceivablesPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['receivables', company.companyId],
    queryFn: () => api.receivables(company.companyId),
  })
  const total = data.reduce((s, r) => s + r.balance, 0)
  const overdue = data.reduce((s, r) => s + r.overdue, 0)
  return (
    <>
      <PageHeader
        crumbs={crumbs(company)}
        title="Cuentas corrientes de clientes"
        description="Lo que cada cliente le debe a la empresa. El saldo no se edita: sale de las facturas de venta registradas y de los cobros."
        actions={<CollectButton />}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard label="Deuda de los clientes" value={money(total)} icon={Wallet} />
        <KpiCard
          label="Vencida"
          value={money(overdue)}
          tone={overdue > 0 ? 'danger' : 'default'}
          hint="Clientes morosos: facturas con el vencimiento ya pasado"
        />
        <KpiCard label="Clientes con saldo" value={data.filter((r) => r.balance > 0).length} />
      </div>
      <Tabs defaultValue="balances">
        <TabsList>
          <TabsTrigger value="balances">Saldos por cliente</TabsTrigger>
          <TabsTrigger value="aging">Antigüedad de saldos</TabsTrigger>
        </TabsList>
        <TabsContent value="balances" className="mt-3">
          <DataTable<ReceivableRow>
            rows={data}
            loading={isLoading}
            error={error}
            rowKey={(r) => r.customer.id}
            search={(r) => `${r.customer.code} ${r.customer.legal_name} ${r.customer.tax_id}`}
            searchPlaceholder="Buscar cliente…"
            onRowClick={(r) => navigate(company.to(`ventas/clientes/${r.customer.code}`))}
            empty="Todavía no hay facturas de venta registradas."
            columns={[
              {
                key: 'code',
                header: 'Código',
                sort: (r) => r.customer.code,
                cell: (r) => <Mono>{r.customer.code}</Mono>,
              },
              {
                key: 'name',
                header: 'Cliente',
                sort: (r) => r.customer.legal_name,
                cell: (r) => <span className="font-medium">{r.customer.legal_name}</span>,
              },
              { key: 'invoices', header: 'Facturas pendientes', align: 'right', cell: (r) => r.invoices },
              {
                key: 'due',
                header: 'Próximo vencimiento',
                sort: (r) => r.next_due ?? '',
                cell: (r) => date(r.next_due),
              },
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
        </TabsContent>
        <TabsContent value="aging" className="mt-3">
          <AgingTable rows={data.filter((r) => r.balance > 0)} />
        </TabsContent>
      </Tabs>
    </>
  )
}

/**
 * Antigüedad de saldos: la deuda de cada cliente según cuánto hace que venció.
 * Lo vencido hace más tiempo es lo más difícil de cobrar.
 */
function AgingTable({ rows }: { rows: ReceivableRow[] }) {
  const company = useCompany()
  const totals = Object.fromEntries(AGING.map(([key]) => [key, rows.reduce((s, r) => s + r.aging[key], 0)])) as Record<
    AgingKey,
    number
  >
  const total = rows.reduce((s, r) => s + r.balance, 0)
  const head = 'px-3 py-2 text-right whitespace-nowrap'
  return (
    <Section
      title="Antigüedad de saldos"
      description="Lo que debe cada cliente según los días que lleva vencida cada factura. Los clientes con deuda vencida son morosos: para venderles a crédito hace falta la autorización de Gerencia."
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-slate-600">
              <th className="px-3 py-2">Cliente</th>
              {AGING.map(([key, label]) => (
                <th key={key} className={head}>
                  {label}
                </th>
              ))}
              <th className={head}>Saldo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customer.id} className="border-b">
                <td className="min-w-52 px-3 py-2">
                  <Link
                    to={company.to(`ventas/clientes/${r.customer.code}`)}
                    className="font-mono text-xs text-brand-blue hover:underline"
                  >
                    {r.customer.code}
                  </Link>{' '}
                  {r.customer.legal_name}
                </td>
                {AGING.map(([key]) => (
                  <td
                    key={key}
                    className={cn(
                      'tabular px-3 py-2 text-right',
                      key !== 'A_VENCER' && r.aging[key] > 0 && 'font-semibold text-red-700',
                    )}
                  >
                    {r.aging[key] ? money(r.aging[key]) : '—'}
                  </td>
                ))}
                <td className="tabular px-3 py-2 text-right font-semibold">{money(r.balance)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={AGING.length + 2} className="px-3 py-8 text-center text-muted-foreground">
                  Ningún cliente debe nada.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="font-semibold text-navy">
              <td className="px-3 py-2">Total</td>
              {AGING.map(([key]) => (
                <td key={key} className="tabular px-3 py-2 text-right">
                  {money(totals[key])}
                  {total > 0 && (
                    <div className="text-xs font-normal text-muted-foreground">
                      {Math.round((totals[key] / total) * 100)} %
                    </div>
                  )}
                </td>
              ))}
              <td className="tabular px-3 py-2 text-right">{money(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  )
}

export function CustomerAccountPage() {
  const company = useCompany()
  const { code = '' } = useParams()
  const customers = useQuery({
    queryKey: ['customers', company.companyId],
    queryFn: () => api.customers(company.companyId),
  })
  const customer = customers.data?.find((c) => c.code === code)
  const { data, isLoading, error } = useQuery({
    enabled: !!customer,
    queryKey: ['customer-account', company.companyId, customer?.id],
    queryFn: () => api.customerAccount(company.companyId, customer!.id),
  })
  if (customers.isLoading || (customer && isLoading) || error || customers.error)
    return <Loading error={error ?? customers.error} />
  if (!customer || !data) return <EmptyState icon={Wallet} title={`No se encontró el cliente ${code}`} />
  const limit = data.customer.credit_limit
  return (
    <>
      <PageHeader
        crumbs={crumbs(company, [{ label: data.customer.legal_name }])}
        title={data.customer.legal_name}
        meta={<Mono>{data.customer.code}</Mono>}
        description={`${data.customer.tax_id ? `CUIT ${data.customer.tax_id} (simulado) · ` : ''}${VAT_CONDITIONS[data.customer.vat_condition]} · condición de pago ${
          data.customer.payment_terms_days ? `${data.customer.payment_terms_days} días` : 'contado'
        }`}
        actions={data.balance > 0 ? <CollectButton customerCode={data.customer.code} /> : undefined}
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Section
          title="Movimientos"
          description="Debe: facturas (aumentan lo que debe el cliente). Haber: cobros (lo cancelan)."
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
                    Saldo a cobrar
                  </td>
                  <td className="tabular px-3 py-2 text-right">{money(data.balance)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>
        <aside className="flex flex-col gap-4">
          <Section title="Crédito">
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Límite</dt>
                <dd className="tabular">{limit == null ? 'Sin límite' : money(limit)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Usado (deuda y pedidos sin facturar)</dt>
                <dd
                  className={cn(
                    'tabular font-semibold',
                    limit != null && data.credit_used > limit ? 'text-red-700' : 'text-navy',
                  )}
                >
                  {money(data.credit_used)}
                </dd>
              </div>
            </dl>
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
                {i.collected > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Cobrado {money(i.collected)} de {money(i.total)}
                  </div>
                )}
              </div>
            ))}
            {!data.pending.length && <p className="text-sm text-muted-foreground">No hay facturas pendientes.</p>}
          </Section>
        </aside>
      </div>
    </>
  )
}
