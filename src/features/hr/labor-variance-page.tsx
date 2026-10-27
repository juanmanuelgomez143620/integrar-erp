import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, KpiCard, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { DocStatus } from '@/components/common/status-badge'
import { api, type LaborVariance } from '@/lib/api'
import { money, qty, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { periodLabel } from './payroll'

const head = 'h-9 text-xs font-semibold text-slate-600'

/** El mes anterior a hoy (aaaa-mm): el último que suele estar liquidado. */
function lastMonth() {
  const [y, m] = todayAR().slice(0, 7).split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** "sobreaplicada" o "subaplicada": la mano de obra que se cargó de más o de menos al costo. */
const variance = (difference: number) =>
  difference > 0 ? 'sobreaplicada' : difference < 0 ? 'subaplicada' : 'sin diferencia'

/**
 * La mano de obra del taller de un mes, por centro de trabajo: la aplicada a las órdenes
 * terminadas contra la real de los sueldos (docs/FASE_6_RRHH_Y_SUELDOS.md §4).
 */
export function LaborVariancePage() {
  const company = useCompany()
  const [period, setPeriod] = useState(lastMonth())
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
  const { data, error } = useQuery({
    queryKey: ['labor-variance', company.companyId, period],
    queryFn: () => api.laborVariance(company.companyId, period),
    enabled: valid,
  })
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Contabilidad' },
          { label: 'Mano de obra del taller' },
        ]}
        title="Mano de obra del taller"
        description="La mano de obra directa que se aplicó a las órdenes terminadas en el mes (las horas por la tarifa de cada centro de trabajo) contra la que se pagó de verdad (el remunerativo y las contribuciones del personal del taller en la liquidación del mes). La diferencia es lo que se cargó de más o de menos al costo de los productos."
      />
      <Section title="Mes">
        <Field label="Mes liquidado">
          <Input type="month" value={period} max={todayAR().slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
      </Section>
      <div className="mt-4">{data ? <Report data={data} /> : valid && <Loading error={error} />}</div>
    </>
  )
}

function Report({ data }: { data: LaborVariance }) {
  const month = periodLabel(data.period)
  const confirmed = !!data.payroll && data.payroll.status_info.label !== 'Borrador'
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Aplicada a las órdenes"
          value={money(data.applied)}
          hint={`${qty(data.hours)} h en ${data.orders.length} ${data.orders.length === 1 ? 'orden terminada' : 'órdenes terminadas'}`}
        />
        <KpiCard label="Real (sueldos del taller)" value={money(data.real)} hint="Remunerativo más contribuciones" />
        <KpiCard
          label="Diferencia"
          value={money(data.difference)}
          hint={`Mano de obra ${variance(data.difference)}`}
          tone={data.difference < 0 ? 'danger' : data.difference > 0 ? 'warning' : 'default'}
        />
        <KpiCard
          label="Costo real por hora aplicada"
          value={data.hours > 0 ? money(data.real / data.hours) : '—'}
          hint={
            data.hours > 0 ? `Tarifa aplicada promedio: ${money(data.applied / data.hours)}` : 'Sin horas aplicadas'
          }
        />
      </div>
      {(!confirmed || data.orders.length === 0) && (
        <div className="flex gap-2 rounded-lg border border-brand-blue/30 bg-brand-blue-soft/60 px-3 py-2.5 text-sm text-slate-700">
          <Info className="mt-0.5 size-4 shrink-0 text-brand-blue" />
          <div>
            {!data.payroll && `No hay liquidación de ${month}: lo real aparece cuando RRHH la prepara y la confirma. `}
            {data.payroll &&
              !confirmed &&
              `${data.payroll.display_number} está en borrador: lo real aparece cuando RRHH la confirma. `}
            {data.orders.length === 0 &&
              `En ${month} no se terminaron órdenes de producción: no hay mano de obra aplicada.`}
          </div>
        </div>
      )}
      <Section
        title={`Por centro de trabajo, ${month}`}
        description="Si la diferencia es negativa, la tarifa de mano de obra del centro quedó corta (o hubo horas que no se aplicaron a ninguna orden); si es positiva, se aplicó de más."
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className={head}>Centro de trabajo</TableHead>
                <TableHead className={cn(head, 'text-right')}>Empleados</TableHead>
                <TableHead className={cn(head, 'text-right')}>Horas aplicadas</TableHead>
                <TableHead className={cn(head, 'text-right')}>Aplicada</TableHead>
                <TableHead className={cn(head, 'text-right')}>Real</TableHead>
                <TableHead className={cn(head, 'text-right')}>Diferencia</TableHead>
                <TableHead className={cn(head, 'text-right')}>Real por hora (tarifa de hoy)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                    Sin mano de obra del taller en el mes.
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((r) => (
                <TableRow key={r.work_center?.id ?? 'sin-centro'}>
                  <TableCell className="text-sm">
                    {r.work_center ? (
                      <>
                        <span className="font-mono text-xs font-semibold">{r.work_center.code}</span>{' '}
                        {r.work_center.name}
                      </>
                    ) : (
                      'Sin centro de trabajo'
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">{r.employees}</TableCell>
                  <TableCell className="tabular text-right">{qty(r.hours)}</TableCell>
                  <TableCell className="tabular text-right">{money(r.applied)}</TableCell>
                  <TableCell className="tabular text-right">{money(r.real)}</TableCell>
                  <TableCell
                    className={cn(
                      'tabular text-right font-medium',
                      r.difference < 0 && 'text-red-700',
                      r.difference > 0 && 'text-amber-700',
                    )}
                  >
                    {money(r.difference)}
                    <div className="text-xs font-normal text-muted-foreground">{variance(r.difference)}</div>
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {r.hours > 0 ? money(r.real / r.hours) : '—'}
                    {r.work_center && (
                      <div className="text-xs text-muted-foreground">({money(r.work_center.labor_rate)})</div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {data.rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell className="text-sm font-semibold text-navy">Total del taller</TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">
                    {data.rows.reduce((s, r) => s + r.employees, 0)}
                  </TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">{qty(data.hours)}</TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">{money(data.applied)}</TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">{money(data.real)}</TableCell>
                  <TableCell className="tabular text-right font-semibold text-navy">{money(data.difference)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </Section>
      <Section title="De dónde salen los importes">
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Liquidación:</span>
            {data.payroll ? (
              <Link to={data.payroll.path} className="flex items-center gap-2 hover:underline">
                <span className="font-mono font-semibold">{data.payroll.display_number}</span>
                <DocStatus info={data.payroll.status_info} />
              </Link>
            ) : (
              <span>—</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Órdenes terminadas:</span>
            {data.orders.length
              ? data.orders.map((o) => (
                  <Link key={o.id} to={o.path} className="font-mono text-xs font-semibold hover:underline">
                    {o.display_number}
                  </Link>
                ))
              : '—'}
          </div>
          <p className="text-xs text-muted-foreground">
            Lo real es lo que fue a Mano de obra directa (5.1.03.01) con el asiento de sueldos; lo aplicado, lo que fue
            a Mano de obra directa aplicada (5.1.02.01) al terminar cada orden. Si Contabilidad ajusta la diferencia
            contra el costo de ventas queda a validar.
          </p>
        </div>
      </Section>
    </div>
  )
}
