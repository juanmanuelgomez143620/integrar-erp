import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api, type ControlArea, type ControlIndicator } from '@/lib/api'
import { date, money, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { periodLabel } from '@/features/hr/payroll'

/** "12,5 %": un porcentaje con un decimal. */
const percent = (n: number) => `${n.toLocaleString('es-AR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} %`

/** Cuánto cambió un indicador contra el mes anterior, en verde si conviene, en rojo si no. */
function Variation({ indicator }: { indicator: ControlIndicator }) {
  const diff = indicator.value - indicator.previous
  if (Math.abs(diff) < 0.005) return <span className="text-xs text-muted-foreground">Sin cambios</span>
  const pct = indicator.previous !== 0 ? (diff / Math.abs(indicator.previous)) * 100 : null
  const good = indicator.better === null ? null : diff > 0 === (indicator.better === 'UP')
  return (
    <span
      className={cn(
        'text-xs font-medium',
        good === true && 'text-green-700',
        good === false && 'text-red-700',
        good === null && 'text-muted-foreground',
      )}
    >
      {diff > 0 ? '▲' : '▼'} {money(Math.abs(diff))}
      {pct !== null && ` (${diff > 0 ? '+' : '−'}${percent(Math.abs(pct))})`}
    </span>
  )
}

/** Un área del tablero: sus indicadores, cada uno con el mes anterior y la variación. */
function AreaSection({ area }: { area: ControlArea }) {
  const sales = area.indicators.find((i) => i.key === 'VENTAS')
  return (
    <Section title={area.title}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {area.indicators.map((i) => (
          <div key={i.key} className="flex flex-col gap-0.5 rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">{i.label}</div>
            <div className="tabular text-lg font-semibold text-navy">{money(i.value)}</div>
            {i.key === 'MARGEN' && sales && sales.value !== 0 && (
              <div className="text-xs text-muted-foreground">
                {percent((i.value / sales.value) * 100)} de las ventas
              </div>
            )}
            <div className="text-xs text-muted-foreground">Mes anterior: {money(i.previous)}</div>
            <Variation indicator={i} />
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{i.hint}</div>
          </div>
        ))}
      </div>
    </Section>
  )
}

/**
 * Control → Tablero de control (Fase 7d.1): la empresa en una pantalla, el mes elegido contra el
 * anterior, desde el libro mayor y el Banco Aula.
 */
export function ControlPanelPage() {
  const company = useCompany()
  const [params, setParams] = useSearchParams()
  const month = params.get('mes') ?? todayAR().slice(0, 7)
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  const { data, error } = useQuery({
    queryKey: ['control-panel', company.companyId, month],
    queryFn: () => api.controlPanel(company.companyId, month),
    enabled: valid,
  })
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Control' }, { label: 'Tablero de control' }]}
        title="Tablero de control"
        description="La empresa en una pantalla: el mes elegido contra el anterior, desde el libro mayor (lo que se movió en el mes y los saldos al cierre) y el Banco Aula. El mes en curso se mide hasta hoy."
      />
      <Section className="mb-4">
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
        {data && (
          <p className="mt-2 text-xs text-muted-foreground">
            {periodLabel(data.period)} hasta el {date(data.to)}, contra {periodLabel(data.previous)} hasta el{' '}
            {date(data.previous_to)}.
          </p>
        )}
      </Section>
      {!valid ? null : !data ? (
        <Loading error={error} />
      ) : data.areas.length ? (
        <div className="grid gap-4">
          {data.areas.map((a) => (
            <AreaSection key={a.key} area={a} />
          ))}
        </div>
      ) : (
        <EmptyState icon={Gauge} title="No hay indicadores para mostrar">
          Los indicadores salen del libro mayor y del Banco Aula: hace falta poder leerlos.
        </EmptyState>
      )}
    </>
  )
}
