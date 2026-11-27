// Los escenarios (Fase 8g, docs/FASE_8G_ESCENARIOS.md): el panel del docente para iniciarlos, seguirlos y
// terminarlos, y el aviso del escenario en curso en Mi trabajo, con la consigna de la isla de cada estudiante.

import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleDashed, Flag, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Loading, Section } from '@/components/common/blocks'
import { api, commands, type ScenarioRunView } from '@/lib/api'
import { ROLES } from '@/lib/domain/catalog'
import { SCENARIOS, scenarioText, type ScenarioCode, type ScenarioInfo } from '@/lib/domain/scenarios'
import { date, money, relative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

function useScenarios() {
  const company = useCompany()
  return useQuery({ queryKey: ['scenarios', company.companyId], queryFn: () => api.scenarios(company.companyId) })
}

/** El nombre de una isla de la empresa: "Isla 3 · Ventas y Clientes". */
function useIslandName() {
  const company = useCompany()
  return (island: number) => {
    const name = company.islands.find((i) => i.number === island)?.name
    return `Isla ${island}${name ? ` · ${name}` : ''}`
  }
}

/** Los criterios de una isla en una corrida, con su estado. */
function IslandCriteria({ info, run, island }: { info: ScenarioInfo; run: ScenarioRunView; island: number }) {
  const state = new Map(run.criteria.map((c) => [c.key, c.done]))
  return (
    <ul className="grid gap-1">
      {info.criteria
        .filter((c) => c.island === island)
        .map((c) => {
          const done = state.get(c.key) ?? false
          return (
            <li key={c.key} className="flex gap-2 text-sm">
              {done ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="Logrado" />
              ) : (
                <CircleDashed className="mt-0.5 size-4 shrink-0 text-slate-400" aria-label="Pendiente" />
              )}
              <span className={cn(!done && 'text-muted-foreground')}>{scenarioText(c.text, run.labels, money)}</span>
            </li>
          )
        })}
    </ul>
  )
}

/** Una corrida: la situación de partida y el avance de cada isla. */
function RunCard({ run, actions }: { run: ScenarioRunView; actions?: ReactNode }) {
  const company = useCompany()
  const islandName = useIslandName()
  const info = SCENARIOS[run.scenario]
  const islands = [...new Set(info.criteria.map((c) => c.island))]
  const done = run.criteria.filter((c) => c.done).length
  return (
    <Section
      title={`Escenario «${info.name}»`}
      description={
        run.status === 'EN_CURSO'
          ? `En curso desde ${relative(run.started_at)} · lo inició ${run.started_by_name} · ${done} de ${run.criteria.length} criterios logrados`
          : `Del ${date(run.started_at)} al ${date(run.ended_at)} · ${done} de ${run.criteria.length} criterios logrados`
      }
      actions={actions}
    >
      <p className="text-sm">
        {scenarioText(info.situation, run.labels, money)}{' '}
        <Link
          to={company.docPath('SALES_ORDER', run.labels.order)}
          className="font-medium text-brand-blue hover:underline"
        >
          Ver el pedido
        </Link>
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        {islands.map((island) => {
          const criteria = info.criteria.filter((c) => c.island === island)
          const islandDone = criteria.filter((c) => run.criteria.find((x) => x.key === c.key)?.done).length
          return (
            <div key={island} className="min-w-0 rounded-lg border p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-navy">{islandName(island)}</span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    islandDone === criteria.length ? 'text-emerald-700' : 'text-muted-foreground',
                  )}
                >
                  {islandDone} de {criteria.length}
                </span>
              </div>
              <IslandCriteria info={info} run={run} island={island} />
            </div>
          )
        })}
      </div>
    </Section>
  )
}

/** Panel docente → Escenarios: iniciar uno (de a uno por empresa), seguirlo y terminarlo. */
export function ScenariosSection() {
  const company = useCompany()
  const islandName = useIslandName()
  const view = useScenarios()
  const start = useCommand((code: ScenarioCode) => commands.startScenario(company.companyId, code), {
    success: (r) => `Escenario iniciado: llegó el pedido ${r.order}. Cada isla tiene su consigna en Mi trabajo.`,
  })
  const end = useCommand(() => commands.endScenario(company.companyId), {
    success: (r) => `Escenario terminado: ${r.done} de ${r.total} criterios logrados.`,
  })
  if (!view.data) return <Loading error={view.error} />
  const { current, history } = view.data
  return (
    <div className="grid grid-cols-1 gap-4">
      {current && (
        <RunCard
          run={current}
          actions={
            <Button size="sm" variant="outline" disabled={end.isPending} onClick={() => end.mutate([])}>
              <Square /> Terminar el escenario
            </Button>
          }
        />
      )}
      <Section
        title="Escenarios"
        description="Un desafío con nombre para la empresa del curso: llega una situación de partida, cada isla recibe su consigna y los criterios de logro se tildan solos con lo que se registra. De a uno por vez."
      >
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Object.values(SCENARIOS).map((s) => (
            <li key={s.code} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
              <div className="flex items-center gap-2 font-medium text-navy">
                <Flag className="size-4 text-brand-blue" /> {s.name}
              </div>
              <p className="text-sm text-muted-foreground">{s.summary}</p>
              <p className="text-xs text-muted-foreground">
                Participan:{' '}
                {[...new Set(s.briefs.map((b) => b.island))]
                  .sort((a, b) => a - b)
                  .map(islandName)
                  .join(', ')}
                .
              </p>
              <div>
                <Button size="sm" disabled={!!current || start.isPending} onClick={() => start.mutate([s.code])}>
                  <Play /> Iniciar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
      {history.length > 0 && (
        <div className="grid grid-cols-1 gap-4">
          {history.map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  )
}

/** En Mi trabajo: el escenario en curso, con la consigna de la isla de quien mira y lo que le falta. */
export function ScenarioBanner() {
  const company = useCompany()
  const islandName = useIslandName()
  const view = useScenarios()
  const run = view.data?.current
  if (!run) return null
  const info = SCENARIOS[run.scenario]
  const mine = new Set(company.roles.map((r) => ROLES[r.role_code]?.island).filter((n): n is number => !!n))
  const briefs = info.briefs.filter((b) => company.supervisor || mine.has(b.island))
  return (
    <Section
      className="mb-4 border-sky-200"
      title={`Escenario en curso: «${info.name}»`}
      description={scenarioText(info.situation, run.labels, money)}
    >
      {briefs.length ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {briefs.map((b) => (
            <div key={b.island} className="min-w-0 rounded-lg border bg-sky-50/50 p-3">
              <div className="text-xs font-semibold tracking-wide text-brand-blue uppercase">
                {islandName(b.island)}
              </div>
              <p className="mt-1 text-sm">{scenarioText(b.text, run.labels, money)}</p>
              <div className="mt-2">
                <IslandCriteria info={info} run={run} island={b.island} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Tu isla no participa en este escenario. Participan:{' '}
          {[...new Set(info.briefs.map((b) => b.island))]
            .sort((a, b) => a - b)
            .map(islandName)
            .join(', ')}
          .
        </p>
      )}
    </Section>
  )
}
