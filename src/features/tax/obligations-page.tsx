import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type ObligationRow, type ObligationsCalendar } from '@/lib/api'
import type { Badge } from '@/lib/domain/types'
import { date, lastMonthAR, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { periodLabel } from '@/features/hr/payroll'

const head = 'h-9 text-xs font-semibold text-slate-600'

const STATUS: Record<ObligationRow['status'], { label: string; badge: Badge }> = {
  PENDIENTE: { label: 'Pendiente', badge: 'neutral' },
  A_PAGAR: { label: 'A pagar', badge: 'info' },
  CUMPLIDA: { label: 'Cumplida', badge: 'success' },
}

/**
 * Las obligaciones de un mes y su estado, que salen de los documentos: los sueldos y las
 * cargas sociales de su liquidación, y los ingresos brutos y el IVA de sus declaraciones
 * (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §3).
 */
export function ObligationsPage() {
  const company = useCompany()
  const [params, setParams] = useSearchParams()
  const period = params.get('mes') ?? lastMonthAR()
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
  const { data, error } = useQuery({
    queryKey: ['obligations', company.companyId, period],
    queryFn: () => api.obligations(company.companyId, period),
    enabled: valid,
  })
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Impuestos' }, { label: 'Vencimientos' }]}
        title="Vencimientos"
        description="Lo que hay que pagar por cada mes y cuándo vence: los sueldos y las cargas sociales de la liquidación, y los ingresos brutos y el IVA de las declaraciones. El estado sale de los documentos: nada se carga a mano. Simulado: los vencimientos son propuestas a validar."
      />
      <Section>
        <Field label="Mes de las obligaciones" hint="Vencen en el mes siguiente.">
          <Input
            type="month"
            value={period}
            onChange={(e) =>
              setParams(
                (p) => {
                  p.set('mes', e.target.value)
                  return p
                },
                { replace: true },
              )
            }
            className="w-48"
          />
        </Field>
      </Section>
      <div className="mt-4">{data ? <Calendar data={data} /> : valid && <Loading error={error} />}</div>
    </>
  )
}

function Calendar({ data }: { data: ObligationsCalendar }) {
  const overdue = data.rows.filter((r) => r.overdue).length
  return (
    <Section
      title={`Obligaciones de ${periodLabel(data.period)}`}
      description={
        overdue
          ? `${overdue === 1 ? 'Una venció' : `${overdue} vencieron`} sin cumplirse: hay que regularizar${overdue === 1 ? 'la' : 'las'}.`
          : 'Ninguna vencida sin cumplirse.'
      }
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className={head}>Vence</TableHead>
              <TableHead className={head}>Obligación</TableHead>
              <TableHead className={head}>Estado</TableHead>
              <TableHead className={head}>Documento</TableHead>
              <TableHead className={cn(head, 'text-right')}>Importe</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r.kind} className={cn(r.overdue && 'bg-red-50/60')}>
                <TableCell className="text-sm whitespace-nowrap">{date(r.due_date)}</TableCell>
                <TableCell className="text-sm font-medium">{r.label}</TableCell>
                <TableCell className="text-sm">
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge label={STATUS[r.status].label} badge={STATUS[r.status].badge} />
                    {r.overdue && <StatusBadge label="Vencida" badge="danger" />}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{r.detail}</div>
                </TableCell>
                <TableCell className="text-sm">
                  {r.document ? (
                    <Link to={r.document.path} className="font-mono font-medium text-primary hover:underline">
                      {r.document.display_number}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="tabular text-right">{r.amount === null ? '—' : money(r.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}
