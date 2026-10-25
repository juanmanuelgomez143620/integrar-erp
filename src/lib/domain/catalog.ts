// Catálogos del sistema. En Supabase serán tablas cargadas por migración
// (roles, permissions, role_permissions, document_types, document_statuses,
// document_transitions, task_rules). Ver DATABASE.md §5, §7 y §9.

import type {
  AccountType,
  AdjustmentReason,
  Badge,
  DocType,
  JournalEntryOrigin,
  ModuleCode,
  MovementType,
  PaymentMethod,
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
  sales: { name: 'Ventas y cobranzas', lockable: true },
  inventory: { name: 'Depósito y stock', lockable: true },
  production: { name: 'Producción y costos', lockable: true },
  hr: { name: 'RRHH y sueldos', lockable: true },
  payables: { name: 'Pagos y tesorería', lockable: true },
  accounting: { name: 'Contabilidad', lockable: true },
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
  rfq: 'purchasing',
  supplier_quote: 'purchasing',
  sales_order: 'sales',
  sales_invoice: 'sales',
  receivable: 'sales',
  customer_receipt: 'sales',
  price_list: 'sales',
  sales_quote: 'sales',
  goods_receipt: 'inventory',
  delivery_note: 'inventory',
  stock: 'inventory',
  stock_adjustment: 'inventory',
  bom: 'production',
  work_center: 'production',
  production_order: 'production',
  employee: 'hr',
  supplier_invoice: 'purchasing',
  payable: 'payables',
  payment_order: 'payables',
  treasury: 'payables',
  funds_transfer: 'payables',
  bank_reconciliation: 'payables',
  account: 'accounting',
  posting_rule: 'accounting',
  journal_entry: 'accounting',
  ledger: 'accounting',
  fiscal_period: 'accounting',
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

// prettier-ignore
export const ROLES: Record<RoleCode, RoleInfo> = {
  GERENCIA: { code: 'GERENCIA', name: 'Gerencia', island: 1, defaultSector: 'GER', isSupervisor: false, description: 'Aprueba operaciones relevantes y supervisa indicadores y alertas.' },
  AUDITOR: { code: 'AUDITOR', name: 'Auditoría interna', island: 1, defaultSector: 'CGE', isSupervisor: false, description: 'Consulta todo y revisa la auditoría. No modifica nada.' },
  COMPRAS: { code: 'COMPRAS', name: 'Compras', island: 2, defaultSector: 'COM', isSupervisor: false, description: 'Atiende solicitudes, gestiona proveedores y emite órdenes de compra.' },
  VENTAS: { code: 'VENTAS', name: 'Ventas', island: 3, defaultSector: 'VEN', isSupervisor: false, description: 'Administra la cartera de clientes y carga los pedidos de venta.' },
  CONTABILIDAD: { code: 'CONTABILIDAD', name: 'Contabilidad', island: 4, defaultSector: 'CON', isSupervisor: false, description: 'Registra los asientos, lleva los libros contables y cierra los meses.' },
  IMPUESTOS: { code: 'IMPUESTOS', name: 'Impuestos', island: 4, defaultSector: 'IMP', isSupervisor: false, description: 'Consulta operaciones y libros contables (obligaciones en fases siguientes).' },
  TESORERIA: { code: 'TESORERIA', name: 'Tesorería y Finanzas', island: 5, defaultSector: 'TES', isSupervisor: false, description: 'Prepara y ejecuta los pagos a proveedores y controla los saldos de caja y bancos.' },
  RRHH: { code: 'RRHH', name: 'RRHH y Sueldos', island: 6, defaultSector: 'RRH', isSupervisor: false, description: 'Lleva los legajos y las categorías del personal; las liquidaciones de sueldos llegan en la Fase 6b.' },
  PRODUCCION: { code: 'PRODUCCION', name: 'Producción', island: 7, defaultSector: 'PRO', isSupervisor: false, description: 'Arma las listas de materiales, planifica y termina las órdenes de producción, y pide los materiales a Compras.' },
  DEPOSITO: { code: 'DEPOSITO', name: 'Depósito y Stock', island: 8, defaultSector: 'DEP', isSupervisor: false, description: 'Recibe y despacha mercadería, entrega los materiales a Producción, controla el stock y pide reposición.' },
  LOGISTICA: { code: 'LOGISTICA', name: 'Logística', island: 8, defaultSector: 'LOG', isSupervisor: false, description: 'Consulta recepciones y stock (despachos en fases siguientes).' },
  DOCENTE: { code: 'DOCENTE', name: 'Docente (supervisor)', island: null, defaultSector: null, isSupervisor: true, description: 'Todos los permisos en la empresa; puede actuar como supervisor.' },
}

export const ROLE_ORDER: RoleCode[] = [
  'GERENCIA',
  'AUDITOR',
  'COMPRAS',
  'VENTAS',
  'CONTABILIDAD',
  'IMPUESTOS',
  'TESORERIA',
  'RRHH',
  'PRODUCCION',
  'DEPOSITO',
  'LOGISTICA',
  'DOCENTE',
]

// ---------------------------------------------------------------- Permisos

const CORE_READ = ['company.read', 'member.read', 'sector.read']
const LEDGER_READ = ['account.read', 'journal_entry.read', 'ledger.read']

/** Matriz del MVP (docs/ROLES_Y_PERMISOS.md §4). DOCENTE es supervisor: todo. */
// prettier-ignore
export const ROLE_PERMISSIONS: Record<RoleCode, string[]> = {
  GERENCIA: [
    ...CORE_READ,
    'customer.read', 'customer.export', 'supplier.read', 'supplier.export', 'product.read', 'product.export',
    'stock.read', 'stock.export', 'stock_adjustment.read', 'stock_adjustment.approve',
    'purchase_requisition.read',
    'purchase_order.read', 'purchase_order.approve', 'purchase_order.cancel', 'purchase_order.export',
    // Anula recepciones registradas por Depósito (separación de funciones, SoD-3).
    'goods_receipt.read', 'goods_receipt.cancel', 'dashboard.read', 'task.read', 'audit.read', 'audit.export',
    ...LEDGER_READ, 'journal_entry.export', 'ledger.export',
    'supplier_invoice.read', 'payable.read', 'posting_rule.read',
    'payment_order.read', 'payment_order.approve', 'treasury.read', 'funds_transfer.read', 'bank_reconciliation.read',
    'rfq.read', 'supplier_quote.read',
    // Autoriza los pedidos que superan el crédito; anula remitos despachados por Depósito (SoD-3).
    'sales_order.read', 'sales_order.approve', 'delivery_note.read', 'delivery_note.cancel',
    'sales_invoice.read', 'receivable.read', 'customer_receipt.read', 'price_list.read', 'sales_quote.read',
    'bom.read', 'production_order.read', 'work_center.read', 'employee.read',
  ],
  COMPRAS: [
    ...CORE_READ,
    'supplier.read', 'supplier.create', 'supplier.update', 'supplier.export',
    'product.read', 'product.create', 'product.update', 'stock.read',
    'purchase_requisition.read', 'purchase_requisition.approve',
    'purchase_order.read', 'purchase_order.create', 'purchase_order.update', 'purchase_order.approve',
    'purchase_order.cancel', 'purchase_order.export',
    'goods_receipt.read',
    'supplier_invoice.read', 'supplier_invoice.create', 'supplier_invoice.cancel', 'payable.read',
    'rfq.read', 'rfq.create', 'rfq.cancel', 'rfq.award',
    'supplier_quote.read', 'supplier_quote.create', 'supplier_quote.cancel',
    // Ve qué se fabrica y con qué materiales, para comprarlos a tiempo.
    'bom.read', 'production_order.read',
  ],
  VENTAS: [
    ...CORE_READ, 'customer.read', 'customer.create', 'customer.update', 'customer.export', 'product.read', 'stock.read',
    'sales_order.read', 'sales_order.create', 'sales_order.cancel', 'delivery_note.read',
    'sales_invoice.read', 'sales_invoice.create', 'sales_invoice.cancel', 'receivable.read', 'customer_receipt.read',
    'price_list.read', 'price_list.create', 'price_list.update',
    'sales_quote.read', 'sales_quote.create', 'sales_quote.cancel', 'production_order.read',
  ],
  DEPOSITO: [
    ...CORE_READ,
    'supplier.read', 'product.read', 'product.create', 'product.update', 'stock.read', 'stock.export',
    'stock_adjustment.read', 'stock_adjustment.create', 'stock_adjustment.cancel',
    'purchase_requisition.read', 'purchase_requisition.create', 'purchase_requisition.update', 'purchase_requisition.cancel',
    'purchase_order.read', 'goods_receipt.read', 'goods_receipt.create', 'goods_receipt.cancel',
    'rfq.read', 'supplier_quote.read',
    'sales_order.read', 'delivery_note.read', 'delivery_note.create', 'delivery_note.cancel',
    // Entrega los materiales de las órdenes de producción liberadas.
    'bom.read', 'production_order.read', 'production_order.issue',
  ],
  PRODUCCION: [
    ...CORE_READ,
    'supplier.read', 'product.read', 'stock.read',
    'purchase_requisition.read', 'purchase_requisition.create', 'purchase_requisition.update', 'purchase_requisition.cancel',
    'purchase_order.read', 'goods_receipt.read',
    'bom.read', 'bom.create', 'bom.update',
    'production_order.read', 'production_order.create', 'production_order.cancel',
    'work_center.read', 'work_center.update',
  ],
  CONTABILIDAD: [
    ...CORE_READ,
    'customer.read', 'supplier.read', 'product.read', 'stock.read', 'stock_adjustment.read',
    'purchase_order.read', 'goods_receipt.read',
    ...LEDGER_READ, 'account.create', 'account.update',
    'journal_entry.create', 'journal_entry.update', 'journal_entry.cancel', 'journal_entry.export',
    'ledger.export', 'fiscal_period.update',
    'supplier_invoice.read', 'payable.read', 'posting_rule.read', 'posting_rule.update',
    'payment_order.read', 'payment_order.create', 'payment_order.cancel', 'treasury.read', 'funds_transfer.read',
    'bank_reconciliation.read', 'bank_reconciliation.create', 'bank_reconciliation.cancel',
    'rfq.read', 'supplier_quote.read', 'sales_order.read', 'delivery_note.read', 'sales_invoice.read',
    'receivable.read', 'customer_receipt.read', 'price_list.read', 'sales_quote.read',
    'bom.read', 'production_order.read', 'work_center.read', 'employee.read',
  ],
  TESORERIA: [
    ...CORE_READ, 'customer.read', 'supplier.read', 'purchase_order.read', ...LEDGER_READ,
    'supplier_invoice.read', 'payable.read',
    'payment_order.read', 'payment_order.create', 'payment_order.pay', 'payment_order.cancel', 'treasury.read',
    'funds_transfer.read', 'funds_transfer.create', 'funds_transfer.cancel', 'bank_reconciliation.read',
    'rfq.read', 'supplier_quote.read', 'sales_order.read', 'delivery_note.read', 'sales_invoice.read',
    // Cobra a los clientes (SoD-9: no cobra las facturas que emitió).
    'receivable.read', 'customer_receipt.read', 'customer_receipt.create', 'customer_receipt.cancel', 'sales_quote.read',
  ],
  // Legajos y categorías del personal (Fase 6a).
  RRHH: [...CORE_READ, 'employee.read', 'employee.create', 'employee.update', 'work_center.read'],
  IMPUESTOS: [
    ...CORE_READ, 'customer.read', 'supplier.read', 'purchase_order.read', ...LEDGER_READ, 'supplier_invoice.read',
    'rfq.read', 'supplier_quote.read', 'sales_order.read', 'delivery_note.read', 'sales_invoice.read',
    'receivable.read', 'customer_receipt.read', 'sales_quote.read',
  ],
  LOGISTICA: [
    ...CORE_READ, 'customer.read', 'supplier.read', 'product.read', 'stock.read', 'purchase_order.read', 'goods_receipt.read',
    'sales_order.read', 'delivery_note.read',
  ],
  AUDITOR: [
    ...CORE_READ,
    'customer.read', 'customer.export', 'supplier.read', 'supplier.export', 'product.read', 'product.export',
    'stock.read', 'stock.export', 'stock_adjustment.read', 'purchase_requisition.read',
    'purchase_order.read', 'purchase_order.export', 'goods_receipt.read',
    'dashboard.read', 'task.read', 'audit.read', 'audit.export',
    ...LEDGER_READ, 'journal_entry.export', 'ledger.export',
    'supplier_invoice.read', 'payable.read', 'posting_rule.read', 'payment_order.read', 'treasury.read',
    'funds_transfer.read', 'bank_reconciliation.read', 'rfq.read', 'supplier_quote.read',
    'sales_order.read', 'delivery_note.read', 'sales_invoice.read', 'receivable.read', 'customer_receipt.read',
    'price_list.read', 'sales_quote.read', 'bom.read', 'production_order.read', 'work_center.read', 'employee.read',
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

// prettier-ignore
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
  JOURNAL_ENTRY: {
    code: 'JOURNAL_ENTRY', prefix: 'AS', name: 'Asiento contable', plural: 'Asientos', resource: 'journal_entry',
    module: 'accounting', path: 'contabilidad/asientos',
    description: 'Registro de un hecho económico por partida doble: las cuentas que se debitan y las que se acreditan, por el mismo importe.',
  },
  SUPPLIER_INVOICE: {
    code: 'SUPPLIER_INVOICE', prefix: 'FP', name: 'Factura de proveedor', plural: 'Facturas de proveedores',
    resource: 'supplier_invoice', module: 'purchasing', path: 'compras/facturas',
    description: 'Registro de la factura que emitió el proveedor, controlada contra la orden de compra y lo recibido. Genera el asiento de compra y la deuda con el proveedor.',
  },
  PAYMENT_ORDER: {
    code: 'PAYMENT_ORDER', prefix: 'OP', name: 'Orden de pago', plural: 'Órdenes de pago',
    resource: 'payment_order', module: 'payables', path: 'pagos/ordenes',
    description: 'Documento interno que autoriza a Tesorería a pagarle a un proveedor las facturas indicadas, desde una caja o un banco. Al pagarse genera el asiento y cancela la deuda.',
  },
  RFQ: {
    code: 'RFQ', prefix: 'SCT', name: 'Solicitud de cotización', plural: 'Solicitudes de cotización',
    resource: 'rfq', module: 'purchasing', path: 'compras/solicitudes-cotizacion',
    description: 'Pedido de precios que Compras hace a varios proveedores antes de comprar: qué, cuánto y hasta cuándo responder. No compromete a la empresa.',
  },
  SUPPLIER_QUOTE: {
    code: 'SUPPLIER_QUOTE', prefix: 'COT', name: 'Cotización de proveedor', plural: 'Cotizaciones',
    resource: 'supplier_quote', module: 'purchasing', path: 'compras/cotizaciones',
    description: 'Respuesta de un proveedor a una solicitud de cotización: precios, plazo de entrega, condición de pago y validez de la oferta. Se compara con las demás antes de elegir.',
  },
  FUNDS_TRANSFER: {
    code: 'FUNDS_TRANSFER', prefix: 'TF', name: 'Transferencia entre cuentas', plural: 'Transferencias entre cuentas',
    resource: 'funds_transfer', module: 'payables', path: 'pagos/transferencias',
    description: 'Movimiento de fondos entre dos cajas o bancos de la empresa, por ejemplo, depositar el efectivo de la caja en el banco. Genera su asiento y no cambia el total de los fondos.',
  },
  BANK_RECONCILIATION: {
    code: 'BANK_RECONCILIATION', prefix: 'CB', name: 'Conciliación bancaria', plural: 'Conciliaciones bancarias',
    resource: 'bank_reconciliation', module: 'payables', path: 'pagos/conciliaciones',
    description: 'Comparación del extracto del banco con el libro mayor a una fecha: la diferencia se explica por los movimientos que el banco todavía no registró, como los cheques sin debitar.',
  },
  SALES_ORDER: {
    code: 'SALES_ORDER', prefix: 'PV', name: 'Pedido de venta', plural: 'Pedidos de venta',
    resource: 'sales_order', module: 'sales', path: 'ventas/pedidos',
    description: 'Lo que compra un cliente: productos, cantidades, precios y condición de pago. Al confirmarse controla el crédito del cliente y reserva el stock para la entrega.',
  },
  DELIVERY_NOTE: {
    code: 'DELIVERY_NOTE', prefix: 'REM', name: 'Remito', plural: 'Remitos',
    resource: 'delivery_note', module: 'inventory', path: 'deposito/remitos',
    description: 'Constancia de la mercadería que sale del depósito para un cliente, contra su pedido de venta. Descuenta el stock y registra el costo de lo vendido.',
  },
  SALES_INVOICE: {
    code: 'SALES_INVOICE', prefix: 'FV', name: 'Factura de venta', plural: 'Facturas de venta',
    resource: 'sales_invoice', module: 'sales', path: 'ventas/facturas',
    description: 'Comprobante simulado que la empresa le emite al cliente por lo que se le entregó. Al registrarse genera el asiento de venta y la deuda del cliente en su cuenta corriente.',
  },
  CUSTOMER_RECEIPT: {
    code: 'CUSTOMER_RECEIPT', prefix: 'RBO', name: 'Recibo de cobro', plural: 'Recibos de cobro',
    resource: 'customer_receipt', module: 'sales', path: 'pagos/cobros',
    description: 'Constancia de lo que pagó un cliente: qué facturas cancela, cuánto de cada una, con qué medio y en qué caja o banco ingresa. Al confirmarse genera el asiento de cobro y baja la deuda del cliente.',
  },
  SALES_QUOTE: {
    code: 'SALES_QUOTE', prefix: 'PRE', name: 'Presupuesto', plural: 'Presupuestos',
    resource: 'sales_quote', module: 'sales', path: 'ventas/presupuestos',
    description: 'Oferta que Ventas le hace a un cliente: productos, cantidades, precios y hasta cuándo vale. No compromete stock ni crédito: si el cliente la acepta, se genera el pedido de venta.',
  },
  PRODUCTION_ORDER: {
    code: 'PRODUCTION_ORDER', prefix: 'OPR', name: 'Orden de producción', plural: 'Órdenes de producción',
    resource: 'production_order', module: 'production', path: 'produccion/ordenes',
    description: 'Lo que Producción va a fabricar: qué producto, cuántas unidades y con qué materiales, según su lista. Al liberarse reserva los materiales; Depósito los entrega y, al terminarla, el producto entra al stock a su costo real.',
  },
}

export interface StatusInfo {
  label: string
  badge: Badge
  description: string
  final: boolean
}

// prettier-ignore
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
  JOURNAL_ENTRY: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Todavía no está en el libro diario: se puede corregir.' },
    CONFIRMADO: { label: 'Registrado', badge: 'success', final: true, description: 'Está en el libro diario con su número de asiento. Ya no se modifica.' },
    ANULADO: { label: 'Anulado', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba registrado, un contraasiento lo compensa y los dos quedan en el libro diario.' },
  },
  SUPPLIER_INVOICE: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Compras la está cargando: todavía no generó deuda ni asiento.' },
    REGISTRADA: { label: 'Registrada', badge: 'info', final: false, description: 'Está en la cuenta corriente del proveedor y en el libro diario. Falta pagarla.' },
    PAGADA_PARCIAL: { label: 'Pagada parcialmente', badge: 'warning', final: false, description: 'Se pagó una parte; queda saldo pendiente.' },
    PAGADA: { label: 'Pagada', badge: 'success', final: true, description: 'Se pagó completa: la deuda con el proveedor quedó cancelada.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba registrada, un contraasiento revirtió la compra.' },
  },
  PAYMENT_ORDER: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Contabilidad o Tesorería la está preparando: todavía no reservó nada.' },
    PENDIENTE_APROBACION: { label: 'Pendiente de aprobación', badge: 'warning', final: false, description: 'Espera la autorización de Gerencia.' },
    APROBADA: { label: 'Aprobada', badge: 'info', final: false, description: 'Autorizada: Tesorería tiene que pagarla.' },
    PAGADA: { label: 'Pagada', badge: 'success', final: true, description: 'Se pagó: la deuda con el proveedor bajó y el pago está en el libro diario.' },
    RECHAZADA: { label: 'Rechazada', badge: 'danger', final: true, description: 'Gerencia no autorizó el pago.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba pagada, un contraasiento revirtió el pago.' },
  },
  RFQ: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Compras la está preparando: todavía no se pidió precio a nadie.' },
    ENVIADA: { label: 'Enviada', badge: 'info', final: false, description: 'Se pidió cotización a los proveedores: Compras carga sus respuestas y las compara.' },
    ADJUDICADA: { label: 'Adjudicada', badge: 'success', final: true, description: 'Se eligió una cotización y de ella nació la orden de compra.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto: no se compra por esta vía.' },
  },
  SUPPLIER_QUOTE: {
    RECIBIDA: { label: 'Recibida', badge: 'info', final: false, description: 'Cargada: participa del cuadro comparativo de su solicitud.' },
    ADJUDICADA: { label: 'Adjudicada', badge: 'success', final: true, description: 'Fue la elegida: de ella nació la orden de compra.' },
    DESCARTADA: { label: 'Descartada', badge: 'neutral', final: true, description: 'No fue elegida, o la solicitud se anuló.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto: por ejemplo, se cargó mal o el proveedor cambió su oferta.' },
  },
  FUNDS_TRANSFER: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Tesorería la está preparando: todavía no movió fondos.' },
    CONFIRMADA: { label: 'Confirmada', badge: 'success', final: true, description: 'Los fondos pasaron de una cuenta a la otra y el movimiento está en el libro diario.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba confirmada, un contraasiento devolvió los fondos a la cuenta de origen.' },
  },
  BANK_RECONCILIATION: {
    CONFIRMADA: { label: 'Confirmada', badge: 'success', final: true, description: 'Cierra con el extracto: sus movimientos quedaron conciliados.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto: sus movimientos volvieron a estar pendientes de conciliar.' },
  },
  SALES_ORDER: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Ventas lo está cargando: todavía no reservó stock.' },
    PENDIENTE_APROBACION: { label: 'Pendiente de aprobación', badge: 'warning', final: false, description: 'Supera el crédito del cliente o el cliente tiene facturas vencidas: espera la autorización de Gerencia. El stock ya está reservado.' },
    CONFIRMADO: { label: 'Confirmado', badge: 'info', final: false, description: 'El stock está reservado: Depósito tiene que prepararlo y despacharlo.' },
    ENTREGADO_PARCIAL: { label: 'Entregado parcialmente', badge: 'info', final: false, description: 'Salió una parte; lo que falta sigue reservado.' },
    ENTREGADO: { label: 'Entregado', badge: 'success', final: true, description: 'Se entregó todo lo pedido.' },
    CERRADO: { label: 'Cerrado con saldo', badge: 'neutral', final: true, description: 'Se dio por terminado con saldo sin entregar: la reserva de ese saldo se liberó.' },
    RECHAZADO: { label: 'Rechazado', badge: 'danger', final: true, description: 'Gerencia no autorizó el crédito: la reserva de stock se liberó.' },
    ANULADO: { label: 'Anulado', badge: 'neutral', final: true, description: 'Sin efecto: si había stock reservado, se liberó.' },
  },
  DELIVERY_NOTE: {
    BORRADOR: { label: 'En preparación', badge: 'neutral', final: false, description: 'Depósito prepara la mercadería: todavía no movió stock.' },
    CONFIRMADO: { label: 'Despachado', badge: 'success', final: true, description: 'La mercadería salió del depósito: bajó el stock y se registró el costo de lo vendido.' },
    ANULADO: { label: 'Anulado', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba despachado, la mercadería volvió al depósito y un contraasiento revirtió su costo.' },
  },
  SALES_INVOICE: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Ventas la está preparando: todavía no tiene número ni generó deuda.' },
    REGISTRADA: { label: 'Registrada', badge: 'info', final: false, description: 'Emitida: está en la cuenta corriente del cliente y en el libro diario. Falta cobrarla.' },
    COBRADA_PARCIAL: { label: 'Cobrada parcialmente', badge: 'warning', final: false, description: 'El cliente pagó una parte; queda saldo pendiente.' },
    COBRADA: { label: 'Cobrada', badge: 'success', final: true, description: 'Se cobró completa: la deuda del cliente quedó cancelada.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba registrada, un contraasiento revirtió la venta y su número no se vuelve a usar.' },
  },
  CUSTOMER_RECEIPT: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Tesorería lo está preparando: lo que cobra queda reservado, pero todavía no ingresó el dinero.' },
    CONFIRMADO: { label: 'Cobrado', badge: 'success', final: true, description: 'El dinero ingresó a la caja o al banco: la deuda del cliente bajó y el cobro está en el libro diario.' },
    ANULADO: { label: 'Anulado', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba cobrado, un contraasiento revirtió el cobro y las facturas volvieron a tener saldo.' },
  },
  SALES_QUOTE: {
    BORRADOR: { label: 'Borrador', badge: 'neutral', final: false, description: 'Ventas lo está preparando: el cliente todavía no lo recibió.' },
    ENVIADO: { label: 'Enviado', badge: 'info', final: false, description: 'El cliente lo recibió: Ventas espera su respuesta mientras la oferta esté vigente.' },
    ACEPTADO: { label: 'Aceptado', badge: 'success', final: true, description: 'El cliente lo aceptó: se generó el pedido de venta con sus ítems y precios.' },
    RECHAZADO: { label: 'Rechazado', badge: 'danger', final: true, description: 'El cliente no lo aceptó.' },
    VENCIDO: { label: 'Vencido', badge: 'neutral', final: true, description: 'Pasó la validez sin respuesta del cliente: para venderle, se prepara otro con los precios del día.' },
    ANULADO: { label: 'Anulado', badge: 'neutral', final: true, description: 'Sin efecto.' },
  },
  PRODUCTION_ORDER: {
    BORRADOR: { label: 'Planificada', badge: 'neutral', final: false, description: 'Producción la está planificando: todavía no reservó materiales.' },
    LIBERADA: { label: 'Liberada', badge: 'info', final: false, description: 'Los materiales están reservados: Depósito tiene que entregarlos.' },
    EN_PROCESO: { label: 'En proceso', badge: 'warning', final: false, description: 'Depósito entregó los materiales: Producción está fabricando.' },
    TERMINADA: { label: 'Terminada', badge: 'success', final: true, description: 'El producto entró al stock a su costo real.' },
    ANULADA: { label: 'Anulada', badge: 'neutral', final: true, description: 'Sin efecto. Si estaba en proceso, los materiales volvieron al depósito y un contraasiento revirtió el consumo.' },
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
  docType: DocType,
  from: string,
  action: TransitionAction,
  to: string,
  permission: string | null,
  label: string,
  help: string,
  requiresComment = false,
  tone: TransitionInfo['tone'] = 'default',
): TransitionInfo => ({ docType, from, action, to, permission, label, help, requiresComment, tone })

// prettier-ignore
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

  // Asiento contable
  t('JOURNAL_ENTRY', 'BORRADOR', 'CONFIRM', 'CONFIRMADO', 'journal_entry.create', 'Registrar en el libro diario', 'Controla la partida doble y el período, y le asigna el número de asiento.'),
  t('JOURNAL_ENTRY', 'BORRADOR', 'CANCEL', 'ANULADO', 'journal_entry.cancel', 'Anular', 'El borrador queda sin efecto; nunca estuvo en el libro diario.', true, 'destructive'),
  t('JOURNAL_ENTRY', 'CONFIRMADO', 'CANCEL', 'ANULADO', 'journal_entry.cancel', 'Anular con contraasiento', 'Registra con fecha de hoy un asiento con el debe y el haber invertidos. Los dos quedan en el libro diario.', true, 'destructive'),

  // Factura de proveedor
  t('SUPPLIER_INVOICE', 'BORRADOR', 'CONFIRM', 'REGISTRADA', 'supplier_invoice.create', 'Registrar factura', 'Controla las cantidades contra lo recibido y genera el asiento de compra y la deuda con el proveedor.'),
  t('SUPPLIER_INVOICE', 'BORRADOR', 'CANCEL', 'ANULADA', 'supplier_invoice.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('SUPPLIER_INVOICE', 'REGISTRADA', 'CANCEL', 'ANULADA', 'supplier_invoice.cancel', 'Anular con contraasiento', 'Revierte el asiento de compra y la deuda. Sólo si todavía no tiene pagos.', true, 'destructive'),
  t('SUPPLIER_INVOICE', 'REGISTRADA', 'SYSTEM', 'PAGADA_PARCIAL', null, '', ''),
  t('SUPPLIER_INVOICE', 'REGISTRADA', 'SYSTEM', 'PAGADA', null, '', ''),
  t('SUPPLIER_INVOICE', 'PAGADA_PARCIAL', 'SYSTEM', 'PAGADA', null, '', ''),
  t('SUPPLIER_INVOICE', 'PAGADA_PARCIAL', 'SYSTEM', 'REGISTRADA', null, '', ''),
  t('SUPPLIER_INVOICE', 'PAGADA', 'SYSTEM', 'PAGADA_PARCIAL', null, '', ''),
  t('SUPPLIER_INVOICE', 'PAGADA', 'SYSTEM', 'REGISTRADA', null, '', ''),

  // Orden de pago
  t('PAYMENT_ORDER', 'BORRADOR', 'SUBMIT', 'PENDIENTE_APROBACION', 'payment_order.create', 'Enviar a aprobación', 'Gerencia recibirá una tarea para autorizar el pago.'),
  t('PAYMENT_ORDER', 'BORRADOR', 'CANCEL', 'ANULADA', 'payment_order.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('PAYMENT_ORDER', 'PENDIENTE_APROBACION', 'APPROVE', 'APROBADA', 'payment_order.approve', 'Aprobar', 'Autoriza a Tesorería a pagar.'),
  t('PAYMENT_ORDER', 'PENDIENTE_APROBACION', 'REJECT', 'RECHAZADA', 'payment_order.approve', 'Rechazar', 'No se paga. Si hace falta, se prepara otra orden.', true, 'destructive'),
  t('PAYMENT_ORDER', 'PENDIENTE_APROBACION', 'CANCEL', 'ANULADA', 'payment_order.cancel', 'Anular', 'Queda sin efecto antes de que Gerencia la autorice.', true, 'destructive'),
  t('PAYMENT_ORDER', 'APROBADA', 'PAY', 'PAGADA', 'payment_order.pay', 'Pagar', 'Registra el pago desde la caja o el banco: genera el asiento y baja la deuda con el proveedor.'),
  t('PAYMENT_ORDER', 'APROBADA', 'CANCEL', 'ANULADA', 'payment_order.cancel', 'Anular', 'Queda sin efecto antes de pagarse.', true, 'destructive'),
  t('PAYMENT_ORDER', 'PAGADA', 'CANCEL', 'ANULADA', 'payment_order.cancel', 'Anular con contraasiento', 'Revierte el pago con un contraasiento: las facturas vuelven a tener saldo.', true, 'destructive'),

  // Solicitud de cotización
  t('RFQ', 'BORRADOR', 'SUBMIT', 'ENVIADA', 'rfq.create', 'Enviar a los proveedores', 'Imprimila y mandásela a cada proveedor invitado; después cargá sus cotizaciones.'),
  t('RFQ', 'BORRADOR', 'CANCEL', 'ANULADA', 'rfq.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('RFQ', 'ENVIADA', 'AWARD', 'ADJUDICADA', 'rfq.award', 'Adjudicar', 'Elegí la cotización: se genera la orden de compra en borrador y las demás quedan descartadas.'),
  t('RFQ', 'ENVIADA', 'CANCEL', 'ANULADA', 'rfq.cancel', 'Anular', 'No se compra por esta vía: las cotizaciones cargadas quedan descartadas.', true, 'destructive'),

  // Cotización de proveedor
  t('SUPPLIER_QUOTE', 'RECIBIDA', 'CANCEL', 'ANULADA', 'supplier_quote.cancel', 'Anular', 'Sale del cuadro comparativo. Si el proveedor cambió su oferta, cargá la nueva.', true, 'destructive'),
  t('SUPPLIER_QUOTE', 'RECIBIDA', 'SYSTEM', 'ADJUDICADA', null, '', ''),
  t('SUPPLIER_QUOTE', 'RECIBIDA', 'SYSTEM', 'DESCARTADA', null, '', ''),

  // Transferencia entre cuentas
  t('FUNDS_TRANSFER', 'BORRADOR', 'CONFIRM', 'CONFIRMADA', 'funds_transfer.create', 'Confirmar transferencia', 'Controla el saldo de la cuenta de origen y genera el asiento.'),
  t('FUNDS_TRANSFER', 'BORRADOR', 'CANCEL', 'ANULADA', 'funds_transfer.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('FUNDS_TRANSFER', 'CONFIRMADA', 'CANCEL', 'ANULADA', 'funds_transfer.cancel', 'Anular con contraasiento', 'Revierte el asiento: los fondos vuelven a la cuenta de origen.', true, 'destructive'),

  // Conciliación bancaria
  t('BANK_RECONCILIATION', 'CONFIRMADA', 'CANCEL', 'ANULADA', 'bank_reconciliation.cancel', 'Anular', 'Sus movimientos vuelven a quedar pendientes de conciliar. Sólo se anula la última conciliación de cada banco.', true, 'destructive'),

  // Pedido de venta: confirmar lleva a Confirmado o, si supera el crédito, a Pendiente de aprobación.
  t('SALES_ORDER', 'BORRADOR', 'CONFIRM', 'CONFIRMADO', 'sales_order.create', 'Confirmar pedido', 'Controla el stock disponible y el crédito del cliente, y reserva la mercadería. Si supera el crédito, lo autoriza Gerencia.'),
  t('SALES_ORDER', 'BORRADOR', 'CONFIRM', 'PENDIENTE_APROBACION', 'sales_order.create', 'Confirmar pedido', 'Controla el stock disponible y el crédito del cliente, y reserva la mercadería. Si supera el crédito, lo autoriza Gerencia.'),
  t('SALES_ORDER', 'BORRADOR', 'CANCEL', 'ANULADO', 'sales_order.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('SALES_ORDER', 'PENDIENTE_APROBACION', 'APPROVE', 'CONFIRMADO', 'sales_order.approve', 'Autorizar crédito', 'El pedido queda confirmado: Depósito recibe la tarea de prepararlo.'),
  t('SALES_ORDER', 'PENDIENTE_APROBACION', 'REJECT', 'RECHAZADO', 'sales_order.approve', 'Rechazar', 'No se le vende a crédito: la reserva de stock se libera.', true, 'destructive'),
  t('SALES_ORDER', 'PENDIENTE_APROBACION', 'CANCEL', 'ANULADO', 'sales_order.cancel', 'Anular', 'Queda sin efecto y la reserva de stock se libera.', true, 'destructive'),
  t('SALES_ORDER', 'CONFIRMADO', 'CANCEL', 'ANULADO', 'sales_order.cancel', 'Anular', 'Sólo si todavía no salió nada: la reserva de stock se libera.', true, 'destructive'),
  t('SALES_ORDER', 'ENTREGADO_PARCIAL', 'CLOSE', 'CERRADO', 'sales_order.cancel', 'Cerrar saldo', 'Se da por terminado: lo que falta no se entrega y su reserva se libera.', true, 'outline'),
  t('SALES_ORDER', 'CONFIRMADO', 'SYSTEM', 'ENTREGADO_PARCIAL', null, '', ''),
  t('SALES_ORDER', 'CONFIRMADO', 'SYSTEM', 'ENTREGADO', null, '', ''),
  t('SALES_ORDER', 'ENTREGADO_PARCIAL', 'SYSTEM', 'ENTREGADO', null, '', ''),
  t('SALES_ORDER', 'ENTREGADO_PARCIAL', 'SYSTEM', 'CONFIRMADO', null, '', ''),
  t('SALES_ORDER', 'ENTREGADO', 'SYSTEM', 'ENTREGADO_PARCIAL', null, '', ''),
  t('SALES_ORDER', 'ENTREGADO', 'SYSTEM', 'CONFIRMADO', null, '', ''),

  // Remito
  t('DELIVERY_NOTE', 'BORRADOR', 'CONFIRM', 'CONFIRMADO', 'delivery_note.create', 'Despachar', 'La mercadería sale del depósito: baja el stock, se libera la reserva y se registra el costo de lo vendido.'),
  t('DELIVERY_NOTE', 'BORRADOR', 'CANCEL', 'ANULADO', 'delivery_note.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('DELIVERY_NOTE', 'CONFIRMADO', 'CANCEL', 'ANULADO', 'delivery_note.cancel', 'Anular con contramovimiento', 'La mercadería vuelve al depósito y un contraasiento revierte su costo. Debe hacerlo otro usuario.', true, 'destructive'),

  // Factura de venta
  t('SALES_INVOICE', 'BORRADOR', 'CONFIRM', 'REGISTRADA', 'sales_invoice.create', 'Registrar factura', 'Le asigna el número, controla las cantidades contra lo entregado y genera el asiento de venta y la deuda del cliente.'),
  t('SALES_INVOICE', 'BORRADOR', 'CANCEL', 'ANULADA', 'sales_invoice.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('SALES_INVOICE', 'REGISTRADA', 'CANCEL', 'ANULADA', 'sales_invoice.cancel', 'Anular con contraasiento', 'Revierte el asiento de venta y la deuda del cliente. Sólo si todavía no tiene cobros.', true, 'destructive'),
  t('SALES_INVOICE', 'REGISTRADA', 'SYSTEM', 'COBRADA_PARCIAL', null, '', ''),
  t('SALES_INVOICE', 'REGISTRADA', 'SYSTEM', 'COBRADA', null, '', ''),
  t('SALES_INVOICE', 'COBRADA_PARCIAL', 'SYSTEM', 'COBRADA', null, '', ''),
  t('SALES_INVOICE', 'COBRADA_PARCIAL', 'SYSTEM', 'REGISTRADA', null, '', ''),
  t('SALES_INVOICE', 'COBRADA', 'SYSTEM', 'COBRADA_PARCIAL', null, '', ''),
  t('SALES_INVOICE', 'COBRADA', 'SYSTEM', 'REGISTRADA', null, '', ''),

  // Recibo de cobro
  t('CUSTOMER_RECEIPT', 'BORRADOR', 'CONFIRM', 'CONFIRMADO', 'customer_receipt.create', 'Confirmar cobro', 'Registra el ingreso en la caja o el banco: genera el asiento de cobro y baja la deuda del cliente.'),
  t('CUSTOMER_RECEIPT', 'BORRADOR', 'CANCEL', 'ANULADO', 'customer_receipt.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('CUSTOMER_RECEIPT', 'CONFIRMADO', 'CANCEL', 'ANULADO', 'customer_receipt.cancel', 'Anular con contraasiento', 'Revierte el cobro con un contraasiento: las facturas vuelven a tener saldo. Sólo si el dinero sigue en la caja o el banco.', true, 'destructive'),

  // Presupuesto
  t('SALES_QUOTE', 'BORRADOR', 'SEND', 'ENVIADO', 'sales_quote.create', 'Enviar al cliente', 'Imprimilo y mandáselo al cliente: Ventas recibe la tarea de seguirlo hasta que responda.'),
  t('SALES_QUOTE', 'BORRADOR', 'CANCEL', 'ANULADO', 'sales_quote.cancel', 'Anular', 'El borrador queda sin efecto.', true, 'destructive'),
  t('SALES_QUOTE', 'ENVIADO', 'CONFIRM', 'ACEPTADO', 'sales_quote.create', 'Registrar la aceptación', 'El cliente aceptó: se genera el pedido de venta en borrador con estos ítems y precios.'),
  t('SALES_QUOTE', 'ENVIADO', 'REJECT', 'RECHAZADO', 'sales_quote.create', 'Registrar el rechazo', 'El cliente no aceptó: anotá su motivo (el precio, el plazo, compró en otra empresa…).', true, 'destructive'),
  t('SALES_QUOTE', 'ENVIADO', 'CLOSE', 'VENCIDO', 'sales_quote.cancel', 'Dar por vencido', 'Pasó la validez sin respuesta del cliente.', false, 'outline'),
  t('SALES_QUOTE', 'ENVIADO', 'CANCEL', 'ANULADO', 'sales_quote.cancel', 'Anular', 'Queda sin efecto (por ejemplo, se cargó mal): si hace falta, se prepara otro.', true, 'destructive'),

  // Orden de producción
  t('PRODUCTION_ORDER', 'BORRADOR', 'RELEASE', 'LIBERADA', 'production_order.create', 'Liberar', 'Controla que haya materiales disponibles y los reserva: Depósito recibe la tarea de entregarlos.'),
  t('PRODUCTION_ORDER', 'BORRADOR', 'CANCEL', 'ANULADA', 'production_order.cancel', 'Anular', 'La orden queda sin efecto.', true, 'destructive'),
  t('PRODUCTION_ORDER', 'LIBERADA', 'ISSUE', 'EN_PROCESO', 'production_order.issue', 'Entregar los materiales', 'Registrá lo que sale de cada material: baja el stock y el consumo pasa a productos en proceso.'),
  t('PRODUCTION_ORDER', 'LIBERADA', 'CANCEL', 'ANULADA', 'production_order.cancel', 'Anular', 'Queda sin efecto y la reserva de materiales se libera.', true, 'destructive'),
  t('PRODUCTION_ORDER', 'EN_PROCESO', 'FINISH', 'TERMINADA', 'production_order.create', 'Terminar', 'Registrá las unidades que salieron bien: entran al stock a su costo real.'),
  t('PRODUCTION_ORDER', 'EN_PROCESO', 'CANCEL', 'ANULADA', 'production_order.cancel', 'Anular con devolución', 'Los materiales vuelven al depósito y un contraasiento revierte el consumo.', true, 'destructive'),
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
  PAY: 'Pagó',
  AWARD: 'Adjudicó',
  RELEASE: 'Liberó',
  ISSUE: 'Entregó los materiales de',
  FINISH: 'Terminó',
  SYSTEM: 'Actualizó',
  CLOSE_PERIOD: 'Cerró el período',
  REOPEN_PERIOD: 'Reabrió el período',
  OPEN_FISCAL_YEAR: 'Abrió el ejercicio',
  ACTIVATE: 'Activó',
  DEACTIVATE: 'Desactivó',
  ASSIGN_ROLE: 'Asignó rol',
  REMOVE_ROLE: 'Quitó rol',
  SETTINGS: 'Cambió configuración',
  CHANGE_PASSWORD: 'Cambió su contraseña',
  RESET_PASSWORD: 'Restableció contraseña',
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

// prettier-ignore
export const TASK_RULES: TaskRule[] = [
  { docType: 'PURCHASE_REQUISITION', status: 'SOLICITADO', taskType: 'ATENDER_SC', assignee: 'ROLE', role: 'COMPRAS', title: 'Atender {number}', description: 'Pedir cotizaciones o incluir la solicitud en una orden de compra, o rechazarla con motivo.' },
  { docType: 'PURCHASE_REQUISITION', status: 'ORDENADO_PARCIAL', taskType: 'ATENDER_SC', assignee: 'ROLE', role: 'COMPRAS', title: 'Completar {number} (saldo sin ordenar)', description: 'Ordenar el saldo pendiente o cerrarlo con motivo.' },
  { docType: 'PURCHASE_ORDER', status: 'PENDIENTE_APROBACION', taskType: 'APROBAR_OC', assignee: 'APPROVER', title: 'Aprobar {number} por {total}', description: 'Revisar proveedor, precios y cantidades; aprobar o rechazar con motivo.' },
  { docType: 'PURCHASE_ORDER', status: 'RECHAZADO', taskType: 'CORREGIR_OC', assignee: 'CREATOR', title: 'Revisar {number} rechazada', description: 'Leer el motivo del rechazo, corregir y reenviar, o anular.' },
  { docType: 'PURCHASE_ORDER', status: 'APROBADO', taskType: 'ENVIAR_OC', assignee: 'ROLE', role: 'COMPRAS', title: 'Enviar {number} al proveedor', description: 'Imprimir la orden, comunicarla al proveedor y marcarla como enviada.' },
  { docType: 'PURCHASE_ORDER', status: 'ENVIADO', taskType: 'RECIBIR_MERCADERIA', assignee: 'ROLE', role: 'DEPOSITO', title: 'Recibir mercadería de {number}', description: 'Cuando llegue la mercadería, controlarla contra la OC y el remito, y registrar la recepción.' },
  { docType: 'PURCHASE_ORDER', status: 'RECIBIDO_PARCIAL', taskType: 'RECIBIR_MERCADERIA', assignee: 'ROLE', role: 'DEPOSITO', title: 'Recibir saldo de {number}', description: 'Queda mercadería pendiente de entrega.' },
  { docType: 'GOODS_RECEIPT', status: 'BORRADOR', taskType: 'CONFIRMAR_RECEPCION', assignee: 'CREATOR', title: 'Confirmar {number}', description: 'Revisar cantidades y confirmar para que ingrese al stock.' },
  { docType: 'STOCK_ADJUSTMENT', status: 'BORRADOR', taskType: 'CONFIRMAR_AJUSTE', assignee: 'CREATOR', title: 'Confirmar {number}', description: 'Revisar el ajuste y confirmarlo.' },
  { docType: 'JOURNAL_ENTRY', status: 'BORRADOR', taskType: 'REGISTRAR_ASIENTO', assignee: 'CREATOR', title: 'Registrar {number}', description: 'Revisar que el debe y el haber sumen lo mismo y registrar el asiento en el libro diario.' },
  { docType: 'SUPPLIER_INVOICE', status: 'BORRADOR', taskType: 'REGISTRAR_FACTURA', assignee: 'CREATOR', title: 'Registrar {number}', description: 'Revisar los datos del comprobante y las cantidades contra lo recibido, y registrar la factura.' },
  { docType: 'PAYMENT_ORDER', status: 'BORRADOR', taskType: 'ENVIAR_OP', assignee: 'CREATOR', title: 'Enviar {number} a aprobación', description: 'Revisar las facturas, los importes y la caja o el banco, y enviar la orden a Gerencia.' },
  { docType: 'PAYMENT_ORDER', status: 'PENDIENTE_APROBACION', taskType: 'APROBAR_PAGO', assignee: 'ROLE', role: 'GERENCIA', title: 'Autorizar el pago {number} por {total}', description: 'Revisar las facturas y el saldo de la caja o el banco; aprobar o rechazar con motivo.' },
  { docType: 'PAYMENT_ORDER', status: 'APROBADA', taskType: 'PAGAR', assignee: 'ROLE', role: 'TESORERIA', title: 'Pagar {number} por {total}', description: 'Hacer la transferencia o entregar el cheque o el efectivo, y registrar el pago.' },
  { docType: 'RFQ', status: 'BORRADOR', taskType: 'ENVIAR_SCT', assignee: 'CREATOR', title: 'Enviar {number} a los proveedores', description: 'Revisar los ítems, las cantidades y los proveedores invitados, y enviar la solicitud.' },
  { docType: 'RFQ', status: 'ENVIADA', taskType: 'ADJUDICAR_SCT', assignee: 'ROLE', role: 'COMPRAS', title: 'Comparar y adjudicar {number}', description: 'Cargar las cotizaciones que lleguen, compararlas en el cuadro y adjudicar la más conveniente, o anular la solicitud con motivo.' },
  { docType: 'FUNDS_TRANSFER', status: 'BORRADOR', taskType: 'CONFIRMAR_TRANSFERENCIA', assignee: 'CREATOR', title: 'Confirmar {number} por {total}', description: 'Revisar las cuentas y el importe, y confirmar la transferencia.' },
  { docType: 'SALES_ORDER', status: 'BORRADOR', taskType: 'CONFIRMAR_PV', assignee: 'CREATOR', title: 'Confirmar {number}', description: 'Revisar el cliente, los ítems y los precios, y confirmar el pedido para reservar la mercadería.' },
  { docType: 'SALES_ORDER', status: 'PENDIENTE_APROBACION', taskType: 'AUTORIZAR_CREDITO', assignee: 'ROLE', role: 'GERENCIA', title: 'Autorizar el crédito de {number} por {total}', description: 'Revisar la deuda del cliente y su límite de crédito; autorizar el pedido o rechazarlo con motivo.' },
  { docType: 'SALES_ORDER', status: 'CONFIRMADO', taskType: 'DESPACHAR_PEDIDO', assignee: 'ROLE', role: 'DEPOSITO', title: 'Preparar y despachar {number}', description: 'Preparar la mercadería reservada, cargar el remito y despacharlo.' },
  { docType: 'SALES_ORDER', status: 'ENTREGADO_PARCIAL', taskType: 'DESPACHAR_PEDIDO', assignee: 'ROLE', role: 'DEPOSITO', title: 'Despachar el saldo de {number}', description: 'Queda mercadería reservada pendiente de entrega.' },
  { docType: 'DELIVERY_NOTE', status: 'BORRADOR', taskType: 'DESPACHAR_REMITO', assignee: 'CREATOR', title: 'Despachar {number}', description: 'Controlar la mercadería preparada contra el remito y despacharlo.' },
  { docType: 'SALES_INVOICE', status: 'BORRADOR', taskType: 'REGISTRAR_FV', assignee: 'CREATOR', title: 'Registrar {number}', description: 'Revisar las cantidades contra lo entregado y registrar la factura de venta.' },
  { docType: 'CUSTOMER_RECEIPT', status: 'BORRADOR', taskType: 'CONFIRMAR_RBO', assignee: 'CREATOR', title: 'Confirmar {number} por {total}', description: 'Revisar las facturas, los importes, el medio de cobro y la caja o el banco, y confirmar el cobro.' },
  { docType: 'SALES_QUOTE', status: 'BORRADOR', taskType: 'ENVIAR_PRE', assignee: 'CREATOR', title: 'Enviar {number} al cliente', description: 'Revisar los ítems, los precios y la validez, y enviar el presupuesto al cliente.' },
  { docType: 'SALES_QUOTE', status: 'ENVIADO', taskType: 'SEGUIR_PRE', assignee: 'ROLE', role: 'VENTAS', title: 'Seguir {number} por {total}', description: 'Registrar la aceptación o el rechazo del cliente antes de que venza la oferta.' },
  { docType: 'PRODUCTION_ORDER', status: 'BORRADOR', taskType: 'LIBERAR_OPR', assignee: 'CREATOR', title: 'Liberar {number}', description: 'Revisar el producto, la cantidad y los materiales, y liberar la orden para reservarlos.' },
  { docType: 'PRODUCTION_ORDER', status: 'LIBERADA', taskType: 'ENTREGAR_MATERIALES', assignee: 'ROLE', role: 'DEPOSITO', title: 'Entregar los materiales de {number}', description: 'Preparar los materiales reservados, entregarlos a Producción y registrar lo que sale de cada uno.' },
  { docType: 'PRODUCTION_ORDER', status: 'EN_PROCESO', taskType: 'TERMINAR_OPR', assignee: 'ROLE', role: 'PRODUCCION', title: 'Terminar {number}', description: 'Cuando termine la fabricación, registrar las unidades que salieron bien.' },
]

export const TASK_TYPE_LABELS: Record<string, string> = {
  ATENDER_SC: 'Atender solicitud',
  APROBAR_OC: 'Aprobar orden',
  CORREGIR_OC: 'Corregir orden',
  ENVIAR_OC: 'Enviar orden',
  RECIBIR_MERCADERIA: 'Recibir mercadería',
  CONFIRMAR_RECEPCION: 'Confirmar recepción',
  CONFIRMAR_AJUSTE: 'Confirmar ajuste',
  REGISTRAR_ASIENTO: 'Registrar asiento',
  REGISTRAR_FACTURA: 'Registrar factura',
  ENVIAR_OP: 'Enviar orden de pago',
  APROBAR_PAGO: 'Autorizar pago',
  PAGAR: 'Pagar',
  ENVIAR_SCT: 'Enviar solicitud de cotización',
  ADJUDICAR_SCT: 'Adjudicar cotización',
  CONFIRMAR_TRANSFERENCIA: 'Confirmar transferencia',
  CONFIRMAR_PV: 'Confirmar pedido',
  AUTORIZAR_CREDITO: 'Autorizar crédito',
  DESPACHAR_PEDIDO: 'Despachar pedido',
  DESPACHAR_REMITO: 'Despachar remito',
  REGISTRAR_FV: 'Registrar factura de venta',
  CONFIRMAR_RBO: 'Confirmar cobro',
  ENVIAR_PRE: 'Enviar presupuesto',
  SEGUIR_PRE: 'Seguir presupuesto',
  LIBERAR_OPR: 'Liberar orden de producción',
  ENTREGAR_MATERIALES: 'Entregar materiales',
  TERMINAR_OPR: 'Terminar orden de producción',
  REPONER_STOCK: 'Evaluar reposición',
  CONSIGNA: 'Consigna del docente',
}

// ---------------------------------------------------------------- Notificaciones

export const NOTIFICATION_TYPES: Record<string, string> = {
  NUEVA_TAREA: 'Tarea nueva',
  STOCK_MINIMO: 'Stock mínimo',
  SC_RECHAZADA: 'Solicitud rechazada',
  OC_APROBADA: 'Orden aprobada',
  OC_RECIBIDA: 'Orden recibida',
  MATERIAL_DISPONIBLE: 'Material disponible',
  PEDIDO_AUTORIZADO: 'Pedido autorizado',
  PEDIDO_DESPACHADO: 'Pedido despachado',
  PRODUCCION_TERMINADA: 'Producción terminada',
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

export const PAYMENT_METHODS: Record<PaymentMethod, string> = {
  TRANSFERENCIA: 'Transferencia',
  CHEQUE: 'Cheque',
  EFECTIVO: 'Efectivo',
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
  DESPACHO_VENTA: 'Despacho por venta',
  ANULACION_DESPACHO: 'Anulación de despacho',
  CONSUMO_PRODUCCION: 'Consumo de producción',
  DEVOLUCION_PRODUCCION: 'Devolución de producción',
  INGRESO_PRODUCCION: 'Ingreso de producción',
}

/** Lo que se vende (docs/FASE_4_VENTAS_Y_CLIENTES.md §2, a validar): las materias primas y los insumos, no. */
export const SELLABLE_PRODUCT_TYPES: ProductType[] = ['PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO']

/** Lo que va en una lista de materiales (docs/FASE_5_PRODUCCION_Y_COSTOS.md §2): materias primas e insumos. */
export const BOM_COMPONENT_TYPES: ProductType[] = ['MATERIA_PRIMA', 'INSUMO']

export const VAT_RATES = [21, 10.5, 27, 0]

export const ACCOUNT_TYPES: Record<AccountType, string> = {
  ACTIVO: 'Activo',
  PASIVO: 'Pasivo',
  PATRIMONIO_NETO: 'Patrimonio neto',
  RESULTADO_POSITIVO: 'Resultado positivo',
  RESULTADO_NEGATIVO: 'Resultado negativo',
}

/** Eventos contables que se imputan solos y los importes de cada uno (docs/FASE_3_COMPRAS_Y_TESORERIA.md §2). */
export const POSTING_EVENTS: Record<string, { label: string; keys: Record<string, string> }> = {
  COMPRA: {
    label: 'Compra (factura de proveedor registrada)',
    keys: {
      MATERIA_PRIMA: 'Materias primas compradas',
      INSUMO: 'Insumos comprados',
      PRODUCTO_TERMINADO: 'Productos terminados comprados',
      MERCADERIA_REVENTA: 'Mercaderías de reventa compradas',
      SERVICIO: 'Servicios comprados',
      IVA_CREDITO: 'IVA de la factura (letra A)',
      PROVEEDORES: 'Deuda con el proveedor',
    },
  },
  PAGO: {
    label: 'Pago a proveedores (orden de pago pagada)',
    keys: {
      // La contrapartida es la caja o el banco de la orden, no una regla.
      PROVEEDORES: 'Deuda con el proveedor que se cancela',
    },
  },
  VENTA: {
    label: 'Venta (factura de venta registrada)',
    keys: {
      PRODUCTO_TERMINADO: 'Productos terminados vendidos',
      MERCADERIA_REVENTA: 'Mercaderías de reventa vendidas',
      SERVICIO: 'Servicios cobrados al cliente',
      IVA_DEBITO: 'IVA de la factura',
      DEUDORES: 'Lo que debe el cliente',
    },
  },
  COBRO: {
    label: 'Cobro a clientes (recibo de cobro confirmado)',
    keys: {
      // La contrapartida es la caja o el banco del recibo, no una regla.
      DEUDORES: 'Lo que el cliente deja de deber',
    },
  },
  COSTO_VENTA: {
    label: 'Costo de lo vendido (remito despachado)',
    keys: {
      COSTO_PRODUCTO_TERMINADO: 'Costo de los productos terminados vendidos',
      COSTO_MERCADERIA_REVENTA: 'Costo de las mercaderías de reventa vendidas',
      PRODUCTO_TERMINADO: 'Productos terminados que salen del inventario',
      MERCADERIA_REVENTA: 'Mercaderías de reventa que salen del inventario',
    },
  },
  CONSUMO_PRODUCCION: {
    label: 'Consumo de producción (materiales entregados)',
    keys: {
      PRODUCCION_EN_PROCESO: 'Productos en proceso que reciben los materiales',
      MATERIA_PRIMA: 'Materias primas consumidas',
      INSUMO: 'Insumos consumidos',
    },
  },
  CONVERSION_PRODUCCION: {
    label: 'Costos de conversión aplicados (orden de producción terminada)',
    keys: {
      PRODUCCION_EN_PROCESO: 'Productos en proceso que reciben la conversión',
      MANO_DE_OBRA_APLICADA: 'Mano de obra directa aplicada a la orden',
      CARGA_FABRIL_APLICADA: 'Carga fabril aplicada a la orden',
    },
  },
  PRODUCCION_TERMINADA: {
    label: 'Producción terminada (orden de producción terminada)',
    keys: {
      PRODUCTO_TERMINADO: 'Productos terminados que ingresan al stock',
      PRODUCCION_EN_PROCESO: 'Productos en proceso que se terminan',
    },
  },
}

export const JOURNAL_ORIGINS: Record<JournalEntryOrigin, string> = {
  MANUAL: 'Manual',
  APERTURA: 'Apertura',
  CONTRAASIENTO: 'Contraasiento',
  AUTOMATICO: 'Automático',
}
