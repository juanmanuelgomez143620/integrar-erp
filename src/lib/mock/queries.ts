// Modelos de lectura. Con Supabase serán consultas con RLS y vistas
// `security_invoker`; la forma de los datos devueltos se mantiene.

import {
  DOC_STATUSES,
  DOC_TYPES,
  MODULES,
  POSTING_EVENTS,
  ROLES,
  TRANSITIONS,
  type StatusInfo,
} from '../domain/catalog'
import { TREASURY_RUBRO } from '../domain/chart-of-accounts'
import type * as T from '../domain/types'
import { date, money, todayAR } from '../format'
import type { DB } from './db'
import {
  accountBalance,
  accountLabel,
  bestQuote,
  can,
  docPath,
  effectivePermissions,
  fail,
  fullName,
  getMember,
  getMemberRoles,
  getProfile,
  INVOICED_STATUSES,
  invoiceCommitted,
  invoicedQuantity,
  invoicePaid,
  invoiceRegistrant,
  isInstanceAdmin,
  isPosted,
  isSchoolAdmin,
  orderFromQuote,
  quoteIsValid,
  quotesOf,
  requirePermission,
  requisitionAvailableQuantity,
  rfqLinesOf,
  round2,
  round3,
} from './engine'

export type PublicProfile = Omit<T.Profile, 'password'>

const publicProfile = (p: T.Profile): PublicProfile => {
  const { password: _password, ...rest } = p
  return rest
}

const nameOf = (db: DB, userId: string | null) => fullName(getProfile(db, userId))

// Los listados tienen órdenes explícitos (nunca el de carga) para que la base
// devuelva exactamente lo mismo (supabase/tests/reads.test.ts).

/** Códigos (MP-001, PRV-010…) en orden de bytes, igual que `order by code collate "C"` en la base. */
const compareCodes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Nombres sin distinguir mayúsculas ni acentos; en la base, private.sort_key(). */
const textKey = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
const compareText = (a: string, b: string) => compareCodes(textKey(a), textKey(b))
const compareNames = (a: PublicProfile, b: PublicProfile) =>
  compareText(a.last_name, b.last_name) ||
  compareText(a.first_name, b.first_name) ||
  compareCodes(a.username, b.username)

const byLineNo = <L extends { line_no: number }>(a: L, b: L) => a.line_no - b.line_no

// ============================================================ Sesión y empresa

export interface MembershipSummary {
  company: T.Company
  /** Para distinguir las empresas de cada curso (todas nacen de la misma plantilla). */
  course: T.Course | null
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
        course: db.courses.find((c) => c.id === company.course_id) ?? null,
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
  const islands = db.islands.filter((i) => i.company_id === company.id).sort((a, b) => a.number - b.number)
  const islandOf = (s: T.Sector) => islands.find((i) => i.id === s.island_id)?.number ?? Infinity
  const moduleOrder = Object.keys(MODULES)
  // Órdenes explícitos (no el de carga): la base devuelve exactamente los mismos.
  return {
    company,
    course: db.courses.find((c) => c.id === company.course_id) ?? null,
    sectors: db.sectors
      .filter((s) => s.company_id === company.id)
      .sort((a, b) => islandOf(a) - islandOf(b) || compareCodes(a.code, b.code)),
    islands,
    warehouses: db.warehouses.filter((w) => w.company_id === company.id).sort((a, b) => compareCodes(a.code, b.code)),
    modules: db.companyModules
      .filter((m) => m.company_id === company.id)
      .sort((a, b) => moduleOrder.indexOf(a.module_code) - moduleOrder.indexOf(b.module_code)),
    approval_rules: db.approvalRules
      .filter((r) => r.company_id === company.id && r.is_active)
      .sort((a, b) => a.min_amount - b.min_amount),
    roles: roles.map((r) => ({
      id: r.id,
      role_code: r.role_code,
      sector_id: r.sector_id,
      sector_name: db.sectors.find((s) => s.id === r.sector_id)?.name ?? '—',
    })),
    permissions: [...eff.perms].sort(compareCodes),
    all: eff.all,
    supervisor: eff.supervisor,
  }
}

function assertPerm(db: DB, userId: string, companyId: string, perm: string) {
  if (!can(effectivePermissions(db, userId, companyId), perm))
    throw new Error('Tu rol no tiene acceso a esta información.')
}

// ============================================================ Maestros

export function listCustomers(db: DB, userId: string, companyId: string) {
  assertPerm(db, userId, companyId, 'customer.read')
  return db.customers.filter((c) => c.company_id === companyId).sort((a, b) => compareCodes(a.code, b.code))
}

export function listSuppliers(db: DB, userId: string, companyId: string) {
  assertPerm(db, userId, companyId, 'supplier.read')
  return db.suppliers.filter((c) => c.company_id === companyId).sort((a, b) => compareCodes(a.code, b.code))
}

export interface ProductRow extends T.Product {
  stock: number | null
  below_min: boolean
  avg_cost: number | null
  supplier_name: string
}

/** Saldos de un producto por depósito, en orden de código de depósito. */
function balancesOf(db: DB, productId: string) {
  const code = (b: T.StockBalance) => db.warehouses.find((w) => w.id === b.warehouse_id)?.code ?? ''
  return db.stockBalances.filter((b) => b.product_id === productId).sort((a, b) => compareCodes(code(a), code(b)))
}

function stockOf(db: DB, productId: string) {
  const balances = balancesOf(db, productId)
  const qty = balances.reduce((s, b) => s + b.qty_on_hand, 0)
  const value = balances.reduce((s, b) => s + b.qty_on_hand * b.avg_unit_cost, 0)
  return { qty, avg: qty > 0 ? value / qty : (balances[0]?.avg_unit_cost ?? null) }
}

function productRow(db: DB, p: T.Product, canStock: boolean): ProductRow {
  const s = stockOf(db, p.id)
  return {
    ...p,
    stock: canStock ? s.qty : null,
    avg_cost: canStock ? (s.avg ?? p.standard_cost) : null,
    below_min: canStock && p.is_active && p.is_stockable && p.min_stock > 0 && s.qty < p.min_stock,
    supplier_name: db.suppliers.find((x) => x.id === p.default_supplier_id)?.legal_name ?? '—',
  }
}

export function listProducts(db: DB, userId: string, companyId: string): ProductRow[] {
  assertPerm(db, userId, companyId, 'product.read')
  const canStock = can(effectivePermissions(db, userId, companyId), 'stock.read')
  return db.products
    .filter((p) => p.company_id === companyId)
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((p) => productRow(db, p, canStock))
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
    product: productRow(db, p, canStock),
    balances: canStock
      ? balancesOf(db, p.id).map((b) => ({
          ...b,
          warehouse_name: db.warehouses.find((w) => w.id === b.warehouse_id)?.name ?? '',
        }))
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
    .sort((a, b) => compareCodes(a.code, b.code))) {
    const total = stockOf(db, p.id).qty
    const balances = balancesOf(db, p.id)
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
        below_min: p.is_active && p.min_stock > 0 && total < p.min_stock,
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
    case 'JOURNAL_ENTRY':
      return db.jeLines.filter((l) => l.document_id === doc.id).length
    case 'SUPPLIER_INVOICE':
      return db.siLines.filter((l) => l.document_id === doc.id).length
    case 'PAYMENT_ORDER':
      return db.opLines.filter((l) => l.document_id === doc.id).length
    case 'RFQ':
      return db.rfqLines.filter((l) => l.document_id === doc.id).length
    case 'SUPPLIER_QUOTE':
      return db.sqLines.filter((l) => l.document_id === doc.id).length
  }
}

function docLines(db: DB, doc: T.Document): { product_id: string }[] {
  switch (doc.doc_type) {
    case 'PURCHASE_REQUISITION':
      return db.prLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
    case 'PURCHASE_ORDER':
      return db.poLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
    case 'GOODS_RECEIPT':
      return db.grLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
    case 'STOCK_ADJUSTMENT':
      return db.saLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
    case 'JOURNAL_ENTRY':
    case 'PAYMENT_ORDER':
      return []
    case 'SUPPLIER_INVOICE':
      return db.siLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
    case 'RFQ':
      return rfqLinesOf(db, doc.id)
    case 'SUPPLIER_QUOTE':
      return db.sqLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
  }
}

function listItem(db: DB, doc: T.Document): DocumentListItem {
  // Lo que resume cada fila: los productos o, en una orden de pago, las facturas que paga.
  const products =
    doc.doc_type === 'PAYMENT_ORDER'
      ? db.opLines
          .filter((l) => l.document_id === doc.id)
          .sort(byLineNo)
          .map((l) => db.documents.find((d) => d.id === l.invoice_id)?.display_number)
          .filter(Boolean)
      : docLines(db, doc)
          .map((l) => db.products.find((p) => p.id === l.product_id)?.code)
          .filter(Boolean)
  const pending = db.approvalRequests.find((a) => a.document_id === doc.id && a.status === 'PENDIENTE')
  const origins = db.docLinks
    .filter((l) => l.to_document_id === doc.id)
    .map((l) => db.documents.find((d) => d.id === l.from_document_id)?.display_number)
    .filter((n): n is string => !!n)
    .sort(compareCodes)
  return {
    ...doc,
    status_info: DOC_STATUSES[doc.doc_type][doc.status],
    supplier_name: db.suppliers.find((s) => s.id === doc.supplier_id)?.legal_name ?? '',
    sector_name: db.sectors.find((s) => s.id === doc.sector_id)?.name ?? '—',
    created_by_name: nameOf(db, doc.created_by),
    line_count: lineCount(db, doc),
    summary: doc.je
      ? doc.je.description
      : products.slice(0, 3).join(', ') + (products.length > 3 ? ` y ${products.length - 3} más` : ''),
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
  const order: T.DocType[] = [
    'PURCHASE_REQUISITION',
    'RFQ',
    'SUPPLIER_QUOTE',
    'PURCHASE_ORDER',
    'GOODS_RECEIPT',
    'SUPPLIER_INVOICE',
    'PAYMENT_ORDER',
    'STOCK_ADJUSTMENT',
    'JOURNAL_ENTRY',
  ]
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
    if (doc.doc_type === 'JOURNAL_ENTRY' && tr.action === 'CANCEL' && doc.je?.origin === 'CONTRAASIENTO') {
      reason = 'Un contraasiento no se anula. Si hubo un error, registrá el asiento correcto.'
    }
    if (
      doc.doc_type === 'PAYMENT_ORDER' &&
      (tr.action === 'APPROVE' || tr.action === 'REJECT') &&
      !eff.supervisor &&
      company.settings.sod_enabled &&
      doc.created_by === userId
    ) {
      reason = 'Separación de funciones: no podés aprobar ni rechazar una orden de pago que preparaste vos.'
    }
    if (
      doc.doc_type === 'PAYMENT_ORDER' &&
      tr.action === 'PAY' &&
      !eff.supervisor &&
      company.settings.sod_enabled &&
      db.opLines.some((l) => l.document_id === doc.id && invoiceRegistrant(db, l.invoice_id) === userId)
    ) {
      reason =
        'Separación de funciones: registraste una de las facturas; tiene que pagarla otro integrante de Tesorería.'
    }
    if (doc.doc_type === 'RFQ' && tr.action === 'AWARD' && !quotesOf(db, doc.id).some((q) => quoteIsValid(db, q))) {
      reason = 'Todavía no hay cotizaciones vigentes para adjudicar.'
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

const rfqNumber = (db: DB, quote: T.Document) =>
  db.documents.find((d) => d.id === quote.sq?.rfq_id)?.display_number ?? '—'

function nextStep(db: DB, doc: T.Document): { who: string; text: string } {
  const sector = db.sectors.find((s) => s.id === doc.sector_id)?.name ?? 'el sector solicitante'
  switch (`${doc.doc_type}:${doc.status}`) {
    case 'PURCHASE_REQUISITION:BORRADOR':
      return { who: sector, text: 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.' }
    case 'PURCHASE_REQUISITION:SOLICITADO':
      return {
        who: 'Compras',
        text: 'Debe pedir cotizaciones o incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.',
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
        who: 'Compras',
        text: 'Llegó todo lo pedido. Cuando llegue la factura del proveedor, se registra contra esta orden y lo recibido.',
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
    case 'SUPPLIER_INVOICE:BORRADOR':
      return {
        who: 'Compras',
        text: 'Controlar el comprobante del proveedor contra la orden de compra y lo recibido, y registrar la factura.',
      }
    case 'SUPPLIER_INVOICE:REGISTRADA':
    case 'SUPPLIER_INVOICE:PAGADA_PARCIAL':
      return {
        who: 'Contabilidad y Tesorería',
        text: `La deuda está en la cuenta corriente del proveedor y vence el ${date(doc.si?.due_date)}. Se cancela con una orden de pago.`,
      }
    case 'PAYMENT_ORDER:BORRADOR':
      return {
        who: 'Contabilidad o Tesorería',
        text: 'Revisar las facturas, los importes y la caja o el banco, y enviar la orden a aprobación.',
      }
    case 'PAYMENT_ORDER:PENDIENTE_APROBACION':
      return {
        who: 'Gerencia',
        text: 'Autorizar el pago o rechazarlo con motivo. Quien preparó la orden no puede aprobarla: es un control de separación de funciones.',
      }
    case 'PAYMENT_ORDER:APROBADA': {
      const account = db.accounts.find((a) => a.id === doc.op?.treasury_account_id)
      return {
        who: 'Tesorería',
        text: `Pagar desde ${account ? accountLabel(account) : 'la caja o el banco'} y registrar el pago: el asiento se genera solo. Quien registró una de las facturas no puede pagarla.`,
      }
    }
    case 'PAYMENT_ORDER:PAGADA':
      return {
        who: '—',
        text: `Se pagó el ${date(doc.op?.paid_on)}: la deuda bajó en la cuenta corriente del proveedor y el pago está en el libro diario.`,
      }
    case 'PAYMENT_ORDER:RECHAZADA':
      return {
        who: 'Contabilidad o Tesorería',
        text: `Motivo del rechazo: "${doc.status_reason}". Si igual hay que pagar, se prepara otra orden.`,
      }
    case 'RFQ:BORRADOR':
      return {
        who: 'Compras',
        text: 'Revisar los ítems, las cantidades y los proveedores invitados, y enviar la solicitud. Si algo está mal, se anula y se prepara otra.',
      }
    case 'RFQ:ENVIADA': {
      const loaded = quotesOf(db, doc.id).length
      const invited = db.rfqSuppliers.filter((s) => s.document_id === doc.id).length
      return {
        who: 'Compras',
        text: loaded
          ? `Hay ${loaded} de ${invited} cotizaciones cargadas. Compararlas en el cuadro y adjudicar: se genera la orden de compra en borrador. Si no es la más conveniente por precio, hay que justificar la elección.`
          : `Mandar la solicitud impresa a cada proveedor invitado y cargar sus cotizaciones a medida que lleguen (responden hasta el ${date(doc.rq?.response_due)}).`,
      }
    }
    case 'RFQ:ADJUDICADA': {
      const awarded = quotesOf(db, doc.id).find((q) => q.status === 'ADJUDICADA')
      const order = awarded ? orderFromQuote(db, awarded.id) : undefined
      const supplier = db.suppliers.find((s) => s.id === awarded?.supplier_id)
      return {
        who: 'Compras',
        text: `Se adjudicó a ${supplier?.legal_name ?? '—'} (${awarded?.display_number ?? '—'}) y se generó ${order?.display_number ?? 'la orden de compra'}: la compra sigue en esa orden.`,
      }
    }
    case 'SUPPLIER_QUOTE:RECIBIDA':
      return {
        who: 'Compras',
        text: `Participa del cuadro comparativo de ${rfqNumber(db, doc)}. Se adjudica desde la solicitud; si se cargó mal, se anula y se carga de nuevo.`,
      }
    case 'SUPPLIER_QUOTE:ADJUDICADA':
      return {
        who: '—',
        text: `Fue la elegida en ${rfqNumber(db, doc)}: de ella nació ${orderFromQuote(db, doc.id)?.display_number ?? 'la orden de compra'}.`,
      }
    case 'JOURNAL_ENTRY:BORRADOR':
      return {
        who: 'Contabilidad',
        text: 'Revisar que las cuentas sean las correctas y que el debe y el haber sumen lo mismo, y registrar el asiento en el libro diario.',
      }
    case 'JOURNAL_ENTRY:CONFIRMADO':
      return {
        who: '—',
        text: `Está en el libro diario con el N.º ${doc.je?.entry_number}. Si tiene un error, no se corrige: se anula con un contraasiento y se registra el asiento correcto.`,
      }
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
  // FP: precio pactado en la OC, para mostrar la diferencia
  order_unit_price?: number
}

export interface ApprovalView extends T.ApprovalRequest {
  approver_role_name: string
  decided_by_name: string
  requested_by_name: string
}

export interface JournalLineView {
  id: string
  line_no: number
  account: { id: string; code: string; name: string }
  debit: number
  credit: number
  notes: string
}

/** Asiento contable: sus líneas van por cuenta, no por producto. */
export interface JournalView {
  description: string
  origin: T.JournalEntryOrigin
  entry_number: number | null
  fiscal_year_name: string | null
  posted_at: string | null
  lines: JournalLineView[]
  total_debit: number
  total_credit: number
  /** En un asiento anulado, su contraasiento; en un contraasiento, el asiento que anula. */
  reversed_by: { display_number: string; path: string } | null
  reverses: { display_number: string; path: string } | null
}

/** Una factura que cancela la orden de pago, y cuánto de ella. */
export interface PaymentLineView {
  id: string
  line_no: number
  invoice: {
    id: string
    display_number: string
    path: string
    /** Comprobante del proveedor: "A 00003-00012874". */
    invoice_label: string
    document_date: string
    due_date: string
    total: number
    status_info: StatusInfo
  }
  amount: number
}

export interface PaymentView {
  treasury_account: { id: string; code: string; name: string }
  payment_reference: string
  paid_on: string | null
  lines: PaymentLineView[]
}

/** Otro documento, para enlazarlo. */
export interface DocRef {
  id: string
  display_number: string
  status: string
  path: string
  status_info: StatusInfo
}

/** Una cotización en el cuadro comparativo de su solicitud (una columna). */
export interface ComparisonQuote extends DocRef {
  supplier: { id: string; code: string; legal_name: string; vat_condition: T.VatCondition }
  supplier_reference: string
  document_date: string
  valid_until: string
  /** La oferta venció (sólo mientras la solicitud está enviada). */
  expired: boolean
  delivery_days: number
  payment_terms_days: number
  /** Costo para la empresa: el neto. */
  subtotal: number
  tax_total: number
  total: number
  quoted_lines: number
  complete: boolean
  /** Un precio por ítem de la solicitud, en su orden; null si no lo cotizó. */
  prices: ({ unit_price: number; vat_rate: number; line_subtotal: number; lowest: boolean } | null)[]
}

/** Solicitud de cotización: proveedores invitados, cuadro comparativo y adjudicación. */
export interface RfqView {
  response_due: string
  award_reason: string
  invited: { supplier: { id: string; code: string; legal_name: string }; quote: DocRef | null }[]
  quotes: ComparisonQuote[]
  /** La más conveniente por precio (sólo mientras la solicitud está enviada). */
  best_quote_id: string | null
  awarded_quote_id: string | null
  /** La orden de compra que nació de la cotización adjudicada. */
  order: DocRef | null
}

/** Cotización: su solicitud, sus condiciones y, si fue adjudicada, su orden de compra. */
export interface QuoteView {
  rfq: DocRef
  supplier_reference: string
  valid_until: string
  expired: boolean
  delivery_days: number
  payment_terms_days: number
  /** Es la más conveniente por precio de su solicitud (mientras está enviada). */
  best: boolean
  order: DocRef | null
}

export interface DocumentDetail {
  doc: DocumentListItem
  lines: DetailLine[]
  journal: JournalView | null
  payment: PaymentView | null
  rfq: RfqView | null
  quote: QuoteView | null
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
      .sort(byLineNo)
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
      .sort(byLineNo)
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
          requisition_max: rl
            ? round3(
                requisitionAvailableQuantity(db, rl.id, doc.id) -
                  db.poLines
                    .filter(
                      (other) =>
                        other.document_id === doc.id && other.requisition_line_id === rl.id && other.id !== l.id,
                    )
                    .reduce((sum, other) => sum + other.quantity, 0),
              )
            : null,
        }
      })
  }
  if (doc.doc_type === 'GOODS_RECEIPT') {
    lines = db.grLines
      .filter((l) => l.document_id === doc.id)
      .sort(byLineNo)
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
      .sort(byLineNo)
      .map((l) => ({
        id: l.id,
        line_no: l.line_no,
        product: product(l.product_id),
        quantity: l.quantity_delta,
        notes: l.notes,
        unit_cost: l.unit_cost,
      }))
  }
  if (doc.doc_type === 'SUPPLIER_INVOICE') {
    lines = db.siLines
      .filter((l) => l.document_id === doc.id)
      .sort(byLineNo)
      .map((l) => {
        const pl = db.poLines.find((x) => x.id === l.po_line_id)
        return {
          id: l.id,
          line_no: l.line_no,
          product: product(l.product_id),
          quantity: l.quantity,
          notes: '',
          po_line_id: l.po_line_id,
          qty_ordered_po: pl?.quantity,
          qty_received: pl?.qty_received,
          unit_price: l.unit_price,
          order_unit_price: pl?.unit_price,
          vat_rate: l.vat_rate,
          line_subtotal: l.line_subtotal,
          line_tax: l.line_tax,
          line_total: l.line_total,
        }
      })
  }
  if (doc.doc_type === 'RFQ') {
    lines = rfqLinesOf(db, doc.id).map((l) => {
      const rl = db.prLines.find((x) => x.id === l.requisition_line_id)
      return {
        id: l.id,
        line_no: l.line_no,
        product: product(l.product_id),
        quantity: l.quantity,
        notes: l.notes,
        requisition_label: rl ? (db.documents.find((d) => d.id === rl.document_id)?.display_number ?? null) : null,
        requisition_line_id: l.requisition_line_id,
      }
    })
  }
  if (doc.doc_type === 'SUPPLIER_QUOTE') {
    lines = db.sqLines
      .filter((l) => l.document_id === doc.id)
      .sort(byLineNo)
      .map((l) => ({
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
      }))
  }
  const warehouseId = doc.po?.warehouse_id ?? doc.gr?.warehouse_id ?? doc.sa?.warehouse_id ?? doc.rq?.warehouse_id
  const orderId = doc.gr?.purchase_order_id ?? doc.si?.purchase_order_id
  const relatedOrder = orderId ? db.documents.find((d) => d.id === orderId) : undefined
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
        : doc.doc_type === 'JOURNAL_ENTRY' || doc.doc_type === 'SUPPLIER_INVOICE'
          ? [
              { label: 'Registró', ...firstBy(['CONFIRM', 'CREATE']) },
              { label: doc.doc_type === 'JOURNAL_ENTRY' ? 'Revisó' : 'Controló', name: '', sector: '', at: '' },
            ]
          : doc.doc_type === 'PAYMENT_ORDER'
            ? [
                { label: 'Preparó', ...firstBy(['SUBMIT', 'CREATE']) },
                { label: 'Autorizó', ...firstBy(['APPROVE']) },
                { label: 'Pagó', ...firstBy(['PAY']) },
              ]
            : doc.doc_type === 'RFQ'
              ? [
                  { label: 'Preparó', ...firstBy(['SUBMIT', 'CREATE']) },
                  { label: 'Adjudicó', ...firstBy(['AWARD']) },
                ]
              : doc.doc_type === 'SUPPLIER_QUOTE'
                ? [
                    { label: 'Cargó', ...firstBy(['CREATE']) },
                    { label: 'Controló', name: '', sector: '', at: '' },
                  ]
                : [
                    { label: 'Recibió / registró', ...firstBy(['CONFIRM', 'CREATE']) },
                    { label: 'Controló', name: '', sector: '', at: '' },
                  ]
  return {
    doc: listItem(db, doc),
    lines,
    journal: doc.je ? journalView(db, doc) : null,
    payment: doc.op ? paymentView(db, doc) : null,
    rfq: doc.rq ? rfqView(db, doc) : null,
    quote: doc.sq ? quoteView(db, doc) : null,
    supplier: db.suppliers.find((s) => s.id === doc.supplier_id) ?? null,
    warehouse: db.warehouses.find((w) => w.id === warehouseId) ?? null,
    related_order: relatedOrder ? listItem(db, relatedOrder) : null,
    approvals: db.approvalRequests
      .filter((a) => a.document_id === doc.id)
      .sort((a, b) => compareCodes(a.requested_at, b.requested_at))
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

function paymentView(db: DB, doc: T.Document): PaymentView {
  const op = doc.op!
  const account = db.accounts.find((a) => a.id === op.treasury_account_id)!
  return {
    treasury_account: { id: account.id, code: account.code, name: account.name },
    payment_reference: op.payment_reference,
    paid_on: op.paid_on,
    lines: db.opLines
      .filter((l) => l.document_id === doc.id)
      .sort(byLineNo)
      .map((l) => {
        const invoice = db.documents.find((d) => d.id === l.invoice_id)!
        return {
          id: l.id,
          line_no: l.line_no,
          invoice: {
            id: invoice.id,
            display_number: invoice.display_number,
            path: docPath(db, invoice),
            invoice_label: `${invoice.si!.letter} ${invoice.si!.point_of_sale}-${invoice.si!.invoice_number}`,
            document_date: invoice.document_date,
            due_date: invoice.si!.due_date,
            total: invoice.total,
            status_info: DOC_STATUSES[invoice.doc_type][invoice.status],
          },
          amount: l.amount,
        }
      }),
  }
}

const docRef = (db: DB, d: T.Document): DocRef => ({
  id: d.id,
  display_number: d.display_number,
  status: d.status,
  path: docPath(db, d),
  status_info: DOC_STATUSES[d.doc_type][d.status],
})

function rfqView(db: DB, doc: T.Document): RfqView {
  const open = doc.status === 'ENVIADA'
  const items = rfqLinesOf(db, doc.id)
  const quotes = quotesOf(db, doc.id)
  const linesOf = (q: T.Document) => db.sqLines.filter((l) => l.document_id === q.id)
  // El precio más bajo de cada ítem entre las cotizaciones del cuadro.
  const lowest = new Map<string, number>()
  for (const q of quotes)
    for (const l of linesOf(q)) {
      const min = lowest.get(l.rfq_line_id)
      if (min === undefined || l.unit_price < min) lowest.set(l.rfq_line_id, l.unit_price)
    }
  const best = open ? bestQuote(db, doc) : null
  const awarded = quotes.find((q) => q.status === 'ADJUDICADA')
  const order = awarded ? orderFromQuote(db, awarded.id) : undefined
  return {
    response_due: doc.rq!.response_due,
    award_reason: doc.rq!.award_reason,
    invited: db.rfqSuppliers
      .filter((s) => s.document_id === doc.id)
      .map((s) => db.suppliers.find((x) => x.id === s.supplier_id)!)
      .sort((a, b) => compareCodes(a.code, b.code))
      .map((s) => {
        const quote = quotes.find((q) => q.supplier_id === s.id)
        return {
          supplier: { id: s.id, code: s.code, legal_name: s.legal_name },
          quote: quote ? docRef(db, quote) : null,
        }
      }),
    quotes: quotes.map((q) => {
      const supplier = db.suppliers.find((s) => s.id === q.supplier_id)!
      const quoted = linesOf(q)
      return {
        ...docRef(db, q),
        supplier: {
          id: supplier.id,
          code: supplier.code,
          legal_name: supplier.legal_name,
          vat_condition: supplier.vat_condition,
        },
        supplier_reference: q.sq!.supplier_reference,
        document_date: q.document_date,
        valid_until: q.sq!.valid_until,
        expired: open && q.status === 'RECIBIDA' && !quoteIsValid(db, q),
        delivery_days: q.sq!.delivery_days,
        payment_terms_days: q.sq!.payment_terms_days,
        subtotal: q.subtotal,
        tax_total: q.tax_total,
        total: q.total,
        quoted_lines: quoted.length,
        complete: quoted.length === items.length,
        prices: items.map((item) => {
          const l = quoted.find((x) => x.rfq_line_id === item.id)
          return l
            ? {
                unit_price: l.unit_price,
                vat_rate: l.vat_rate,
                line_subtotal: l.line_subtotal,
                lowest: l.unit_price === lowest.get(item.id),
              }
            : null
        }),
      }
    }),
    best_quote_id: best?.id ?? null,
    awarded_quote_id: awarded?.id ?? null,
    order: order ? docRef(db, order) : null,
  }
}

function quoteView(db: DB, doc: T.Document): QuoteView {
  const sq = doc.sq!
  const rfq = db.documents.find((d) => d.id === sq.rfq_id)!
  const open = rfq.status === 'ENVIADA'
  const order = doc.status === 'ADJUDICADA' ? orderFromQuote(db, doc.id) : undefined
  return {
    rfq: docRef(db, rfq),
    supplier_reference: sq.supplier_reference,
    valid_until: sq.valid_until,
    expired: open && doc.status === 'RECIBIDA' && !quoteIsValid(db, doc),
    delivery_days: sq.delivery_days,
    payment_terms_days: sq.payment_terms_days,
    best: open && bestQuote(db, rfq)?.id === doc.id,
    order: order ? docRef(db, order) : null,
  }
}

function journalView(db: DB, doc: T.Document): JournalView {
  const je = doc.je!
  const lines = db.jeLines
    .filter((l) => l.document_id === doc.id)
    .sort(byLineNo)
    .map((l) => {
      const a = db.accounts.find((x) => x.id === l.account_id)!
      return {
        id: l.id,
        line_no: l.line_no,
        account: { id: a.id, code: a.code, name: a.name },
        debit: l.debit,
        credit: l.credit,
        notes: l.notes,
      }
    })
  const ref = (d: T.Document | undefined) => (d ? { display_number: d.display_number, path: docPath(db, d) } : null)
  return {
    description: je.description,
    origin: je.origin,
    entry_number: je.entry_number,
    fiscal_year_name: db.fiscalYears.find((y) => y.id === je.fiscal_year_id)?.name ?? null,
    posted_at: je.posted_at,
    lines,
    total_debit: round2(lines.reduce((sum, l) => sum + l.debit, 0)),
    total_credit: round2(lines.reduce((sum, l) => sum + l.credit, 0)),
    reversed_by: ref(db.documents.find((d) => d.je?.reverses_id === doc.id)),
    reverses: ref(je.reverses_id ? db.documents.find((d) => d.id === je.reverses_id) : undefined),
  }
}

// ============================================================ Contabilidad

export interface AccountRow extends T.Account {
  debit: number
  credit: number
  /** Debe − haber de los asientos del libro diario; un rubro suma sus cuentas. */
  balance: number
  /** Saldo del lado contrario a su naturaleza (por ejemplo, Caja acreedora): un error típico. */
  contrary: boolean
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))

function assertRange(from: string, to: string) {
  if (!isDate(from) || !isDate(to)) fail('DATO_INVALIDO', 'Indicá las fechas desde y hasta.')
  if (from > to) fail('DATO_INVALIDO', 'La fecha desde no puede ser posterior a la fecha hasta.')
}

/** Líneas de los asientos del libro diario de la empresa, con su asiento. */
function postedLines(db: DB, companyId: string) {
  const docs = new Map(db.documents.filter((d) => d.company_id === companyId && isPosted(d)).map((d) => [d.id, d]))
  return db.jeLines.filter((l) => docs.has(l.document_id)).map((line) => ({ line, doc: docs.get(line.document_id)! }))
}

/** Orden del libro diario: fecha, número de asiento y línea. */
const byJournalOrder = (a: { line: T.JournalEntryLine; doc: T.Document }, b: typeof a) =>
  compareCodes(a.doc.document_date, b.doc.document_date) ||
  a.doc.je!.entry_number! - b.doc.je!.entry_number! ||
  a.line.line_no - b.line.line_no

const isContrary = (a: T.Account, balance: number) => (a.normal_side === 'DEBE' ? balance < 0 : balance > 0)

export function listAccounts(db: DB, userId: string, companyId: string): AccountRow[] {
  assertPerm(db, userId, companyId, 'account.read')
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const { line } of postedLines(db, companyId)) {
    const t = totals.get(line.account_id) ?? { debit: 0, credit: 0 }
    t.debit += line.debit
    t.credit += line.credit
    totals.set(line.account_id, t)
  }
  const accounts = db.accounts.filter((a) => a.company_id === companyId).sort((a, b) => compareCodes(a.code, b.code))
  return accounts.map((a) => {
    const own = a.is_imputable ? [a] : accounts.filter((x) => x.is_imputable && x.code.startsWith(`${a.code}.`))
    const debit = round2(own.reduce((sum, x) => sum + (totals.get(x.id)?.debit ?? 0), 0))
    const credit = round2(own.reduce((sum, x) => sum + (totals.get(x.id)?.credit ?? 0), 0))
    const balance = round2(debit - credit)
    return { ...a, debit, credit, balance, contrary: a.is_imputable && isContrary(a, balance) }
  })
}

export interface PeriodView extends T.FiscalPeriod {
  closed_by_name: string
  entries: number
  drafts: number
}

export interface FiscalYearView extends T.FiscalYear {
  periods: PeriodView[]
}

/** Ejercicios del más reciente al más antiguo, con sus meses y cuántos asientos tiene cada uno. */
export function listFiscalYears(db: DB, userId: string, companyId: string): FiscalYearView[] {
  assertPerm(db, userId, companyId, 'ledger.read')
  const entries = db.documents.filter((d) => d.company_id === companyId && d.doc_type === 'JOURNAL_ENTRY')
  const inPeriod = (d: T.Document, p: T.FiscalPeriod) =>
    p.start_date <= d.document_date && d.document_date <= p.end_date
  return db.fiscalYears
    .filter((y) => y.company_id === companyId)
    .sort((a, b) => compareCodes(b.start_date, a.start_date))
    .map((y) => ({
      ...y,
      periods: db.fiscalPeriods
        .filter((p) => p.fiscal_year_id === y.id)
        .sort((a, b) => a.number - b.number)
        .map((p) => ({
          ...p,
          closed_by_name: p.closed_by ? nameOf(db, p.closed_by) : '',
          entries: entries.filter((d) => isPosted(d) && inPeriod(d, p)).length,
          drafts: entries.filter((d) => d.status === 'BORRADOR' && inPeriod(d, p)).length,
        })),
    }))
}

export interface JournalBookEntry {
  id: string
  display_number: string
  path: string
  entry_number: number
  date: string
  description: string
  origin: T.JournalEntryOrigin
  status: string
  /** Como en los manuales: primero las cuentas del debe y después las del haber. */
  lines: { account_code: string; account_name: string; debit: number; credit: number; notes: string }[]
  total: number
}

export interface JournalBook {
  entries: JournalBookEntry[]
  total_debit: number
  total_credit: number
}

/** Libro diario: los asientos registrados entre dos fechas, en orden correlativo. */
export function journalBook(db: DB, userId: string, companyId: string, from: string, to: string): JournalBook {
  assertPerm(db, userId, companyId, 'ledger.read')
  assertRange(from, to)
  const rows = postedLines(db, companyId)
    .filter(({ doc }) => from <= doc.document_date && doc.document_date <= to)
    .sort(byJournalOrder)
  const entries: JournalBookEntry[] = []
  for (const { line, doc } of rows) {
    let entry = entries.at(-1)
    if (entry?.id !== doc.id) {
      entry = {
        id: doc.id,
        display_number: doc.display_number,
        path: docPath(db, doc),
        entry_number: doc.je!.entry_number!,
        date: doc.document_date,
        description: doc.je!.description,
        origin: doc.je!.origin,
        status: doc.status,
        lines: [],
        total: doc.total,
      }
      entries.push(entry)
    }
    const a = db.accounts.find((x) => x.id === line.account_id)!
    entry.lines.push({
      account_code: a.code,
      account_name: a.name,
      debit: line.debit,
      credit: line.credit,
      notes: line.notes,
    })
  }
  for (const e of entries) e.lines.sort((a, b) => Number(b.debit > 0) - Number(a.debit > 0))
  return {
    entries,
    total_debit: round2(rows.reduce((sum, r) => sum + r.line.debit, 0)),
    total_credit: round2(rows.reduce((sum, r) => sum + r.line.credit, 0)),
  }
}

export interface LedgerRow {
  document_id: string
  display_number: string
  path: string
  entry_number: number
  date: string
  description: string
  debit: number
  credit: number
  /** Saldo acumulado (debe − haber) después de este movimiento. */
  balance: number
}

export interface Ledger {
  account: AccountRow
  opening_balance: number
  rows: LedgerRow[]
  total_debit: number
  total_credit: number
  closing_balance: number
}

/** Libro mayor de una cuenta imputable: saldo anterior, movimientos con saldo acumulado y saldo final. */
export function ledger(
  db: DB,
  userId: string,
  companyId: string,
  accountId: string,
  from: string,
  to: string,
): Ledger | null {
  assertPerm(db, userId, companyId, 'ledger.read')
  assertRange(from, to)
  const account = listAccounts(db, userId, companyId).find((a) => a.id === accountId)
  if (!account) return null
  if (!account.is_imputable) fail('DATO_INVALIDO', 'El mayor se consulta por cuenta imputable (de nivel 4).')
  const lines = postedLines(db, companyId)
    .filter(({ line }) => line.account_id === accountId)
    .sort(byJournalOrder)
  const opening = round2(
    lines.filter(({ doc }) => doc.document_date < from).reduce((sum, { line }) => sum + line.debit - line.credit, 0),
  )
  let balance = opening
  const rows = lines
    .filter(({ doc }) => from <= doc.document_date && doc.document_date <= to)
    .map(({ line, doc }) => {
      balance = round2(balance + line.debit - line.credit)
      return {
        document_id: doc.id,
        display_number: doc.display_number,
        path: docPath(db, doc),
        entry_number: doc.je!.entry_number!,
        date: doc.document_date,
        description: line.notes || doc.je!.description,
        debit: line.debit,
        credit: line.credit,
        balance,
      }
    })
  return {
    account,
    opening_balance: opening,
    rows,
    total_debit: round2(rows.reduce((sum, r) => sum + r.debit, 0)),
    total_credit: round2(rows.reduce((sum, r) => sum + r.credit, 0)),
    closing_balance: balance,
  }
}

export interface TrialBalanceRow {
  account_id: string
  code: string
  name: string
  account_type: T.AccountType
  debit: number
  credit: number
  debit_balance: number
  credit_balance: number
  contrary: boolean
}

export interface TrialBalance {
  rows: TrialBalanceRow[]
  totals: { debit: number; credit: number; debit_balance: number; credit_balance: number }
  /** Las sumas del debe y del haber coinciden, y también los saldos. */
  balanced: boolean
}

/** Balance de sumas y saldos de las cuentas con movimientos entre dos fechas. */
export function trialBalance(db: DB, userId: string, companyId: string, from: string, to: string): TrialBalance {
  assertPerm(db, userId, companyId, 'ledger.read')
  assertRange(from, to)
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const { line, doc } of postedLines(db, companyId)) {
    if (doc.document_date < from || doc.document_date > to) continue
    const t = totals.get(line.account_id) ?? { debit: 0, credit: 0 }
    t.debit += line.debit
    t.credit += line.credit
    totals.set(line.account_id, t)
  }
  const rows = db.accounts
    .filter((a) => totals.has(a.id))
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((a) => {
      const debit = round2(totals.get(a.id)!.debit)
      const credit = round2(totals.get(a.id)!.credit)
      const balance = round2(debit - credit)
      return {
        account_id: a.id,
        code: a.code,
        name: a.name,
        account_type: a.account_type,
        debit,
        credit,
        debit_balance: Math.max(balance, 0),
        credit_balance: Math.max(-balance, 0),
        contrary: isContrary(a, balance),
      }
    })
  const sum = (key: 'debit' | 'credit' | 'debit_balance' | 'credit_balance') =>
    round2(rows.reduce((s, r) => s + r[key], 0))
  const result = {
    debit: sum('debit'),
    credit: sum('credit'),
    debit_balance: sum('debit_balance'),
    credit_balance: sum('credit_balance'),
  }
  return {
    rows,
    totals: result,
    balanced: result.debit === result.credit && result.debit_balance === result.credit_balance,
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
    for (const line of db.prLines.filter((l) => l.document_id === doc.id).sort(byLineNo)) {
      const pending = requisitionAvailableQuantity(db, line.id)
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
        .sort(byLineNo)
        .map((l) => ({
          line: l,
          product: db.products.find((p) => p.id === l.product_id)!,
          pending: l.quantity - l.qty_received,
        }))
        .filter((x) => x.pending > 1e-9),
    }))
}

export interface InvoiceableOrder {
  order: DocumentListItem
  lines: {
    line: T.PurchaseOrderLine
    product: T.Product
    invoiced: number
    /** Recibido menos facturado: lo que todavía se puede facturar. */
    pending: number
  }[]
}

/** OC enviadas con mercadería recibida y todavía sin facturar (para registrar la factura del proveedor). */
export function invoiceableOrders(db: DB, userId: string, companyId: string): InvoiceableOrder[] {
  assertPerm(db, userId, companyId, 'supplier_invoice.create')
  return db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'PURCHASE_ORDER' &&
        ['ENVIADO', 'RECIBIDO_PARCIAL', 'RECIBIDO', 'CERRADO'].includes(d.status),
    )
    .sort((a, b) => a.number - b.number)
    .map((d) => ({
      order: listItem(db, d),
      lines: db.poLines
        .filter((l) => l.document_id === d.id)
        .sort(byLineNo)
        .map((l) => {
          const invoiced = invoicedQuantity(db, l.id)
          return {
            line: l,
            product: db.products.find((p) => p.id === l.product_id)!,
            invoiced,
            pending: round3(l.qty_received - invoiced),
          }
        })
        .filter((x) => x.pending > 1e-9),
    }))
    .filter((o) => o.lines.length)
}

// ============================================================ Cuentas corrientes de proveedores

export interface PayableInvoice {
  id: string
  display_number: string
  path: string
  /** Comprobante del proveedor: "A 00003-00012874". */
  invoice_label: string
  document_date: string
  due_date: string
  total: number
  paid: number
  pending: number
  overdue: boolean
}

export interface PayableRow {
  supplier: { id: string; code: string; legal_name: string; tax_id: string; payment_terms_days: number }
  balance: number
  invoices: number
  overdue: number
  next_due: string | null
}

/** Facturas registradas (que generaron deuda) de una empresa. */
function registeredInvoices(db: DB, companyId: string) {
  return db.documents.filter(
    (d) => d.company_id === companyId && d.doc_type === 'SUPPLIER_INVOICE' && INVOICED_STATUSES.includes(d.status),
  )
}

function payableInvoice(db: DB, doc: T.Document, today: string): PayableInvoice {
  const paid = invoicePaid(db, doc.id)
  return {
    id: doc.id,
    display_number: doc.display_number,
    path: docPath(db, doc),
    invoice_label: `${doc.si!.letter} ${doc.si!.point_of_sale}-${doc.si!.invoice_number}`,
    document_date: doc.document_date,
    due_date: doc.si!.due_date,
    total: doc.total,
    paid,
    pending: round2(doc.total - paid),
    overdue: doc.si!.due_date < today && round2(doc.total - paid) > 0,
  }
}

/** Saldo con cada proveedor que tiene facturas registradas, por código. */
export function listPayables(db: DB, userId: string, companyId: string): PayableRow[] {
  assertPerm(db, userId, companyId, 'payable.read')
  const today = todayAR()
  const invoices = registeredInvoices(db, companyId)
  return db.suppliers
    .filter((s) => s.company_id === companyId && invoices.some((d) => d.supplier_id === s.id))
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((s) => {
      const pending = invoices
        .filter((d) => d.supplier_id === s.id)
        .map((d) => payableInvoice(db, d, today))
        .filter((i) => i.pending > 0)
      const dues = pending.map((i) => i.due_date).sort(compareCodes)
      return {
        supplier: {
          id: s.id,
          code: s.code,
          legal_name: s.legal_name,
          tax_id: s.tax_id,
          payment_terms_days: s.payment_terms_days,
        },
        balance: round2(pending.reduce((sum, i) => sum + i.pending, 0)),
        invoices: pending.length,
        overdue: round2(pending.filter((i) => i.overdue).reduce((sum, i) => sum + i.pending, 0)),
        next_due: dues[0] ?? null,
      }
    })
}

export interface SupplierAccountMovement {
  document_id: string
  display_number: string
  path: string
  date: string
  description: string
  /** Debe: lo que se le pagó. Haber: lo que facturó (aumenta la deuda). */
  debit: number
  credit: number
  balance: number
}

export interface SupplierAccount {
  supplier: T.Supplier
  movements: SupplierAccountMovement[]
  pending: PayableInvoice[]
  balance: number
}

/** Cuenta corriente de un proveedor: facturas y pagos con saldo acumulado, y las facturas pendientes. */
export function supplierAccount(db: DB, userId: string, companyId: string, supplierId: string): SupplierAccount | null {
  assertPerm(db, userId, companyId, 'payable.read')
  const supplier = db.suppliers.find((s) => s.id === supplierId && s.company_id === companyId)
  if (!supplier) return null
  const today = todayAR()
  const invoices = registeredInvoices(db, companyId)
    .filter((d) => d.supplier_id === supplier.id)
    .sort((a, b) => compareCodes(a.document_date, b.document_date) || a.number - b.number)
  const payments = db.documents.filter(
    (d) =>
      d.company_id === companyId &&
      d.doc_type === 'PAYMENT_ORDER' &&
      d.status === 'PAGADA' &&
      d.supplier_id === supplier.id,
  )
  // Facturas (haber) y pagos (debe) por fecha; el mismo día, primero las facturas.
  const entries = [
    ...invoices.map((doc) => ({ doc, date: doc.document_date, payment: false })),
    ...payments.map((doc) => ({ doc, date: doc.op!.paid_on!, payment: true })),
  ].sort((a, b) => compareCodes(a.date, b.date) || Number(a.payment) - Number(b.payment) || a.doc.number - b.doc.number)
  let balance = 0
  const movements = entries.map(({ doc: d, date: on, payment }) => {
    balance = round2(balance + (payment ? -d.total : d.total))
    const account = payment ? db.accounts.find((a) => a.id === d.op!.treasury_account_id) : undefined
    return {
      document_id: d.id,
      display_number: d.display_number,
      path: docPath(db, d),
      date: on,
      description: payment
        ? `Pago desde ${account?.name ?? ''}${d.op!.payment_reference ? ` (${d.op!.payment_reference})` : ''}`
        : `Factura ${d.si!.letter} ${d.si!.point_of_sale}-${d.si!.invoice_number}`,
      debit: payment ? d.total : 0,
      credit: payment ? 0 : d.total,
      balance,
    }
  })
  const pending = invoices.map((d) => payableInvoice(db, d, today)).filter((i) => i.pending > 0)
  return { supplier, movements, pending, balance }
}

// ============================================================ Tesorería

export interface TreasuryAccountRow {
  account: { id: string; code: string; name: string; description: string; is_active: boolean }
  /** Saldo del libro mayor. */
  balance: number
}

/** Cajas y bancos: las cuentas imputables del rubro Caja y bancos, con su saldo del libro mayor. */
export function treasuryAccounts(db: DB, userId: string, companyId: string): TreasuryAccountRow[] {
  assertPerm(db, userId, companyId, 'treasury.read')
  return db.accounts
    .filter((a) => a.company_id === companyId && a.is_imputable && a.code.startsWith(`${TREASURY_RUBRO}.`))
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((a) => ({
      account: { id: a.id, code: a.code, name: a.name, description: a.description, is_active: a.is_active },
      balance: accountBalance(db, a.id),
    }))
}

export interface PaymentCandidate {
  invoice: PayableInvoice
  /** Lo que ya está en otras órdenes de pago en curso. */
  committed: number
  /** Lo que todavía se puede incluir en una orden nueva. */
  available: number
}

/** Facturas de un proveedor que se pueden pagar, de la que vence primero (para preparar una orden de pago). */
export function paymentCandidates(db: DB, userId: string, companyId: string, supplierId: string): PaymentCandidate[] {
  assertPerm(db, userId, companyId, 'payment_order.create')
  const today = todayAR()
  return db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'SUPPLIER_INVOICE' &&
        d.supplier_id === supplierId &&
        ['REGISTRADA', 'PAGADA_PARCIAL'].includes(d.status),
    )
    .sort((a, b) => compareCodes(a.si!.due_date, b.si!.due_date) || a.number - b.number)
    .map((d) => {
      const invoice = payableInvoice(db, d, today)
      const committed = invoiceCommitted(db, d.id)
      return { invoice, committed, available: round2(invoice.pending - committed) }
    })
}

// ============================================================ Imputación automática

export interface PostingRuleRow extends T.PostingRule {
  event_label: string
  key_label: string
  account: { id: string; code: string; name: string }
}

/** Reglas de imputación de la empresa, en el orden del catálogo de eventos. */
export function listPostingRules(db: DB, userId: string, companyId: string): PostingRuleRow[] {
  assertPerm(db, userId, companyId, 'posting_rule.read')
  const events = Object.keys(POSTING_EVENTS)
  const keyOrder = (event: string, key: string) => Object.keys(POSTING_EVENTS[event]?.keys ?? {}).indexOf(key)
  return db.postingRules
    .filter((r) => r.company_id === companyId)
    .sort(
      (a, b) =>
        events.indexOf(a.event) - events.indexOf(b.event) || keyOrder(a.event, a.key) - keyOrder(b.event, b.key),
    )
    .map((r) => {
      const a = db.accounts.find((x) => x.id === r.account_id)!
      return {
        ...r,
        event_label: POSTING_EVENTS[r.event]?.label ?? r.event,
        key_label: POSTING_EVENTS[r.event]?.keys[r.key] ?? r.key,
        account: { id: a.id, code: a.code, name: a.name },
      }
    })
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
  const profile = getProfile(db, userId)
  if (!profile?.is_active || (!isInstanceAdmin(profile) && !getMember(db, userId, companyId)?.is_active)) return []
  const eff = effectivePermissions(db, userId, companyId)
  const canAll = eff.all || eff.perms.has('task.read')
  const company = db.companies.find((c) => c.id === companyId)!
  return (
    db.tasks
      .filter((t) => t.company_id === companyId)
      .filter((t) => includeClosed || t.status === 'PENDIENTE' || t.status === 'EN_CURSO')
      .map((t) => {
        const mine = t.assigned_user_id === userId || (!!t.assigned_role && eff.roles.includes(t.assigned_role))
        return { t, mine }
      })
      .filter(({ mine }) => mine || (scope === 'all' && canAll))
      // Primero las que alguien está haciendo; después, de la más nueva a la más vieja.
      .sort(
        (a, b) =>
          Number(b.t.status === 'EN_CURSO') - Number(a.t.status === 'EN_CURSO') ||
          compareCodes(b.t.created_at, a.t.created_at),
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
  )
}

/** Avisos del usuario en la empresa, del más nuevo al más viejo. Con `limit: null`, el historial completo. */
export function listNotifications(db: DB, userId: string, companyId: string, limit: number | null = 60) {
  const profile = getProfile(db, userId)
  if (!profile?.is_active || (!isInstanceAdmin(profile) && !getMember(db, userId, companyId)?.is_active)) return []
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
  // Sólo cuenta lo que el usuario puede leer: los indicadores no revelan documentos ajenos a su rol (ni a su empresa).
  const docs = db.documents.filter(
    (d) => d.company_id === companyId && can(eff, `${DOC_TYPES[d.doc_type].resource}.read`),
  )
  const pos = docs.filter((d) => d.doc_type === 'PURCHASE_ORDER')
  const month = todayAR().slice(0, 7)
  const canPurchasing = can(eff, 'purchase_order.read')
  const canStock = can(eff, 'stock.read')
  const lowStock = db.products
    .filter((p) => canStock && p.company_id === companyId && p.is_active && p.is_stockable && p.min_stock > 0)
    .sort((a, b) => compareCodes(a.code, b.code))
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
    lead_time_hours: canPurchasing && leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null,
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
    .sort((a, b) => (a.roles[0]?.island ?? 99) - (b.roles[0]?.island ?? 99) || compareNames(a.user, b.user))
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
export function publicSchoolInfo(db: DB): Pick<T.SchoolSettings, 'official_name' | 'short_name' | 'logo_path'> {
  return { official_name: db.school.official_name, short_name: db.school.short_name, logo_path: db.school.logo_path }
}

function requireSchoolAdminRead(db: DB, userId: string) {
  if (!isSchoolAdmin(getProfile(db, userId)))
    fail('SIN_PERMISO', 'Sólo la administración de la escuela puede ver esto.')
}

/** El directorio institucional no se expone a estudiantes ni docentes de otras empresas. */
export function listUsers(db: DB, userId: string): PublicProfile[] {
  requireSchoolAdminRead(db, userId)
  return db.profiles.map(publicProfile).sort(compareNames)
}

/** Cursos del año lectivo: los administra la escuela; el docente los consulta para crear la empresa de su curso. */
export function listCourses(db: DB, userId: string): T.Course[] {
  if (getProfile(db, userId)?.app_role !== 'DOCENTE') requireSchoolAdminRead(db, userId)
  return [...db.courses].sort((a, b) => b.academic_year - a.academic_year || compareText(a.name, b.name))
}

export function listTeachers(db: DB, userId: string): PublicProfile[] {
  requireSchoolAdminRead(db, userId)
  return db.profiles
    .filter((p) => p.app_role === 'DOCENTE')
    .map(publicProfile)
    .sort(compareNames)
}
