import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { CircleAlert, Landmark } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, KpiCard, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api, type CashFlow, type CashProjection } from '@/lib/api'
import { money, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

const head = 'h-9 text-xs font-semibold text-slate-600'

/** Flujo de fondos: lo que va a entrar y salir según los vencimientos, y lo que entró y salió en un período. */
export function CashFlowPage() {
  const company = useCompany()
  const today = todayAR()
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`)
  const [to, setTo] = useState(today)
  const projection = useQuery({
    queryKey: ['cash-projection', company.companyId],
    queryFn: () => api.cashProjection(company.companyId),
  })
  const flow = useQuery({
    queryKey: ['cash-flow', company.companyId, from, to],
    queryFn: () => api.cashFlow(company.companyId, from, to),
    enabled: !!from && !!to && from <= to,
  })
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Pagos y tesorería' },
          { label: 'Cajas y bancos', to: company.to('pagos/cajas-y-bancos') },
          { label: 'Flujo de fondos' },
        ]}
        title="Flujo de fondos"
        description="Si alcanza el dinero para lo que hay que pagar, contando lo que falta cobrar, y de dónde vino y adónde fue en un período. Sale de los vencimientos de las facturas y de las liquidaciones de sueldos, y del libro mayor de cajas y bancos: no se carga a mano."
      />
      <div className="flex flex-col gap-4">
        {projection.data ? <Projection data={projection.data} /> : <Loading error={projection.error} />}
        <Section
          title="Flujo real"
          description="Entradas y salidas de cajas y bancos en el período, según el documento que las originó."
          actions={
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Desde">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" />
              </Field>
              <Field label="Hasta">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" />
              </Field>
            </div>
          }
          bodyClassName="p-0"
        >
          {flow.data ? <Flow data={flow.data} /> : <Loading error={flow.error} />}
        </Section>
      </div>
    </>
  )
}

function Projection({ data }: { data: CashProjection }) {
  const short = data.buckets.find((b) => b.key === data.shortfall)
  return (
    <Section
      title="Flujo proyectado"
      description="Desde el saldo de hoy, lo que falta cobrar de las facturas de venta y pagar de las de proveedores, de los sueldos (en su fecha de pago), de las cargas sociales y de los impuestos presentados (en su vencimiento). Lo vencido sin cobrar puede demorarse: es lo que muestra la antigüedad de saldos."
      bodyClassName="p-0"
    >
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Disponible hoy en cajas y bancos" value={money(data.balance)} icon={Landmark} />
        <KpiCard
          label="Falta cobrar a clientes"
          value={money(data.buckets.reduce((s, b) => s + b.collections, 0))}
          hint="Facturas de venta registradas con saldo"
        />
        <KpiCard
          label="Falta pagar"
          value={money(data.buckets.reduce((s, b) => s + b.payments + b.payroll + b.taxes, 0))}
          hint={`A proveedores ${money(data.buckets.reduce((s, b) => s + b.payments, 0))}; sueldos y cargas sociales ${money(data.buckets.reduce((s, b) => s + b.payroll, 0))}; impuestos ${money(data.buckets.reduce((s, b) => s + b.taxes, 0))}`}
        />
        <KpiCard
          label="Saldo después de cobrar y pagar todo"
          value={money(data.buckets[data.buckets.length - 1]?.balance ?? data.balance)}
          tone={data.shortfall ? 'danger' : 'default'}
        />
      </div>
      {short && (
        <div className="mx-4 mb-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <span className="font-medium">No alcanzan los fondos:</span> aun cobrando lo que vence, para pagar lo que
            vence hasta el tramo "{short.label.toLowerCase()}" faltan {money(-short.balance)}. Hay que conseguir fondos
            (adelantar cobranzas, pedir un préstamo) o negociar los plazos con los proveedores.
          </div>
        </div>
      )}
      <div className="overflow-x-auto border-t">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className={head}>Vencimiento</TableHead>
              <TableHead className={cn(head, 'text-right')}>A cobrar</TableHead>
              <TableHead className={cn(head, 'text-right')}>A pagar</TableHead>
              <TableHead className={cn(head, 'text-right')}>Sueldos y cargas sociales</TableHead>
              <TableHead className={cn(head, 'text-right')}>Impuestos</TableHead>
              <TableHead className={cn(head, 'text-right')}>Saldo después</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="text-sm text-muted-foreground">Disponible hoy</TableCell>
              <TableCell />
              <TableCell />
              <TableCell />
              <TableCell />
              <TableCell className="tabular text-right font-medium">{money(data.balance)}</TableCell>
            </TableRow>
            {data.buckets.map((b) => (
              <TableRow key={b.key}>
                <TableCell
                  className={cn(
                    'text-sm',
                    b.key === 'VENCIDAS' &&
                      (b.payments > 0 || b.collections > 0 || b.payroll > 0 || b.taxes > 0) &&
                      'text-red-700',
                  )}
                >
                  {b.label}
                </TableCell>
                <TableCell className="tabular text-right">
                  {b.collections ? money(b.collections) : '—'}
                  {b.receivables > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {b.receivables} {b.receivables === 1 ? 'factura' : 'facturas'}
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular text-right">
                  {b.payments ? money(b.payments) : '—'}
                  {b.invoices > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {b.invoices} {b.invoices === 1 ? 'factura' : 'facturas'}
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular text-right">
                  {b.payroll ? money(b.payroll) : '—'}
                  {b.payroll_items > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {b.payroll_items} {b.payroll_items === 1 ? 'pago' : 'pagos'}
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular text-right">
                  {b.taxes ? money(b.taxes) : '—'}
                  {b.tax_items > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {b.tax_items} {b.tax_items === 1 ? 'declaración' : 'declaraciones'}
                    </div>
                  )}
                </TableCell>
                <TableCell className={cn('tabular text-right font-medium', b.balance < 0 && 'text-red-700')}>
                  {money(b.balance)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}

function Flow({ data }: { data: CashFlow }) {
  const company = useCompany()
  return (
    <div className="grid gap-0 xl:grid-cols-2 xl:divide-x">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className={head}>Concepto</TableHead>
              <TableHead className={cn(head, 'text-right')}>Entradas</TableHead>
              <TableHead className={cn(head, 'text-right')}>Salidas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="text-sm text-muted-foreground">Saldo inicial</TableCell>
              <TableCell colSpan={2} className="tabular text-right font-medium">
                {money(data.opening)}
              </TableCell>
            </TableRow>
            {data.concepts.map((c) => (
              <TableRow key={c.key}>
                <TableCell className="text-sm">{c.label}</TableCell>
                <TableCell className="tabular text-right">{c.inflow ? money(c.inflow) : '—'}</TableCell>
                <TableCell className="tabular text-right">{c.outflow ? money(c.outflow) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="text-sm font-semibold text-navy">Totales del período</TableCell>
              <TableCell className="tabular text-right font-semibold text-navy">{money(data.inflow)}</TableCell>
              <TableCell className="tabular text-right font-semibold text-navy">{money(data.outflow)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-sm font-semibold text-navy">Saldo final</TableCell>
              <TableCell colSpan={2} className="tabular text-right font-semibold text-navy">
                {money(data.closing)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <div className="overflow-x-auto border-t xl:border-t-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className={head}>Caja o banco</TableHead>
              <TableHead className={cn(head, 'text-right')}>Inicial</TableHead>
              <TableHead className={cn(head, 'text-right')}>Entradas</TableHead>
              <TableHead className={cn(head, 'text-right')}>Salidas</TableHead>
              <TableHead className={cn(head, 'text-right')}>Final</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.accounts.map((a) => (
              <TableRow key={a.account.id}>
                <TableCell className="text-sm">
                  {company.can('ledger.read') ? (
                    <Link className="hover:underline" to={company.to(`contabilidad/mayor?cuenta=${a.account.id}`)}>
                      {a.account.name}
                    </Link>
                  ) : (
                    a.account.name
                  )}{' '}
                  <span className="font-mono text-xs text-muted-foreground">{a.account.code}</span>
                </TableCell>
                <TableCell className="tabular text-right">{money(a.opening)}</TableCell>
                <TableCell className="tabular text-right">{a.inflow ? money(a.inflow) : '—'}</TableCell>
                <TableCell className="tabular text-right">{a.outflow ? money(a.outflow) : '—'}</TableCell>
                <TableCell className={cn('tabular text-right font-medium', a.closing < 0 && 'text-red-700')}>
                  {money(a.closing)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
