import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api, type IvaBook } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import { date, lastMonthAR, money, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { periodLabel } from '@/features/hr/payroll'

const head = 'h-9 text-xs font-semibold text-slate-600'

/** Los libros IVA ventas y compras de un mes, salidos de las facturas registradas (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §2). */
export function IvaBooksPage() {
  const company = useCompany()
  const [params, setParams] = useSearchParams()
  const period = params.get('mes') ?? lastMonthAR()
  const sales = params.get('libro') !== 'compras'
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        p.set(key, value)
        return p
      },
      { replace: true },
    )
  const { data, error } = useQuery({
    queryKey: ['iva-book', company.companyId, period, sales],
    queryFn: () => api.ivaBook(company.companyId, period, sales),
    enabled: valid,
  })
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Impuestos' }, { label: 'Libros IVA' }]}
        title="Libros IVA"
        description="Las facturas de venta y de proveedores de cada mes con su IVA, por alícuota: el mes de una factura es el de su registración, y una factura anulada resta en el mes de su anulación. Con ellos se prepara la declaración mensual de IVA."
      />
      <Section>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Mes">
            <Input
              type="month"
              value={period}
              max={todayAR().slice(0, 7)}
              onChange={(e) => set('mes', e.target.value)}
            />
          </Field>
          <Tabs value={sales ? 'ventas' : 'compras'} onValueChange={(v) => set('libro', v)}>
            <TabsList>
              <TabsTrigger value="ventas">Libro IVA ventas</TabsTrigger>
              <TabsTrigger value="compras">Libro IVA compras</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </Section>
      <div className="mt-4">{data ? <Book data={data} /> : valid && <Loading error={error} />}</div>
    </>
  )
}

function Book({ data }: { data: IvaBook }) {
  const party = data.sales ? 'Cliente' : 'Proveedor'
  return (
    <div className="flex flex-col gap-4">
      <Section
        title={`Libro IVA ${data.sales ? 'ventas' : 'compras'}, ${periodLabel(data.period)}`}
        description={
          data.sales
            ? 'El débito fiscal del mes es el total de la columna IVA: coincide con lo que se acreditó en IVA débito fiscal (2.1.04.01).'
            : 'El crédito fiscal del mes es el total de la columna IVA (sólo las facturas con letra A): coincide con lo que se debitó en IVA crédito fiscal (1.1.04.01). Las de letra C van por el total, sin crédito fiscal.'
        }
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className={head}>Fecha</TableHead>
                <TableHead className={head}>Comprobante</TableHead>
                <TableHead className={head}>{party}</TableHead>
                <TableHead className={cn(head, 'text-right')}>Neto gravado</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
                <TableHead className={cn(head, 'text-right')}>Exento</TableHead>
                {!data.sales && <TableHead className={cn(head, 'text-right')}>Sin crédito fiscal</TableHead>}
                <TableHead className={cn(head, 'text-right')}>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={data.sales ? 7 : 8} className="py-6 text-center text-sm text-muted-foreground">
                    No hay facturas registradas en el mes.
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((r, i) => (
                <TableRow key={`${r.invoice.id}-${i}`} className={cn(r.sign < 0 && 'text-red-700')}>
                  <TableCell className="text-sm">
                    {date(r.entry_date)}
                    {r.invoice.document_date !== r.entry_date && (
                      <div className="text-xs text-muted-foreground">del {date(r.invoice.document_date)}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="font-mono">{r.voucher}</span>
                    <div className="text-xs">
                      <Link to={r.invoice.path} className="font-mono hover:underline">
                        {r.invoice.display_number}
                      </Link>
                      {r.sign < 0 && ' · anulada'}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.counterparty.name}
                    <div className="text-xs text-muted-foreground">
                      CUIT {r.counterparty.tax_id} · {VAT_CONDITIONS[r.counterparty.vat_condition]}
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right">{money(r.net)}</TableCell>
                  <TableCell className="tabular text-right">{money(r.vat)}</TableCell>
                  <TableCell className="tabular text-right">{r.exempt ? money(r.exempt) : '—'}</TableCell>
                  {!data.sales && (
                    <TableCell className="tabular text-right">{r.no_credit ? money(r.no_credit) : '—'}</TableCell>
                  )}
                  <TableCell className="tabular text-right font-medium">{money(r.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            {data.rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3} className="text-sm font-semibold text-navy">
                    Totales del mes
                  </TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">{money(data.net)}</TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">{money(data.vat)}</TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">{money(data.exempt)}</TableCell>
                  {!data.sales && (
                    <TableCell className="tabular text-right font-semibold text-navy">
                      {money(data.no_credit)}
                    </TableCell>
                  )}
                  <TableCell className="tabular text-right font-semibold text-navy">{money(data.total)}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </Section>
      {data.by_rate.length > 0 && (
        <Section title="Por alícuota" bodyClassName="p-0" className="max-w-xl">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className={head}>Alícuota</TableHead>
                <TableHead className={cn(head, 'text-right')}>Neto gravado</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.by_rate.map((r) => (
                <TableRow key={r.rate}>
                  <TableCell className="text-sm">{String(r.rate).replace('.', ',')} %</TableCell>
                  <TableCell className="tabular text-right">{money(r.net)}</TableCell>
                  <TableCell className="tabular text-right">{money(r.vat)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </div>
  )
}
