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

export type ModuleCode = 'core' | 'masters' | 'purchasing' | 'inventory' | 'management' | 'audit'

export type PermissionAction = 'read' | 'create' | 'update' | 'approve' | 'cancel' | 'delete' | 'export'

export type VatCondition = 'RESPONSABLE_INSCRIPTO' | 'MONOTRIBUTO' | 'EXENTO' | 'CONSUMIDOR_FINAL'

export type ProductType = 'MATERIA_PRIMA' | 'INSUMO' | 'PRODUCTO_TERMINADO' | 'MERCADERIA_REVENTA' | 'SERVICIO'

export type DocType = 'PURCHASE_REQUISITION' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT' | 'STOCK_ADJUSTMENT'

export type TransitionAction =
  'SUBMIT' | 'APPROVE' | 'REJECT' | 'WITHDRAW' | 'REOPEN' | 'SEND' | 'CONFIRM' | 'CANCEL' | 'CLOSE' | 'SYSTEM'

export type Badge = 'neutral' | 'info' | 'warning' | 'success' | 'danger'

export type MovementType =
  'STOCK_INICIAL' | 'RECEPCION_COMPRA' | 'ANULACION_RECEPCION' | 'AJUSTE_POSITIVO' | 'AJUSTE_NEGATIVO'

export type AdjustmentReason = 'INVENTARIO_INICIAL' | 'CONTEO_FISICO' | 'ROTURA' | 'CONSUMO_INTERNO' | 'OTRO'

export type Priority = 'BAJA' | 'NORMAL' | 'ALTA' | 'URGENTE'

export interface SchoolSettings {
  official_name: string
  short_name: string
  city: string
  province: string
  features: Record<string, boolean>
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
  qty_reserved: number
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
