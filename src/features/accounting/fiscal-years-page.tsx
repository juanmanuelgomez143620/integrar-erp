import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarRange, Lock, LockOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, Loading, Section } from '@/components/common/blocks'
import { ActionDialog } from '@/components/common/dialogs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type PeriodView } from '@/lib/api'
import { date, dateTime, todayAR } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

export function FiscalYearsPage() {
  const company = useCompany()
  const { data, isLoading, error } = useQuery({
    queryKey: ['fiscal-years', company.companyId],
    queryFn: () => api.fiscalYears(company.companyId),
  })
  const [pending, setPending] = useState<PeriodView | null>(null)
  const [opening, setOpening] = useState(false)
  const canClose = company.can('fiscal_period.update')
  const setStatus = useCommand(
    (period: PeriodView, reason: string) =>
      commands.setPeriodStatus(
        company.companyId,
        period.id,
        period.status === 'ABIERTO' ? 'CERRADO' : 'ABIERTO',
        reason,
      ),
    { success: 'Listo. El cambio quedó en la auditoría.', onSuccess: () => setPending(null) },
  )
  const nextYear = data?.length ? Number(data[0].start_date.slice(0, 4)) + 1 : Number(todayAR().slice(0, 4))
  const open = useCommand(() => commands.openFiscalYear(company.companyId, nextYear), {
    success: `Ejercicio ${nextYear} abierto.`,
    onSuccess: () => setOpening(false),
  })
  if (isLoading || !data) return <Loading error={error} />
  const closing = pending?.status === 'ABIERTO'

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Contabilidad' }, { label: 'Ejercicios y períodos' }]}
        title="Ejercicios y períodos"
        description="El ejercicio es el año contable; cada mes es un período. Contabilidad cierra un mes cuando terminó de revisarlo y ya no se registran asientos con esas fechas. Sólo el docente puede reabrirlo."
        actions={
          company.supervisor ? (
            <Button variant="outline" onClick={() => setOpening(true)}>
              <CalendarRange /> Abrir ejercicio {nextYear}
            </Button>
          ) : undefined
        }
      />
      {!data.length && <EmptyState icon={CalendarRange} title="Todavía no hay ejercicios abiertos" />}
      <div className="flex flex-col gap-4">
        {data.map((year) => (
          <Section
            key={year.id}
            title={year.name}
            description={`Del ${date(year.start_date)} al ${date(year.end_date)}`}
            bodyClassName="p-0"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead className="text-xs">Período</TableHead>
                    <TableHead className="text-right text-xs">Asientos</TableHead>
                    <TableHead className="text-right text-xs">Borradores</TableHead>
                    <TableHead className="text-xs">Estado</TableHead>
                    <TableHead className="text-xs">
                      <span className="sr-only">Acciones</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {year.periods.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm font-medium">{p.name}</TableCell>
                      <TableCell className="tabular text-right text-sm">{p.entries || '—'}</TableCell>
                      <TableCell className="tabular text-right text-sm">{p.drafts || '—'}</TableCell>
                      <TableCell>
                        <StatusBadge
                          label={p.status === 'ABIERTO' ? 'Abierto' : 'Cerrado'}
                          badge={p.status === 'ABIERTO' ? 'success' : 'neutral'}
                        />
                        {p.status === 'CERRADO' && p.closed_at && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {p.closed_by_name} · {dateTime(p.closed_at)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {p.status === 'ABIERTO' && canClose && (
                          <Button size="sm" variant="outline" onClick={() => setPending(p)}>
                            <Lock /> Cerrar
                          </Button>
                        )}
                        {p.status === 'CERRADO' && company.supervisor && (
                          <Button size="sm" variant="outline" onClick={() => setPending(p)}>
                            <LockOpen /> Reabrir
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        ))}
      </div>
      {pending && (
        <ActionDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={`${closing ? 'Cerrar' : 'Reabrir'} ${pending.name}`}
          description={
            closing
              ? `Ya no se van a poder registrar asientos con fecha de ${pending.name.toLowerCase()}.${
                  pending.drafts
                    ? ` Hay ${pending.drafts} ${pending.drafts === 1 ? 'borrador' : 'borradores'} con esas fechas que quedarían sin registrar.`
                    : ''
                }`
              : 'Se van a poder registrar asientos de nuevo en ese mes. El motivo queda en la auditoría.'
          }
          confirmLabel={closing ? 'Cerrar el período' : 'Reabrir el período'}
          reason={!closing}
          reasonRequired={!closing}
          busy={setStatus.isPending}
          onConfirm={(text) => setStatus.mutate([pending, text])}
        />
      )}
      {opening && (
        <ActionDialog
          open
          onOpenChange={setOpening}
          title={`Abrir el ejercicio ${nextYear}`}
          description="Se crean los doce períodos mensuales, abiertos. Los saldos de las cuentas continúan del ejercicio anterior."
          confirmLabel="Abrir ejercicio"
          busy={open.isPending}
          onConfirm={() => open.mutate([])}
        />
      )}
    </>
  )
}
