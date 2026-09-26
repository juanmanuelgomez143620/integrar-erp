// Catálogos del sistema. En Supabase serán tablas cargadas por migración
// (roles, permissions, role_permissions, document_types, document_statuses,
// document_transitions, task_rules). Ver DATABASE.md §5, §7 y §9.

import type {
  AdjustmentReason,
  Badge,
  DocType,
  ModuleCode,
  MovementType,
  Priority,
  ProductType,
  RoleCode,
  TransitionAction,
  VatCondition,
} from './types'

// ---------------------------------------------------------------- Módulos

export const MODULES: Record<ModuleCode, { name: string; lockable: boolean }> = {
  core: { name: 'Núcleo', lockable: false },
  masters: { name: 'Maestros (clientes, proveedores, productos)', lockable: true },
  purchasing: { name: 'Compras', lockable: true },
  inventory: { name: 'Depósito y stock', lockable: true },
  management: { name: 'Tablero de gestión', lockable: true },
  audit: { name: 'Auditoría', lockable: true },
}

export const RESOURCE_MODULE: Record<string, ModuleCode> = {
  company: 'core',
  member: 'core',
  sector: 'core',
  customer: 'masters',
  supplier: 'masters',
  product: 'masters',
  purchase_requisition: 'purchasing',
  purchase_order: 'purchasing',
  goods_receipt: 'inventory',
  stock: 'inventory',
  stock_adjustment: 'inventory',
  dashboard: 'management',
  task: 'management',
  audit: 'audit',
}

export function permissionModule(permission: string): ModuleCode {
  return RESOURCE_MODULE[permission.split('.')[0]] ?? 'core'
}

// ---------------------------------------------------------------- Roles

export interface RoleInfo {
  code: RoleCode
  name: string
  island: number | null
  defaultSector: string | null
  description: string
  isSupervisor: boolean
}

export const ROLES: Record<RoleCode, RoleInfo> = {
  GERENCIA: { code: 'GERENCIA', name: 'Gerencia', island: 1, defaultSector: 'GER', isSupervisor: false, description: 'Aprueba operaciones relevantes y supervisa indicadores y alertas.' },
  AUDITOR: { code: 'AUDITOR', name: 'Auditoría interna', island: 1, defaultSector: 'CGE', isSupervisor: false, description: 'Consulta todo y revisa la auditoría. No modifica nada.' },
  COMPRAS: { code: 'COMPRAS', name: 'Compras', island: 2, defaultSector: 'COM', isSupervisor: false, description: 'Atiende solicitudes, gestiona proveedores y emite órdenes de compra.' },
  VENTAS: { code: 'VENTAS', name: 'Ventas', island: 3, defaultSector: 'VEN', isSupervisor: false, description: 'Administra la cartera de clientes.' },
  CONTABILIDAD: { code: 'CONTABILIDAD', name: 'Contabilidad', island: 4, defaultSector: 'CON', isSupervisor: false, description: 'Consulta operaciones (asientos en fases siguientes).' },
  IMPUESTOS: { code: 'IMPUESTOS', name: 'Impuestos', island: 4, defaultSector: 'IMP', isSupervisor: false, description: 'Consulta operaciones (obligaciones en fases siguientes).' },
  TESORERIA: { code: 'TESORERIA', name: 'Tesorería y Finanzas', island: 5, defaultSector: 'TES', isSupervisor: false, description: 'Consulta órdenes de compra para proyectar pagos.' },
  RRHH: { code: 'RRHH', name: 'RRHH y Sueldos', island: 6, defaultSector: 'RRH', isSupervisor: false, description: 'Legajos y sueldos en fases siguientes.' },
  PRODUCCION: { code: 'PRODUCCION', name: 'Producción', island: 7, defaultSector: 'PRO', isSupervisor: false, description: 'Detecta necesidades de materiales y las solicita a Compras.' },
  DEPOSITO: { code: 'DEPOSITO', name: 'Depósito y Stock', island: 8, defaultSector: 'DEP', isSupervisor: false, description: 'Recibe mercadería, controla el stock y pide reposición.' },
  LOGISTICA: { code: 'LOGISTICA', name: 'Logística', island: 8, defaultSector: 'LOG', isSupervisor: false, description: 'Consulta recepciones y stock (despachos en fases siguientes).' },
  DOCENTE: { code: 'DOCENTE', name: 'Docente (supervisor)', island: null, defaultSector: null, isSupervisor: true, description: 'Todos los permisos en la empresa; puede actuar como supervisor.' },
}

export const ROLE_ORDER: RoleCode[] = [
  'GERENCIA', 'AUDITOR', 'COMPRAS', 'VENTAS', 'CONTABILIDAD', 'IMPUESTOS',
  'TESORERIA', 'RRHH', 'PRODUCCION', 'DEPOSITO', 'LOGISTICA', 'DOCENTE',
]

// ---------------------------------------------------------------- Permisos

const CORE_READ = ['company.read', 'member.read', 'sector.read']

/** Matriz del MVP (docs/ROLES_Y_PERMISOS.md §4). DOCENTE es supervisor: todo. */
export const ROLE_PERMISSIONS: Record<RoleCode, string[]> = {
  GERENCIA: [
    ...CORE_READ,
    'customer.read', 'customer.export', 'supplier.read', 'supplier.export', 'product.read', 'product.export',
    'stock.read', 'stock.export', 'stock_adjustment.read', 'stock_adjustment.approve',
    'purchase_requisition.read',
    'purchase_order.read', 'purchase_order.approve', 'purchase_order.cancel', 'purchase_order.export',
    'goods_receipt.read', 'dashboard.read', 'task.read', 'audit.read', 'audit.export',
  ],
  COMPRAS: [
    ...CORE_READ,
    'supplier.read', 'supplier.create', 'supplier.update', 'supplier.export',
    'product.read', 'product.create', 'product.update', 'stock.read',
    'purchase_requisition.read', 'purchase_requisition.approve',
    'purchase_order.read', 'purchase_order.create', 'purchase_order.update', 'purchase_order.approve',
    'purchase_order.cancel', 'purchase_order.export',
    'goods_receipt.read',
  ],
  VENTAS: [...CORE_READ, 'customer.read', 'customer.create', 'customer.update', 'customer.export', 'product.read', 'stock.read'],
  DEPOSITO: [
    ...CORE_READ,
    'supplier.read', 'product.read', 'product.create', 'product.update', 'stock.read', 'stock.export',
    'stock_adjustment.read', 'stock_adjustment.create', 'stock_adjustment.cancel',
    'purchase_requisition.read', 'purchase_requisition.create', 'purchase_requisition.update', 'purchase_requisition.cancel',
    'purchase_order.read', 'goods_receipt.read', 'goods_receipt.create', 'goods_receipt.cancel',
  ],
  PRODUCCION: [
    ...CORE_READ,
    'supplier.read', 'product.read', 'stock.read',
    'purchase_requisition.read', 'purchase_requisition.create', 'purchase_requisition.update', 'purchase_requisition.cancel',
    'purchase_order.read', 'goods_receipt.read',
  ],
  CONTABILIDAD: [
    ...CORE_READ,
    'customer.read', 'supplier.read', 'product.read', 'stock.read', 'stock_adjustment.read',
    'purchase_order.read', 'goods_receipt.read',
  ],
  TESORERIA: [...CORE_READ, 'customer.read', 'supplier.read', 'purchase_order.read'],
  RRHH: [...CORE_READ],
  IMPUESTOS: [...CORE_READ, 'customer.read', 'supplier.read', 'purchase_order.read'],
  LOGISTICA: [...CORE_READ, 'customer.read', 'supplier.read', 'product.read', 'stock.read', 'purchase_order.read', 'goods_receipt.read'],
  AUDITOR: [
    ...CORE_READ,
    'customer.read', 'customer.export', 'supplier.read', 'supplier.export', 'product.read', 'product.export',
    'stock.read', 'stock.export', 'stock_adjustment.read', 'purchase_requisition.read',
    'purchase_order.read', 'purchase_order.export', 'goods_receipt.read',
    'dashboard.read', 'task.read', 'audit.read', 'audit.export',
  ],
  DOCENTE: [],
}

// ---------------------------------------------------------------- Documentos

export interface DocTypeInfo {
  code: DocType
  prefix: string
  name: string
  plural: string
  resource: string
  module: ModuleCode
  path: string
  description: string
}

export const DOC_TYPES: Record<DocType, DocTypeInfo> = {
  PURCHASE_REQUISITION: {
    code: 'PURCHASE_REQUISITION', prefix: 'SC', name: 'Solicitud de compra', plural: 'Solicitudes de compra',
    resource: 'purchase_requisition', module: 'purchasing', path: 'compras/solicitudes',
    description: 'Documento interno por el cual un sector pide a Compras que adquiera algo. No compromete a la empresa con terceros.',
  },
  PURCHASE_ORDER: {
    code: 'PURCHASE_ORDER', prefix: 'OC', name: 'Orden de compra', plural: 'Órdenes de compra',
    resource: 'purchase_order', module: 'purchasing', path: 'compras/ordenes',
    description: 'Documento externo que compromete a la empresa con un proveedor: qué, cuánto, a qué precio, cuándo y dónde entregar.',
  },
  GOODS_RECEIPT: {
    code: 'GOODS_RECEIPT', prefix: 'REC', name: 'Recepción de mercadería', plural: 'Recepciones',
    resource: 'goods_receipt', module: 'inventory', path: 'deposito/recepciones',
    description: 'Constancia de lo que efectivamente llegó, contra la orden de compra y el remito del proveedor. Suma stock.',
  },
  STOCK_ADJUSTMENT: {
    code: 'STOCK_ADJUSTMENT', prefix: 'AJS', name: 'Ajuste de stock', plural: 'Ajustes de stock',
    resource: 'stock_adjustment', module: 'inventory', path: 'stock/ajustes',
    description: 'Corrección documentada del stock: inventario inicial, conteo físico, rotura o consumo interno.',
  },
}

export interface StatusInfo {
  label: string
  badge: Badge
  description: string
  final: boolean
}

export const DOC_STATUSES: Record<DocType, Record<string, StatusInfo>> = {
  PURCHASE_REQUISITION: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'El solicitante la está preparando.' },
    SOLICITADO: { label: 'Solicitada', badge: 'info', final: false, description: 'Enviada a Compras, que debe atenderla.' },
    ORDENADO_PARCIAL: { label: 'Ordenada parcialmente', badge: 'info', final: false, description: 'Parte de lo pedido ya está incluido en una orden de compra.' },
    ORDENADO: { label: 'Ordenada', badge: 'success', final: true, description: 'Todo lo pedido está incluido en órdenes de compra vigentes.' },
    CERRADO: { label: 'Cerrada con saldo', badge: 'neutral', final: true, description: 'Compras decidió no ordenar el resto.' },
    RECHAZADO: { label: 'Rechazada', badge: 'danger', final: true, description: 'Compras no la atenderá.' },
    ANULADO: { label: 'Anulada', badge: 'neutral', final: true, description: 'Dejada sin efecto por el solicitante.' },
  },
  PURCHASE_ORDER: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Compras la prepara: proveedor, ítems, precios y entrega.' },
    PENDIENTE_APROBACION: { label: 'Pendiente de aprobación', badge: 'warning', final: false, description: 'Espera la decisión del aprobador que indica la regla.' },
    RECHAZADO: { label: 'Rechazada', badge: 'danger', final: false, description: 'El aprobador la objetó; Compras puede corregirla o anularla.' },
    APROBADO: { label: 'Aprobada', badge: 'success', final: false, description: 'Autorizada; falta comunicarla al proveedor.' },
    ENVIADO: { label: 'Enviada al proveedor', badge: 'info', final: false, description: 'El proveedor la recibió; Depósito espera la mercadería.' },
    RECIBIDO_PARCIAL: { label: 'Recibida parcialmente', badge: 'info', final: false, description: 'Llegó una parte; queda saldo pendiente.' },
    RECIBIDO: { label: 'Recibida', badge: 'success', final: true, description: 'Se recibió todo lo ordenado.' },
    CERRADO: { label: 'Cerrada con saldo', badge: 'neutral', final: true, description: 'Se dio por terminada con saldo sin recibir.' },
    ANULADO: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto.' },
  },
  GOODS_RECEIPT: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Depósito la está completando; todavía no movió stock.' },
    CONFIRMADO: { label: 'Confirmada', badge: 'success', final: true, description: 'La mercadería ingresó al stock.' },
    ANULADO: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto (si estaba confirmada, se revirtió el stock).' },
  },
  STOCK_ADJUSTMENT: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Todavía no movió stock.' },
    CONFIRMADO: { label: 'Confirmado', badge: 'success', final: true, description: 'El ajuste impactó en el stock.' },
    ANULADO: { label: 'Anulado', badge: 'neutral', final: true, description: 'Sin efecto.' },
  },
}

export interface TransitionInfo {
  docType: DocType
  from: string
  action: TransitionAction
  to: string
  permission: string | null
  label: string
  help: string
  requiresComment: boolean
  tone: 'default' | 'outline' | 'destructive'
}

const t = (
  docType: DocType, from: string, action: TransitionAction, to: string, permission: string | null,
  label: string, help: string, requiresComment = false, tone: TransitionInfo['tone'] = 'default',
): TransitionInfo => ({ docType, from, action, to, permission, label, help, requiresComment, tone })

export const TRANSITIONS: TransitionInfo[] = [
  // Solicitud de compra
  t('PURCHASE_REQUISITION', 'BORRADOR', 'SUBMIT', 'SOLICITADO', 'purchase_requisition.create', 'Enviar a Compras', 'Compras recibirá una tarea para atenderla.'),
  t('PURCHASE_REQUISITION', 'BORRADOR', 'CANCEL', 'ANULADO', 'purchase_requisition.cancel', 'Anular', 'La solicitud queda sin efecto.', true, 'destructive'),
  t('PURCHASE_REQUISITION', 'SOLICITADO', 'REJECT', 'RECHAZADO', 'purchase_requisition.approve', 'Rechazar', 'Compras no la atenderá. El motivo le llega al solicitante.', true, 'destructive'),
  t('PURCHASE_REQUISITION', 'SOLICITADO', 'CANCEL', 'ANULADO', 'purchase_requisition.cancel', 'Anular', 'El solicitante la deja sin efecto antes de que se ordene.', true, 'destructive'),
  t('PURCHASE_REQUISITION', 'ORDENADO_PARCIAL', 'CLOSE', 'CERRADO', 'purchase_requisition.approve', 'Cerrar saldo', 'Compras decide no ordenar lo que falta.', true, 'outline'),
  t('PURCHASE_REQUISITION', 'SOLICITADO', 'SYSTEM', 'ORDENADO_PARCIAL', null, '', ''),
  t('PURCHASE_REQUISITION', 'SOLICITADO', 'SYSTEM', 'ORDENADO', null, '', ''),
  t('PURCHASE_REQUISITION', 'ORDENADO_PARCIAL', 'SYSTEM', 'ORDENADO', null, '', ''),
  t('PURCHASE_REQUISITION', 'ORDENADO_PARCIAL', 'SYSTEM', 'SOLICITADO', null, '', ''),
  t('PURCHASE_REQUISITION', 'ORDENADO', 'SYSTEM', 'SOLICITADO', null, '', ''),
  t('PURCHASE_REQUISITION', 'ORDENADO', 'SYSTEM', 'ORDENADO_PARCIAL', null, '', ''),

  // Orden de compra
  t('PURCHASE_ORDER', 'BORRADOR', 'SUBMIT', 'PENDIENTE_APROBACION', 'purchase_order.create', 'Enviar a aprobación', 'El sistema aplica las reglas de aprobación según el monto.'),
  t('PURCHASE_ORDER', 'BORRADOR', 'CANCEL', 'ANULADO', 'purchase_order.cancel', 'Anular', 'Libera las solicitudes asociadas.', true, 'destructive'),
  t('PURCHASE_ORDER', 'PENDIENTE_APROBACION', 'APPROVE', 'APROBADO', 'purchase_order.approve', 'Aprobar', 'Autoriza el compromiso con el proveedor.'),
  t('PURCHASE_ORDER', 'PENDIENTE_APROBACION', 'REJECT', 'RECHAZADO', 'purchase_order.approve', 'Rechazar', 'Vuelve a Compras con el motivo para corregirla.', true, 'destructive'),
  t('PURCHASE_ORDER', 'PENDIENTE_APROBACION', 'WITHDRAW', 'BORRADOR', 'purchase_order.update', 'Retirar de aprobación', 'La orden vuelve a borrador para corregirla.', false, 'outline'),
  t('PURCHASE_ORDER', 'RECHAZADO', 'REOPEN', 'BORRADOR', 'purchase_order.update', 'Reabrir para corregir', 'Vuelve a borrador para modificarla y reenviarla.', false, 'outline'),
  t('PURCHASE_ORDER', 'RECHAZADO', 'CANCEL', 'ANULADO', 'purchase_order.cancel', 'Anular', 'Libera las solicitudes asociadas.', true, 'destructive'),
  t('PURCHASE_ORDER', 'APROBADO', 'SEND', 'ENVIADO', 'purchase_order.update', 'Marcar como enviada al proveedor', 'Depósito recibirá la tarea de esperar la mercadería.'),
  t('PURCHASE_ORDER', 'APROBADO', 'CANCEL', 'ANULADO', 'purchase_order.cancel', 'Anular', 'Libera las solicitudes asociadas.', true, 'destructive'),
  t('PURCHASE_ORDER', 'ENVIADO', 'CANCEL', 'ANULADO', 'purchase_order.cancel', 'Anular', 'Sólo si no hubo recepciones.', true, 'destructive'),
  t('PURCHASE_ORDER', 'RECIBIDO_PARCIAL', 'CLOSE', 'CERRADO', 'purchase_order.cancel', 'Cerrar saldo', 'Se da por terminada: el saldo no se recibirá.', true, 'outline'),
  t('PURCHASE_ORDER', 'ENVIADO', 'SYSTEM', 'RECIBIDO_PARCIAL', null, '', ''),
  t('PURCHASE_ORDER', 'ENVIADO', 'SYSTEM', 'RECIBIDO', null, '', ''),
  t('PURCHASE_ORDER', 'RECIBIDO_PARCIAL', 'SYSTEM', 'RECIBIDO', null, '', ''),
  t('PURCHASE_ORDER', 'RECIBIDO_PARCIAL', 'SYSTEM', 'ENVIADO', null, '', ''),
  t('PURCHASE_ORDER', 'RECIBIDO', 'SYSTEM', 'RECIBIDO_PARCIAL', null, '', ''),
  t('PURCHASE_ORDER', 'RECIBIDO', 'SYSTEM', 'ENVIADO', null, '', ''),

  // Recepción
  t('GOODS_RECEIPT', 'BORRADOR', 'CONFIRM', 'CONFIRMADO', 'goods_receipt.create', 'Confirmar recepción', 'Suma el stock y actualiza la orden de compra.'),
  t('GOODS_RECEIPT', 'BORRADOR', 'CANCEL', 'ANULADO', 'goods_receipt.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('GOODS_RECEIPT', 'CONFIRMADO', 'CANCEL', 'ANULADO', 'goods_receipt.cancel', 'Anular con contramovimiento', 'Resta del stock lo recibido. Debe hacerlo otro usuario.', true, 'destructive'),

  // Ajuste de stock
  t('STOCK_ADJUSTMENT', 'BORRADOR', 'CONFIRM', 'CONFIRMADO', 'stock_adjustment.create', 'Confirmar ajuste', 'Impacta en el stock.'),
  t('STOCK_ADJUSTMENT', 'BORRADOR', 'CANCEL', 'ANULADO', 'stock_adjustment.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
]

export const ACTION_VERBS: Record<string, string> = {
  CREATE: 'Creó',
  UPDATE: 'Modificó',
  SUBMIT: 'Envió',
  APPROVE: 'Aprobó',
  REJECT: 'Rechazó',
  WITHDRAW: 'Retiró de aprobación',
  REOPEN: 'Reabrió',
  SEND: 'Envió al proveedor',
  CONFIRM: 'Confirmó',
  CANCEL: 'Anuló',
  CLOSE: 'Cerró el saldo de',
  SYSTEM: 'Actualizó',
  ACTIVATE: 'Activó',
  DEACTIVATE: 'Desactivó',
  ASSIGN_ROLE: 'Asignó rol',
  REMOVE_ROLE: 'Quitó rol',
  SETTINGS: 'Cambió configuración',
  LOGIN: 'Ingresó',
  RESET: 'Reinició',
}

// ---------------------------------------------------------------- Tareas

export interface TaskRule {
  docType: DocType
  status: string
  taskType: string
  assignee: 'ROLE' | 'APPROVER' | 'CREATOR'
  role?: RoleCode
  title: string
  description: string
}

export const TASK_RULES: TaskRule[] = [
  { docType: 'PURCHASE_REQUISITION', status: 'SOLICITADO', taskType: 'ATENDER_SC', assignee: 'ROLE', role: 'COMPRAS', title: 'Atender {number}', description: 'Incluir la solicitud en una orden de compra o rechazarla con motivo.' },
  { docType: 'PURCHASE_REQUISITION', status: 'ORDENADO_PARCIAL', taskType: 'ATENDER_SC', assignee: 'ROLE', role: 'COMPRAS', title: 'Completar {number} (saldo sin ordenar)', description: 'Ordenar el saldo pendiente o cerrarlo con motivo.' },
  { docType: 'PURCHASE_ORDER', status: 'PENDIENTE_APROBACION', taskType: 'APROBAR_OC', assignee: 'APPROVER', title: 'Aprobar {number} por {total}', description: 'Revisar proveedor, precios y cantidades; aprobar o rechazar con motivo.' },
  { docType: 'PURCHASE_ORDER', status: 'RECHAZADO', taskType: 'CORREGIR_OC', assignee: 'CREATOR', title: 'Revisar {number} rechazada', description: 'Leer el motivo del rechazo, corregir y reenviar, o anular.' },
  { docType: 'PURCHASE_ORDER', status: 'APROBADO', taskType: 'ENVIAR_OC', assignee: 'ROLE', role: 'COMPRAS', title: 'Enviar {number} al proveedor', description: 'Imprimir la orden, comunicarla al proveedor y marcarla como enviada.' },
  { docType: 'PURCHASE_ORDER', status: 'ENVIADO', taskType: 'RECIBIR_MERCADERIA', assignee: 'ROLE', role: 'DEPOSITO', title: 'Recibir mercadería de {number}', description: 'Cuando llegue la mercadería, controlarla contra la OC y el remito, y registrar la recepción.' },
  { docType: 'PURCHASE_ORDER', status: 'RECIBIDO_PARCIAL', taskType: 'RECIBIR_MERCADERIA', assignee: 'ROLE', role: 'DEPOSITO', title: 'Recibir saldo de {number}', description: 'Queda mercadería pendiente de entrega.' },
  { docType: 'GOODS_RECEIPT', status: 'BORRADOR', taskType: 'CONFIRMAR_RECEPCION', assignee: 'CREATOR', title: 'Confirmar {number}', description: 'Revisar cantidades y confirmar para que ingrese al stock.' },
  { docType: 'STOCK_ADJUSTMENT', status: 'BORRADOR', taskType: 'CONFIRMAR_AJUSTE', assignee: 'CREATOR', title: 'Confirmar {number}', description: 'Revisar el ajuste y confirmarlo.' },
]

export const TASK_TYPE_LABELS: Record<string, string> = {
  ATENDER_SC: 'Atender solicitud',
  APROBAR_OC: 'Aprobar orden',
  CORREGIR_OC: 'Corregir orden',
  ENVIAR_OC: 'Enviar orden',
  RECIBIR_MERCADERIA: 'Recibir mercadería',
  CONFIRMAR_RECEPCION: 'Confirmar recepción',
  CONFIRMAR_AJUSTE: 'Confirmar ajuste',
  REPONER_STOCK: 'Evaluar reposición',
  CONSIGNA: 'Consigna del docente',
}

// ---------------------------------------------------------------- Etiquetas

export const VAT_CONDITIONS: Record<VatCondition, string> = {
  RESPONSABLE_INSCRIPTO: 'Responsable inscripto',
  MONOTRIBUTO: 'Monotributo',
  EXENTO: 'Exento',
  CONSUMIDOR_FINAL: 'Consumidor final',
}

export const PRODUCT_TYPES: Record<ProductType, string> = {
  MATERIA_PRIMA: 'Materia prima',
  INSUMO: 'Insumo',
  PRODUCTO_TERMINADO: 'Producto terminado',
  MERCADERIA_REVENTA: 'Mercadería de reventa',
  SERVICIO: 'Servicio',
}

export const UNITS: Record<string, { name: string; decimals: boolean }> = {
  UN: { name: 'Unidad', decimals: false },
  KG: { name: 'Kilogramo', decimals: true },
  L: { name: 'Litro', decimals: true },
  M: { name: 'Metro', decimals: true },
  M2: { name: 'Metro cuadrado', decimals: true },
  PIE: { name: 'Pie cuadrado (pie tablar)', decimals: true },
  CAJA: { name: 'Caja', decimals: false },
  PAR: { name: 'Par', decimals: false },
  ROL: { name: 'Rollo', decimals: false },
}

export const PRIORITIES: Record<Priority, string> = {
  BAJA: 'Baja',
  NORMAL: 'Normal',
  ALTA: 'Alta',
  URGENTE: 'Urgente',
}

export const ADJUSTMENT_REASONS: Record<AdjustmentReason, string> = {
  INVENTARIO_INICIAL: 'Inventario inicial',
  CONTEO_FISICO: 'Diferencia de conteo físico',
  ROTURA: 'Rotura o deterioro',
  CONSUMO_INTERNO: 'Consumo interno / producción',
  OTRO: 'Otro',
}

export const MOVEMENT_TYPES: Record<MovementType, string> = {
  STOCK_INICIAL: 'Stock inicial',
  RECEPCION_COMPRA: 'Recepción de compra',
  ANULACION_RECEPCION: 'Anulación de recepción',
  AJUSTE_POSITIVO: 'Ajuste positivo',
  AJUSTE_NEGATIVO: 'Ajuste negativo',
}

export const VAT_RATES = [21, 10.5, 27, 0]
