// Tipos de dominio. Reflejan las tablas descriptas en DATABASE.md para que el
// cambio del backend simulado por Supabase no altere la interfaz.

export type AppRole = 'SUPERADMIN' | 'ADMIN' | 'DOCENTE' | 'ESTUDIANTE'

export type RoleCode =
  | 'GERENCIA'
  | 'COMPRAS'
  | 'VENTAS'
  | 'DEPOSITO'
  | 'PRODUCCION'
  | 'CONTABILIDAD'
  | 'TESORERIA'
  | 'RRHH'
  | 'IMPUESTOS'
  | 'LOGISTICA'
  | 'AUDITOR'
  | 'DOCENTE'

export type ModuleCode =
  | 'core'
  | 'masters'
  | 'purchasing'
  | 'sales'
  | 'inventory'
  | 'production'
  | 'hr'
  | 'payables'
  | 'accounting'
  | 'management'
  | 'audit'

export type PermissionAction =
  'read' | 'create' | 'update' | 'approve' | 'cancel' | 'delete' | 'export' | 'pay' | 'award' | 'issue'

export type VatCondition = 'RESPONSABLE_INSCRIPTO' | 'MONOTRIBUTO' | 'EXENTO' | 'CONSUMIDOR_FINAL'

export type ProductType = 'MATERIA_PRIMA' | 'INSUMO' | 'PRODUCTO_TERMINADO' | 'MERCADERIA_REVENTA' | 'SERVICIO'

export type DocType =
  | 'PURCHASE_REQUISITION'
  | 'PURCHASE_ORDER'
  | 'GOODS_RECEIPT'
  | 'STOCK_ADJUSTMENT'
  | 'JOURNAL_ENTRY'
  | 'SUPPLIER_INVOICE'
  | 'PAYMENT_ORDER'
  | 'RFQ'
  | 'SUPPLIER_QUOTE'
  | 'FUNDS_TRANSFER'
  | 'BANK_RECONCILIATION'
  | 'SALES_ORDER'
  | 'DELIVERY_NOTE'
  | 'SALES_INVOICE'
  | 'CUSTOMER_RECEIPT'
  | 'SALES_QUOTE'
  | 'PRODUCTION_ORDER'
  | 'PAYROLL'

/** Cómo se pagó una orden de pago o se cobró un recibo. */
export type PaymentMethod = 'TRANSFERENCIA' | 'CHEQUE' | 'EFECTIVO'

export type TransitionAction =
  | 'SUBMIT'
  | 'APPROVE'
  | 'REJECT'
  | 'WITHDRAW'
  | 'REOPEN'
  | 'SEND'
  | 'CONFIRM'
  | 'CANCEL'
  | 'CLOSE'
  | 'PAY'
  | 'AWARD'
  | 'RELEASE'
  | 'ISSUE'
  | 'FINISH'
  | 'SYSTEM'

export type Badge = 'neutral' | 'info' | 'warning' | 'success' | 'danger'

export type MovementType =
  | 'STOCK_INICIAL'
  | 'RECEPCION_COMPRA'
  | 'ANULACION_RECEPCION'
  | 'AJUSTE_POSITIVO'
  | 'AJUSTE_NEGATIVO'
  | 'DESPACHO_VENTA'
  | 'ANULACION_DESPACHO'
  | 'CONSUMO_PRODUCCION'
  | 'DEVOLUCION_PRODUCCION'
  | 'INGRESO_PRODUCCION'

export type AdjustmentReason = 'INVENTARIO_INICIAL' | 'CONTEO_FISICO' | 'ROTURA' | 'CONSUMO_INTERNO' | 'OTRO'

export type Priority = 'BAJA' | 'NORMAL' | 'ALTA' | 'URGENTE'

export interface SchoolSettings {
  official_name: string
  short_name: string
  city: string
  province: string
  contact_email: string
  /** Minutos sin actividad antes de cerrar la sesión (computadoras compartidas). 0 = no se cierra. */
  session_timeout_minutes: number
  features: Record<string, boolean>
  /** Ruta del logo en Storage (p. ej. school-logos/ens9-logo.png). */
  logo_path?: string | null
  /** Solo en el motor simulado / DB: timestamp de última actualización. */
  updated_at?: string
  /** Solo en el motor simulado / DB: usuario que hizo la última actualización. */
  updated_by?: string
}

export interface Profile {
  id: string
  username: string
  /** Sólo en el backend simulado. Con Supabase la contraseña vive en Auth. */
  password: string
  first_name: string
  last_name: string
  app_role: AppRole
  is_active: boolean
  must_change_password: boolean
  created_at: string
}

export interface Course {
  id: string
  academic_year: number
  name: string
  orientation: string
}

export interface CompanySettings {
  sod_enabled: boolean
  allow_negative_stock: boolean
  /** Los porcentajes de la liquidación de sueldos (Fase 6b); sin ellos, los de PAYROLL_DEFAULT_RATES. */
  payroll?: Partial<PayrollRates>
}

/** Porcentajes de la liquidación de sueldos (a validar: sin pretensión de exactitud legal). */
export interface PayrollRates {
  /** Antigüedad: por ciento del básico por año cumplido. */
  seniority_pct: number
  /** Presentismo: por ciento del básico más la antigüedad, si no hubo ausencias sin aviso. */
  attendance_pct: number
  /** Aportes del empleado: jubilación, ley 19.032 y obra social, sobre el remunerativo. */
  retirement_pct: number
  pami_pct: number
  health_pct: number
  /** Contribuciones de la empresa sobre el remunerativo. */
  employer_pct: number
}

export interface Company {
  id: string
  course_id: string | null
  slug: string
  legal_name: string
  trade_name: string
  tax_id: string
  vat_condition: VatCondition
  activity: string
  address_line: string
  city: string
  province: string
  start_date: string
  is_template: boolean
  status: 'ACTIVA' | 'ARCHIVADA'
  settings: CompanySettings
  created_at: string
}

export interface Island {
  id: string
  company_id: string
  number: number
  name: string
}

export interface Sector {
  id: string
  company_id: string
  code: string
  name: string
  island_id: string | null
}

export interface Warehouse {
  id: string
  company_id: string
  code: string
  name: string
}

export interface Member {
  id: string
  company_id: string
  user_id: string
  job_title: string
  is_active: boolean
}

export interface MemberRole {
  id: string
  company_id: string
  member_id: string
  role_code: RoleCode
  sector_id: string | null
}

export interface CompanyModule {
  company_id: string
  module_code: ModuleCode
  is_enabled: boolean
}

interface Audited {
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
}

export interface Partner extends Audited {
  id: string
  company_id: string
  code: string
  legal_name: string
  trade_name: string
  tax_id: string
  vat_condition: VatCondition
  address_line: string
  city: string
  province: string
  phone: string
  email: string
  contact_name: string
  payment_terms_days: number
  notes: string
  is_active: boolean
}

export interface Customer extends Partner {
  credit_limit: number | null
  /** Lista de precios que se le propone (4d); sin lista, el precio de venta de cada producto. */
  price_list_id: string | null
}

/** Lista de precios de una empresa (tabla price_lists): el precio sin IVA de cada producto que se vende. */
export interface PriceList extends Audited {
  id: string
  company_id: string
  code: string
  name: string
  description: string
  is_active: boolean
}

/** El precio de un producto en una lista (tabla price_list_items). */
export interface PriceListItem {
  id: string
  company_id: string
  price_list_id: string
  product_id: string
  unit_price: number
}

/**
 * Lista de materiales de un producto terminado (tabla boms, una por producto):
 * su fórmula. Las órdenes de producción guardan su propia copia.
 */
export interface Bom extends Audited {
  id: string
  company_id: string
  product_id: string
  notes: string
  is_active: boolean
}

/** Un componente de la lista (tabla bom_lines): una materia prima o un insumo y cuánto lleva cada unidad. */
export interface BomLine {
  id: string
  company_id: string
  bom_id: string
  line_no: number
  component_id: string
  /** Por unidad del producto terminado. */
  quantity: number
}

/**
 * Centro de trabajo (tabla work_centers): un sector del taller con su tarifa de
 * mano de obra directa y su tasa de carga fabril por hora, predeterminadas.
 */
export interface WorkCenter extends Audited {
  id: string
  company_id: string
  code: string
  name: string
  /** Mano de obra directa: pesos por hora. */
  labor_rate: number
  /** Carga fabril (costos indirectos): pesos por hora. */
  overhead_rate: number
  is_active: boolean
}

/** Liquidación de sueldos de un mes (Fase 6b). */
export interface PayrollHeader {
  /** El mes liquidado: aaaa-mm. */
  period: string
  payment_date: string
  /** Los porcentajes con que se calculó (los de la empresa al crearla). */
  rates: PayrollRates
  confirmed_at: string | null
  /** El pago de los netos (Fase 6c): el día y la caja o el banco. */
  salaries_paid_on: string | null
  salaries_account_id: string | null
  /** El de los aportes retenidos y las contribuciones. */
  charges_paid_on: string | null
  charges_account_id: string | null
}

/** Lo de un empleado en una liquidación: sus novedades y los importes calculados. */
export interface PayrollLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  employee_id: string
  /** Copias al crearla: la categoría con su básico, la antigüedad al fin del mes y si es del taller. */
  category_id: string
  basic_salary: number
  seniority_years: number
  is_direct_labor: boolean
  work_center_id: string | null
  days_worked: number
  absence_days: number
  overtime_50: number
  overtime_100: number
  basic: number
  seniority: number
  attendance: number
  overtime: number
  /** Total remunerativo. */
  gross: number
  retirement: number
  pami: number
  health: number
  deductions: number
  net: number
  /** Contribuciones de la empresa. */
  employer: number
}

/** Categoría del personal (un convenio simplificado, Fase 6a): su sueldo básico mensual. */
export interface JobCategory extends Audited {
  id: string
  company_id: string
  code: string
  name: string
  /** Sueldo básico mensual. */
  basic_salary: number
  /** Si es del taller: su sueldo es mano de obra directa y el empleado trabaja en un centro de trabajo. */
  is_direct_labor: boolean
  is_active: boolean
}

export type EmployeeStatus = 'ACTIVO' | 'BAJA'

/** Legajo de un empleado de la empresa simulada (un personaje: sin documento ni datos reales). */
export interface Employee extends Audited {
  id: string
  company_id: string
  /** Número de legajo, correlativo en la empresa. */
  file_number: number
  first_name: string
  last_name: string
  hire_date: string
  category_id: string
  sector_id: string
  /** El centro de trabajo, si es del taller. */
  work_center_id: string | null
  status: EmployeeStatus
  termination_date: string | null
  termination_reason: string
}

/** Las horas que lleva cada unidad en un centro de trabajo (tabla bom_operations): la ruta simplificada. */
export interface BomOperation {
  id: string
  company_id: string
  bom_id: string
  line_no: number
  work_center_id: string
  /** Por unidad del producto terminado. */
  hours: number
}

export interface Supplier extends Partner {
  lead_time_days: number | null
  category: string
}

export interface Product extends Audited {
  id: string
  company_id: string
  code: string
  name: string
  description: string
  category: string
  product_type: ProductType
  uom_code: string
  is_stockable: boolean
  standard_cost: number
  sale_price: number | null
  vat_rate: number
  min_stock: number
  reorder_qty: number | null
  default_supplier_id: string | null
  default_warehouse_id: string | null
  location: string
  is_active: boolean
}

export interface RequisitionHeader {
  needed_by: string | null
  priority: Priority
  reason: string
}

export interface PurchaseOrderHeader {
  expected_date: string | null
  warehouse_id: string
  payment_terms_days: number
  delivery_terms: string
  approved_at: string | null
  sent_at: string | null
}

export interface GoodsReceiptHeader {
  purchase_order_id: string
  warehouse_id: string
  supplier_delivery_note: string
  carrier_name: string
  received_at: string | null
}

export interface StockAdjustmentHeader {
  warehouse_id: string
  reason_code: AdjustmentReason
}

export type JournalEntryOrigin = 'MANUAL' | 'APERTURA' | 'CONTRAASIENTO' | 'AUTOMATICO'

/** Cabecera del asiento (tabla journal_entries, 1 a 1 con documents). */
export interface JournalEntryHeader {
  /** Leyenda: qué hecho económico registra. */
  description: string
  origin: JournalEntryOrigin
  /** Se asignan al registrarlo: ejercicio y número correlativo del libro diario. */
  fiscal_year_id: string | null
  entry_number: number | null
  posted_at: string | null
  /** En un contraasiento, el asiento que anula. */
  reverses_id: string | null
}

/** Factura de proveedor (tabla supplier_invoices, 1 a 1 con documents): el comprobante que emitió el proveedor. */
export interface SupplierInvoiceHeader {
  purchase_order_id: string
  /** A si el proveedor es responsable inscripto (IVA discriminado); C si no. */
  letter: 'A' | 'C'
  point_of_sale: string
  invoice_number: string
  due_date: string
  registered_at: string | null
}

/** Orden de pago (tabla payment_orders, 1 a 1 con documents): qué facturas de un proveedor se pagan y desde dónde. */
export interface PaymentOrderHeader {
  /** Caja o banco desde el que se paga: una cuenta imputable del rubro Caja y bancos. */
  treasury_account_id: string
  /** Número de transferencia o de cheque, que anota Tesorería al pagar. */
  payment_reference: string
  /** Fecha del pago (la del asiento). */
  paid_on: string | null
  /** Medio con que se pagó (al pagarse). */
  payment_method: PaymentMethod | null
}

/** Solicitud de cotización (tabla rfqs, 1 a 1 con documents): qué se pide cotizar, hasta cuándo y dónde se entregaría. */
export interface RfqHeader {
  /** Fecha límite para que respondan los proveedores. */
  response_due: string
  /** Depósito de entrega: pasa a la OC de la cotización adjudicada. */
  warehouse_id: string
  /** Por qué se adjudicó (obligatorio si no es la más conveniente por precio). */
  award_reason: string
}

/** Cotización de un proveedor (tabla supplier_quotes, 1 a 1 con documents) a una solicitud de cotización. */
export interface SupplierQuoteHeader {
  rfq_id: string
  /** Número o referencia de la cotización del proveedor. */
  supplier_reference: string
  /** Validez de la oferta. */
  valid_until: string
  delivery_days: number
  payment_terms_days: number
}

/** Transferencia entre cuentas (tabla funds_transfers, 1 a 1 con documents): de una caja o un banco a otro. */
export interface FundsTransferHeader {
  from_account_id: string
  to_account_id: string
  /** Número de la boleta de depósito o de la transferencia. */
  reference: string
  /** Fecha en que se confirmó (la del asiento). */
  transferred_on: string | null
}

/**
 * Conciliación bancaria (tabla bank_reconciliations, 1 a 1 con documents): el
 * extracto de un banco a una fecha contra su mayor. Los importes calculados se
 * guardan como quedaron al confirmarla.
 */
export interface BankReconciliationHeader {
  account_id: string
  statement_date: string
  /** Saldo según el extracto del banco. */
  statement_balance: number
  /** Saldo según libros (el mayor) a la fecha del extracto. */
  book_balance: number
  /** Entradas registradas que el banco todavía no acreditó. */
  pending_debits: number
  /** Pagos registrados (cheques, transferencias) que el banco todavía no debitó. */
  pending_credits: number
}

/** Pedido de venta (tabla sales_orders, 1 a 1 con documents): qué compra el cliente, desde dónde se entrega y en qué condiciones. */
export interface SalesOrderHeader {
  /** Depósito desde el que se entrega: ahí se reserva el stock. */
  warehouse_id: string
  /** Fecha de entrega que pidió el cliente (opcional). */
  delivery_date: string | null
  payment_terms_days: number
  /** Número de orden de compra del cliente u otra referencia suya. */
  customer_reference: string
  /** Por qué necesitó la autorización de Gerencia (crédito excedido o facturas vencidas); vacío si no. */
  credit_reason: string
  /** Cuándo quedó confirmado (por Ventas o con la autorización de Gerencia). */
  confirmed_at: string | null
}

/** Remito (tabla delivery_notes, 1 a 1 con documents): lo que Depósito despacha de un pedido de venta. */
export interface DeliveryNoteHeader {
  sales_order_id: string
  warehouse_id: string
  carrier_name: string
  /** Cuándo salió la mercadería (al despacharlo). */
  dispatched_at: string | null
}

/**
 * Factura de venta (tabla sales_invoices, 1 a 1 con documents): el comprobante
 * simulado que la empresa emite al cliente, contra lo entregado de un pedido.
 */
export interface SalesInvoiceHeader {
  sales_order_id: string
  /** A a responsables inscriptos y monotributistas, B a exentos y consumidores finales; C si la empresa no es responsable inscripta. */
  letter: 'A' | 'B' | 'C'
  point_of_sale: string
  /** Correlativo por letra: se asigna al registrarla (vacío en borrador). */
  invoice_number: string
  /** Fecha de la factura más la condición de pago del pedido. */
  due_date: string
  registered_at: string | null
}

/** Presupuesto (tabla sales_quotes, 1 a 1 con documents): lo que Ventas le cotiza a un cliente y hasta cuándo vale la oferta. */
export interface SalesQuoteHeader {
  /** Hasta cuándo vale la oferta: después no se acepta. */
  valid_until: string
  /** Desde dónde se entregaría: pasa al pedido. */
  warehouse_id: string
  payment_terms_days: number
  customer_reference: string
}

/**
 * Orden de producción (tabla production_orders, 1 a 1 con documents): qué se
 * fabrica, cuánto, de qué depósito salen los materiales y a cuál entra el producto.
 */
export interface ProductionOrderHeader {
  product_id: string
  /** Unidades planificadas. */
  quantity: number
  materials_warehouse_id: string
  output_warehouse_id: string
  /** Fecha prevista de terminación (opcional). */
  due_date: string | null
  /** Unidades que salieron bien (al terminarla). */
  quantity_produced: number | null
  /** Costo real de cada unidad terminada. */
  unit_cost: number | null
  released_at: string | null
  issued_at: string | null
  finished_at: string | null
}

/** Recibo de cobro (tabla customer_receipts, 1 a 1 con documents): qué facturas de un cliente se cobran y dónde ingresa el dinero. */
export interface CustomerReceiptHeader {
  /** Caja o banco donde ingresa el dinero: los cheques de terceros, a Valores a depositar. */
  treasury_account_id: string
  payment_method: PaymentMethod
  /** Número de la transferencia o del cheque del cliente (obligatorio con cheque). */
  reference: string
  /** Fecha del cobro (al confirmarse: la del asiento). */
  received_on: string | null
}

/** Un ítem del presupuesto: el precio de lista que se propuso y el que se cotizó. */
export interface SalesQuoteLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  product_id: string
  quantity: number
  list_price: number
  unit_price: number
  vat_rate: number
  line_subtotal: number
  line_tax: number
  line_total: number
}

/** Un material de la orden de producción: lo previsto según la lista y lo que entregó Depósito. */
export interface ProductionOrderLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  /** El componente (materia prima o insumo). */
  product_id: string
  quantity_planned: number
  /** Costo promedio (o estándar) del material al planificar la orden. */
  planned_unit_cost: number
  /** Lo que entregó Depósito (0 hasta la entrega). */
  quantity_issued: number
  /** Costo promedio con que salió (0 hasta la entrega). */
  unit_cost: number
}

/** Las horas de la orden en un centro de trabajo: previstas, con las tarifas de ese momento, y reales. */
export interface ProductionOrderOperation {
  id: string
  company_id: string
  document_id: string
  line_no: number
  work_center_id: string
  hours_planned: number
  labor_rate: number
  overhead_rate: number
  /** Las que registró Producción al terminarla. */
  hours_actual: number | null
}

/** Una factura (y cuánto de ella) que cancela un recibo de cobro. */
export interface CustomerReceiptLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  invoice_id: string
  amount: number
}

/** Un movimiento del mayor que figura en el extracto (tabla bank_reconciliation_lines). */
export interface BankReconciliationLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  journal_line_id: string
}

/** Cabecera común de todo comprobante (tabla `documents`) + detalle por tipo. */
export interface Document extends Audited {
  id: string
  company_id: string
  doc_type: DocType
  number: number
  display_number: string
  status: string
  document_date: string
  sector_id: string | null
  supplier_id: string | null
  customer_id: string | null
  subtotal: number
  tax_total: number
  total: number
  notes: string
  status_reason: string
  pr?: RequisitionHeader
  po?: PurchaseOrderHeader
  gr?: GoodsReceiptHeader
  sa?: StockAdjustmentHeader
  je?: JournalEntryHeader
  si?: SupplierInvoiceHeader
  op?: PaymentOrderHeader
  rq?: RfqHeader
  sq?: SupplierQuoteHeader
  ft?: FundsTransferHeader
  br?: BankReconciliationHeader
  so?: SalesOrderHeader
  dn?: DeliveryNoteHeader
  fv?: SalesInvoiceHeader
  rc?: CustomerReceiptHeader
  qt?: SalesQuoteHeader
  pd?: ProductionOrderHeader
  py?: PayrollHeader
}

export interface RequisitionLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  product_id: string
  quantity: number
  qty_ordered: number
  notes: string
}

export interface PurchaseOrderLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  product_id: string
  requisition_line_id: string | null
  quantity: number
  unit_price: number
  vat_rate: number
  line_subtotal: number
  line_tax: number
  line_total: number
  qty_received: number
}

export interface GoodsReceiptLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  po_line_id: string
  product_id: string
  quantity: number
  unit_cost: number
  notes: string
}

export interface StockAdjustmentLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  product_id: string
  quantity_delta: number
  unit_cost: number
  notes: string
}

export interface SupplierInvoiceLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  po_line_id: string
  product_id: string
  quantity: number
  unit_price: number
  vat_rate: number
  line_subtotal: number
  line_tax: number
  line_total: number
}

/** Una factura (y cuánto de ella) que cancela una orden de pago. */
export interface PaymentOrderLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  invoice_id: string
  amount: number
}

/** Un ítem del pedido de venta. Lo que falta entregar queda reservado mientras el pedido está en curso. */
export interface SalesOrderLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  product_id: string
  quantity: number
  /** Precio de venta del producto al cargar el pedido: la bonificación se mide contra él. */
  list_price: number
  unit_price: number
  vat_rate: number
  line_subtotal: number
  line_tax: number
  line_total: number
  qty_delivered: number
}

/** Un ítem del remito. */
export interface DeliveryNoteLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  so_line_id: string
  product_id: string
  quantity: number
  /** Costo unitario con que salió del depósito (el promedio al despacharlo); 0 en borrador y en los servicios. */
  unit_cost: number
  notes: string
}

/** Un ítem de la factura de venta: lo entregado de una línea del pedido, a su precio. */
export interface SalesInvoiceLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  so_line_id: string
  product_id: string
  quantity: number
  unit_price: number
  vat_rate: number
  line_subtotal: number
  line_tax: number
  line_total: number
}

/** Un ítem que se pide cotizar; puede atender una línea de solicitud de compra. */
export interface RfqLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  product_id: string
  quantity: number
  requisition_line_id: string | null
  notes: string
}

/** Un proveedor invitado a cotizar (tabla rfq_suppliers). */
export interface RfqSupplier {
  company_id: string
  document_id: string
  supplier_id: string
}

/** El precio que cotiza un proveedor para un ítem de la solicitud (la cantidad es la pedida). */
export interface SupplierQuoteLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  rfq_line_id: string
  product_id: string
  quantity: number
  unit_price: number
  vat_rate: number
  line_subtotal: number
  line_tax: number
  line_total: number
}

/** Regla de imputación automática: a qué cuenta va cada importe de un evento contable. */
export interface PostingRule {
  id: string
  company_id: string
  event: string
  key: string
  account_id: string
}

export interface JournalEntryLine {
  id: string
  company_id: string
  document_id: string
  line_no: number
  account_id: string
  debit: number
  credit: number
  notes: string
}

export type AccountType = 'ACTIVO' | 'PASIVO' | 'PATRIMONIO_NETO' | 'RESULTADO_POSITIVO' | 'RESULTADO_NEGATIVO'

export type BalanceSide = 'DEBE' | 'HABER'

/** Cuenta del plan de cuentas. Sólo el nivel 4 es imputable; los niveles 1 a 3 agrupan. */
export interface Account extends Audited {
  id: string
  company_id: string
  /** Jerárquico: 1 · 1.1 · 1.1.01 · 1.1.01.01 (clase, grupo, rubro y cuenta). */
  code: string
  name: string
  account_type: AccountType
  /** Lado en el que la cuenta tiene su saldo normal; al revés que su tipo en las regularizadoras. */
  normal_side: BalanceSide
  level: number
  is_imputable: boolean
  description: string
  is_active: boolean
}

export interface FiscalYear {
  id: string
  company_id: string
  name: string
  start_date: string
  end_date: string
  created_at: string
}

export interface FiscalPeriod {
  id: string
  company_id: string
  fiscal_year_id: string
  number: number
  name: string
  start_date: string
  end_date: string
  status: 'ABIERTO' | 'CERRADO'
  closed_by: string | null
  closed_at: string | null
}

export interface DocumentLink {
  company_id: string
  from_document_id: string
  to_document_id: string
  created_at: string
}

export interface StockMovement {
  id: number
  company_id: string
  product_id: string
  warehouse_id: string
  movement_type: MovementType
  quantity: number
  unit_cost: number
  total_cost: number
  balance_qty: number
  balance_avg_cost: number
  document_id: string | null
  document_line_id: string | null
  movement_date: string
  created_by: string | null
  created_at: string
}

export interface StockBalance {
  company_id: string
  product_id: string
  warehouse_id: string
  qty_on_hand: number
  avg_unit_cost: number
  last_movement_at: string | null
}

export interface ApprovalRule {
  id: string
  company_id: string
  doc_type: DocType
  level: number
  min_amount: number
  max_amount: number | null
  approver_role: RoleCode
  require_different_user: boolean
  description: string
  is_active: boolean
}

export interface ApprovalRequest {
  id: string
  company_id: string
  document_id: string
  rule_id: string
  level: number
  approver_role: RoleCode
  amount: number
  status: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | 'CANCELADO'
  requested_by: string
  requested_at: string
  decided_by: string | null
  decided_at: string | null
  comment: string
}

export type TaskStatus = 'PENDIENTE' | 'EN_CURSO' | 'RESUELTA' | 'CANCELADA'

export interface Task {
  id: string
  company_id: string
  document_id: string | null
  task_type: string
  title: string
  description: string
  origin_status: string | null
  context: Record<string, string>
  assigned_role: RoleCode | null
  assigned_user_id: string | null
  status: TaskStatus
  priority: Priority
  source: 'SISTEMA' | 'DOCENTE' | 'ESCENARIO'
  claimed_by: string | null
  claimed_at: string | null
  completed_by: string | null
  completed_at: string | null
  created_by: string | null
  created_at: string
}

export interface Notification {
  id: string
  company_id: string
  recipient_user_id: string
  type: string
  title: string
  body: string
  link_path: string
  document_id: string | null
  task_id: string | null
  read_at: string | null
  created_at: string
}

export interface AuditEvent {
  id: number
  company_id: string | null
  occurred_at: string
  actor_user_id: string | null
  actor_name: string
  actor_role_code: string
  actor_sector_name: string
  action: string
  entity_type: string
  entity_id: string | null
  entity_label: string
  document_id: string | null
  from_status: string | null
  to_status: string | null
  summary: string
  changes: Record<string, { from: unknown; to: unknown }> | null
}
