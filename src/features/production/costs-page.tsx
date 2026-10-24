import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Input } from '@/components/ui/input'
import { DataTable } from '@/components/common/data-table'
import { Field, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api, type ProductionCostRow } from '@/lib/api'
import { date, money, percent, qty, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Costos de producción: las órdenes terminadas de un período, previsto contra real (docs/FASE_5_PRODUCCION_Y_COSTOS.md §4). */
export function ProductionCostsPage() {
  const company = useCompany()
  const today = todayAR()
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`)
  const [to, setTo] = useState(today)
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['production-costs', company.companyId, from, to],
    queryFn: () => api.productionCosts(company.companyId, from, to),
    enabled: !!from && !!to,
  })
  const totals = data.reduce(
    (t, r) => ({
      material: t.material + r.material_cost,
      labor: t.labor + r.labor_cost,
      overhead: t.overhead + r.overhead_cost,
    }),
    { material: 0, labor: 0, overhead: 0 },
  )
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Producción' }, { label: 'Costos de producción' }]}
        title="Costos de producción"
        description="Las órdenes terminadas en el período: el costo real de cada elemento (materia prima, mano de obra directa y carga fabril), el de cada unidad y cuánto se aparta del costo estándar del producto."
      />
      <Section title="Período">
        <div className="flex flex-wrap gap-4">
          <Field label="Desde">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Section>
      <div className="mt-4">
        <DataTable<ProductionCostRow>
          rows={data}
          loading={isLoading}
          error={error}
          rowKey={(r) => r.order.id}
          search={(r) => `${r.order.display_number} ${r.product.code} ${r.product.name}`}
          searchPlaceholder="Buscar orden o producto…"
          empty="No se terminaron órdenes en el período."
          columns={[
            {
              key: 'order',
              header: 'Orden',
              sort: (r) => r.order.display_number,
              cell: (r) => (
                <Link to={r.order.path} className="font-mono text-xs hover:underline">
                  {r.order.display_number}
                </Link>
              ),
            },
            { key: 'date', header: 'Terminada', sort: (r) => r.finished_on, cell: (r) => date(r.finished_on) },
            {
              key: 'product',
              header: 'Producto',
              sort: (r) => r.product.code,
              cell: (r) => (
                <span className="text-xs">
                  <span className="font-mono font-semibold">{r.product.code}</span> {r.product.name}
                </span>
              ),
            },
            {
              key: 'units',
              header: 'Unidades',
              align: 'right',
              sort: (r) => r.quantity_produced,
              cell: (r) => (
                <span className="tabular">
                  {qty(r.quantity_produced)}
                  {r.quantity_produced !== r.quantity && (
                    <span className="text-xs text-amber-700"> de {qty(r.quantity)}</span>
                  )}
                </span>
              ),
            },
            {
              key: 'material',
              header: 'Materia prima',
              align: 'right',
              sort: (r) => r.material_cost,
              cell: (r) => <span className="tabular">{money(r.material_cost)}</span>,
            },
            {
              key: 'labor',
              header: 'Mano de obra',
              align: 'right',
              sort: (r) => r.labor_cost,
              cell: (r) => <span className="tabular">{money(r.labor_cost)}</span>,
            },
            {
              key: 'overhead',
              header: 'Carga fabril',
              align: 'right',
              sort: (r) => r.overhead_cost,
              cell: (r) => <span className="tabular">{money(r.overhead_cost)}</span>,
            },
            {
              key: 'total',
              header: 'Real (previsto)',
              align: 'right',
              sort: (r) => r.material_cost + r.labor_cost + r.overhead_cost,
              cell: (r) => {
                const real = round2(r.material_cost + r.labor_cost + r.overhead_cost)
                return (
                  <span className="tabular">
                    {money(real)}
                    <div className={cn('text-xs', real > r.planned_cost ? 'text-red-700' : 'text-muted-foreground')}>
                      ({money(r.planned_cost)})
                    </div>
                  </span>
                )
              },
            },
            {
              key: 'unit',
              header: 'Por unidad (estándar)',
              align: 'right',
              sort: (r) => r.unit_cost,
              cell: (r) => {
                const gap = r.product.standard_cost
                  ? Math.round(((r.unit_cost - r.product.standard_cost) / r.product.standard_cost) * 1000) / 10
                  : null
                return (
                  <span className="tabular font-medium">
                    {money(r.unit_cost)}
                    <div
                      className={cn(
                        'text-xs font-normal',
                        gap !== null && gap > 5 ? 'text-red-700' : 'text-muted-foreground',
                      )}
                    >
                      ({money(r.product.standard_cost)}
                      {gap !== null && `, ${percent(gap, true)}`})
                    </div>
                  </span>
                )
              },
            },
          ]}
        />
      </div>
      {data.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          En el período: materia prima {money(totals.material)}, mano de obra directa {money(totals.labor)} y carga
          fabril {money(totals.overhead)}. La mano de obra y la carga fabril son las aplicadas (horas × tarifas
          predeterminadas): la diferencia con lo que se gastó de verdad es la sub- o sobreaplicación.
        </p>
      )}
    </>
  )
}
