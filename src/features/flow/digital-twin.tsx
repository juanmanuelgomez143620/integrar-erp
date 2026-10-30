import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minimize2, Rotate3d } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DocumentListItem, EmployeeRow, StockRow, TreasuryAccountRow } from '@/lib/api'
import type { Vehicle } from '@/lib/domain/types'
import { cn } from '@/lib/utils'
import type { FlowNodes, NodeId } from './flow-model'
import {
  bankBalance,
  FAMILY_LABELS,
  fiscoInfo,
  packages,
  parkedVehicles,
  routeTrucks,
  staffFigures,
  stockPiles,
  trucks,
  workInProgress,
  type DocFamily,
} from './twin-model'
import type { TwinScene } from './twin-scene'

const FAMILY_SWATCH: Record<DocFamily, string> = {
  purchasing: 'bg-[#185FA5]',
  sales: 'bg-[#0F8A7E]',
  production: 'bg-[#8A5A2B]',
  money: 'bg-[#2E7D32]',
}

type Status = 'loading' | 'ready' | 'unsupported' | 'error'

/**
 * Gemelo digital: la planta de la empresa en 3D con el personal, los documentos,
 * las tareas, el stock con su forma, el reparto, el banco y el fisco reales.
 * Three.js se carga sólo acá.
 */
export function DigitalTwin({
  docs,
  nodes,
  stock,
  employees,
  vehicles,
  treasury,
  fiscoReadable,
  focus,
  activeNode,
  selectedDocId,
  replay,
  onSelectPlace,
  onSelectDoc,
  children,
}: {
  docs: DocumentListItem[]
  nodes: FlowNodes
  stock: StockRow[]
  /** El legajo; null si el rol no lo puede leer (figuras genéricas). */
  employees: EmployeeRow[] | null
  vehicles: Vehicle[]
  /** Las cajas y los bancos; null si el rol no los puede leer. */
  treasury: TreasuryAccountRow[] | null
  /** Si el rol puede leer las declaraciones de impuestos. */
  fiscoReadable: boolean
  focus: NodeId | null
  activeNode: NodeId | null
  selectedDocId: string | null
  /** Sectores del recorrido que se está repitiendo y el paso actual. */
  replay: { steps: NodeId[]; index: number } | null
  onSelectPlace: (id: NodeId) => void
  onSelectDoc: (id: string) => void
  /** Controles que van sobre la escena (el recorrido de un documento). */
  children?: React.ReactNode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<TwinScene | null>(null)
  const callbacks = useRef({ onSelectPlace, onSelectDoc })
  const [status, setStatus] = useState<Status>('loading')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    callbacks.current = { onSelectPlace, onSelectDoc }
  }, [onSelectPlace, onSelectDoc])

  useEffect(() => {
    let cancelled = false
    let scene: TwinScene | null = null
    import('./twin-scene')
      .then(({ TwinScene, webglAvailable }) => {
        if (cancelled || !hostRef.current) return
        if (!webglAvailable()) {
          setStatus('unsupported')
          return
        }
        scene = new TwinScene(hostRef.current, {
          onSelectPlace: (id) => callbacks.current.onSelectPlace(id),
          onSelectDoc: (id) => callbacks.current.onSelectDoc(id),
        })
        sceneRef.current = scene
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
      scene?.dispose()
      sceneRef.current = null
    }
  }, [])

  const state = useMemo(() => {
    const docCounts: Partial<Record<NodeId, number>> = {}
    const taskCounts: Partial<Record<NodeId, number>> = {}
    for (const [id, stats] of Object.entries(nodes) as [NodeId, FlowNodes[NodeId]][]) {
      docCounts[id] = stats.docs.length
      taskCounts[id] = stats.tasks.length
    }
    return {
      docs,
      docCounts,
      taskCounts,
      trucks: trucks(docs),
      routes: routeTrucks(docs),
      parked: parkedVehicles(vehicles, docs),
      packages: packages(docs),
      piles: stockPiles(stock),
      wip: workInProgress(docs),
      staff: employees ? staffFigures(employees, docs) : null,
      bank: treasury ? bankBalance(treasury) : null,
      fisco: fiscoReadable ? fiscoInfo(docs) : null,
    }
  }, [docs, nodes, stock, employees, vehicles, treasury, fiscoReadable])

  useEffect(() => {
    sceneRef.current?.update({ ...state, focus, activeNode, selectedDocId })
  }, [status, state, focus, activeNode, selectedDocId])

  useEffect(() => {
    sceneRef.current?.focusPlace(focus)
  }, [status, focus])

  const replayKey = replay ? `${replay.steps.join('>')}#${replay.index}` : ''
  useEffect(() => {
    sceneRef.current?.setReplay(replay?.steps ?? null, replay?.index ?? -1)
    // La clave resume el recorrido: evita repetir la animación en cada dibujo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, replayKey])

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border bg-[#F7F9FB]',
        expanded ? 'h-[78vh] min-h-[420px]' : 'h-[380px] sm:h-[500px]',
      )}
    >
      <div ref={hostRef} className="absolute inset-0" />

      {status !== 'ready' ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          {status === 'loading'
            ? 'Armando la planta en 3D…'
            : status === 'unsupported'
              ? 'Este equipo no puede mostrar gráficos 3D (WebGL). Usá el circuito de abajo: muestra lo mismo en 2D.'
              : 'No se pudo cargar la vista 3D. Usá el circuito de abajo: muestra lo mismo en 2D.'}
        </div>
      ) : (
        <>
          <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-2">
            <p className="pointer-events-auto hidden items-center gap-1.5 rounded-md bg-white/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm sm:flex">
              <Rotate3d className="size-3.5" aria-hidden />
              Arrastrá para girar · rueda para acercar · clic derecho para desplazar
            </p>
            <div className="pointer-events-auto ml-auto flex gap-1.5">
              <Button variant="outline" size="sm" className="bg-white/90" onClick={() => sceneRef.current?.resetView()}>
                Vista general
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8 bg-white/90"
                onClick={() => setExpanded((value) => !value)}
                aria-label={expanded ? 'Achicar la vista 3D' : 'Agrandar la vista 3D'}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            </div>
          </div>
          <TwinLegend />
          {children}
        </>
      )}
    </div>
  )
}

function TwinLegend() {
  return (
    <details className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] rounded-md bg-white/95 text-[11px] shadow-sm">
      <summary className="cursor-pointer px-2 py-1 font-semibold text-navy">Referencias</summary>
      <div className="grid gap-1.5 border-t px-2 py-2 text-muted-foreground">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {(Object.keys(FAMILY_LABELS) as DocFamily[]).map((family) => (
            <span key={family} className="flex items-center gap-1">
              <span className={cn('inline-block h-1.5 w-3 rounded-sm', FAMILY_SWATCH[family])} aria-hidden />
              {FAMILY_LABELS[family]}
            </span>
          ))}
        </div>
        <p>Cada sobre es un documento abierto, apilado en el sector donde está. Cuando cambia de estado, viaja.</p>
        <p>
          Depósitos: cada producto con su forma (una figura por mueble, hasta 8, y por placa, hasta 12; tablas, latas,
          cajas y rollos más altos cuanto más hay respecto del doble del mínimo). Al acercarse, cada producto muestra su
          cantidad. La base: <span className="font-medium text-[#185FA5]">azul</span> cubre el mínimo,{' '}
          <span className="font-medium text-[#B07D1E]">ámbar</span> está cerca y{' '}
          <span className="font-medium text-[#C0392B]">rojo</span> está por debajo; barra oscura = hay reserva.
        </p>
        <p>En Producción, la mesa de armado muestra lo que se está fabricando, con su forma y su cantidad.</p>
        <p>
          Camiones: órdenes de compra que llegan de Proveedores; hojas de ruta cargando en el muelle o en camino a
          Clientes (azul, el propio; verde, un transportista); el propio sin hoja, estacionado. Los bultos del muelle
          son remitos en preparación.
        </p>
        <p>
          Personas: el personal del legajo en su sector (el nombre, al pasar el mouse); sin permiso para ver el legajo,
          figuras genéricas. Se mueven cuando su sector tiene tareas pendientes.
        </p>
        <p>Banco: el saldo de las cuentas bancarias. Fisco: las declaraciones presentadas que falta pagar.</p>
      </div>
    </details>
  )
}
