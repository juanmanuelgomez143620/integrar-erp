// Modelos de lectura. Con Supabase serán consultas con RLS y vistas
// `security_invoker`; la forma de los datos devueltos se mantiene.

import { DOC_STATUSES, DOC_TYPES, ROLES, TRANSITIONS, type StatusInfo } from '../domain/catalog'
import type * as T from '../domain/types'
import { money } from '../format'
import type { DB } from './db'
import {
  can,
  docPath,
  effectivePermissions,
  fail,
  fullName,
  getMember,
  getMemberRoles,
  getProfile,
  isInstanceAdmin,
  isSchoolAdmin,
  requirePermission,
} from './engine'

export type PublicProfile = Omit<T.Profile, 'password'>

const publicProfile = (p: T.Profile): PublicProfile => {
  const { password: _password, ...rest } = p
  return rest
}

const nameOf = (db: DB, userId: string | null) => fullName(getProfile(db, userId))

// ============================================================ Sesión y empresa

export interface MembershipSummary {
  company: T.Company
  roles: { role_code: T.RoleCode; role_name: string; sector_name: string; island: number | null }[]
}

export interface MeContext {
  user: PublicProfile
  school: T.SchoolSettings
  memberships: MembershipSummary[]
}

export function meContext(db: DB, userId: string): MeContext {
  const profile = getProfile(db, userId)
  if (!profile) throw new Error('Sesión inválida')
  const companies = isInstanceAdmin(profile)
    ? db.companies
    : db.companies.filter((c) => getMember(db, userId, c.id)?.is_active)
  return {
    user: publicProfile(profile),
    school: db.school,
    memberships: companies.map((company) => {
      const member = getMember(db, userId, company.id)
      const roles = member ? getMemberRoles(db, member.id) : []
      return {
        company,
        roles: roles.map((r) => {
          const sector = db.sectors.find((s) => s.id === r.sector_id)
          const island = db.islands.find((i) => i.id === sector?.island_id)
          return {
            role_code: r.role_code,
            role_name: ROLES[r.role_code].name,
            sector_name: sector?.name ?? '—',
            island: island?.number ?? null,
          }
        }),
      }
    }),
  }
}

export interface CompanyContext {
  company: T.Company
  course: T.Course | null
  sectors: T.Sector[]
  islands: T.Island[]
  warehouses: T.Warehouse[]
  modules: T.CompanyModule[]
  approval_rules: T.ApprovalRule[]
  roles: { id: string; role_code: T.RoleCode; sector_id: string | null; sector_name: string }[]
  permissions: string[]
  all: boolean
  supervisor: boolean
}

export function companyContext(db: DB, userId: string, slug: string): CompanyContext | null {
  const company = db.companies.find((c) => c.slug === slug)
  if (!company) return null
  const eff = effectivePermissions(db, userId, company.id)
  const member = getMember(db, userId, company.id)
  if (!eff.supervisor && !member?.is_active) return null
  const roles = member ? getMemberRoles(db, member.id) : []
  return {
    company,
    course: db.courses.find((c) => c.id === company.course_id) ?? null,
    sectors: db.sectors.filter((s) => s.company_id === company.id),
    islands: db.islands.filter((i) => i.company_id === company.id),
    warehouses: db.warehouses.filter((w) => w.company_id === company.id),
    modules: db.companyModules.filter((m) => m.company_id === company.id),
    approval_rules: db.approvalRules.filter((r) => r.company_id === company.id && r.is_active),
    roles: roles.map((r) => ({
      id: r.id,
      role_code: r.role_code,
      sector_id: r.sector_id,
      sector_name: db.sectors.find((s) => s.id === r.sector_id)?.name ?? '—',
    })),
    permissions: [...eff.perms],
    all: eff.all,
    supervisor: eff.supervisor,
  }
}

function assertPerm(db: DB, userId: string, companyId: string, perm: string) {
  if (!can(effectivePermissions(db, userId, companyId), perm)) throw new Error('Sin permiso de lectura')
}

// ============================================================ Maestros

export function listCustomers(db: DB, userId: string, companyId: string) {
  assertPerm(db, userId, companyId, 'customer.read')
  return db.customers.filter((c) => c.company_id === companyId).sort((a, b) => a.code.localeCompare(b.code))
}

export function listSuppliers(db: DB, userId: string, companyId: string) {
  assertPerm(db, userId, companyId, 'supplier.read')
  return db.suppliers.filter((c) => c.company_id === companyId).sort((a, b) => a.code.localeCompare(b.code))
}

export interface ProductRow extends T.Product {
  stock: number
  below_min: boolean
  avg_cost: number
  supplier_name: string
}

function stockOf(db: DB, productId: string) {
  const balances = db.stockBalances.filter((b) => b.product_id === productId)
  const qty = balances.reduce((s, b) => s + b.qty_on_hand, 0)
  const value = balances.reduce((s, b) => s + b.qty_on_hand * b.avg_unit_cost, 0)
  return { qty, avg: qty > 0 ? value / qty : (balances[0]?.avg_unit_cost ?? 0) }
}

function productRow(db: DB, p: T.Product): ProductRow {
  const s = stockOf(db, p.id)
  return {
    ...p,
    stock: s.qty,
    avg_cost: s.avg || p.standard_cost,
    below_min: p.is_stockable && p.min_stock > 0 && s.qty < p.min_stock,
    supplier_name: db.suppliers.find((x) => x.id === p.default_supplier_id)?.legal_name ?? '—',
  }
}

export function listProducts(db: DB, userId: string, companyId: string): ProductRow[] {
  assertPerm(db, userId, companyId, 'product.read')
  return db.products
    .filter((p) => p.company_id === companyId)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => productRow(db, p))
}

export interface KardexRow extends T.StockMovement {
  warehouse_name: string
  document_label: string | null
  document_path: string | null
  user_name: string
}

export interface ProductDetail {
  product: ProductRow
  balances: (T.StockBalance & { warehouse_name: string })[]
  kardex: KardexRow[]
}

export function productDetail(db: DB, userId: string, companyId: string, code: string): ProductDetail | null {
  assertPerm(db, userId, companyId, 'product.read')
  const p = db.products.find((x) => x.company_id === companyId && x.code === code)
  if (!p) return null
  const canStock = can(effectivePermissions(db, userId, companyId), 'stock.read')
  return {
    product: productRow(db, p),
    balances: canStock
      ? db.stockBalances
          .filter((b) => b.product_id === p.id)
          .map((b) => ({ ...b, warehouse_name: db.warehouses.find((w) => w.id === b.warehouse_id)?.name ?? '' }))
      : [],
    kardex: canStock
      ? db.stockMovements
          .filter((m) => m.product_id === p.id)
          .sort((a, b) => b.id - a.id)
          .map((m) => {
            const doc = db.documents.find((d) => d.id === m.document_id)
            return {
              ...m,
              warehouse_name: db.warehouses.find((w) => w.id === m.warehouse_id)?.code ?? '',
              document_label: doc?.display_number ?? null,
              document_path: doc ? docPath(db, doc) : null,
              user_name: nameOf(db, m.created_by),
            }
          })
      : [],
  }
}

export interface StockRow {
  product: T.Product
  warehouse: T.Warehouse
  qty: number
  avg_cost: number
  value: number
  total_qty: number
  below_min: boolean
}

export function listStock(db: DB, userId: string, companyId: string): StockRow[] {
  assertPerm(db, userId, companyId, 'stock.read')
  const rows: StockRow[] = []
  for (const p of db.products
    .filter((x) => x.company_id === companyId && x.is_stockable)
    .sort((a, b) => a.code.localeCompare(b.code))) {
    const total = stockOf(db, p.id).qty
    const balances = db.stockBalances.filter((b) => b.product_id === p.id)
    const list = balances.length
      ? balances
      : [{ warehouse_id: p.default_warehouse_id!, qty_on_hand: 0, avg_unit_cost: p.standard_cost } as T.StockBalance]
    for (const b of list) {
      const warehouse = db.warehouses.find((w) => w.id === b.warehouse_id)
      if (!warehouse) continue
      rows.push({
        product: p,
        warehouse,
        qty: b.qty_on_hand,
        avg_cost: b.avg_unit_cost,
        value: b.qty_on_hand * b.avg_unit_cost,
        total_qty: total,
        below_min: p.min_stock > 0 && total < p.min_stock,
      })
    }
  }
  return rows
}

// ============================================================ Documentos

export interface DocumentListItem extends T.Document {
  status_info: StatusInfo
  supplier_name: string
  sector_name: string
  created_by_name: string
  line_count: number
  summary: string
  pending_approver: string | null
  reference_label: string | null
  path: string
}

function readableDocTypes(db: DB, userId: string, companyId: string): T.DocType[] {
  const eff = effectivePermissions(db, userId, companyId)
  return (Object.keys(DOC_TYPES) as T.DocType[]).filter((t) => can(eff, `${DOC_TYPES[t].resource}.read`))
}

function lineCount(db: DB, doc: T.Document) {
  switch (doc.doc_type) {
    case 'PURCHASE_REQUISITION':
      return db.prLines.filter((l) => l.document_id === doc.id).length
    case 'PURCHASE_ORDER':
      return db.poLines.filter((l) => l.document_id === doc.id).length
    case 'GOODS_RECEIPT':
      return db.grLines.filter((l) => l.document_id === doc.id).length
    case 'STOCK_ADJUSTMENT':
      return db.saLines.filter((l) => l.document_id === doc.id).length
  }
}

function docLines(db: DB, doc: T.Document): { product_id: string }[] {
  switch (doc.doc_type) {
    case 'PURCHASE_REQUISITION':
      return db.prLines.filter((l) => l.document_id === doc.id)
    case 'PURCHASE_ORDER':
      return db.poLines.filter((l) => l.document_id === doc.id)
    case 'GOODS_RECEIPT':
      return db.grLines.filter((l) => l.document_id === doc.id)
    case 'STOCK_ADJUSTMENT':
      return db.saLines.filter((l) => l.document_id === doc.id)
  }
}

function listItem(db: DB, doc: T.Document): DocumentListItem {
  const products = docLines(db, doc)
    .map((l) => db.products.find((p) => p.id === l.product_id)?.code)
    .filter(Boolean)
  const pending = db.approvalRequests.find((a) => a.document_id === doc.id && a.status === 'PENDIENTE')
  const origins = db.docLinks
    .filter((l) => l.to_document_id === doc.id)
    .map((l) => db.documents.find((d) => d.id === l.from_document_id)?.display_number)
    .filter(Boolean)
  return {
    ...doc,
    status_info: DOC_STATUSES[doc.doc_type][doc.status],
    supplier_name: db.suppliers.find((s) => s.id === doc.supplier_id)?.legal_name ?? '',
    sector_name: db.sectors.find((s) => s.id === doc.sector_id)?.name ?? '—',
    created_by_name: nameOf(db, doc.created_by),
    line_count: lineCount(db, doc),
    summary: products.slice(0, 3).join(', ') + (products.length > 3 ? ` y ${products.length - 3} más` : ''),
    pending_approver: pending ? ROLES[pending.approver_role].name : null,
    reference_label: origins.length ? origins.join(', ') : null,
    path: docPath(db, doc),
  }
}

export function listDocuments(db: DB, userId: string, companyId: string, docType: T.DocType): DocumentListItem[] {
  assertPerm(db, userId, companyId, `${DOC_TYPES[docType].resource}.read`)
  return db.documents
    .filter((d) => d.company_id === companyId && d.doc_type === docType)
    .sort((a, b) => b.number - a.number)
    .map((d) => listItem(db, d))
}

export interface FlowNode {
  id: string
  doc_type: T.DocType
  display_number: string
  status_info: StatusInfo
  path: string
  current: boolean
  readable: boolean
  date: string
}

function documentFlow(db: DB, userId: string, doc: T.Document): FlowNode[] {
  const seen = new Set<string>([doc.id])
  const queue = [doc.id]
  while (queue.length) {
    const current = queue.shift()!
    for (const l of db.docLinks) {
      const next =
        l.from_document_id === current ? l.to_document_id : l.to_document_id === current ? l.from_document_id : null
      if (next && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  const readable = new Set(readableDocTypes(db, userId, doc.company_id))
  const order: T.DocType[] = ['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT']
  return db.documents
    .filter((d) => seen.has(d.id))
    .sort((a, b) => order.indexOf(a.doc_type) - order.indexOf(b.doc_type) || a.number - b.number)
    .map((d) => ({
      id: d.id,
      doc_type: d.doc_type,
      display_number: d.display_number,
      status_info: DOC_STATUSES[d.doc_type][d.status],
      path: docPath(db, d),
      current: d.id === doc.id,
      readable: readable.has(d.doc_type),
      date: d.created_at,
    }))
}

export interface AvailableAction {
  action: T.TransitionAction
  label: string
  help: string
  tone: 'default' | 'outline' | 'destructive'
  requires_comment: boolean
  enabled: boolean
  reason: string | null
}

function availableActions(db: DB, userId: string, doc: T.Document): AvailableAction[] {
  const eff = effectivePermissions(db, userId, doc.company_id)
  const company = db.companies.find((c) => c.id === doc.company_id)!
  const result: AvailableAction[] = []
  for (const tr of TRANSITIONS.filter(
    (t) => t.docType === doc.doc_type && t.from === doc.status && t.action !== 'SYSTEM',
  )) {
    if (!tr.permission || !can(eff, tr.permission)) continue
    let reason: string | null = null
    if (doc.doc_type === 'PURCHASE_ORDER' && (tr.action === 'APPROVE' || tr.action === 'REJECT')) {
      const req = db.approvalRequests.find((a) => a.document_id === doc.id && a.status === 'PENDIENTE')
      if (req && !eff.supervisor && !eff.roles.includes(req.approver_role)) {
        reason = `Por el monto (${money(req.amount)}) la aprueba ${ROLES[req.approver_role].name}.`
      } else if (!eff.supervisor && company.settings.sod_enabled && doc.created_by === userId) {
        reason = 'Separación de funciones: no podés aprobar ni rechazar una orden que creaste vos.'
      }
    }
    if (doc.doc_type === 'PURCHASE_ORDER' && tr.action === 'WITHDRAW' && !eff.supervisor && doc.created_by !== userId) {
      reason = 'Sólo quien creó la orden puede retirarla.'
    }
    if (
      doc.doc_type === 'PURCHASE_ORDER' &&
      tr.action === 'CANCEL' &&
      db.poLines.some((l) => l.document_id === doc.id && l.qty_received > 0)
    ) {
      reason = 'Tiene recepciones: usá "Cerrar saldo".'
    }
    if (
      doc.doc_type === 'PURCHASE_REQUISITION' &&
      (tr.action === 'SUBMIT' || tr.action === 'CANCEL') &&
      !eff.supervisor &&
      doc.created_by !== userId
    ) {
      const member = getMember(db, userId, doc.company_id)
      const sectors = member ? getMemberRoles(db, member.id).map((r) => r.sector_id) : []
      if (!doc.sector_id || !sectors.includes(doc.sector_id)) reason = 'Sólo el sector solicitante puede hacerlo.'
    }
    if (
      doc.doc_type === 'GOODS_RECEIPT' &&
      doc.status === 'CONFIRMADO' &&
      tr.action === 'CANCEL' &&
      company.settings.sod_enabled &&
      !eff.supervisor &&
      !eff.roles.includes('GERENCIA') &&
      doc.created_by === userId
    ) {
      reason = 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularla.'
    }
    result.push({
      action: tr.action,
      label: tr.label,
      help: tr.help,
      tone: tr.tone,
      requires_comment: tr.requiresComment,
      enabled: !reason,
      reason,
    })
  }
  return result
}

function nextStep(db: DB, doc: T.Document): { who: string; text: string } {
  const sector = db.sectors.find((s) => s.id === doc.sector_id)?.name ?? 'el sector solicitante'
  switch (`${doc.doc_type}:${doc.status}`) {
    case 'PURCHASE_REQUISITION:BORRADOR':
      return { who: sector, text: 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.' }
    case 'PURCHASE_REQUISITION:SOLICITADO':
      return {
        who: 'Compras',
        text: 'Debe incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.',
      }
    case 'PURCHASE_REQUISITION:ORDENADO_PARCIAL':
      return { who: 'Compras', text: 'Resta ordenar el saldo pendiente o cerrarlo con motivo.' }
    case 'PURCHASE_REQUISITION:ORDENADO':
      return {
        who: 'Compras y Depósito',
        text: 'La necesidad ya está cubierta por órdenes de compra. Seguí su avance en "Flujo documental".',
      }
    case 'PURCHASE_ORDER:BORRADOR':
      return {
        who: 'Compras',
        text: 'Revisar proveedor, precios, cantidades y fecha de entrega, y enviar la orden a aprobación.',
      }
    case 'PURCHASE_ORDER:PENDIENTE_APROBACION': {
      const req = db.approvalRequests.find((a) => a.document_id === doc.id && a.status === 'PENDIENTE')
      const rule = db.approvalRules.find((r) => r.id === req?.rule_id)
      return {
        who: req ? ROLES[req.approver_role].name : 'Aprobador',
        text: `${rule?.description ?? ''} Quien creó la orden no puede aprobarla: es un control de separación de funciones.`.trim(),
      }
    }
    case 'PURCHASE_ORDER:RECHAZADO':
      return {
        who: 'Compras',
        text: `Motivo del rechazo: "${doc.status_reason}". Reabrir, corregir y reenviar, o anular la orden.`,
      }
    case 'PURCHASE_ORDER:APROBADO':
      return {
        who: 'Compras',
        text: 'Comunicar la orden al proveedor (imprimirla o enviarla) y marcarla como enviada.',
      }
    case 'PURCHASE_ORDER:ENVIADO':
      return {
        who: 'Depósito',
        text: 'Cuando llegue la mercadería, controlarla contra esta orden y el remito del proveedor, y registrar la recepción.',
      }
    case 'PURCHASE_ORDER:RECIBIDO_PARCIAL':
      return {
        who: 'Depósito o Compras',
        text: 'Falta recibir el saldo. Si no va a llegar, Compras puede cerrar el saldo con motivo.',
      }
    case 'PURCHASE_ORDER:RECIBIDO':
      return {
        who: 'Próxima fase',
        text: 'Circuito de compra completo. En la Fase 3 continuará con la factura del proveedor, el pago y el asiento contable.',
      }
    case 'GOODS_RECEIPT:BORRADOR':
      return {
        who: 'Depósito',
        text: 'Revisar cantidades contra el remito y confirmar la recepción para que ingrese al stock.',
      }
    case 'GOODS_RECEIPT:CONFIRMADO':
      return {
        who: '—',
        text: 'La mercadería ingresó al stock (ver kardex). Compras y el solicitante fueron notificados.',
      }
    case 'STOCK_ADJUSTMENT:BORRADOR':
      return { who: 'Depósito', text: 'Revisar y confirmar el ajuste.' }
    case 'STOCK_ADJUSTMENT:CONFIRMADO':
      return { who: '—', text: 'El ajuste impactó en el stock y quedó documentado.' }
    default:
      return { who: '—', text: DOC_STATUSES[doc.doc_type][doc.status]?.description ?? '' }
  }
}

export interface DetailLine {
  id: string
  line_no: number
  product: T.Product
  quantity: number
  notes: string
  // SC
  qty_ordered?: number
  // OC
  unit_price?: number
  vat_rate?: number
  line_subtotal?: number
  line_tax?: number
  line_total?: number
  qty_received?: number
  requisition_label?: string | null
  requisition_line_id?: string | null
  /** Máximo que esta línea puede pedir de su solicitud (pendiente + lo ya pedido acá). */
  requisition_max?: number | null
  // REC
  po_line_id?: string
  qty_ordered_po?: number
  unit_cost?: number
}

export interface ApprovalView extends T.ApprovalRequest {
  approver_role_name: string
  decided_by_name: string
  requested_by_name: string
}

export interface DocumentDetail {
  doc: DocumentListItem
  lines: DetailLine[]
  supplier: T.Supplier | null
  warehouse: T.Warehouse | null
  related_order: DocumentListItem | null
  approvals: ApprovalView[]
  flow: FlowNode[]
  history: T.AuditEvent[]
  actions: AvailableAction[]
  next_step: { who: string; text: string }
  signatures: { label: string; name: string; sector: string; at: string }[]
}

export function documentDetail(
  db: DB,
  userId: string,
  companyId: string,
  docType: T.DocType,
  displayNumber: string,
): DocumentDetail | null {
  assertPerm(db, userId, companyId, `${DOC_TYPES[docType].resource}.read`)
  const doc = db.documents.find(
    (d) => d.company_id === companyId && d.doc_type === docType && d.display_number === displayNumber,
  )
  if (!doc) return null
  return buildDetail(db, userId, doc)
}

export function documentDetailById(db: DB, userId: string, docId: string): DocumentDetail | null {
  const doc = db.documents.find((d) => d.id === docId)
  if (!doc) return null
  assertPerm(db, userId, doc.company_id, `${DOC_TYPES[doc.doc_type].resource}.read`)
  return buildDetail(db, userId, doc)
}

function buildDetail(db: DB, userId: string, doc: T.Document): DocumentDetail {
  const product = (id: string) => db.products.find((p) => p.id === id)!
  let lines: DetailLine[] = []
  if (doc.doc_type === 'PURCHASE_REQUISITION') {
    lines = db.prLines
      .filter((l) => l.document_id === doc.id)
      .map((l) => ({
        id: l.id,
        line_no: l.line_no,
        product: product(l.product_id),
        quantity: l.quantity,
        notes: l.notes,
        qty_ordered: l.qty_ordered,
      }))
  }
  if (doc.doc_type === 'PURCHASE_ORDER') {
    lines = db.poLines
      .filter((l) => l.document_id === doc.id)
      .map((l) => {
        const rl = db.prLines.find((x) => x.id === l.requisition_line_id)
        const req = rl ? db.documents.find((d) => d.id === rl.document_id) : null
        return {
          id: l.id,
          line_no: l.line_no,
          product: product(l.product_id),
          quantity: l.quantity,
          notes: '',
          unit_price: l.unit_price,
          vat_rate: l.vat_rate,
          line_subtotal: l.line_subtotal,
          line_tax: l.line_tax,
          line_total: l.line_total,
          qty_received: l.qty_received,
          requisition_label: req?.display_number ?? null,
          requisition_line_id: l.requisition_line_id,
          requisition_max: rl ? rl.quantity - rl.qty_ordered + l.quantity : null,
        }
      })
  }
  if (doc.doc_type === 'GOODS_RECEIPT') {
    lines = db.grLines
      .filter((l) => l.document_id === doc.id)
      .map((l) => {
        const pl = db.poLines.find((x) => x.id === l.po_line_id)
        return {
          id: l.id,
          line_no: l.line_no,
          product: product(l.product_id),
          quantity: l.quantity,
          notes: l.notes,
          po_line_id: l.po_line_id,
          qty_ordered_po: pl?.quantity,
          qty_received: pl?.qty_received,
          unit_cost: l.unit_cost,
        }
      })
  }
  if (doc.doc_type === 'STOCK_ADJUSTMENT') {
    lines = db.saLines
      .filter((l) => l.document_id === doc.id)
      .map((l) => ({
        id: l.id,
        line_no: l.line_no,
        product: product(l.product_id),
        quantity: l.quantity_delta,
        notes: l.notes,
        unit_cost: l.unit_cost,
      }))
  }
  const warehouseId = doc.po?.warehouse_id ?? doc.gr?.warehouse_id ?? doc.sa?.warehouse_id
  const relatedOrder = doc.gr ? db.documents.find((d) => d.id === doc.gr!.purchase_order_id) : undefined
  const history = db.audit.filter((e) => e.document_id === doc.id).sort((a, b) => a.id - b.id)
  const firstBy = (actions: string[]) => {
    const e = [...history].reverse().find((h) => actions.includes(h.action))
    return e ? { name: e.actor_name, sector: e.actor_sector_name, at: e.occurred_at } : { name: '', sector: '', at: '' }
  }
  const signatures =
    doc.doc_type === 'PURCHASE_REQUISITION'
      ? [
          { label: 'Solicitó', ...firstBy(['SUBMIT', 'CREATE']) },
          { label: 'Atendió (Compras)', ...firstBy(['SYSTEM']) },
        ]
      : doc.doc_type === 'PURCHASE_ORDER'
        ? [
            { label: 'Emitió', ...firstBy(['SUBMIT', 'CREATE']) },
            { label: 'Autorizó', ...firstBy(['APPROVE']) },
          ]
        : [
            { label: 'Recibió / registró', ...firstBy(['CONFIRM', 'CREATE']) },
            { label: 'Controló', name: '', sector: '', at: '' },
          ]
  return {
    doc: listItem(db, doc),
    lines,
    supplier: db.suppliers.find((s) => s.id === doc.supplier_id) ?? null,
    warehouse: db.warehouses.find((w) => w.id === warehouseId) ?? null,
    related_order: relatedOrder ? listItem(db, relatedOrder) : null,
    approvals: db.approvalRequests
      .filter((a) => a.document_id === doc.id)
      .map((a) => ({
        ...a,
        approver_role_name: ROLES[a.approver_role].name,
        decided_by_name: a.decided_by ? nameOf(db, a.decided_by) : '',
        requested_by_name: nameOf(db, a.requested_by),
      })),
    flow: documentFlow(db, userId, doc),
    history,
    actions: availableActions(db, userId, doc),
    next_step: nextStep(db, doc),
    signatures,
  }
}

// ============================================================ Insumos para crear documentos

export interface PendingRequisitionLine {
  line: T.RequisitionLine
  pending: number
  requisition: DocumentListItem
  product: T.Product
}

export function pendingRequisitionLines(db: DB, userId: string, companyId: string): PendingRequisitionLine[] {
  assertPerm(db, userId, companyId, 'purchase_requisition.read')
  const result: PendingRequisitionLine[] = []
  for (const doc of db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'PURCHASE_REQUISITION' &&
        ['SOLICITADO', 'ORDENADO_PARCIAL'].includes(d.status),
    )
    .sort((a, b) => a.number - b.number)) {
    const item = listItem(db, doc)
    for (const line of db.prLines.filter((l) => l.document_id === doc.id)) {
      const pending = line.quantity - line.qty_ordered
      if (pending > 1e-9)
        result.push({ line, pending, requisition: item, product: db.products.find((p) => p.id === line.product_id)! })
    }
  }
  return result
}

export interface ReceivableOrder {
  order: DocumentListItem
  lines: { line: T.PurchaseOrderLine; product: T.Product; pending: number }[]
}

export function receivableOrders(db: DB, userId: string, companyId: string): ReceivableOrder[] {
  assertPerm(db, userId, companyId, 'purchase_order.read')
  return db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'PURCHASE_ORDER' &&
        ['ENVIADO', 'RECIBIDO_PARCIAL'].includes(d.status),
    )
    .sort((a, b) => a.number - b.number)
    .map((d) => ({
      order: listItem(db, d),
      lines: db.poLines
        .filter((l) => l.document_id === d.id)
        .map((l) => ({
          line: l,
          product: db.products.find((p) => p.id === l.product_id)!,
          pending: l.quantity - l.qty_received,
        }))
        .filter((x) => x.pending > 1e-9),
    }))
}

// ============================================================ Tareas y notificaciones

export interface TaskItem extends T.Task {
  document_label: string | null
  document_type: T.DocType | null
  path: string | null
  assignee_label: string
  claimed_by_name: string | null
  completed_by_name: string | null
  mine: boolean
}

export function listTasks(
  db: DB,
  userId: string,
  companyId: string,
  scope: 'mine' | 'all',
  includeClosed = false,
): TaskItem[] {
  const eff = effectivePermissions(db, userId, companyId)
  const canAll = eff.all || eff.perms.has('task.read')
  const company = db.companies.find((c) => c.id === companyId)!
  return db.tasks
    .filter((t) => t.company_id === companyId)
    .filter((t) => includeClosed || t.status === 'PENDIENTE' || t.status === 'EN_CURSO')
    .map((t) => {
      const mine = t.assigned_user_id === userId || (!!t.assigned_role && eff.roles.includes(t.assigned_role))
      return { t, mine }
    })
    .filter(({ mine }) => mine || (scope === 'all' && canAll))
    .sort((a, b) =>
      a.t.status === b.t.status ? b.t.created_at.localeCompare(a.t.created_at) : a.t.status === 'EN_CURSO' ? -1 : 1,
    )
    .map(({ t, mine }) => {
      const doc = db.documents.find((d) => d.id === t.document_id)
      return {
        ...t,
        mine,
        document_label: doc?.display_number ?? null,
        document_type: doc?.doc_type ?? null,
        path: doc ? docPath(db, doc) : t.task_type === 'REPONER_STOCK' ? `/e/${company.slug}/stock` : null,
        assignee_label: t.assigned_user_id
          ? nameOf(db, t.assigned_user_id)
          : t.assigned_role
            ? ROLES[t.assigned_role].name
            : '—',
        claimed_by_name: t.claimed_by ? nameOf(db, t.claimed_by) : null,
        completed_by_name: t.completed_by ? nameOf(db, t.completed_by) : null,
      }
    })
}

/** Avisos del usuario en la empresa, del más nuevo al más viejo. Con `limit: null`, el historial completo. */
export function listNotifications(db: DB, userId: string, companyId: string, limit: number | null = 60) {
  const rows = db.notifications
    .filter((n) => n.company_id === companyId && n.recipient_user_id === userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  return limit === null ? rows : rows.slice(0, limit)
}

// ============================================================ Auditoría

export function listAudit(db: DB, userId: string, companyId: string): T.AuditEvent[] {
  const eff = effectivePermissions(db, userId, companyId)
  const all = can(eff, 'audit.read')
  const readable = new Set(readableDocTypes(db, userId, companyId))
  return db.audit
    .filter((e) => e.company_id === companyId)
    .filter((e) => {
      if (all || e.actor_user_id === userId) return true
      const doc = e.document_id ? db.documents.find((d) => d.id === e.document_id) : null
      return !!doc && readable.has(doc.doc_type)
    })
    .sort((a, b) => b.id - a.id)
}

// ============================================================ Exportaciones

/**
 * Exportar tiene permiso propio (`*.export`, docs/ROLES_Y_PERMISOS.md): un
 * rol puede consultar un listado sin poder descargarlo completo (por
 * ejemplo, Producción ve el stock pero no lo exporta). Se valida acá, no
 * sólo ocultando el botón. Con Supabase serán funciones RPC que validan el
 * permiso antes de devolver las filas; la interfaz sólo arma el archivo.
 */
function requireExport(db: DB, userId: string, companyId: string, permission: string) {
  requirePermission({ db, userId, now: new Date().toISOString() }, companyId, permission)
}

export function exportCustomers(db: DB, userId: string, companyId: string) {
  requireExport(db, userId, companyId, 'customer.export')
  return listCustomers(db, userId, companyId)
}

export function exportSuppliers(db: DB, userId: string, companyId: string) {
  requireExport(db, userId, companyId, 'supplier.export')
  return listSuppliers(db, userId, companyId)
}

export function exportProducts(db: DB, userId: string, companyId: string) {
  requireExport(db, userId, companyId, 'product.export')
  return listProducts(db, userId, companyId)
}

export function exportStock(db: DB, userId: string, companyId: string) {
  requireExport(db, userId, companyId, 'stock.export')
  return listStock(db, userId, companyId)
}

export function exportAudit(db: DB, userId: string, companyId: string) {
  requireExport(db, userId, companyId, 'audit.export')
  return listAudit(db, userId, companyId)
}

// ============================================================ Tablero

export interface Dashboard {
  kpis: {
    pr_pending: number
    po_pending_approval: number
    po_pending_amount: number
    po_in_transit: number
    below_min: number
    inventory_value: number | null
    purchases_month: number
    my_tasks: number
  }
  po_by_status: { status: string; label: string; badge: T.Badge; count: number }[]
  low_stock: { code: string; name: string; qty: number; min: number; uom: string }[]
  activity: T.AuditEvent[]
  tasks: TaskItem[]
  lead_time_hours: number | null
  can: { purchasing: boolean; stock: boolean; audit: boolean }
}

export function dashboard(db: DB, userId: string, companyId: string): Dashboard {
  const eff = effectivePermissions(db, userId, companyId)
  const docs = db.documents.filter((d) => d.company_id === companyId)
  const pos = docs.filter((d) => d.doc_type === 'PURCHASE_ORDER')
  const month = new Date().toISOString().slice(0, 7)
  const canPurchasing = can(eff, 'purchase_order.read')
  const canStock = can(eff, 'stock.read')
  const lowStock = db.products
    .filter((p) => p.company_id === companyId && p.is_stockable && p.min_stock > 0)
    .map((p) => ({ p, qty: stockOf(db, p.id).qty }))
    .filter(({ p, qty }) => qty < p.min_stock)
    .map(({ p, qty }) => ({ code: p.code, name: p.name, qty, min: p.min_stock, uom: p.uom_code }))
  const receipts = docs.filter((d) => d.doc_type === 'GOODS_RECEIPT' && d.status === 'CONFIRMADO' && d.gr?.received_at)
  const leadTimes: number[] = []
  for (const gr of receipts) {
    const poId = gr.gr!.purchase_order_id
    const prIds = db.docLinks.filter((l) => l.to_document_id === poId).map((l) => l.from_document_id)
    for (const prId of prIds) {
      const pr = docs.find((d) => d.id === prId)
      if (pr) leadTimes.push((new Date(gr.gr!.received_at!).getTime() - new Date(pr.created_at).getTime()) / 3_600_000)
    }
  }
  const tasks = listTasks(db, userId, companyId, 'mine')
  const statusOrder = Object.keys(DOC_STATUSES.PURCHASE_ORDER)
  return {
    kpis: {
      pr_pending: docs.filter(
        (d) => d.doc_type === 'PURCHASE_REQUISITION' && ['SOLICITADO', 'ORDENADO_PARCIAL'].includes(d.status),
      ).length,
      po_pending_approval: pos.filter((d) => d.status === 'PENDIENTE_APROBACION').length,
      po_pending_amount: pos.filter((d) => d.status === 'PENDIENTE_APROBACION').reduce((s, d) => s + d.total, 0),
      po_in_transit: pos.filter((d) => ['ENVIADO', 'RECIBIDO_PARCIAL'].includes(d.status)).length,
      below_min: lowStock.length,
      inventory_value: canStock
        ? db.stockBalances
            .filter((b) => b.company_id === companyId)
            .reduce((s, b) => s + b.qty_on_hand * b.avg_unit_cost, 0)
        : null,
      purchases_month: pos
        .filter((d) => d.po?.approved_at?.startsWith(month) && d.status !== 'ANULADO')
        .reduce((s, d) => s + d.total, 0),
      my_tasks: tasks.length,
    },
    po_by_status: statusOrder
      .map((status) => ({
        status,
        label: DOC_STATUSES.PURCHASE_ORDER[status].label,
        badge: DOC_STATUSES.PURCHASE_ORDER[status].badge,
        count: pos.filter((d) => d.status === status).length,
      }))
      .filter((x) => x.count > 0),
    low_stock: canStock ? lowStock : [],
    activity: listAudit(db, userId, companyId).slice(0, 8),
    tasks: tasks.slice(0, 6),
    lead_time_hours: leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null,
    can: { purchasing: canPurchasing, stock: canStock, audit: can(eff, 'audit.read') },
  }
}

// ============================================================ Panel docente

export interface MemberView {
  user: PublicProfile
  member_id: string | null
  job_title: string
  roles: {
    id: string
    role_code: T.RoleCode
    role_name: string
    sector_id: string | null
    sector_name: string
    island: number | null
  }[]
  last_activity: string | null
  actions_count: number
}

export function listMembers(db: DB, userId: string, companyId: string): MemberView[] {
  const eff = effectivePermissions(db, userId, companyId)
  if (!eff.supervisor) throw new Error('Sólo docentes')
  const members = db.members.filter((m) => m.company_id === companyId)
  return members
    .map((m) => {
      const profile = getProfile(db, m.user_id)!
      const events = db.audit.filter((e) => e.company_id === companyId && e.actor_user_id === m.user_id)
      return {
        user: publicProfile(profile),
        member_id: m.id,
        job_title: m.job_title,
        roles: getMemberRoles(db, m.id).map((r) => {
          const sector = db.sectors.find((s) => s.id === r.sector_id)
          return {
            id: r.id,
            role_code: r.role_code,
            role_name: ROLES[r.role_code].name,
            sector_id: r.sector_id,
            sector_name: sector?.name ?? '—',
            island: db.islands.find((i) => i.id === sector?.island_id)?.number ?? null,
          }
        }),
        last_activity: events.length ? events[events.length - 1].occurred_at : null,
        actions_count: events.length,
      }
    })
    .sort(
      (a, b) =>
        (a.roles[0]?.island ?? 99) - (b.roles[0]?.island ?? 99) || a.user.last_name.localeCompare(b.user.last_name),
    )
}

export function demoUsers(db: DB) {
  return db.profiles
    .filter((p) => p.is_active)
    .map((p) => {
      const member = db.members.find((m) => m.user_id === p.id)
      const roles = member ? getMemberRoles(db, member.id) : []
      const sector = db.sectors.find((s) => s.id === roles[0]?.sector_id)
      const island = db.islands.find((i) => i.id === sector?.island_id)
      return {
        username: p.username,
        name: fullName(p),
        app_role: p.app_role,
        role_label: roles.length
          ? roles.map((r) => ROLES[r.role_code].name).join(' + ')
          : p.app_role === 'ADMIN'
            ? 'Administración escolar'
            : p.app_role,
        island: island?.number ?? null,
      }
    })
    .sort((a, b) => (a.island ?? (a.app_role === 'ADMIN' ? -2 : -1)) - (b.island ?? (b.app_role === 'ADMIN' ? -2 : -1)))
}

// ============================================================ Administración de la escuela

/**
 * Lo único de la escuela que se muestra antes de ingresar (pantalla de
 * ingreso). Con Supabase: función pública que devuelve sólo estos campos,
 * nunca la fila completa de school_settings.
 */
export function publicSchoolInfo(db: DB): Pick<T.SchoolSettings, 'official_name' | 'short_name'> {
  return { official_name: db.school.official_name, short_name: db.school.short_name }
}

function requireSchoolAdminRead(db: DB, userId: string) {
  if (!isSchoolAdmin(getProfile(db, userId)))
    fail('SIN_PERMISO', 'Sólo la administración de la escuela puede ver esto.')
}

export function listCourses(db: DB, userId: string): T.Course[] {
  requireSchoolAdminRead(db, userId)
  return [...db.courses].sort((a, b) => b.academic_year - a.academic_year || a.name.localeCompare(b.name))
}

export function listTeachers(db: DB, userId: string): PublicProfile[] {
  requireSchoolAdminRead(db, userId)
  return db.profiles
    .filter((p) => p.app_role === 'DOCENTE')
    .map(publicProfile)
    .sort((a, b) => a.last_name.localeCompare(b.last_name))
}
