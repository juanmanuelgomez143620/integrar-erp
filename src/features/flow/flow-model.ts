// Modelo de la vista "Mapa vivo": traduce documentos y tareas a los sectores
// del circuito. Son funciones puras para poder probarlas sin interfaz.

import type { DocumentListItem, StockRow, TaskItem } from '@/lib/api'
import { ROLES } from '@/lib/domain/catalog'
import type { DocType } from '@/lib/domain/types'

export type NodeId = 'GER' | 'COM' | 'DEP_MP' | 'PRO' | 'DEP_PT' | 'VEN' | 'TES' | 'CON' | 'LOG' | 'CGE' | 'IMP' | 'RRH'

export type Lane = 'approval' | 'physical' | 'money' | 'support'

export interface NodeMeta {
  label: string
  short: string
  code: string
  lane: Lane
  description: string
}

export const NODES: Record<NodeId, NodeMeta> = {
  GER: {
    label: 'Gerencia',
    short: 'Gerencia',
    code: 'GER',
    lane: 'approval',
    description: 'Aprueba las órdenes de compra, los pedidos que superan el crédito y los pagos.',
  },
  COM: {
    label: 'Compras',
    short: 'Compras',
    code: 'COM',
    lane: 'physical',
    description: 'Atiende las solicitudes, pide cotizaciones y emite las órdenes de compra.',
  },
  DEP_MP: {
    label: 'Depósito de materias primas',
    short: 'Depósito MP',
    code: 'DEP',
    lane: 'physical',
    description: 'Recibe la mercadería y entrega los materiales a Producción.',
  },
  PRO: {
    label: 'Producción',
    short: 'Producción',
    code: 'PRO',
    lane: 'physical',
    description: 'Planifica, libera y termina las órdenes de producción.',
  },
  DEP_PT: {
    label: 'Depósito de productos terminados',
    short: 'Depósito PT',
    code: 'DEP',
    lane: 'physical',
    description: 'Prepara y despacha los pedidos de venta.',
  },
  VEN: {
    label: 'Ventas',
    short: 'Ventas',
    code: 'VEN',
    lane: 'physical',
    description: 'Carga los pedidos, factura y sigue la cuenta corriente de los clientes.',
  },
  TES: {
    label: 'Tesorería',
    short: 'Tesorería',
    code: 'TES',
    lane: 'money',
    description: 'Paga proveedores, cobra clientes y controla las cajas y los bancos.',
  },
  CON: {
    label: 'Contabilidad',
    short: 'Contabilidad',
    code: 'CON',
    lane: 'money',
    description: 'Registra los asientos, las facturas y las conciliaciones.',
  },
  LOG: {
    label: 'Logística',
    short: 'Logística',
    code: 'LOG',
    lane: 'support',
    description: 'Armará las hojas de ruta y seguirá las entregas (Fase 7c).',
  },
  CGE: {
    label: 'Control de Gestión',
    short: 'Control',
    code: 'CGE',
    lane: 'support',
    description: 'Consulta y audita el circuito completo.',
  },
  IMP: {
    label: 'Impuestos',
    short: 'Impuestos',
    code: 'IMP',
    lane: 'support',
    description: 'Lleva los libros IVA y presenta las declaraciones.',
  },
  RRH: {
    label: 'RRHH y Sueldos',
    short: 'RRHH',
    code: 'RRH',
    lane: 'support',
    description: 'Lleva los legajos, los convenios y las liquidaciones.',
  },
}

export const LANES: { id: Lane; label: string; hint: string }[] = [
  { id: 'approval', label: 'Aprueba', hint: 'Decisiones que destraban el circuito' },
  { id: 'physical', label: 'Circuito físico', hint: 'De la compra a la entrega' },
  { id: 'money', label: 'Dinero y registros', hint: 'Facturas, pagos y asientos' },
  { id: 'support', label: 'Soporte', hint: 'Control, personal e impuestos' },
]

export const LANE_NODES: Record<Lane, NodeId[]> = {
  approval: ['GER'],
  physical: ['COM', 'DEP_MP', 'PRO', 'DEP_PT', 'VEN'],
  money: ['CON', 'TES'],
  support: ['LOG', 'CGE', 'IMP', 'RRH'],
}

/** Tipos de documento que se piden al contrato. Se filtran por permiso en la pantalla. */
export const FLOW_DOC_TYPES: DocType[] = [
  'PURCHASE_REQUISITION',
  'RFQ',
  'SUPPLIER_QUOTE',
  'PURCHASE_ORDER',
  'GOODS_RECEIPT',
  'PRODUCTION_ORDER',
  'SALES_QUOTE',
  'SALES_ORDER',
  'DELIVERY_NOTE',
  'SALES_INVOICE',
  'SUPPLIER_INVOICE',
  'PAYMENT_ORDER',
  'CUSTOMER_RECEIPT',
]

const NODE_BY_SECTOR_CODE: Record<string, NodeId> = {
  GER: 'GER',
  CGE: 'CGE',
  COM: 'COM',
  VEN: 'VEN',
  CON: 'CON',
  IMP: 'IMP',
  TES: 'TES',
  RRH: 'RRH',
  PRO: 'PRO',
  COS: 'PRO',
  DEP: 'DEP_PT',
  LOG: 'LOG',
}

const NODE_BY_SECTOR_NAME: Record<string, NodeId> = {
  Gerencia: 'GER',
  'Control de Gestión': 'CGE',
  Compras: 'COM',
  Ventas: 'VEN',
  Contabilidad: 'CON',
  Impuestos: 'IMP',
  'Tesorería y Finanzas': 'TES',
  'RRHH y Sueldos': 'RRH',
  Producción: 'PRO',
  Costos: 'PRO',
  Depósito: 'DEP_MP',
  Logística: 'LOG',
}

export function nodeFromSectorCode(code: string | null | undefined): NodeId | null {
  return code ? (NODE_BY_SECTOR_CODE[code] ?? null) : null
}

export function nodeFromSectorName(name: string | null | undefined): NodeId | null {
  return name ? (NODE_BY_SECTOR_NAME[name] ?? null) : null
}

/**
 * Dónde está hoy un documento abierto. No es una máquina de estados: es una
 * guía visual para el aula, basada en el estado que ya calculó el motor.
 */
export function documentNode(doc: DocumentListItem): NodeId {
  switch (doc.doc_type) {
    case 'PURCHASE_REQUISITION':
      return doc.status === 'BORRADOR' ? (nodeFromSectorName(doc.sector_name) ?? 'COM') : 'COM'
    case 'RFQ':
    case 'SUPPLIER_QUOTE':
      return 'COM'
    case 'PURCHASE_ORDER':
      if (doc.status === 'PENDIENTE_APROBACION' || doc.status === 'RECHAZADO') return 'GER'
      if (doc.status === 'RECIBIDO_PARCIAL') return 'DEP_MP'
      return 'COM'
    case 'GOODS_RECEIPT':
      return 'DEP_MP'
    case 'PRODUCTION_ORDER':
      return doc.status === 'LIBERADA' ? 'DEP_MP' : 'PRO'
    case 'SALES_QUOTE':
      return 'VEN'
    case 'SALES_ORDER':
      if (doc.status === 'PENDIENTE_APROBACION' || doc.status === 'RECHAZADO') return 'GER'
      if (doc.status === 'CONFIRMADO' || doc.status === 'ENTREGADO_PARCIAL') return 'DEP_PT'
      return 'VEN'
    case 'DELIVERY_NOTE':
      return 'DEP_PT'
    case 'SALES_INVOICE':
      return 'VEN'
    case 'SUPPLIER_INVOICE':
      return nodeFromSectorName(doc.sector_name) ?? 'CON'
    case 'PAYMENT_ORDER':
      if (doc.status === 'PENDIENTE_APROBACION' || doc.status === 'RECHAZADO') return 'GER'
      return 'TES'
    case 'CUSTOMER_RECEIPT':
      return 'TES'
    default:
      return 'CON'
  }
}

/** Dónde espera una tarea. Depósito se divide entre materiales y terminados. */
export function taskNode(task: TaskItem): NodeId | null {
  const role = task.assigned_role
  if (!role) return null
  if (role === 'DEPOSITO') {
    if (
      task.task_type === 'RECIBIR_MERCADERIA' ||
      task.task_type === 'ENTREGAR_MATERIALES' ||
      task.task_type === 'CONFIRMAR_RECEPCION' ||
      task.task_type === 'CONFIRMAR_AJUSTE'
    ) {
      return 'DEP_MP'
    }
    return 'DEP_PT'
  }
  return nodeFromSectorCode(ROLES[role]?.defaultSector)
}

export interface NodeStats {
  docs: DocumentListItem[]
  tasks: TaskItem[]
}

export type FlowNodes = Record<NodeId, NodeStats>

export function buildNodeStats(docs: DocumentListItem[], tasks: TaskItem[]): FlowNodes {
  const nodes = {} as FlowNodes
  for (const id of Object.keys(NODES) as NodeId[]) nodes[id] = { docs: [], tasks: [] }

  for (const doc of docs) nodes[documentNode(doc)].docs.push(doc)
  for (const task of tasks) {
    const node = taskNode(task)
    if (node) nodes[node].tasks.push(task)
  }

  for (const node of Object.values(nodes)) {
    // Lo más nuevo primero: al abrir un sector se ve qué acaba de entrar.
    node.docs.sort((a, b) => b.created_at.localeCompare(a.created_at))
    // Lo más viejo primero: es lo que está esperando hace más tiempo.
    node.tasks.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }
  return nodes
}

export type CoverageTone = 'danger' | 'warning' | 'ok'

/** Cobertura de la empresa contra el mínimo, con el mismo criterio que el stock. */
export function coverageTone(row: StockRow): CoverageTone {
  if (row.below_min) return 'danger'
  if (row.product.min_stock > 0 && row.total_qty < row.product.min_stock * 1.5) return 'warning'
  return 'ok'
}
