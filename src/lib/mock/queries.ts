// Modelos de lectura. Con Supabase serán consultas con RLS y vistas
// `security_invoker`; la forma de los datos devueltos se mantiene.

import {
  DOC_STATUSES,
  DOC_TYPES,
  MODULES,
  POSTING_EVENTS,
  ROLES,
  SELLABLE_PRODUCT_TYPES,
  TRANSITIONS,
  type StatusInfo,
} from '../domain/catalog'
import { TREASURY_RUBRO } from '../domain/chart-of-accounts'
import type * as T from '../domain/types'
import { date, money, qty, todayAR } from '../format'
import type { DB } from './db'
import {
  accountBalance,
  accountLabel,
  activeBomOf,
  accountLinesUpTo,
  bestQuote,
  bomLinesOf,
  can,
  customerCreditUsed,
  deliveryNoteLines,
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
  lastReconciliation,
  onHandQuantity,
  orderFromQuote,
  orderFromSalesQuote,
  plannedUnitCost,
  productionMaterialCost,
  productionOrderLines,
  productionShortages,
  quoteExpired,
  quoteIsValid,
  quotesOf,
  receiptLines,
  reconciledLineIds,
  requirePermission,
  requisitionAvailableQuantity,
  reservedQuantity,
  rfqLinesOf,
  round2,
  round3,
  INVOICED_SALES_STATUSES,
  salesInvoiceCommitted,
  salesInvoicedQuantity,
  salesInvoiceLabel,
  salesInvoiceLines,
  salesInvoicePending,
  salesLetter,
  salesOrderLines,
  salesQuoteLines,
  shortageText,
  type AccountLine,
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
  balances: (T.StockBalance & { warehouse_name: string; qty_reserved: number; qty_available: number })[]
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
      ? balancesOf(db, p.id).map((b) => {
          const reserved = reservedQuantity(db, p.id, b.warehouse_id)
          return {
            ...b,
            warehouse_name: db.warehouses.find((w) => w.id === b.warehouse_id)?.name ?? '',
            qty_reserved: reserved,
            qty_available: round3(b.qty_on_hand - reserved),
          }
        })
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
  /** Reservado para pedidos de venta en curso, y lo que queda disponible para vender. */
  reserved: number
  available: number
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
      const reserved = reservedQuantity(db, p.id, warehouse.id)
      rows.push({
        product: p,
        warehouse,
        qty: b.qty_on_hand,
        reserved,
        available: round3(b.qty_on_hand - reserved),
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
  customer_name: string
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
    case 'FUNDS_TRANSFER':
      return 0
    case 'BANK_RECONCILIATION':
      return db.brLines.filter((l) => l.document_id === doc.id).length
    case 'SALES_ORDER':
      return db.soLines.filter((l) => l.document_id === doc.id).length
    case 'DELIVERY_NOTE':
      return db.dnLines.filter((l) => l.document_id === doc.id).length
    case 'SALES_INVOICE':
      return db.fvLines.filter((l) => l.document_id === doc.id).length
    case 'CUSTOMER_RECEIPT':
      return db.rcLines.filter((l) => l.document_id === doc.id).length
    case 'SALES_QUOTE':
      return db.qtLines.filter((l) => l.document_id === doc.id).length
    case 'PRODUCTION_ORDER':
      return db.prdLines.filter((l) => l.document_id === doc.id).length
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
    case 'FUNDS_TRANSFER':
    case 'BANK_RECONCILIATION':
    case 'CUSTOMER_RECEIPT':
      return []
    case 'SUPPLIER_INVOICE':
      return db.siLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
    case 'RFQ':
      return rfqLinesOf(db, doc.id)
    case 'SUPPLIER_QUOTE':
      return db.sqLines.filter((l) => l.document_id === doc.id).sort(byLineNo)
    case 'SALES_ORDER':
      return salesOrderLines(db, doc.id)
    case 'DELIVERY_NOTE':
      return deliveryNoteLines(db, doc.id)
    case 'SALES_INVOICE':
      return salesInvoiceLines(db, doc.id)
    case 'SALES_QUOTE':
      return salesQuoteLines(db, doc.id)
    // La orden se resume por lo que fabrica, no por sus materiales.
    case 'PRODUCTION_ORDER':
      return [{ product_id: doc.pd!.product_id }]
  }
}

function listItem(db: DB, doc: T.Document): DocumentListItem {
  // Lo que resume cada fila: los productos o, en una orden de pago o un recibo de cobro, las facturas que cancela.
  const invoiceLines: { document_id: string; line_no: number; invoice_id: string }[] | null =
    doc.doc_type === 'PAYMENT_ORDER' ? db.opLines : doc.doc_type === 'CUSTOMER_RECEIPT' ? db.rcLines : null
  const products = invoiceLines
    ? invoiceLines
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
    customer_name: db.customers.find((c) => c.id === doc.customer_id)?.legal_name ?? '',
    sector_name: db.sectors.find((s) => s.id === doc.sector_id)?.name ?? '—',
    created_by_name: nameOf(db, doc.created_by),
    line_count: lineCount(db, doc),
    summary: doc.je
      ? doc.je.description
      : doc.ft
        ? `${db.accounts.find((a) => a.id === doc.ft!.from_account_id)?.name} → ${db.accounts.find((a) => a.id === doc.ft!.to_account_id)?.name}`
        : doc.br
          ? `${db.accounts.find((a) => a.id === doc.br!.account_id)?.name} al ${date(doc.br.statement_date)}`
          : doc.pd
            ? `${products[0]} ${db.products.find((p) => p.id === doc.pd!.product_id)?.name ?? ''}`
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
    'FUNDS_TRANSFER',
    'BANK_RECONCILIATION',
    'SALES_QUOTE',
    'SALES_ORDER',
    'DELIVERY_NOTE',
    'SALES_INVOICE',
    'CUSTOMER_RECEIPT',
    'PRODUCTION_ORDER',
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
    // Una acción puede llevar a estados distintos (confirmar un pedido): el botón es uno solo.
    if (result.some((r) => r.action === tr.action)) continue
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
    if (doc.doc_type === 'FUNDS_TRANSFER' && tr.action === 'CONFIRM') {
      const from = db.accounts.find((a) => a.id === doc.ft!.from_account_id)!
      const balance = accountBalance(db, from.id)
      if (doc.total > balance + 1e-9) reason = `No alcanza el saldo de ${accountLabel(from)}: hay ${money(balance)}.`
    }
    if (doc.doc_type === 'BANK_RECONCILIATION' && tr.action === 'CANCEL') {
      const last = lastReconciliation(db, doc.br!.account_id)
      if (last && last.id !== doc.id)
        reason = `Sólo se anula la última conciliación de la cuenta (${last.display_number}).`
    }
    if (doc.doc_type === 'FUNDS_TRANSFER' && doc.status === 'CONFIRMADA' && tr.action === 'CANCEL') {
      const to = db.accounts.find((a) => a.id === doc.ft!.to_account_id)!
      const balance = accountBalance(db, to.id)
      if (doc.total > balance + 1e-9)
        reason = `Los fondos ya se usaron: en ${accountLabel(to)} hay ${money(balance)}. Para devolverlos, prepará otra transferencia.`
    }
    if (doc.doc_type === 'SALES_ORDER') reason = salesOrderActionReason(db, userId, doc, tr.action) ?? reason
    if (
      doc.doc_type === 'CUSTOMER_RECEIPT' &&
      tr.action === 'CONFIRM' &&
      !eff.supervisor &&
      company.settings.sod_enabled &&
      db.rcLines.some((l) => l.document_id === doc.id && invoiceRegistrant(db, l.invoice_id) === userId)
    ) {
      reason = 'Separación de funciones: emitiste una de las facturas; tiene que cobrarla otro integrante de Tesorería.'
    }
    if (doc.doc_type === 'SALES_QUOTE') {
      const expired = quoteExpired(db, doc)
      if ((tr.action === 'SEND' || tr.action === 'CONFIRM') && expired)
        reason = `La oferta venció el ${date(doc.qt!.valid_until)}: prepará otro presupuesto con los precios del día.`
      if (tr.action === 'CLOSE' && !expired) reason = `Vale hasta el ${date(doc.qt!.valid_until)}: todavía no venció.`
    }
    if (doc.doc_type === 'PRODUCTION_ORDER' && tr.action === 'RELEASE') {
      const shortages = productionShortages(db, doc)
      if (shortages.length) reason = `Faltan materiales: ${shortages.map(shortageText).join('; ')}.`
    }
    if (doc.doc_type === 'CUSTOMER_RECEIPT' && doc.status === 'CONFIRMADO' && tr.action === 'CANCEL') {
      const account = db.accounts.find((a) => a.id === doc.rc!.treasury_account_id)!
      const balance = accountBalance(db, account.id)
      if (doc.total > balance + 1e-9)
        reason = `Los fondos ya se usaron: en ${accountLabel(account)} hay ${money(balance)}. Primero hay que anular el movimiento que los usó.`
    }
    if (doc.doc_type === 'DELIVERY_NOTE' && doc.status === 'CONFIRMADO' && tr.action === 'CANCEL') {
      const order = db.documents.find((d) => d.id === doc.dn!.sales_order_id)!
      if (
        company.settings.sod_enabled &&
        !eff.supervisor &&
        !eff.roles.includes('GERENCIA') &&
        invoiceRegistrant(db, doc.id) === userId
      )
        reason = 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularlo.'
      else if (order.status === 'CERRADO') reason = `${order.display_number} está cerrado: ya no se anula el remito.`
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

/** El pedido tiene algo entregado y todavía sin facturar. */
const uninvoicedDelivery = (db: DB, doc: T.Document) =>
  salesOrderLines(db, doc.id).some((l) => l.qty_delivered - salesInvoicedQuantity(db, l.id) > 1e-9)

/** Por qué no se puede confirmar, autorizar, anular o cerrar un pedido de venta; null si se puede. */
function salesOrderActionReason(db: DB, userId: string, doc: T.Document, action: T.TransitionAction) {
  const eff = effectivePermissions(db, userId, doc.company_id)
  const company = db.companies.find((c) => c.id === doc.company_id)!
  if (action === 'CONFIRM' && !company.settings.allow_negative_stock) {
    for (const l of salesOrderLines(db, doc.id)) {
      const p = db.products.find((x) => x.id === l.product_id)!
      if (!p.is_stockable) continue
      const available = round3(
        onHandQuantity(db, p.id, doc.so!.warehouse_id) - reservedQuantity(db, p.id, doc.so!.warehouse_id, doc.id),
      )
      if (l.quantity > available + 1e-9)
        return `Falta stock de ${p.code}: hay ${qty(Math.max(available, 0), p.uom_code)} disponibles y el pedido lleva ${qty(l.quantity, p.uom_code)}.`
    }
  }
  if (
    (action === 'APPROVE' || action === 'REJECT') &&
    !eff.supervisor &&
    company.settings.sod_enabled &&
    doc.created_by === userId
  )
    return 'Separación de funciones: no podés autorizar ni rechazar el crédito de un pedido que cargaste vos.'
  if (action === 'CANCEL' && salesOrderLines(db, doc.id).some((l) => l.qty_delivered > 1e-9))
    return 'Tiene entregas: usá "Cerrar saldo".'
  if (action === 'CANCEL' || action === 'CLOSE') {
    const draft = db.documents
      .filter((d) => d.doc_type === 'DELIVERY_NOTE' && d.status === 'BORRADOR' && d.dn!.sales_order_id === doc.id)
      .sort((a, b) => a.number - b.number)[0]
    if (draft) return `${draft.display_number} está en preparación: Depósito tiene que despacharlo o anularlo.`
  }
  return null
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
    case 'BANK_RECONCILIATION:CONFIRMADA':
      return {
        who: '—',
        text: `Cierra con el extracto al ${date(doc.br?.statement_date)}. Lo pendiente (${money(doc.br?.pending_credits ?? 0)} en pagos sin debitar y ${money(doc.br?.pending_debits ?? 0)} en entradas sin acreditar) se controla en la próxima conciliación.`,
      }
    case 'FUNDS_TRANSFER:BORRADOR':
      return {
        who: 'Tesorería',
        text: 'Revisar las cuentas y el importe, y confirmar la transferencia: se controla el saldo de la cuenta de origen y se genera el asiento.',
      }
    case 'FUNDS_TRANSFER:CONFIRMADA': {
      const from = db.accounts.find((a) => a.id === doc.ft?.from_account_id)
      const to = db.accounts.find((a) => a.id === doc.ft?.to_account_id)
      return {
        who: '—',
        text: `Se transfirió el ${date(doc.ft?.transferred_on)} de ${from?.name ?? '—'} a ${to?.name ?? '—'}: el movimiento está en el libro diario y no cambia el total de los fondos.`,
      }
    }
    case 'SALES_ORDER:BORRADOR':
      return {
        who: 'Ventas',
        text: 'Revisar el cliente, los ítems, los precios y el depósito, y confirmar el pedido: se controla el stock disponible y el crédito del cliente, y se reserva la mercadería.',
      }
    case 'SALES_ORDER:PENDIENTE_APROBACION':
      return {
        who: 'Gerencia',
        text: `${doc.so?.credit_reason ?? ''} Autorizar el crédito o rechazar el pedido con motivo; mientras tanto, la mercadería queda reservada. Quien cargó el pedido no puede autorizarlo: es un control de separación de funciones.`.trim(),
      }
    case 'SALES_ORDER:CONFIRMADO': {
      const warehouse = db.warehouses.find((w) => w.id === doc.so?.warehouse_id)
      return {
        who: 'Depósito',
        text: `La mercadería está reservada en ${warehouse?.name ?? 'el depósito'}. Prepararla, cargar el remito y despacharlo.`,
      }
    }
    case 'SALES_ORDER:ENTREGADO_PARCIAL':
      return {
        who: 'Depósito o Ventas',
        text: 'Falta entregar el saldo, que sigue reservado. Si no se va a entregar, Ventas puede cerrar el saldo con motivo.',
      }
    case 'SALES_ORDER:ENTREGADO':
      return uninvoicedDelivery(db, doc)
        ? { who: 'Ventas', text: 'Se entregó todo lo pedido: falta facturar lo entregado.' }
        : {
            who: '—',
            text: 'Se entregó y se facturó todo lo pedido: la deuda está en la cuenta corriente del cliente.',
          }
    case 'SALES_ORDER:CERRADO':
      return uninvoicedDelivery(db, doc)
        ? { who: 'Ventas', text: 'Se cerró con saldo sin entregar: falta facturar lo que sí se entregó.' }
        : { who: '—', text: DOC_STATUSES.SALES_ORDER.CERRADO.description }
    case 'SALES_INVOICE:BORRADOR':
      return {
        who: 'Ventas',
        text: 'Revisar las cantidades contra lo entregado y registrar la factura: se le asigna el número y se generan el asiento de venta y la deuda del cliente.',
      }
    case 'SALES_INVOICE:REGISTRADA':
      return {
        who: 'Tesorería',
        text: `La deuda está en la cuenta corriente del cliente y vence el ${date(doc.fv?.due_date)}. Se cancela cuando el cliente paga, con un recibo de cobro.`,
      }
    case 'SALES_INVOICE:COBRADA_PARCIAL':
      return {
        who: 'Tesorería',
        text: `El cliente pagó una parte: quedan ${money(salesInvoicePending(db, doc))} en su cuenta corriente (vence el ${date(doc.fv?.due_date)}). El saldo se cancela con otro recibo de cobro.`,
      }
    case 'SALES_QUOTE:BORRADOR':
      return {
        who: 'Ventas',
        text: quoteExpired(db, doc)
          ? `Venció el ${date(doc.qt?.valid_until)}: anularlo y, si hace falta, preparar otro con los precios del día.`
          : 'Revisar los ítems, los precios y la validez, e imprimir el presupuesto para enviárselo al cliente.',
      }
    case 'SALES_QUOTE:ENVIADO':
      return {
        who: 'Ventas',
        text: quoteExpired(db, doc)
          ? `La oferta venció el ${date(doc.qt?.valid_until)}: darlo por vencido y, si el cliente sigue interesado, preparar otro con los precios del día.`
          : `El cliente tiene hasta el ${date(doc.qt?.valid_until)} para responder. Si acepta, se registra la aceptación y se genera el pedido de venta; si no, el rechazo con su motivo.`,
      }
    case 'SALES_QUOTE:ACEPTADO':
      return {
        who: 'Ventas',
        text: `El cliente lo aceptó: se generó ${orderFromSalesQuote(db, doc.id)?.display_number ?? 'el pedido de venta'} en borrador. Ventas lo revisa y lo confirma: ahí se controlan el stock y el crédito.`,
      }
    case 'SALES_QUOTE:RECHAZADO':
      return { who: '—', text: `Motivo del cliente: "${doc.status_reason}".` }
    case 'CUSTOMER_RECEIPT:BORRADOR':
      return {
        who: 'Tesorería',
        text: 'Revisar las facturas, los importes, el medio de cobro y la caja o el banco, y confirmar el cobro: se genera el asiento y baja la deuda del cliente. Quien emitió una de las facturas no puede registrar su cobro.',
      }
    case 'CUSTOMER_RECEIPT:CONFIRMADO':
      return {
        who: '—',
        text: `Se cobró el ${date(doc.rc?.received_on)}: la deuda bajó en la cuenta corriente del cliente y el cobro está en el libro diario.${doc.rc?.payment_method === 'CHEQUE' ? ' Para depositar el cheque en el banco, Tesorería prepara una transferencia entre cuentas.' : ''}`,
      }
    case 'SALES_ORDER:RECHAZADO':
      return {
        who: 'Ventas',
        text: `Motivo del rechazo: "${doc.status_reason}". Si el cliente achica el pedido o paga lo que debe, se carga otro.`,
      }
    case 'DELIVERY_NOTE:BORRADOR':
      return {
        who: 'Depósito',
        text: 'Preparar la mercadería, controlarla contra el remito y despacharlo: baja el stock, se libera la reserva y se registra el costo de lo vendido.',
      }
    case 'DELIVERY_NOTE:CONFIRMADO':
      return {
        who: '—',
        text: 'La mercadería salió: bajó el stock (ver kardex), el costo de lo vendido está en el libro diario y Ventas fue notificada.',
      }
    case 'PRODUCTION_ORDER:BORRADOR': {
      const shortages = productionShortages(db, doc)
      return {
        who: 'Producción',
        text: shortages.length
          ? `Faltan materiales: ${shortages.map(shortageText).join('; ')}. Pedíselos a Compras (o fabricá menos unidades) y liberá la orden cuando lleguen.`
          : 'Revisar el producto, la cantidad y los materiales, y liberar la orden: se controla que haya materiales y quedan reservados para Depósito.',
      }
    }
    case 'PRODUCTION_ORDER:LIBERADA': {
      const warehouse = db.warehouses.find((w) => w.id === doc.pd?.materials_warehouse_id)
      return {
        who: 'Depósito',
        text: `Los materiales están reservados en ${warehouse?.name ?? 'el depósito'}. Prepararlos, entregárselos a Producción y registrar lo que sale de cada uno.`,
      }
    }
    case 'PRODUCTION_ORDER:EN_PROCESO':
      return {
        who: 'Producción',
        text: 'Fabricar y, al terminar, registrar las unidades que salieron bien: entran al stock a su costo real.',
      }
    case 'PRODUCTION_ORDER:TERMINADA': {
      const product = db.products.find((p) => p.id === doc.pd?.product_id)
      return {
        who: '—',
        text: `Ingresaron ${qty(doc.pd?.quantity_produced ?? 0, product?.uom_code)} de ${product?.code ?? '—'} a ${money(doc.pd?.unit_cost ?? 0)} por unidad (ver kardex): el costo pasó de productos en proceso a productos terminados.`,
      }
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
  // PV: precio de venta del producto (la bonificación se mide contra él), lo entregado, lo facturado y lo disponible
  list_price?: number
  qty_delivered?: number
  qty_invoiced?: number
  /** En el depósito del pedido, sin lo reservado para otros pedidos; null en los servicios. */
  qty_available?: number | null
  // REM
  so_line_id?: string
  qty_ordered_so?: number
  // OPR: lo previsto de cada material (y a qué costo) y lo que entregó Depósito (y a qué costo salió)
  planned_unit_cost?: number
  qty_issued?: number
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

/** Una factura que cancela la orden de pago o el recibo de cobro, y cuánto de ella. */
export interface PaymentLineView {
  id: string
  line_no: number
  invoice: {
    id: string
    display_number: string
    path: string
    /** Comprobante: "A 00003-00012874". */
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
  payment_method: T.PaymentMethod | null
  lines: PaymentLineView[]
}

/** Recibo de cobro: dónde ingresó el dinero, con qué medio y qué facturas cancela. */
export interface ReceiptView {
  treasury_account: { id: string; code: string; name: string }
  payment_method: T.PaymentMethod
  reference: string
  received_on: string | null
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

/** Transferencia entre cuentas: de qué caja o banco a cuál. */
export interface TransferView {
  from_account: { id: string; code: string; name: string }
  to_account: { id: string; code: string; name: string }
  reference: string
  transferred_on: string | null
}

/** Un movimiento del mayor de una caja o un banco, para conciliarlo. */
export interface ReconciliationLineView {
  line_id: string
  document_id: string
  display_number: string
  path: string
  entry_number: number
  date: string
  description: string
  debit: number
  credit: number
}

/** Conciliación bancaria: el extracto contra el mayor, y lo que quedó pendiente. */
export interface ReconciliationView {
  account: { id: string; code: string; name: string }
  statement_date: string
  statement_balance: number
  book_balance: number
  pending_debits: number
  pending_credits: number
  /** Los movimientos que figuraban en el extracto. */
  reconciled: ReconciliationLineView[]
  /** Los que no figuraban todavía: entradas sin acreditar y pagos sin debitar. */
  pending: ReconciliationLineView[]
}

/** Pedido de venta: sus condiciones y el crédito del cliente. */
export interface SalesOrderView {
  delivery_date: string | null
  payment_terms_days: number
  customer_reference: string
  credit_reason: string
  confirmed_at: string | null
  /** Límite de crédito del cliente (null: sin límite) y lo que usa sin contar este pedido. */
  credit_limit: number | null
  credit_used: number
}

/** Presupuesto: hasta cuándo vale la oferta y, si se aceptó, el pedido que generó. */
export interface SalesQuoteView {
  valid_until: string
  /** La oferta venció (mientras está en borrador o enviado). */
  expired: boolean
  payment_terms_days: number
  customer_reference: string
  order: DocRef | null
}

/** Orden de producción: qué se fabrica, de qué depósito a cuál, y su costo previsto y real. */
export interface ProductionOrderView {
  product: { id: string; code: string; name: string; uom_code: string }
  quantity: number
  quantity_produced: number | null
  materials_warehouse: { id: string; code: string; name: string }
  output_warehouse: { id: string; code: string; name: string }
  due_date: string | null
  released_at: string | null
  issued_at: string | null
  finished_at: string | null
  /** Costo previsto de los materiales (al planificarla). */
  planned_cost: number
  /** Costo de los materiales entregados (0 hasta la entrega). */
  material_cost: number
  /** Costo real de cada unidad terminada (al terminarla). */
  unit_cost: number | null
}

/** Remito: quién lo lleva, cuándo salió y a qué costo. */
export interface DeliveryView {
  carrier_name: string
  dispatched_at: string | null
  /** Costo de lo que salió del depósito, al promedio del despacho (0 mientras está en preparación). */
  cost_total: number
}

export interface DocumentDetail {
  doc: DocumentListItem
  lines: DetailLine[]
  journal: JournalView | null
  payment: PaymentView | null
  receipt: ReceiptView | null
  rfq: RfqView | null
  quote: QuoteView | null
  transfer: TransferView | null
  reconciliation: ReconciliationView | null
  sales_order: SalesOrderView | null
  sales_quote: SalesQuoteView | null
  production_order: ProductionOrderView | null
  delivery: DeliveryView | null
  supplier: T.Supplier | null
  customer: T.Customer | null
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
  if (doc.doc_type === 'SALES_ORDER') {
    lines = salesOrderLines(db, doc.id).map((l) => {
      const p = product(l.product_id)
      return {
        id: l.id,
        line_no: l.line_no,
        product: p,
        quantity: l.quantity,
        notes: '',
        unit_price: l.unit_price,
        list_price: l.list_price,
        vat_rate: l.vat_rate,
        line_subtotal: l.line_subtotal,
        line_tax: l.line_tax,
        line_total: l.line_total,
        qty_delivered: l.qty_delivered,
        qty_invoiced: salesInvoicedQuantity(db, l.id),
        qty_available: p.is_stockable
          ? round3(
              onHandQuantity(db, p.id, doc.so!.warehouse_id) - reservedQuantity(db, p.id, doc.so!.warehouse_id, doc.id),
            )
          : null,
      }
    })
  }
  if (doc.doc_type === 'SALES_QUOTE') {
    lines = salesQuoteLines(db, doc.id).map((l) => ({
      id: l.id,
      line_no: l.line_no,
      product: product(l.product_id),
      quantity: l.quantity,
      notes: '',
      unit_price: l.unit_price,
      list_price: l.list_price,
      vat_rate: l.vat_rate,
      line_subtotal: l.line_subtotal,
      line_tax: l.line_tax,
      line_total: l.line_total,
    }))
  }
  if (doc.doc_type === 'PRODUCTION_ORDER') {
    const warehouseId = doc.pd!.materials_warehouse_id
    const pending = doc.status === 'BORRADOR' || doc.status === 'LIBERADA'
    lines = productionOrderLines(db, doc.id).map((l) => ({
      id: l.id,
      line_no: l.line_no,
      product: product(l.product_id),
      quantity: l.quantity_planned,
      notes: '',
      planned_unit_cost: l.planned_unit_cost,
      qty_issued: l.quantity_issued,
      unit_cost: l.unit_cost,
      // Mientras no se entregó: lo disponible en el depósito, sin lo reservado para otros.
      qty_available: pending
        ? round3(
            onHandQuantity(db, l.product_id, warehouseId) - reservedQuantity(db, l.product_id, warehouseId, doc.id),
          )
        : null,
    }))
  }
  if (doc.doc_type === 'DELIVERY_NOTE') {
    lines = deliveryNoteLines(db, doc.id).map((l) => {
      const sl = db.soLines.find((x) => x.id === l.so_line_id)!
      return {
        id: l.id,
        line_no: l.line_no,
        product: product(l.product_id),
        quantity: l.quantity,
        notes: l.notes,
        so_line_id: l.so_line_id,
        qty_ordered_so: sl.quantity,
        qty_delivered: sl.qty_delivered,
        unit_price: sl.unit_price,
        unit_cost: l.unit_cost,
      }
    })
  }
  if (doc.doc_type === 'SALES_INVOICE') {
    lines = salesInvoiceLines(db, doc.id).map((l) => {
      const sl = db.soLines.find((x) => x.id === l.so_line_id)!
      return {
        id: l.id,
        line_no: l.line_no,
        product: product(l.product_id),
        quantity: l.quantity,
        notes: '',
        so_line_id: l.so_line_id,
        qty_ordered_so: sl.quantity,
        qty_delivered: sl.qty_delivered,
        unit_price: l.unit_price,
        vat_rate: l.vat_rate,
        line_subtotal: l.line_subtotal,
        line_tax: l.line_tax,
        line_total: l.line_total,
      }
    })
  }
  const warehouseId =
    doc.po?.warehouse_id ??
    doc.gr?.warehouse_id ??
    doc.sa?.warehouse_id ??
    doc.rq?.warehouse_id ??
    doc.so?.warehouse_id ??
    doc.dn?.warehouse_id ??
    doc.qt?.warehouse_id ??
    doc.pd?.materials_warehouse_id
  const orderId =
    doc.gr?.purchase_order_id ?? doc.si?.purchase_order_id ?? doc.dn?.sales_order_id ?? doc.fv?.sales_order_id
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
                : doc.doc_type === 'FUNDS_TRANSFER'
                  ? [
                      { label: 'Preparó', ...firstBy(['CREATE']) },
                      { label: 'Confirmó', ...firstBy(['CONFIRM']) },
                    ]
                  : doc.doc_type === 'BANK_RECONCILIATION'
                    ? [
                        { label: 'Concilió', ...firstBy(['CREATE']) },
                        { label: 'Revisó', name: '', sector: '', at: '' },
                      ]
                    : doc.doc_type === 'SALES_ORDER'
                      ? [
                          { label: 'Vendió', ...firstBy(['CONFIRM', 'CREATE']) },
                          { label: 'Autorizó el crédito', ...firstBy(['APPROVE']) },
                        ]
                      : doc.doc_type === 'DELIVERY_NOTE'
                        ? [
                            { label: 'Despachó', ...firstBy(['CONFIRM', 'CREATE']) },
                            { label: 'Recibió conforme (cliente)', name: '', sector: '', at: '' },
                          ]
                        : doc.doc_type === 'SALES_INVOICE'
                          ? [
                              { label: 'Emitió', ...firstBy(['CONFIRM', 'CREATE']) },
                              { label: 'Controló', name: '', sector: '', at: '' },
                            ]
                          : doc.doc_type === 'CUSTOMER_RECEIPT'
                            ? [
                                { label: 'Preparó', ...firstBy(['CREATE']) },
                                { label: 'Cobró', ...firstBy(['CONFIRM']) },
                              ]
                            : doc.doc_type === 'SALES_QUOTE'
                              ? [
                                  { label: 'Preparó', ...firstBy(['CREATE']) },
                                  { label: 'Conformidad del cliente', name: '', sector: '', at: '' },
                                ]
                              : doc.doc_type === 'PRODUCTION_ORDER'
                                ? [
                                    { label: 'Planificó', ...firstBy(['CREATE']) },
                                    { label: 'Entregó los materiales', ...firstBy(['ISSUE']) },
                                    { label: 'Terminó', ...firstBy(['FINISH']) },
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
    receipt: doc.rc ? receiptView(db, doc) : null,
    rfq: doc.rq ? rfqView(db, doc) : null,
    quote: doc.sq ? quoteView(db, doc) : null,
    transfer: doc.ft ? transferView(db, doc) : null,
    reconciliation: doc.br ? reconciliationView(db, doc) : null,
    sales_order: doc.so ? salesOrderView(db, doc) : null,
    sales_quote: doc.qt ? salesQuoteView(db, doc) : null,
    production_order: doc.pd ? productionOrderView(db, doc) : null,
    delivery: doc.dn ? deliveryView(db, doc) : null,
    supplier: db.suppliers.find((s) => s.id === doc.supplier_id) ?? null,
    customer: db.customers.find((c) => c.id === doc.customer_id) ?? null,
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

function productionOrderView(db: DB, doc: T.Document): ProductionOrderView {
  const pd = doc.pd!
  const product = db.products.find((p) => p.id === pd.product_id)!
  const warehouse = (id: string) => {
    const w = db.warehouses.find((x) => x.id === id)!
    return { id: w.id, code: w.code, name: w.name }
  }
  return {
    product: { id: product.id, code: product.code, name: product.name, uom_code: product.uom_code },
    quantity: pd.quantity,
    quantity_produced: pd.quantity_produced,
    materials_warehouse: warehouse(pd.materials_warehouse_id),
    output_warehouse: warehouse(pd.output_warehouse_id),
    due_date: pd.due_date,
    released_at: pd.released_at,
    issued_at: pd.issued_at,
    finished_at: pd.finished_at,
    planned_cost: doc.subtotal,
    material_cost: productionMaterialCost(db, doc.id),
    unit_cost: pd.unit_cost,
  }
}

function salesOrderView(db: DB, doc: T.Document): SalesOrderView {
  const so = doc.so!
  const customer = db.customers.find((c) => c.id === doc.customer_id)!
  return {
    delivery_date: so.delivery_date,
    payment_terms_days: so.payment_terms_days,
    customer_reference: so.customer_reference,
    credit_reason: so.credit_reason,
    confirmed_at: so.confirmed_at,
    credit_limit: customer.credit_limit,
    credit_used: customerCreditUsed(db, customer.id, doc.id),
  }
}

function salesQuoteView(db: DB, doc: T.Document): SalesQuoteView {
  const qt = doc.qt!
  const order = doc.status === 'ACEPTADO' ? orderFromSalesQuote(db, doc.id) : undefined
  return {
    valid_until: qt.valid_until,
    expired: ['BORRADOR', 'ENVIADO'].includes(doc.status) && quoteExpired(db, doc),
    payment_terms_days: qt.payment_terms_days,
    customer_reference: qt.customer_reference,
    order: order ? docRef(db, order) : null,
  }
}

function deliveryView(db: DB, doc: T.Document): DeliveryView {
  return {
    carrier_name: doc.dn!.carrier_name,
    dispatched_at: doc.dn!.dispatched_at,
    cost_total: round2(deliveryNoteLines(db, doc.id).reduce((s, l) => s + round2(l.quantity * l.unit_cost), 0)),
  }
}

function paymentView(db: DB, doc: T.Document): PaymentView {
  const op = doc.op!
  const account = db.accounts.find((a) => a.id === op.treasury_account_id)!
  return {
    treasury_account: { id: account.id, code: account.code, name: account.name },
    payment_reference: op.payment_reference,
    paid_on: op.paid_on,
    payment_method: op.payment_method,
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

function receiptView(db: DB, doc: T.Document): ReceiptView {
  const rc = doc.rc!
  const account = db.accounts.find((a) => a.id === rc.treasury_account_id)!
  return {
    treasury_account: { id: account.id, code: account.code, name: account.name },
    payment_method: rc.payment_method,
    reference: rc.reference,
    received_on: rc.received_on,
    lines: receiptLines(db, doc.id).map((l) => {
      const invoice = db.documents.find((d) => d.id === l.invoice_id)!
      return {
        id: l.id,
        line_no: l.line_no,
        invoice: {
          id: invoice.id,
          display_number: invoice.display_number,
          path: docPath(db, invoice),
          invoice_label: salesInvoiceLabel(invoice.fv!),
          document_date: invoice.document_date,
          due_date: invoice.fv!.due_date,
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

const reconciliationLine = (db: DB, { line, doc }: AccountLine): ReconciliationLineView => ({
  line_id: line.id,
  document_id: doc.id,
  display_number: doc.display_number,
  path: docPath(db, doc),
  entry_number: doc.je!.entry_number!,
  date: doc.document_date,
  description: line.notes || doc.je!.description,
  debit: line.debit,
  credit: line.credit,
})

function reconciliationView(db: DB, doc: T.Document): ReconciliationView {
  const br = doc.br!
  const account = db.accounts.find((a) => a.id === br.account_id)!
  const own = new Set(db.brLines.filter((l) => l.document_id === doc.id).map((l) => l.journal_line_id))
  // Lo pendiente a la fecha de esta conciliación: ni lo concilió ella ni una anterior.
  const before = reconciledLineIds(db, account.id, doc.number - 1)
  const lines = accountLinesUpTo(db, account.id, br.statement_date)
  return {
    account: { id: account.id, code: account.code, name: account.name },
    statement_date: br.statement_date,
    statement_balance: br.statement_balance,
    book_balance: br.book_balance,
    pending_debits: br.pending_debits,
    pending_credits: br.pending_credits,
    reconciled: lines.filter(({ line }) => own.has(line.id)).map((l) => reconciliationLine(db, l)),
    pending: lines
      .filter(({ line }) => !own.has(line.id) && !before.has(line.id))
      .map((l) => reconciliationLine(db, l)),
  }
}

function transferView(db: DB, doc: T.Document): TransferView {
  const ref = (id: string) => {
    const a = db.accounts.find((x) => x.id === id)!
    return { id: a.id, code: a.code, name: a.name }
  }
  return {
    from_account: ref(doc.ft!.from_account_id),
    to_account: ref(doc.ft!.to_account_id),
    reference: doc.ft!.reference,
    transferred_on: doc.ft!.transferred_on,
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

// ============================================================ Ventas (docs/FASE_4_VENTAS_Y_CLIENTES.md)

/** Un cliente para el pedido de venta: su condición de pago y su crédito. */
export interface SalesCustomer {
  id: string
  code: string
  legal_name: string
  vat_condition: T.VatCondition
  payment_terms_days: number
  credit_limit: number | null
  /** Lo que ya usa del crédito: pedidos sin facturar (y, desde 4b, facturas sin cobrar). */
  credit_used: number
  /** Su lista de precios, si tiene una activa (4d). */
  price_list: { id: string; code: string; name: string } | null
}

export function salesCustomers(db: DB, userId: string, companyId: string): SalesCustomer[] {
  assertPerm(db, userId, companyId, 'sales_order.create')
  return db.customers
    .filter((c) => c.company_id === companyId && c.is_active)
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((c) => ({
      id: c.id,
      code: c.code,
      legal_name: c.legal_name,
      vat_condition: c.vat_condition,
      payment_terms_days: c.payment_terms_days,
      credit_limit: c.credit_limit,
      credit_used: customerCreditUsed(db, c.id),
      price_list: activeListOf(db, c),
    }))
}

/** La lista de precios activa de un cliente, si tiene. */
function activeListOf(db: DB, customer: T.Customer) {
  const list = customer.price_list_id ? db.priceLists.find((l) => l.id === customer.price_list_id) : undefined
  return list?.is_active ? { id: list.id, code: list.code, name: list.name } : null
}

/** Lo que hay de un producto en un depósito, lo reservado para pedidos y lo disponible. */
export interface WarehouseAvailability {
  warehouse_id: string
  on_hand: number
  reserved: number
  available: number
}

export interface SellableProduct {
  id: string
  code: string
  name: string
  uom_code: string
  product_type: T.ProductType
  is_stockable: boolean
  sale_price: number | null
  /** La alícuota que se factura: la del producto, o 0 si la empresa no es responsable inscripta. */
  vat_rate: number
  /** Por depósito, en orden de código; vacío en los servicios. */
  stock: WarehouseAvailability[]
  /** Su precio en cada lista activa que lo tiene, por código de lista (4d). */
  list_prices: { price_list_id: string; unit_price: number }[]
}

function availabilityOf(db: DB, companyId: string, productId: string): WarehouseAvailability[] {
  return db.warehouses
    .filter((w) => w.company_id === companyId)
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((w) => {
      const onHand = onHandQuantity(db, productId, w.id)
      const reserved = reservedQuantity(db, productId, w.id)
      return { warehouse_id: w.id, on_hand: onHand, reserved, available: round3(onHand - reserved) }
    })
}

/** Lo que se puede vender, con su precio y lo disponible en cada depósito (para cargar el pedido). */
export function salesCatalog(db: DB, userId: string, companyId: string): SellableProduct[] {
  assertPerm(db, userId, companyId, 'sales_order.create')
  const company = db.companies.find((c) => c.id === companyId)!
  return db.products
    .filter((p) => p.company_id === companyId && p.is_active && SELLABLE_PRODUCT_TYPES.includes(p.product_type))
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      uom_code: p.uom_code,
      product_type: p.product_type,
      is_stockable: p.is_stockable,
      sale_price: p.sale_price,
      vat_rate: company.vat_condition === 'RESPONSABLE_INSCRIPTO' ? p.vat_rate : 0,
      stock: p.is_stockable ? availabilityOf(db, companyId, p.id) : [],
      list_prices: db.priceListItems
        .filter((i) => i.product_id === p.id)
        .map((i) => ({ item: i, list: db.priceLists.find((l) => l.id === i.price_list_id)! }))
        .filter(({ list }) => list.is_active)
        .sort((a, b) => compareCodes(a.list.code, b.list.code))
        .map(({ item }) => ({ price_list_id: item.price_list_id, unit_price: item.unit_price })),
    }))
}

// ============================================================ Listas de precios (docs/FASE_4_VENTAS_Y_CLIENTES.md §6)

export interface PriceListRow {
  list: T.PriceList
  /** Productos con precio en la lista. */
  items: number
  /** Clientes que la tienen asignada. */
  customers: number
}

/** Las listas de precios de la empresa, por código. */
export function listPriceLists(db: DB, userId: string, companyId: string): PriceListRow[] {
  assertPerm(db, userId, companyId, 'price_list.read')
  return db.priceLists
    .filter((l) => l.company_id === companyId)
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((l) => ({
      list: l,
      items: db.priceListItems.filter((i) => i.price_list_id === l.id).length,
      customers: db.customers.filter((c) => c.price_list_id === l.id).length,
    }))
}

export interface PriceListProduct {
  id: string
  code: string
  name: string
  uom_code: string
  product_type: T.ProductType
  sale_price: number | null
  is_active: boolean
}

export interface PriceListDetail {
  list: T.PriceList
  /** El precio de cada producto de la lista, por código. */
  items: { product: PriceListProduct; unit_price: number }[]
  customers: { id: string; code: string; legal_name: string; is_active: boolean }[]
  /** Lo que se vende y todavía no está en la lista: para agregarlo. */
  missing: PriceListProduct[]
}

const priceListProduct = (p: T.Product): PriceListProduct => ({
  id: p.id,
  code: p.code,
  name: p.name,
  uom_code: p.uom_code,
  product_type: p.product_type,
  sale_price: p.sale_price,
  is_active: p.is_active,
})

/** Una lista de precios con sus productos, sus clientes y lo que le falta (null si no existe). */
export function priceListDetail(db: DB, userId: string, companyId: string, code: string): PriceListDetail | null {
  assertPerm(db, userId, companyId, 'price_list.read')
  const list = db.priceLists.find((l) => l.company_id === companyId && l.code === code)
  if (!list) return null
  const items = db.priceListItems
    .filter((i) => i.price_list_id === list.id)
    .map((i) => ({
      product: priceListProduct(db.products.find((p) => p.id === i.product_id)!),
      unit_price: i.unit_price,
    }))
    .sort((a, b) => compareCodes(a.product.code, b.product.code))
  const inList = new Set(items.map((i) => i.product.id))
  return {
    list,
    items,
    customers: db.customers
      .filter((c) => c.company_id === companyId && c.price_list_id === list.id)
      .sort((a, b) => compareCodes(a.code, b.code))
      .map((c) => ({ id: c.id, code: c.code, legal_name: c.legal_name, is_active: c.is_active })),
    missing: db.products
      .filter(
        (p) =>
          p.company_id === companyId &&
          p.is_active &&
          SELLABLE_PRODUCT_TYPES.includes(p.product_type) &&
          !inList.has(p.id),
      )
      .sort((a, b) => compareCodes(a.code, b.code))
      .map(priceListProduct),
  }
}

export interface DispatchableOrder {
  order: DocumentListItem
  warehouse: T.Warehouse
  lines: {
    line: T.SalesOrderLine
    product: T.Product
    /** Lo que falta entregar. */
    pending: number
    /** Lo que hay en el depósito del pedido (null en los servicios). */
    on_hand: number | null
  }[]
}

/** Pedidos confirmados con algo por entregar (para preparar el remito). */
export function dispatchableOrders(db: DB, userId: string, companyId: string): DispatchableOrder[] {
  assertPerm(db, userId, companyId, 'delivery_note.create')
  return db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'SALES_ORDER' &&
        ['CONFIRMADO', 'ENTREGADO_PARCIAL'].includes(d.status),
    )
    .sort((a, b) => a.number - b.number)
    .map((d) => ({
      order: listItem(db, d),
      warehouse: db.warehouses.find((w) => w.id === d.so!.warehouse_id)!,
      lines: salesOrderLines(db, d.id)
        .map((l) => {
          const p = db.products.find((x) => x.id === l.product_id)!
          return {
            line: l,
            product: p,
            pending: round3(l.quantity - l.qty_delivered),
            on_hand: p.is_stockable ? onHandQuantity(db, p.id, d.so!.warehouse_id) : null,
          }
        })
        .filter((x) => x.pending > 1e-9),
    }))
    .filter((o) => o.lines.length)
}

export interface InvoiceableSalesOrder {
  order: DocumentListItem
  /** La letra que tendrá la factura (según la condición del cliente). */
  letter: T.SalesInvoiceHeader['letter']
  lines: {
    line: T.SalesOrderLine
    product: T.Product
    invoiced: number
    /** Entregado menos facturado: lo que todavía se puede facturar. */
    pending: number
  }[]
}

/** Pedidos con algo entregado y todavía sin facturar (para emitir la factura de venta). */
export function invoiceableSalesOrders(db: DB, userId: string, companyId: string): InvoiceableSalesOrder[] {
  assertPerm(db, userId, companyId, 'sales_invoice.create')
  const company = db.companies.find((c) => c.id === companyId)!
  return db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'SALES_ORDER' &&
        ['ENTREGADO_PARCIAL', 'ENTREGADO', 'CERRADO'].includes(d.status),
    )
    .sort((a, b) => a.number - b.number)
    .map((d) => ({
      order: listItem(db, d),
      letter: salesLetter(
        company,
        db.customers.find((c) => c.id === d.customer_id)!,
      ),
      lines: salesOrderLines(db, d.id)
        .map((l) => {
          const invoiced = salesInvoicedQuantity(db, l.id)
          return {
            line: l,
            product: db.products.find((p) => p.id === l.product_id)!,
            invoiced,
            pending: round3(l.qty_delivered - invoiced),
          }
        })
        .filter((x) => x.pending > 1e-9),
    }))
    .filter((o) => o.lines.length)
}

// ============================================================ Cuentas corrientes de clientes (docs/FASE_4_VENTAS_Y_CLIENTES.md §4)

export interface ReceivableInvoice {
  id: string
  display_number: string
  path: string
  /** Comprobante: "A 00001-00000012". */
  invoice_label: string
  document_date: string
  due_date: string
  total: number
  collected: number
  pending: number
  overdue: boolean
}

/** Tramos de la antigüedad de saldos: a vencer y vencido de 1 a 30, de 31 a 60, de 61 a 90 y más de 90 días. */
export type AgingKey = 'A_VENCER' | 'DE_1_A_30' | 'DE_31_A_60' | 'DE_61_A_90' | 'MAS_DE_90'

export interface ReceivableRow {
  customer: {
    id: string
    code: string
    legal_name: string
    tax_id: string
    payment_terms_days: number
    credit_limit: number | null
  }
  balance: number
  invoices: number
  overdue: number
  next_due: string | null
  /** Lo pendiente según los días que lleva vencido. */
  aging: Record<AgingKey, number>
}

/** Hasta cuántos días de vencida entra una factura en cada tramo. */
const AGING_BUCKETS: [AgingKey, number][] = [
  ['A_VENCER', 0],
  ['DE_1_A_30', 30],
  ['DE_31_A_60', 60],
  ['DE_61_A_90', 90],
  ['MAS_DE_90', Infinity],
]

/** Antigüedad de saldos de unas facturas pendientes. */
function agingOf(pending: ReceivableInvoice[], today: string): Record<AgingKey, number> {
  const aging = Object.fromEntries(AGING_BUCKETS.map(([key]) => [key, 0])) as Record<AgingKey, number>
  for (const i of pending) {
    const days = daysBetween(i.due_date, today)
    const [key] = AGING_BUCKETS.find(([, upTo]) => days <= upTo)!
    aging[key] = round2(aging[key] + i.pending)
  }
  return aging
}

function receivableInvoice(db: DB, doc: T.Document, today: string): ReceivableInvoice {
  const pending = salesInvoicePending(db, doc)
  return {
    id: doc.id,
    display_number: doc.display_number,
    path: docPath(db, doc),
    invoice_label: salesInvoiceLabel(doc.fv!),
    document_date: doc.document_date,
    due_date: doc.fv!.due_date,
    total: doc.total,
    collected: round2(doc.total - pending),
    pending,
    overdue: doc.fv!.due_date < today && pending > 0,
  }
}

/** Facturas de venta registradas (que generaron deuda) de una empresa. */
function registeredSalesInvoices(db: DB, companyId: string) {
  return db.documents.filter(
    (d) => d.company_id === companyId && d.doc_type === 'SALES_INVOICE' && INVOICED_SALES_STATUSES.includes(d.status),
  )
}

/** Lo que debe cada cliente con facturas registradas, por código, con la antigüedad de su saldo. */
export function listReceivables(db: DB, userId: string, companyId: string): ReceivableRow[] {
  assertPerm(db, userId, companyId, 'receivable.read')
  const today = todayAR()
  const invoices = registeredSalesInvoices(db, companyId)
  return db.customers
    .filter((c) => c.company_id === companyId && invoices.some((d) => d.customer_id === c.id))
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((c) => {
      const pending = invoices
        .filter((d) => d.customer_id === c.id)
        .map((d) => receivableInvoice(db, d, today))
        .filter((i) => i.pending > 0)
      const dues = pending.map((i) => i.due_date).sort(compareCodes)
      return {
        customer: {
          id: c.id,
          code: c.code,
          legal_name: c.legal_name,
          tax_id: c.tax_id,
          payment_terms_days: c.payment_terms_days,
          credit_limit: c.credit_limit,
        },
        balance: round2(pending.reduce((sum, i) => sum + i.pending, 0)),
        invoices: pending.length,
        overdue: round2(pending.filter((i) => i.overdue).reduce((sum, i) => sum + i.pending, 0)),
        next_due: dues[0] ?? null,
        aging: agingOf(pending, today),
      }
    })
}

export interface CustomerAccountMovement {
  document_id: string
  display_number: string
  path: string
  date: string
  description: string
  /** Debe: lo que se le facturó (aumenta su deuda). Haber: lo que pagó. */
  debit: number
  credit: number
  balance: number
}

export interface CustomerAccount {
  customer: T.Customer
  movements: CustomerAccountMovement[]
  pending: ReceivableInvoice[]
  balance: number
  /** El crédito que usa: lo que debe más lo pedido sin facturar. */
  credit_used: number
}

/** Cuenta corriente de un cliente: facturas y cobros con saldo acumulado, y las facturas pendientes. */
export function customerAccount(db: DB, userId: string, companyId: string, customerId: string): CustomerAccount | null {
  assertPerm(db, userId, companyId, 'receivable.read')
  const customer = db.customers.find((c) => c.id === customerId && c.company_id === companyId)
  if (!customer) return null
  const today = todayAR()
  const invoices = registeredSalesInvoices(db, companyId)
    .filter((d) => d.customer_id === customer.id)
    .sort((a, b) => compareCodes(a.document_date, b.document_date) || a.number - b.number)
  const receipts = db.documents.filter(
    (d) =>
      d.company_id === companyId &&
      d.doc_type === 'CUSTOMER_RECEIPT' &&
      d.status === 'CONFIRMADO' &&
      d.customer_id === customer.id,
  )
  // Facturas (debe) y cobros (haber) por fecha; el mismo día, primero las facturas.
  const entries = [
    ...invoices.map((doc) => ({ doc, date: doc.document_date, receipt: false })),
    ...receipts.map((doc) => ({ doc, date: doc.rc!.received_on!, receipt: true })),
  ].sort((a, b) => compareCodes(a.date, b.date) || Number(a.receipt) - Number(b.receipt) || a.doc.number - b.doc.number)
  let balance = 0
  const movements = entries.map(({ doc: d, date: on, receipt }) => {
    balance = round2(balance + (receipt ? -d.total : d.total))
    const account = receipt ? db.accounts.find((a) => a.id === d.rc!.treasury_account_id) : undefined
    return {
      document_id: d.id,
      display_number: d.display_number,
      path: docPath(db, d),
      date: on,
      description: receipt
        ? `Cobro en ${account?.name ?? ''}${d.rc!.reference ? ` (${d.rc!.reference})` : ''}`
        : `Factura ${salesInvoiceLabel(d.fv!)}`,
      debit: receipt ? 0 : d.total,
      credit: receipt ? d.total : 0,
      balance,
    }
  })
  const pending = invoices.map((d) => receivableInvoice(db, d, today)).filter((i) => i.pending > 0)
  return { customer, movements, pending, balance, credit_used: customerCreditUsed(db, customer.id) }
}

export interface ReceiptCandidate {
  invoice: ReceivableInvoice
  /** Lo que ya está en otros recibos en borrador. */
  committed: number
  /** Lo que todavía se puede cobrar en un recibo nuevo. */
  available: number
}

/** Facturas de un cliente que se pueden cobrar, de la que vence primero (para preparar un recibo de cobro). */
export function receiptCandidates(db: DB, userId: string, companyId: string, customerId: string): ReceiptCandidate[] {
  assertPerm(db, userId, companyId, 'customer_receipt.create')
  const today = todayAR()
  return db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'SALES_INVOICE' &&
        d.customer_id === customerId &&
        ['REGISTRADA', 'COBRADA_PARCIAL'].includes(d.status),
    )
    .sort((a, b) => compareCodes(a.fv!.due_date, b.fv!.due_date) || a.number - b.number)
    .map((d) => {
      const invoice = receivableInvoice(db, d, today)
      const committed = salesInvoiceCommitted(db, d.id)
      return { invoice, committed, available: round2(invoice.pending - committed) }
    })
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

// ============================================================ Flujo de fondos (docs/FASE_3_COMPRAS_Y_TESORERIA.md §7)

export type CashConceptKey = 'APERTURA' | 'COBROS' | 'PAGOS' | 'TRANSFERENCIAS' | 'OTROS'

export interface CashFlowConcept {
  key: CashConceptKey
  label: string
  inflow: number
  outflow: number
}

export interface CashFlowAccount {
  account: { id: string; code: string; name: string }
  opening: number
  inflow: number
  outflow: number
  closing: number
}

export interface CashFlow {
  from: string
  to: string
  opening: number
  inflow: number
  outflow: number
  closing: number
  concepts: CashFlowConcept[]
  accounts: CashFlowAccount[]
}

const CASH_CONCEPTS: [CashConceptKey, string][] = [
  ['APERTURA', 'Saldos de apertura'],
  ['COBROS', 'Cobros a clientes'],
  ['PAGOS', 'Pagos a proveedores'],
  ['TRANSFERENCIAS', 'Movimientos entre cajas y bancos'],
  ['OTROS', 'Otros asientos de Contabilidad'],
]

const treasuryAccountsOf = (db: DB, companyId: string) =>
  db.accounts
    .filter((a) => a.company_id === companyId && a.is_imputable && a.code.startsWith(`${TREASURY_RUBRO}.`))
    .sort((a, b) => compareCodes(a.code, b.code))

/**
 * De dónde viene un movimiento de fondos: el documento que generó su asiento
 * (en un contraasiento, el del asiento que anula) o, si es manual, su origen.
 */
function cashConcept(db: DB, entry: T.Document): CashConceptKey {
  const base = (entry.je?.reverses_id && db.documents.find((d) => d.id === entry.je!.reverses_id)) || entry
  const source = db.docLinks
    .filter((l) => l.to_document_id === base.id)
    .map((l) => db.documents.find((d) => d.id === l.from_document_id))
    .find((d) => d && d.doc_type !== 'JOURNAL_ENTRY')
  if (source?.doc_type === 'CUSTOMER_RECEIPT') return 'COBROS'
  if (source?.doc_type === 'PAYMENT_ORDER') return 'PAGOS'
  if (source?.doc_type === 'FUNDS_TRANSFER') return 'TRANSFERENCIAS'
  return base.je?.origin === 'APERTURA' ? 'APERTURA' : 'OTROS'
}

/** Flujo de fondos real de un período: saldo inicial, entradas y salidas por concepto y por cuenta, y saldo final. */
export function cashFlow(db: DB, userId: string, companyId: string, from: string, to: string): CashFlow {
  assertPerm(db, userId, companyId, 'treasury.read')
  assertRange(from, to)
  const treasury = treasuryAccountsOf(db, companyId)
  const ids = new Set(treasury.map((a) => a.id))
  const lines = postedLines(db, companyId).filter(({ line }) => ids.has(line.account_id))
  const before = lines.filter(({ doc }) => doc.document_date < from)
  const within = lines.filter(({ doc }) => from <= doc.document_date && doc.document_date <= to)
  const total = (rows: typeof lines, value: (row: (typeof lines)[number]) => number) =>
    round2(rows.reduce((sum, row) => sum + value(row), 0))
  const accounts = treasury.map((a) => {
    const opening = total(
      before.filter(({ line }) => line.account_id === a.id),
      ({ line }) => line.debit - line.credit,
    )
    const own = within.filter(({ line }) => line.account_id === a.id)
    const inflow = total(own, ({ line }) => line.debit)
    const outflow = total(own, ({ line }) => line.credit)
    return {
      account: { id: a.id, code: a.code, name: a.name },
      opening,
      inflow,
      outflow,
      closing: round2(opening + inflow - outflow),
    }
  })
  const opening = round2(accounts.reduce((sum, a) => sum + a.opening, 0))
  const inflow = total(within, ({ line }) => line.debit)
  const outflow = total(within, ({ line }) => line.credit)
  return {
    from,
    to,
    opening,
    inflow,
    outflow,
    closing: round2(opening + inflow - outflow),
    concepts: CASH_CONCEPTS.map(([key, label]) => {
      const rows = within.filter(({ doc }) => cashConcept(db, doc) === key)
      return {
        key,
        label,
        inflow: total(rows, ({ line }) => line.debit),
        outflow: total(rows, ({ line }) => line.credit),
      }
    }),
    accounts,
  }
}

export type CashBucketKey = 'VENCIDAS' | 'SEMANA' | 'QUINCENA' | 'MES' | 'DESPUES'

export interface CashProjectionBucket {
  key: CashBucketKey
  label: string
  /** Lo que falta cobrar de las facturas de venta que vencen en el tramo. */
  collections: number
  receivables: number
  /** Lo que falta pagar de las facturas de proveedores que vencen en el tramo. */
  payments: number
  invoices: number
  /** Saldo de cajas y bancos que quedaría después de cobrar y pagar hasta este tramo. */
  balance: number
}

export interface CashProjection {
  today: string
  /** Saldo de hoy de cajas y bancos. */
  balance: number
  buckets: CashProjectionBucket[]
  /** El primer tramo en que no alcanzan los fondos (null si alcanzan). */
  shortfall: CashBucketKey | null
}

/** Tramos por días hasta el vencimiento: [clave, etiqueta, hasta cuántos días]. */
const CASH_BUCKETS: [CashBucketKey, string, number][] = [
  ['VENCIDAS', 'Vencidas', -1],
  ['SEMANA', 'Próximos 7 días', 7],
  ['QUINCENA', 'De 8 a 15 días', 15],
  ['MES', 'De 16 a 30 días', 30],
  ['DESPUES', 'A más de 30 días', Infinity],
]

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)

/**
 * Flujo de fondos proyectado: desde el saldo de hoy, lo que falta cobrar de las
 * facturas de venta y pagar de las de proveedores, por vencimiento, y el saldo
 * que quedaría tras cada tramo.
 */
export function cashProjection(db: DB, userId: string, companyId: string): CashProjection {
  assertPerm(db, userId, companyId, 'treasury.read')
  const today = todayAR()
  const ids = new Set(treasuryAccountsOf(db, companyId).map((a) => a.id))
  const balance = round2(
    postedLines(db, companyId)
      .filter(({ line }) => ids.has(line.account_id))
      .reduce((sum, { line }) => sum + line.debit - line.credit, 0),
  )
  const pending = registeredInvoices(db, companyId)
    .map((d) => payableInvoice(db, d, today))
    .filter((i) => i.pending > 0)
  const receivable = registeredSalesInvoices(db, companyId)
    .map((d) => receivableInvoice(db, d, today))
    .filter((i) => i.pending > 0)
  let running = balance
  const buckets = CASH_BUCKETS.map(([key, label, upTo], i) => {
    const after = i === 0 ? -Infinity : CASH_BUCKETS[i - 1][2]
    const within = <R extends { due_date: string }>(rows: R[]) =>
      rows.filter((row) => {
        const days = daysBetween(today, row.due_date)
        return days > after && days <= upTo
      })
    const inBucket = within(pending)
    const toCollect = within(receivable)
    const payments = round2(inBucket.reduce((sum, inv) => sum + inv.pending, 0))
    const collections = round2(toCollect.reduce((sum, inv) => sum + inv.pending, 0))
    running = round2(running + collections - payments)
    return {
      key,
      label,
      collections,
      receivables: toCollect.length,
      payments,
      invoices: inBucket.length,
      balance: running,
    }
  })
  return { today, balance, buckets, shortfall: buckets.find((b) => b.balance < 0)?.key ?? null }
}

// ============================================================ Cheques y conciliación (docs/FASE_3_COMPRAS_Y_TESORERIA.md §7)

export interface ReconciliationCandidates {
  account: { id: string; code: string; name: string }
  /** La última conciliación confirmada de la cuenta. */
  last: { display_number: string; path: string; statement_date: string; statement_balance: number } | null
  /** Saldo según libros a la fecha del extracto. */
  book_balance: number
  /** Los movimientos todavía sin conciliar hasta esa fecha, en el orden del libro diario. */
  lines: ReconciliationLineView[]
}

/** Lo que hace falta para conciliar un banco a una fecha (null si la cuenta no es una caja o un banco). */
export function reconciliationCandidates(
  db: DB,
  userId: string,
  companyId: string,
  accountId: string,
  statementDate: string,
): ReconciliationCandidates | null {
  assertPerm(db, userId, companyId, 'bank_reconciliation.create')
  if (!isDate(statementDate)) fail('DATO_INVALIDO', 'Indicá la fecha del extracto.')
  const account = treasuryAccountsOf(db, companyId).find((a) => a.id === accountId)
  if (!account) return null
  const last = lastReconciliation(db, account.id)
  const lines = accountLinesUpTo(db, account.id, statementDate)
  const reconciled = reconciledLineIds(db, account.id)
  return {
    account: { id: account.id, code: account.code, name: account.name },
    last: last
      ? {
          display_number: last.display_number,
          path: docPath(db, last),
          statement_date: last.br!.statement_date,
          statement_balance: last.br!.statement_balance,
        }
      : null,
    book_balance: round2(lines.reduce((s, { line }) => s + line.debit - line.credit, 0)),
    lines: lines.filter(({ line }) => !reconciled.has(line.id)).map((l) => reconciliationLine(db, l)),
  }
}

export type ChequeStatus = 'PENDIENTE' | 'DEBITADO' | 'ANULADO'

export interface IssuedCheque {
  payment: DocRef
  number: string
  date: string
  supplier_name: string
  account: { id: string; code: string; name: string }
  amount: number
  /** Pendiente de débito hasta que una conciliación lo encuentra en el extracto. */
  status: ChequeStatus
  reconciliation: DocRef | null
}

/** Cheques emitidos: los pagos con cheque, con su estado según las conciliaciones. */
export function issuedCheques(db: DB, userId: string, companyId: string): IssuedCheque[] {
  assertPerm(db, userId, companyId, 'treasury.read')
  return db.documents
    .filter(
      (d) =>
        d.company_id === companyId &&
        d.doc_type === 'PAYMENT_ORDER' &&
        d.op?.payment_method === 'CHEQUE' &&
        ['PAGADA', 'ANULADA'].includes(d.status),
    )
    .sort((a, b) => compareCodes(a.op!.paid_on!, b.op!.paid_on!) || a.number - b.number)
    .map((d) => {
      const account = db.accounts.find((a) => a.id === d.op!.treasury_account_id)!
      // La línea del banco en el asiento del pago, y la conciliación que la encontró.
      const entry = db.docLinks
        .filter((l) => l.from_document_id === d.id)
        .map((l) => db.documents.find((x) => x.id === l.to_document_id))
        .find((x) => x?.je?.origin === 'AUTOMATICO')
      const line =
        entry && db.jeLines.find((l) => l.document_id === entry.id && l.account_id === account.id && l.credit > 0)
      const brLine = line && db.brLines.find((l) => l.journal_line_id === line.id && isConfirmedReconciliation(db, l))
      const reconciliation = brLine ? db.documents.find((x) => x.id === brLine.document_id) : undefined
      return {
        payment: docRef(db, d),
        number: d.op!.payment_reference,
        date: d.op!.paid_on!,
        supplier_name: db.suppliers.find((s) => s.id === d.supplier_id)?.legal_name ?? '',
        account: { id: account.id, code: account.code, name: account.name },
        amount: d.total,
        status: d.status === 'ANULADA' ? 'ANULADO' : reconciliation ? 'DEBITADO' : 'PENDIENTE',
        reconciliation: d.status !== 'ANULADA' && reconciliation ? docRef(db, reconciliation) : null,
      }
    })
}

const isConfirmedReconciliation = (db: DB, l: T.BankReconciliationLine) =>
  db.documents.some((d) => d.id === l.document_id && d.status === 'CONFIRMADA')

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

// ============================================================ Producción (docs/FASE_5_PRODUCCION_Y_COSTOS.md)

/** Costo estimado de los materiales de una unidad: cantidad × costo promedio (o estándar) de cada componente. */
function bomMaterialCost(db: DB, bomId: string) {
  return round2(
    bomLinesOf(db, bomId).reduce((s, l) => {
      const c = db.products.find((p) => p.id === l.component_id)!
      return s + round2(l.quantity * plannedUnitCost(db, c, c.default_warehouse_id))
    }, 0),
  )
}

/** Un producto terminado y su lista de materiales (si tiene). */
export interface BomRow {
  product: { id: string; code: string; name: string; uom_code: string; is_active: boolean }
  bom: { id: string; is_active: boolean; updated_at: string } | null
  components: number
  /** Costo estimado de los materiales de una unidad (0 si no tiene lista). */
  material_cost: number
}

export function listBoms(db: DB, userId: string, companyId: string): BomRow[] {
  assertPerm(db, userId, companyId, 'bom.read')
  return db.products
    .filter((p) => p.company_id === companyId && p.product_type === 'PRODUCTO_TERMINADO')
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((p) => {
      const bom = db.boms.find((b) => b.product_id === p.id)
      return {
        product: { id: p.id, code: p.code, name: p.name, uom_code: p.uom_code, is_active: p.is_active },
        bom: bom ? { id: bom.id, is_active: bom.is_active, updated_at: bom.updated_at } : null,
        components: bom ? bomLinesOf(db, bom.id).length : 0,
        material_cost: bom ? bomMaterialCost(db, bom.id) : 0,
      }
    })
}

/** Un componente de la lista, con su costo estimado. */
export interface BomComponentLine {
  line_no: number
  component: { id: string; code: string; name: string; uom_code: string; product_type: T.ProductType }
  quantity: number
  unit_cost: number
  line_cost: number
}

export interface BomDetail {
  product: { id: string; code: string; name: string; uom_code: string; is_active: boolean; standard_cost: number }
  bom: { id: string; notes: string; is_active: boolean; created_at: string; updated_at: string } | null
  lines: BomComponentLine[]
  material_cost: number
  /** Órdenes del producto planificadas, liberadas o en proceso. */
  open_orders: number
}

export function bomDetail(db: DB, userId: string, companyId: string, productCode: string): BomDetail | null {
  assertPerm(db, userId, companyId, 'bom.read')
  const p = db.products.find(
    (x) => x.company_id === companyId && x.code === productCode && x.product_type === 'PRODUCTO_TERMINADO',
  )
  if (!p) return null
  const bom = db.boms.find((b) => b.product_id === p.id)
  const lines = bom
    ? bomLinesOf(db, bom.id).map((l) => {
        const c = db.products.find((x) => x.id === l.component_id)!
        const unitCost = plannedUnitCost(db, c, c.default_warehouse_id)
        return {
          line_no: l.line_no,
          component: { id: c.id, code: c.code, name: c.name, uom_code: c.uom_code, product_type: c.product_type },
          quantity: l.quantity,
          unit_cost: unitCost,
          line_cost: round2(l.quantity * unitCost),
        }
      })
    : []
  return {
    product: {
      id: p.id,
      code: p.code,
      name: p.name,
      uom_code: p.uom_code,
      is_active: p.is_active,
      standard_cost: p.standard_cost,
    },
    bom: bom
      ? {
          id: bom.id,
          notes: bom.notes,
          is_active: bom.is_active,
          created_at: bom.created_at,
          updated_at: bom.updated_at,
        }
      : null,
    lines,
    material_cost: round2(lines.reduce((s, l) => s + l.line_cost, 0)),
    open_orders: db.documents.filter(
      (d) =>
        d.doc_type === 'PRODUCTION_ORDER' &&
        d.pd!.product_id === p.id &&
        ['BORRADOR', 'LIBERADA', 'EN_PROCESO'].includes(d.status),
    ).length,
  }
}

/** Un producto que se puede fabricar: su lista activa, con lo disponible de cada material en cada depósito. */
export interface ProducibleProduct {
  id: string
  code: string
  name: string
  uom_code: string
  default_warehouse_id: string | null
  components: {
    component: { id: string; code: string; name: string; uom_code: string; default_warehouse_id: string | null }
    quantity: number
    stock: WarehouseAvailability[]
  }[]
}

/** Lo que Producción puede planificar (para cargar la orden). */
export function productionCatalog(db: DB, userId: string, companyId: string): ProducibleProduct[] {
  assertPerm(db, userId, companyId, 'production_order.create')
  return db.products
    .filter((p) => p.company_id === companyId && p.is_active && activeBomOf(db, p.id))
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      uom_code: p.uom_code,
      default_warehouse_id: p.default_warehouse_id,
      components: bomLinesOf(db, activeBomOf(db, p.id)!.id).map((l) => {
        const c = db.products.find((x) => x.id === l.component_id)!
        return {
          component: {
            id: c.id,
            code: c.code,
            name: c.name,
            uom_code: c.uom_code,
            default_warehouse_id: c.default_warehouse_id,
          },
          quantity: l.quantity,
          stock: availabilityOf(db, companyId, c.id),
        }
      }),
    }))
}
