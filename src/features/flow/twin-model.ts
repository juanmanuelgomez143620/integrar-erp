// Modelo del gemelo digital: la planta de la empresa en 3D. Son funciones
// puras (sin Three.js) para poder probarlas sin interfaz; la escena sólo dibuja
// lo que devuelven.

import type { DocumentListItem, EmployeeRow, StockRow, TreasuryAccountRow } from '@/lib/api'
import type { AuditEvent, DocType, Vehicle } from '@/lib/domain/types'
import {
  coverageTone,
  documentNode,
  nodeFromSectorCode,
  nodeFromSectorName,
  type CoverageTone,
  type NodeId,
} from './flow-model'

/** Lugares de la planta: los sectores y lo que está afuera de la empresa. */
export type PlaceId = NodeId | 'SUP' | 'CLI' | 'BAN' | 'FIS'

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
// oficinas quedan atrás, con Gerencia en el centro; afuera, el Banco y el Fisco.
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
  FIS: { label: 'Fisco', kind: 'outside', x: -23, z: -10, w: 5, d: 5 },
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
  // Las declaraciones van al fisco desde Impuestos; los pagos, desde Tesorería.
  { from: 'IMP', to: 'FIS', kind: 'paper' },
  { from: 'TES', to: 'FIS', kind: 'money' },
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
    case 'ROUTE_SHEET':
      return 'sales'
    case 'PRODUCTION_ORDER':
      return 'production'
    default:
      return 'money'
  }
}

export const FAMILY_LABELS: Record<DocFamily, string> = {
  purchasing: 'Compras',
  sales: 'Ventas y entregas',
  production: 'Producción',
  money: 'Dinero y registros',
}

// --- el personal -------------------------------------------------------------

export interface StaffFigure {
  id: string
  place: NodeId
  /** Nombre, categoría y centro de trabajo, para el cartel al pasar el mouse. */
  tip: string
  /** Centro de trabajo del taller (su código), si tiene. */
  station: string | null
}

/**
 * El personal activo del legajo, en el sector de cada uno (el operario de
 * depósito, en terminados). El chofer de una hoja de ruta en camino no está en
 * su sector: va en el camión.
 */
export function staffFigures(employees: EmployeeRow[], docs: DocumentListItem[]): StaffFigure[] {
  const driving = new Set(
    docs
      .filter((doc) => doc.doc_type === 'ROUTE_SHEET' && doc.status === 'EN_CAMINO' && doc.rs?.driver_id)
      .map((doc) => doc.rs!.driver_id),
  )
  return employees
    .filter((e) => e.status === 'ACTIVO' && !driving.has(e.id))
    .flatMap((e) => {
      const place = nodeFromSectorCode(e.sector.code)
      if (!place) return []
      const where = e.work_center ? ` · ${e.work_center.name}` : ''
      return [
        {
          id: e.id,
          place,
          tip: `${e.last_name}, ${e.first_name} · ${e.category.name}${where}`,
          station: e.work_center?.code ?? null,
        },
      ]
    })
}

// --- el transporte -----------------------------------------------------------

export interface Truck {
  docId: string
  label: string
  /** Entra al muelle de recepción o sale por el de despacho. */
  direction: 'in' | 'out'
}

const MAX_TRUCKS = 3

/** Camiones que llegan de Proveedores: las órdenes de compra enviadas que Depósito espera. */
export function trucks(docs: DocumentListItem[]): Truck[] {
  return docs
    .filter(
      (doc) => doc.doc_type === 'PURCHASE_ORDER' && (doc.status === 'ENVIADO' || doc.status === 'RECIBIDO_PARCIAL'),
    )
    .slice(0, MAX_TRUCKS)
    .map((doc) => ({ docId: doc.id, label: doc.display_number, direction: 'in' as const }))
}

export interface RouteTruck {
  docId: string
  label: string
  /** Con qué sale: el transportista, o el vehículo propio con su chofer. */
  transport: string
  stops: number
  /** En camino a los clientes; si no, cargando en el muelle de terminados. */
  moving: boolean
  own: boolean
}

/** Las hojas de ruta abiertas: cargando en el muelle o en camino a los clientes. */
export function routeTrucks(docs: DocumentListItem[]): RouteTruck[] {
  return docs
    .filter((doc) => doc.doc_type === 'ROUTE_SHEET' && (doc.status === 'BORRADOR' || doc.status === 'EN_CAMINO'))
    .slice(0, MAX_TRUCKS)
    .map((doc) => ({
      docId: doc.id,
      label: doc.display_number,
      transport: doc.summary,
      stops: doc.line_count,
      moving: doc.status === 'EN_CAMINO',
      own: Boolean(doc.rs?.vehicle_id),
    }))
}

/** Los vehículos propios activos que ninguna hoja de ruta abierta está usando: esperan estacionados. */
export function parkedVehicles(vehicles: Vehicle[], docs: DocumentListItem[]): { id: string; label: string }[] {
  const busy = new Set(
    docs
      .filter((doc) => doc.doc_type === 'ROUTE_SHEET' && (doc.status === 'BORRADOR' || doc.status === 'EN_CAMINO'))
      .map((doc) => doc.rs?.vehicle_id),
  )
  return vehicles
    .filter((v) => v.is_active && !busy.has(v.id))
    .map((v) => ({ id: v.id, label: `${v.code} (${v.plate})` }))
}

/** Los remitos en preparación: bultos en el muelle de terminados. */
export function packages(docs: DocumentListItem[]): { docId: string; label: string }[] {
  return docs
    .filter((doc) => doc.doc_type === 'DELIVERY_NOTE' && doc.status === 'BORRADOR')
    .slice(0, 4)
    .map((doc) => ({ docId: doc.id, label: doc.display_number }))
}

// --- el banco y el fisco -----------------------------------------------------

/** Lo que hay en los bancos: el saldo de las cuentas bancarias del libro mayor. */
export function bankBalance(accounts: TreasuryAccountRow[]): number {
  return accounts
    .filter((a) => a.account.is_active && /banco/i.test(a.account.name))
    .reduce((sum, a) => sum + a.balance, 0)
}

export interface FiscoInfo {
  /** Declaraciones presentadas que falta pagar. */
  pending: number
  amount: number
  /** El vencimiento más próximo de esas declaraciones. */
  nextDue: string | null
}

/** Lo que la empresa le debe al fisco: las declaraciones presentadas sin pagar. */
export function fiscoInfo(docs: DocumentListItem[]): FiscoInfo {
  const due = docs.filter((doc) => doc.doc_type === 'TAX_RETURN' && doc.status === 'PRESENTADA')
  return {
    pending: due.length,
    amount: due.reduce((sum, doc) => sum + doc.total, 0),
    nextDue: due.map((doc) => doc.tr!.due_date).sort()[0] ?? null,
  }
}

// --- los productos -----------------------------------------------------------

export type ShapeKind =
  'table' | 'chair' | 'wardrobe' | 'bed' | 'mattress' | 'planks' | 'boards' | 'cans' | 'hardware' | 'rolls' | 'box'

const FURNITURE = new Set<ShapeKind>(['table', 'chair', 'wardrobe', 'bed', 'mattress'])

/**
 * Cuántas unidades se dibujan como mucho; el resto va en el cartel (a validar). Los muebles y
 * las placas (que se cuentan por unidad) van uno por uno.
 */
const MAX_UNITS: Partial<Record<ShapeKind, number>> = {
  table: 8,
  chair: 8,
  wardrobe: 8,
  bed: 8,
  mattress: 6,
  boards: 12,
}

/** Niveles de los materiales a granel: la altura sigue a la cantidad, no a cada unidad. */
const BULK_LEVELS = 6

/** La forma con que se dibuja un producto: sale de su nombre y de su categoría (a validar). */
export function productShape(product: { name: string; category: string }): ShapeKind {
  const name = product.name.toLowerCase()
  const category = product.category.toLowerCase()
  if (/\bmesa/.test(name)) return 'table'
  if (/\bsilla/.test(name)) return 'chair'
  if (/placard|ropero|armario/.test(name)) return 'wardrobe'
  if (/colch/.test(name)) return 'mattress'
  if (/\bcama/.test(name)) return 'bed'
  if (/\btabla\b|tirante|list[oó]n/.test(name)) return 'planks'
  if (/placa|tablero|mdf|fen[oó]lic/.test(name)) return 'boards'
  if (/barniz|\bcola\b|pintura|laca|sellador/.test(name)) return 'cans'
  if (/tornillo|bisagra|corredera|herraje|clavo|tuerca/.test(name)) return 'hardware'
  if (/film|rollo|cinta/.test(name)) return 'rolls'
  if (category.includes('madera')) return 'planks'
  if (category.includes('placa') || category.includes('tablero')) return 'boards'
  if (category.includes('herraje')) return 'hardware'
  if (category.includes('embalaje')) return 'rolls'
  return 'box'
}

/**
 * Cuántas figuras se dibujan de una cantidad: una por unidad en los muebles y en las placas
 * contadas por unidad (hasta el tope); en lo demás, niveles según `level` (de 0 a 1).
 */
function figures(shape: ShapeKind, qty: number, level: number, countable: boolean) {
  if (!FURNITURE.has(shape) && !(countable && shape === 'boards')) {
    return { units: qty > 0 ? Math.max(1, Math.round(Math.min(1, level) * BULK_LEVELS)) : 0, more: 0 }
  }
  const whole = Math.max(0, Math.floor(qty))
  const units = Math.min(whole, MAX_UNITS[shape] ?? whole)
  return { units, more: whole - units }
}

export interface StockPile {
  key: string
  place: 'DEP_MP' | 'DEP_PT'
  code: string
  name: string
  qty: number
  uom: string
  shape: ShapeKind
  /** Figuras a dibujar: una por unidad (muebles y placas) o niveles proporcionales en lo demás. */
  units: number
  /** Las unidades que no se dibujan (el cartel dice "+N"). */
  more: number
  tone: CoverageTone
  reserved: boolean
}

const FINISHED = new Set(['PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA'])

/**
 * El stock de cada depósito con la forma de cada producto y su cantidad. La altura de lo que
 * va a granel se mide contra el doble de su stock mínimo (cuánto hay respecto de lo habitual:
 * no se mezclan pies con litros); sin mínimo, contra el que más tiene de esa forma.
 */
export function stockPiles(rows: StockRow[]): StockPile[] {
  const place = (row: StockRow) => (FINISHED.has(row.product.product_type) ? 'DEP_PT' : 'DEP_MP')
  const shapeMax = new Map<string, number>()
  for (const row of rows) {
    const key = `${place(row)}:${productShape(row.product)}`
    shapeMax.set(key, Math.max(shapeMax.get(key) ?? 0, row.qty))
  }
  return rows.map((row) => {
    const shape = productShape(row.product)
    const reference =
      row.product.min_stock > 0 ? row.product.min_stock * 2 : (shapeMax.get(`${place(row)}:${shape}`) ?? 0)
    const level = reference > 0 ? Math.max(0, row.qty) / reference : 0
    return {
      key: `${row.warehouse.id}:${row.product.id}`,
      place: place(row),
      code: row.product.code,
      name: row.product.name,
      qty: row.qty,
      uom: row.product.uom_code,
      shape,
      ...figures(shape, row.qty, level, row.product.uom_code === 'UN'),
      tone: coverageTone(row),
      reserved: row.reserved > 0,
    }
  })
}

export interface WorkInProgress {
  docId: string
  label: string
  /** El producto que se fabrica: código y nombre. */
  product: string
  shape: ShapeKind
  quantity: number
  units: number
  more: number
}

/** Lo que se está fabricando: las órdenes en proceso, con la forma del producto y la cantidad. */
export function workInProgress(docs: DocumentListItem[]): WorkInProgress[] {
  return docs
    .filter((doc) => doc.doc_type === 'PRODUCTION_ORDER' && doc.status === 'EN_PROCESO')
    .slice(0, 2)
    .map((doc) => {
      const shape = productShape({ name: doc.summary, category: '' })
      const quantity = doc.pd!.quantity
      return {
        docId: doc.id,
        label: doc.display_number,
        product: doc.summary,
        shape,
        quantity,
        ...figures(shape, quantity, 1, true),
      }
    })
}

// --- el recorrido de un documento ----------------------------------------------

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
