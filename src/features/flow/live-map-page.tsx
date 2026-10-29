import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Boxes,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Truck,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, KpiCard, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type DocumentListItem, type StockRow, type TaskItem } from '@/lib/api'
import { DOC_STATUSES, DOC_TYPES } from '@/lib/domain/catalog'
import type { AuditEvent, DocType, Priority } from '@/lib/domain/types'
import { dateTime, money, moneyShort, relative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { CircuitBoard, FlowLegend } from './circuit-board'
import {
  buildNodeStats,
  documentNode,
  FLOW_DOC_TYPES,
  NODES,
  nodeFromSectorName,
  type NodeId,
  type NodeStats,
} from './flow-model'
import { WarehouseView } from './warehouse-view'

interface FlowData {
  docs: DocumentListItem[]
  tasks: TaskItem[]
  audit: AuditEvent[]
  stock: StockRow[]
}

/**
 * Mapa vivo: una muestra de sólo lectura del circuito operativo. Usa las
 * lecturas del contrato y se degrada según los permisos del rol.
 */
export function LiveMapPage() {
  const company = useCompany()
  const readable = FLOW_DOC_TYPES.filter((type) => company.can(`${DOC_TYPES[type].resource}.read`))

  const { data, isLoading, error, isFetching, refetch, dataUpdatedAt } = useQuery<FlowData>({
    queryKey: ['live-map', company.companyId, readable.join(',')],
    queryFn: async () => {
      const [docs, tasks, audit, stock] = await Promise.all([
        Promise.all(readable.map((type) => api.documents(company.companyId, type))),
        api.tasks(company.companyId, 'all'),
        api.audit(company.companyId),
        company.can('stock.read') ? api.stock(company.companyId) : Promise.resolve([] as StockRow[]),
      ])
      return { docs: docs.flat(), tasks, audit, stock }
    },
    // Veinte segundos es suficiente para un aula y evita una consulta por
    // tipo de documento en cada segundo.
    refetchInterval: 20_000,
  })

  if (isLoading || !data) return <Loading error={error} />

  return (
    <LiveMap
      data={data}
      readable={readable}
      isFetching={isFetching}
      onRefresh={() => void refetch()}
      updatedAt={dataUpdatedAt}
      error={error}
    />
  )
}

function LiveMap({
  data,
  readable,
  isFetching,
  onRefresh,
  updatedAt,
  error,
}: {
  data: FlowData
  readable: DocType[]
  isFetching: boolean
  onRefresh: () => void
  updatedAt: number
  error: Error | null
}) {
  const company = useCompany()
  const [focus, setFocus] = useState<NodeId | null>(null)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const openDocs = useMemo(() => data.docs.filter((doc) => !doc.status_info.final), [data.docs])
  const nodes = useMemo(() => buildNodeStats(openDocs, data.tasks), [openDocs, data.tasks])
  const oldestTask = useMemo(
    () => [...data.tasks].sort((a, b) => a.created_at.localeCompare(b.created_at))[0],
    [data.tasks],
  )
  const stockValue = data.stock.reduce((sum, row) => sum + row.value, 0)
  const inTransit = openDocs.filter((doc) => doc.doc_type === 'PURCHASE_ORDER' && doc.status === 'ENVIADO').length
  const busySectors = (Object.keys(nodes) as NodeId[]).filter((id) => nodes[id].tasks.length > 0).length
  const selectedDoc = data.docs.find((doc) => doc.id === selectedDocId) ?? null

  const events = useMemo(() => data.audit.slice(0, 60).reverse(), [data.audit])
  const stepIndex = Math.min(step, events.length)
  const currentEvent = stepIndex > 0 ? events[stepIndex - 1] : null
  const activeNode = currentEvent ? nodeFromSectorName(currentEvent.actor_sector_name) : null

  useEffect(() => {
    if (!playing || events.length === 0 || stepIndex >= events.length) return
    const timer = window.setTimeout(() => setStep((value) => Math.min(value + 1, events.length)), 1500 / speed)
    return () => window.clearTimeout(timer)
  }, [playing, events.length, stepIndex, speed])

  // La antigüedad se mide contra la última actualización, no contra el reloj
  // del render: así el valor es estable y no cambia en cada dibujo.
  const oldestDays = oldestTask && updatedAt ? (updatedAt - new Date(oldestTask.created_at).getTime()) / 86_400_000 : 0
  const playingNow = playing && stepIndex < events.length

  function selectDoc(doc: DocumentListItem) {
    setSelectedDocId(doc.id)
    setFocus(documentNode(doc))
  }

  function focusNode(id: NodeId) {
    setFocus(id)
    setSelectedDocId(null)
  }

  function clearFocus() {
    setFocus(null)
    setSelectedDocId(null)
  }

  function togglePlay() {
    if (!events.length) return
    if (stepIndex >= events.length) {
      setStep(0)
      setPlaying(true)
      return
    }
    setPlaying((value) => !value)
  }

  function stepBy(delta: number) {
    setPlaying(false)
    setStep((value) => Math.max(0, Math.min(events.length, value + delta)))
  }

  return (
    <>
      <PageHeader
        title="Mapa vivo de la empresa"
        description="El circuito completo en una vista: documentos abiertos, tareas que esperan y stock en los depósitos. Se actualiza cada 20 segundos y muestra sólo lo que tu rol puede leer."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="relative flex size-2">
                {!error && (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                )}
                <span
                  className={cn('relative inline-flex size-2 rounded-full', error ? 'bg-amber-500' : 'bg-emerald-500')}
                />
              </span>
              {error ? 'Sin actualizar' : 'En vivo'} ·{' '}
              {updatedAt ? relative(new Date(updatedAt).toISOString()) : 'recién'}
            </span>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
              <RefreshCw className={cn(isFetching && 'animate-spin')} /> Actualizar
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Documentos en circuito"
          value={openDocs.length}
          icon={ClipboardList}
          hint={`${readable.length} tipos de comprobante`}
        />
        <KpiCard
          label="Tareas pendientes"
          value={data.tasks.length}
          icon={Boxes}
          hint={`${busySectors} sectores con trabajo`}
          tone={data.tasks.length ? 'warning' : 'default'}
        />
        <KpiCard
          label="Tarea más antigua"
          value={oldestTask ? relative(oldestTask.created_at) : '—'}
          icon={Clock}
          hint={oldestTask?.title ?? 'Sin tareas pendientes'}
          tone={oldestDays > 7 ? 'danger' : oldestDays > 2 ? 'warning' : 'default'}
        />
        {data.stock.length > 0 ? (
          <KpiCard
            label="Valor en depósito"
            value={moneyShort(stockValue)}
            icon={Wallet}
            hint={`${data.stock.length} posiciones de stock`}
          />
        ) : (
          <KpiCard label="OC en tránsito" value={inTransit} icon={Truck} hint="Mercadería que espera Depósito" />
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Section
          className="xl:col-span-2"
          title="Circuito operativo"
          description="Cada tarjeta es un sector; las fichas son documentos abiertos. Hacé clic en una ficha para verla y seguir la operación."
          actions={
            <span className="text-xs text-muted-foreground">
              {openDocs.length} documentos · {data.tasks.length} tareas
            </span>
          }
          bodyClassName="p-3 sm:p-4"
        >
          {readable.length === 0 ? (
            <p className="mb-3 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Tu rol no tiene acceso a los documentos del circuito. Igual podés ver tus tareas y la actividad que te
              corresponde.
            </p>
          ) : null}
          {openDocs.length === 0 && data.tasks.length === 0 ? (
            <div className="mb-3">
              <EmptyState icon={ClipboardList} title="No hay operaciones abiertas">
                Cuando alguien cree una solicitud de compra, un pedido de venta o una orden de producción, va a aparecer
                acá y vas a poder seguirla entre sectores.
              </EmptyState>
            </div>
          ) : null}
          <CircuitBoard
            nodes={nodes}
            focus={focus}
            activeNode={activeNode}
            selectedDocId={selectedDocId}
            onFocus={focusNode}
            onSelectDoc={selectDoc}
          />
          <FlowLegend />
        </Section>

        <Section
          className="order-2 xl:order-3"
          title={selectedDoc ? 'Documento' : focus ? NODES[focus].short : 'Dónde se trabaja'}
          description={
            selectedDoc
              ? DOC_TYPES[selectedDoc.doc_type].name
              : focus
                ? NODES[focus].description
                : 'Tareas abiertas por sector, de la cola más larga a la más corta.'
          }
          actions={
            selectedDoc || focus ? (
              <Button variant="ghost" size="sm" onClick={clearFocus}>
                <ArrowLeft /> Volver
              </Button>
            ) : undefined
          }
          bodyClassName="p-0"
        >
          {selectedDoc ? (
            <DocumentDetail doc={selectedDoc} />
          ) : focus ? (
            <SectorDetail node={focus} stats={nodes[focus]} onSelectDoc={selectDoc} />
          ) : (
            <SectorQueues nodes={nodes} onFocus={focusNode} readableCount={readable.length} />
          )}
        </Section>

        <Section
          title="Recorrido de la actividad"
          description="Reproducí los últimos eventos de auditoría. Resalta el sector que actuó; no reconstruye el estado histórico del mapa."
          className="order-3 xl:order-2"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPlaying(false)
                setStep(0)
              }}
              disabled={!events.length}
            >
              <RotateCcw /> Reiniciar
            </Button>
          }
        >
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay actividad registrada para recorrer.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => stepBy(-1)}
                  disabled={stepIndex === 0}
                  aria-label="Evento anterior"
                >
                  <ChevronLeft />
                </Button>
                <Button size="icon" onClick={togglePlay} aria-label={playingNow ? 'Pausar' : 'Reproducir'}>
                  {playingNow ? <Pause /> : <Play />}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => stepBy(1)}
                  disabled={stepIndex >= events.length}
                  aria-label="Evento siguiente"
                >
                  <ChevronRight />
                </Button>
                <input
                  type="range"
                  min={0}
                  max={events.length}
                  value={stepIndex}
                  onChange={(event) => {
                    setPlaying(false)
                    setStep(Number(event.target.value))
                  }}
                  className="min-w-[140px] flex-1 accent-[#185FA5]"
                  aria-label="Posición en el recorrido de la actividad"
                />
                <span className="tabular text-xs text-muted-foreground">
                  {stepIndex} / {events.length}
                </span>
                <select
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                  className="h-8 rounded-md border bg-card px-1.5 text-xs"
                  aria-label="Velocidad del recorrido"
                >
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </div>
              <div
                className="mt-3 min-h-16 rounded-lg border bg-muted/30 px-3 py-2.5"
                aria-live={playingNow ? 'off' : 'polite'}
                aria-atomic="true"
              >
                {currentEvent ? (
                  <>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="tabular font-medium text-foreground">{dateTime(currentEvent.occurred_at)}</span>
                      <span aria-hidden>·</span>
                      <span className="font-medium text-foreground">{currentEvent.actor_name}</span>
                      {currentEvent.actor_sector_name && currentEvent.actor_sector_name !== '—' ? (
                        <span>({currentEvent.actor_sector_name})</span>
                      ) : null}
                      {currentEvent.from_status && currentEvent.to_status ? (
                        <span className="rounded bg-card px-1.5 py-0.5 text-[10px]">
                          {statusLabel(currentEvent.from_status)} → {statusLabel(currentEvent.to_status)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm">{currentEvent.summary}</p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Al inicio del recorrido. Apretá Reproducir o avanzá con las flechas para ver qué hizo cada sector.
                  </p>
                )}
              </div>
            </>
          )}
        </Section>
      </div>

      {data.stock.length > 0 ? (
        <div className="mt-4">
          <WarehouseView rows={data.stock} productHref={(code) => company.to(`productos/${code}`)} />
        </div>
      ) : null}

      <details className="mt-4 rounded-xl border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-navy">Cómo leer el mapa</summary>
        <div className="border-t px-4 py-3">
          <ol className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <Step n="1" title="Sectores">
              Cada tarjeta es un sector. El número azul son los documentos abiertos; el ámbar, las tareas que esperan.
            </Step>
            <Step n="2" title="Documentos">
              Cada ficha es un comprobante con su número y estado. Hacé clic para ver el detalle y abrirlo.
            </Step>
            <Step n="3" title="Actividad">
              La línea de tiempo recorre lo que hizo cada sector. Sirve para explicar cómo se llegó al estado actual.
            </Step>
            <Step n="4" title="Depósito">
              Altura = cantidad relativa al máximo de la nave; color = cobertura sobre el mínimo; borde punteado = hay
              mercadería reservada.
            </Step>
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            El mapa no inventa movimientos: cada documento está donde su estado indica. Si un sector no aparece con
            trabajo, es porque no tiene tareas ni documentos abiertos en este momento.
          </p>
        </div>
      </details>
    </>
  )
}

function DocumentDetail({ doc }: { doc: DocumentListItem }) {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-navy">{doc.display_number}</span>
        <StatusBadge label={doc.status_info.label} badge={doc.status_info.badge} />
      </div>
      <p className="mt-3 text-sm">{doc.summary || 'Sin detalle.'}</p>
      <dl className="mt-3 space-y-1.5 text-xs">
        <DetailRow label="Sector" value={doc.sector_name} />
        <DetailRow label="Preparado por" value={doc.created_by_name} />
        <DetailRow label="Fecha" value={dateTime(doc.document_date)} />
        {doc.supplier_name ? <DetailRow label="Proveedor" value={doc.supplier_name} /> : null}
        {doc.customer_name ? <DetailRow label="Cliente" value={doc.customer_name} /> : null}
        {doc.pending_approver ? <DetailRow label="Espera a" value={doc.pending_approver} /> : null}
        {doc.reference_label ? <DetailRow label="Origen" value={doc.reference_label} /> : null}
        {doc.total > 0 ? <DetailRow label="Total" value={money(doc.total)} /> : null}
      </dl>
      <Button asChild className="mt-4 w-full">
        <Link to={doc.path}>Abrir documento</Link>
      </Button>
    </div>
  )
}

function SectorDetail({
  node,
  stats,
  onSelectDoc,
}: {
  node: NodeId
  stats: NodeStats
  onSelectDoc: (doc: DocumentListItem) => void
}) {
  return (
    <div className="divide-y">
      <div className="grid grid-cols-2 gap-2 p-4">
        <MiniStat label="Documentos" value={stats.docs.length} />
        <MiniStat label="Tareas" value={stats.tasks.length} />
      </div>
      <div className="p-4">
        <h3 className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Tareas que esperan</h3>
        {stats.tasks.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No hay tareas pendientes en este sector.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {stats.tasks.slice(0, 8).map((task) => (
              <li key={task.id}>
                <TaskRow task={task} />
              </li>
            ))}
          </ul>
        )}
        {stats.tasks.length > 8 ? (
          <p className="mt-2 text-xs text-muted-foreground">y {stats.tasks.length - 8} tareas más…</p>
        ) : null}
      </div>
      <div className="p-4">
        <h3 className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Documentos abiertos</h3>
        {stats.docs.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No hay documentos abiertos en este sector.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {stats.docs.slice(0, 8).map((doc) => (
              <li key={doc.id}>
                <DocRow doc={doc} onClick={() => onSelectDoc(doc)} />
              </li>
            ))}
          </ul>
        )}
        {stats.docs.length > 8 ? (
          <p className="mt-2 text-xs text-muted-foreground">y {stats.docs.length - 8} documentos más…</p>
        ) : null}
      </div>
      <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        {NODES[node].label}. {NODES[node].description}
      </p>
    </div>
  )
}

function SectorQueues({
  nodes,
  onFocus,
  readableCount,
}: {
  nodes: ReturnType<typeof buildNodeStats>
  onFocus: (id: NodeId) => void
  readableCount: number
}) {
  const rows = (Object.keys(nodes) as NodeId[])
    .map((id) => ({ id, stats: nodes[id] }))
    .filter((row) => row.stats.tasks.length > 0)
    .sort((a, b) => b.stats.tasks.length - a.stats.tasks.length)
  const max = Math.max(1, ...rows.map((row) => row.stats.tasks.length))

  if (rows.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">
          No hay tareas pendientes: el circuito está quieto. Cuando un sector tenga que actuar, va a aparecer acá.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Estás viendo {readableCount} tipos de documento según tus permisos.
        </p>
      </div>
    )
  }

  return (
    <div className="divide-y">
      {rows.map(({ id, stats }) => {
        const oldest = stats.tasks[0]
        return (
          <button
            key={id}
            type="button"
            onClick={() => onFocus(id)}
            className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
          >
            <span className="w-10 shrink-0 pt-0.5 text-[9px] font-semibold tracking-wider text-slate-500 uppercase">
              {NODES[id].code}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{NODES[id].short}</span>
                <span className="tabular text-sm font-semibold text-navy">{stats.tasks.length}</span>
              </span>
              <span className="mt-1 block h-1.5 rounded-full bg-muted">
                <span
                  className="block h-1.5 rounded-full bg-amber-400"
                  style={{ width: `${(stats.tasks.length / max) * 100}%` }}
                />
              </span>
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                La más antigua: {relative(oldest.created_at)} · {oldest.assignee_label}
              </span>
            </span>
          </button>
        )
      })}
      <p className="px-4 py-3 text-[11px] text-muted-foreground">
        Estás viendo {readableCount} tipos de documento según tus permisos. Los documentos que no podés leer no aparecen
        en el mapa.
      </p>
    </div>
  )
}

function TaskRow({ task }: { task: TaskItem }) {
  const body = (
    <>
      <PriorityDot priority={task.priority} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{task.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {task.assignee_label} · {relative(task.created_at)}
        </span>
      </span>
    </>
  )
  return task.path ? (
    <Link to={task.path} className="flex items-center gap-2 rounded-md px-1 py-1.5 hover:bg-muted/60">
      {body}
    </Link>
  ) : (
    <div className="flex items-center gap-2 px-1 py-1.5">{body}</div>
  )
}

function DocRow({ doc, onClick }: { doc: DocumentListItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-muted/60"
    >
      <span className="font-mono text-[11px] font-semibold text-navy">{doc.display_number}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{DOC_TYPES[doc.doc_type].name}</span>
      <StatusBadge label={doc.status_info.label} badge={doc.status_info.badge} className="h-4 px-1.5 text-[10px]" />
    </button>
  )
}

function PriorityDot({ priority }: { priority: Priority }) {
  return (
    <span
      role="img"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        priority === 'URGENTE'
          ? 'bg-red-500'
          : priority === 'ALTA'
            ? 'bg-amber-500'
            : priority === 'NORMAL'
              ? 'bg-slate-400'
              : 'bg-slate-300',
      )}
      aria-label={`Prioridad ${priority.toLowerCase()}`}
    />
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="tabular text-lg font-semibold text-navy">{value}</div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  )
}

/** Los eventos guardan el código del estado; en pantalla mostramos su nombre. */
function statusLabel(code: string) {
  for (const statuses of Object.values(DOC_STATUSES)) {
    const info = statuses[code]
    if (info) return info.label
  }
  return code
}

function Step({ n, title, children }: { n: string; title: string; children: string }) {
  return (
    <li className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-blue-soft text-[11px] font-semibold text-brand-blue">
          {n}
        </span>
        <span className="text-xs font-semibold text-navy">{title}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </li>
  )
}
