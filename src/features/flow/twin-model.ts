// Modelo del gemelo digital: la planta de la empresa en 3D. Son funciones
// puras (sin Three.js) para poder probarlas sin interfaz; la escena sólo dibuja
// lo que devuelven.

import type { DocumentListItem, StockRow } from '@/lib/api'
import type { AuditEvent, DocType } from '@/lib/domain/types'
import { coverageTone, documentNode, nodeFromSectorName, type CoverageTone, type NodeId } from './flow-model'

/** Lugares de la planta: los sectores y lo que está afuera de la empresa. */
export type PlaceId = NodeId | 'SUP' | 'CLI' | 'BAN'

export type PlaceKind = 'office' | 'warehouse' | 'plant' | 'outside'

export interface Place {
  label: string
  kind: PlaceKind
  /** Centro sobre el piso (x hacia la derecha, z hacia quien mira). */
  x: number
  z: number
  /** Ancho y profundidad del sector. */
  w: number
  d: number
}

// La planta se lee de izquierda a derecha como el circuito físico: entra la
// mercadería de los proveedores, se produce y sale hacia los clientes. Las
// oficinas quedan atrás, con Gerencia en el centro.
export const PLACES: Record<PlaceId, Place> = {
  SUP: { label: 'Proveedores', kind: 'outside', x: -23, z: 3, w: 5, d: 8 },
  DEP_MP: { label: 'Depósito MP', kind: 'warehouse', x: -13, z: 3, w: 10, d: 8 },
  PRO: { label: 'Producción', kind: 'plant', x: -1, z: 3, w: 10, d: 8 },
  DEP_PT: { label: 'Depósito PT', kind: 'warehouse', x: 11, z: 3, w: 10, d: 8 },
  CLI: { label: 'Clientes', kind: 'outside', x: 22, z: 3, w: 5, d: 8 },
  COM: { label: 'Compras', kind: 'office', x: -14, z: -7, w: 6, d: 5 },
  CON: { label: 'Contabilidad', kind: 'office', x: -7, z: -7, w: 6, d: 5 },
  GER: { label: 'Gerencia', kind: 'office', x: 0, z: -7, w: 6, d: 5 },
  TES: { label: 'Tesorería', kind: 'office', x: 7, z: -7, w: 6, d: 5 },
  VEN: { label: 'Ventas', kind: 'office', x: 14, z: -7, w: 6, d: 5 },
  RRH: { label: 'RRHH', kind: 'office', x: -10.5, z: -14, w: 5, d: 4 },
  IMP: { label: 'Impuestos', kind: 'office', x: -3.5, z: -14, w: 5, d: 4 },
  CGE: { label: 'Control', kind: 'office', x: 3.5, z: -14, w: 5, d: 4 },
  LOG: { label: 'Logística', kind: 'office', x: 10.5, z: -14, w: 5, d: 4 },
  BAN: { label: 'Banco', kind: 'outside', x: 22, z: -10, w: 5, d: 5 },
}

export const PLACE_IDS = Object.keys(PLACES) as PlaceId[]

export type RouteKind = 'goods' | 'paper' | 'money'

export interface Route {
  from: PlaceId
  to: PlaceId
  kind: RouteKind
}

/** Los caminos por donde viajan la mercadería, los papeles y el dinero. */
export const ROUTES: Route[] = [
  { from: 'SUP', to: 'DEP_MP', kind: 'goods' },
  { from: 'DEP_MP', to: 'PRO', kind: 'goods' },
  { from: 'PRO', to: 'DEP_PT', kind: 'goods' },
  { from: 'DEP_PT', to: 'CLI', kind: 'goods' },
  { from: 'COM', to: 'GER', kind: 'paper' },
  { from: 'COM', to: 'DEP_MP', kind: 'paper' },
  { from: 'COM', to: 'SUP', kind: 'paper' },
  { from: 'VEN', to: 'GER', kind: 'paper' },
  { from: 'VEN', to: 'DEP_PT', kind: 'paper' },
  { from: 'VEN', to: 'CLI', kind: 'paper' },
  { from: 'DEP_MP', to: 'CON', kind: 'paper' },
  { from: 'CON', to: 'TES', kind: 'paper' },
  { from: 'GER', to: 'TES', kind: 'paper' },
  { from: 'TES', to: 'BAN', kind: 'money' },
  { from: 'CLI', to: 'BAN', kind: 'money' },
  { from: 'BAN', to: 'SUP', kind: 'money' },
]

export type DocFamily = 'purchasing' | 'sales' | 'production' | 'money'

/** Familia de un comprobante: define el color del sobre en la escena. */
export function docFamily(type: DocType): DocFamily {
  switch (type) {
    case 'PURCHASE_REQUISITION':
    case 'RFQ':
    case 'SUPPLIER_QUOTE':
    case 'PURCHASE_ORDER':
    case 'GOODS_RECEIPT':
      return 'purchasing'
    case 'SALES_QUOTE':
    case 'SALES_ORDER':
    case 'DELIVERY_NOTE':
    case 'SALES_INVOICE':
      return 'sales'
    case 'PRODUCTION_ORDER':
      return 'production'
    default:
      return 'money'
  }
}

export const FAMILY_LABELS: Record<DocFamily, string> = {
  purchasing: 'Compras',
  sales: 'Ventas',
  production: 'Producción',
  money: 'Dinero y registros',
}

export interface Truck {
  docId: string
  label: string
  /** Entra al muelle de recepción o sale por el de despacho. */
  direction: 'in' | 'out'
}

const MAX_TRUCKS = 3

/**
 * Camiones en los muelles: las órdenes de compra enviadas que Depósito espera
 * y los remitos que se están preparando para despachar.
 */
export function trucks(docs: DocumentListItem[]): Truck[] {
  const inbound = docs
    .filter(
      (doc) => doc.doc_type === 'PURCHASE_ORDER' && (doc.status === 'ENVIADO' || doc.status === 'RECIBIDO_PARCIAL'),
    )
    .slice(0, MAX_TRUCKS)
    .map((doc) => ({ docId: doc.id, label: doc.display_number, direction: 'in' as const }))
  const outbound = docs
    .filter((doc) => doc.doc_type === 'DELIVERY_NOTE' && doc.status === 'BORRADOR')
    .slice(0, MAX_TRUCKS)
    .map((doc) => ({ docId: doc.id, label: doc.display_number, direction: 'out' as const }))
  return [...inbound, ...outbound]
}

export interface RackSlot {
  key: string
  place: 'DEP_MP' | 'DEP_PT'
  code: string
  name: string
  qty: number
  /** Altura relativa a lo que más hay en ese depósito (0 a 1). */
  level: number
  tone: CoverageTone
  reserved: boolean
}

const FINISHED = new Set(['PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA'])

/** Las estanterías: cada posición de stock en el depósito que le corresponde. */
export function rackSlots(rows: StockRow[]): RackSlot[] {
  const place = (row: StockRow) => (FINISHED.has(row.product.product_type) ? 'DEP_PT' : 'DEP_MP')
  const max: Record<string, number> = { DEP_MP: 0, DEP_PT: 0 }
  for (const row of rows) max[place(row)] = Math.max(max[place(row)], row.qty)
  return rows.map((row) => ({
    key: `${row.warehouse.id}:${row.product.id}`,
    place: place(row),
    code: row.product.code,
    name: row.product.name,
    qty: row.qty,
    level: max[place(row)] > 0 ? Math.max(0, row.qty) / max[place(row)] : 0,
    tone: coverageTone(row),
    reserved: row.reserved > 0,
  }))
}

export interface ReplayStep {
  place: NodeId
  /** `null` en el último paso: dónde espera hoy el documento. */
  event: AuditEvent | null
}

/**
 * El recorrido de un documento según la auditoría: cada evento, en orden, en
 * el sector de quien actuó. Si no se sabe el sector, queda donde está el
 * documento hoy. Si sigue abierto y hoy espera en otro sector, ese es el
 * último paso.
 */
export function replaySteps(doc: DocumentListItem, audit: AuditEvent[]): ReplayStep[] {
  const now = documentNode(doc)
  const steps: ReplayStep[] = audit
    .filter((event) => event.document_id === doc.id)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id - b.id)
    .map((event) => ({ place: nodeFromSectorName(event.actor_sector_name) ?? now, event }))
  if (steps.length && !doc.status_info?.final && steps[steps.length - 1].place !== now) {
    steps.push({ place: now, event: null })
  }
  return steps
}
