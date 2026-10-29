import { Fragment } from 'react'
import { ChevronRight, Truck, Users } from 'lucide-react'
import type { DocumentListItem } from '@/lib/api'
import { DOC_TYPES } from '@/lib/domain/catalog'
import type { Badge } from '@/lib/domain/types'
import { cn } from '@/lib/utils'
import { LANES, LANE_NODES, NODES, type FlowNodes, type NodeId } from './flow-model'

const DOT_CLASSES: Record<Badge, string> = {
  neutral: 'bg-slate-400',
  info: 'bg-blue-500',
  warning: 'bg-amber-500',
  success: 'bg-emerald-500',
  danger: 'bg-red-500',
}

interface CircuitBoardProps {
  nodes: FlowNodes
  focus: NodeId | null
  activeNode: NodeId | null
  selectedDocId: string | null
  onFocus: (id: NodeId) => void
  onSelectDoc: (doc: DocumentListItem) => void
}

/**
 * Tablero del circuito: cuatro carriles con los sectores y las fichas de los
 * documentos abiertos. En pantallas chicas se desplaza horizontalmente dentro
 * de la tarjeta, sin desbordar la página.
 */
export function CircuitBoard({ nodes, focus, activeNode, selectedDocId, onFocus, onSelectDoc }: CircuitBoardProps) {
  return (
    <div>
      <p className="mb-2 text-[11px] text-muted-foreground xl:hidden">
        Desplazá el circuito hacia los costados para ver todos los sectores.
      </p>
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[800px] space-y-2.5">
          {LANES.map((lane) => (
            <div key={lane.id} className="flex items-stretch gap-2">
              <div className="flex w-[88px] shrink-0 flex-col justify-center border-r pr-2">
                <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">{lane.label}</span>
                <span className="mt-0.5 text-[10px] leading-tight text-slate-500">{lane.hint}</span>
              </div>
              <div className={cn('flex flex-1 items-stretch gap-1', lane.id === 'physical' && 'gap-1.5')}>
                {lane.id === 'physical' && <ExternalNode icon={Truck} label="Proveedores" />}
                {LANE_NODES[lane.id].map((id, index) => (
                  <Fragment key={id}>
                    {index > 0 && <Arrow />}
                    <SectorCard
                      id={id}
                      nodes={nodes}
                      fill={lane.id === 'physical'}
                      focus={focus === id}
                      active={activeNode === id}
                      selectedDocId={selectedDocId}
                      onFocus={() => onFocus(id)}
                      onSelectDoc={onSelectDoc}
                    />
                  </Fragment>
                ))}
                {lane.id === 'physical' && <ExternalNode icon={Users} label="Clientes" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExternalNode({ icon: Icon, label }: { icon: typeof Truck; label: string }) {
  return (
    <div className="flex w-[86px] shrink-0 flex-col justify-center rounded-xl border border-dashed bg-muted/40 px-2 py-2 text-center">
      <Icon className="mx-auto size-4 text-slate-400" aria-hidden />
      <span className="mt-1 text-[11px] font-medium text-slate-600">{label}</span>
    </div>
  )
}

function Arrow() {
  return <ChevronRight className="size-3.5 shrink-0 self-center text-slate-300" aria-hidden />
}

function SectorCard({
  id,
  nodes,
  fill,
  focus,
  active,
  selectedDocId,
  onFocus,
  onSelectDoc,
}: {
  id: NodeId
  nodes: FlowNodes
  fill: boolean
  focus: boolean
  active: boolean
  selectedDocId: string | null
  onFocus: () => void
  onSelectDoc: (doc: DocumentListItem) => void
}) {
  const meta = NODES[id]
  const stats = nodes[id]
  const hasWork = stats.tasks.length > 0

  return (
    <div
      className={cn(
        'relative flex min-w-0 flex-col rounded-xl border bg-card p-2 transition-colors hover:border-brand-blue/40',
        fill ? 'flex-1 basis-0' : 'w-[132px] shrink-0',
        focus ? 'border-brand-blue ring-2 ring-brand-blue/20' : 'border-slate-200',
        active && 'border-amber-400 ring-2 ring-amber-300/60',
        meta.lane === 'support' && 'bg-muted/30',
      )}
    >
      <button type="button" onClick={onFocus} className="text-left">
        <div className="flex items-start justify-between gap-1">
          <span className="text-[9px] font-semibold tracking-wider text-slate-500 uppercase">{meta.code}</span>
          <span
            className={cn(
              'rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
              stats.docs.length ? 'bg-brand-blue-soft text-brand-blue' : 'bg-slate-100 text-slate-500',
            )}
            title={`${stats.docs.length} documentos abiertos`}
          >
            {stats.docs.length}
          </span>
        </div>
        <div className="mt-0.5 text-[12px] leading-tight font-semibold text-navy">{meta.short}</div>
        <div className={cn('mt-0.5 text-[10px]', hasWork ? 'text-amber-700' : 'text-slate-500')}>
          {hasWork ? `${stats.tasks.length} tarea${stats.tasks.length === 1 ? '' : 's'}` : 'sin tareas'}
        </div>
      </button>

      <div className="mt-1.5 flex min-h-4 flex-col gap-1">
        {stats.docs.slice(0, 3).map((doc) => (
          <DocChip key={doc.id} doc={doc} selected={doc.id === selectedDocId} onClick={() => onSelectDoc(doc)} />
        ))}
        {stats.docs.length > 3 && (
          <button
            type="button"
            onClick={onFocus}
            className="text-left text-[10px] font-medium text-brand-blue hover:underline"
          >
            +{stats.docs.length - 3} más
          </button>
        )}
        {stats.docs.length === 0 && !hasWork && <span className="text-[10px] text-slate-300">—</span>}
      </div>
    </div>
  )
}

function DocChip({ doc, selected, onClick }: { doc: DocumentListItem; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${DOC_TYPES[doc.doc_type].name} · ${doc.status_info.label}`}
      aria-label={`${DOC_TYPES[doc.doc_type].name} ${doc.display_number}, ${doc.status_info.label}`}
      className={cn(
        'flex w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-left transition-colors',
        selected
          ? 'border-brand-blue bg-brand-blue-soft'
          : 'border-slate-100 bg-slate-50/70 hover:border-brand-blue/40',
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASSES[doc.status_info.badge])} aria-hidden />
      <span className="truncate font-mono text-[10px] font-semibold text-navy">{doc.display_number}</span>
    </button>
  )
}

export function FlowLegend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-slate-600">Estado del documento:</span>
      {(
        [
          ['neutral', 'Borrador o cerrado'],
          ['info', 'En curso'],
          ['warning', 'Espera una decisión'],
          ['success', 'Aprobado o recibido'],
          ['danger', 'Rechazado o anulado'],
        ] as [Badge, string][]
      ).map(([badge, label]) => (
        <span key={badge} className="flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', DOT_CLASSES[badge])} aria-hidden />
          {label}
        </span>
      ))}
      <span className="ml-auto hidden sm:inline">
        Contador azul: documentos abiertos · texto ámbar: tareas pendientes
      </span>
    </div>
  )
}
