// Motor de negocio simulado. Cada función exportada `cmd*` equivale a una
// función RPC de PostgreSQL (DATABASE.md §13): valida permiso, estado,
// separación de funciones y datos, aplica efectos y registra auditoría,
// tareas y notificaciones. Se ejecuta dentro de `transact` (todo o nada).

import {
  ACTION_VERBS,
  DOC_STATUSES,
  DOC_TYPES,
  MODULES,
  PRODUCT_TYPES,
  ROLES,
  ROLE_PERMISSIONS,
  TASK_RULES,
  TRANSITIONS,
  permissionModule,
  type TransitionInfo,
} from '../domain/catalog'
import type * as T from '../domain/types'
import { money, qty as fmtQty, todayAR } from '../format'
import type { DB } from './db'

// ============================================================ Infraestructura

export class BusinessError extends Error {
  code: string
  hint?: string
  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'BusinessError'
    this.code = code
    this.hint = hint
  }
}

export function fail(code: string, message: string, hint?: string): never {
  throw new BusinessError(code, message, hint)
}

export interface Ctx {
  db: DB
  userId: string | null
  now: string
}

export const uid = () => crypto.randomUUID()
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000
export const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000
const EPS = 1e-9

// ============================================================ Identidad y permisos

export function getProfile(db: DB, userId: string | null) {
  return userId ? db.profiles.find((p) => p.id === userId) : undefined
}

export function fullName(p: T.Profile | undefined): string {
  return p ? `${p.first_name} ${p.last_name}` : 'Sistema'
}

export function isInstanceAdmin(p: T.Profile | undefined): boolean {
  return p?.app_role === 'SUPERADMIN' || p?.app_role === 'ADMIN'
}

export function getMember(db: DB, userId: string, companyId: string) {
  return db.members.find((m) => m.user_id === userId && m.company_id === companyId)
}

export function getMemberRoles(db: DB, memberId: string) {
  return db.memberRoles.filter((r) => r.member_id === memberId)
}

export function isModuleEnabled(db: DB, companyId: string, module: T.ModuleCode): boolean {
  if (!MODULES[module].lockable) return true
  const row = db.companyModules.find((m) => m.company_id === companyId && m.module_code === module)
  return row ? row.is_enabled : true
}

export interface EffectivePermissions {
  all: boolean
  supervisor: boolean
  perms: Set<string>
  roles: T.RoleCode[]
}

export function effectivePermissions(db: DB, userId: string, companyId: string): EffectivePermissions {
  const profile = getProfile(db, userId)
  const member = getMember(db, userId, companyId)
  const roles = member?.is_active ? getMemberRoles(db, member.id).map((r) => r.role_code) : []
  const supervisor = isInstanceAdmin(profile) || roles.some((r) => ROLES[r].isSupervisor)
  if (supervisor) return { all: true, supervisor: true, perms: new Set(), roles }
  const perms = new Set<string>()
  for (const role of roles) {
    for (const perm of ROLE_PERMISSIONS[role]) {
      if (isModuleEnabled(db, companyId, permissionModule(perm))) perms.add(perm)
    }
  }
  return { all: false, supervisor: false, perms, roles }
}

export function can(eff: EffectivePermissions, permission: string) {
  return eff.all || eff.perms.has(permission)
}

export function rolesWithPermission(permission: string): string {
  const names = (Object.keys(ROLE_PERMISSIONS) as T.RoleCode[])
    .filter((r) => ROLE_PERMISSIONS[r].includes(permission))
    .map((r) => ROLES[r].name)
  return names.length ? names.join(', ') : 'Docente'
}

export interface Actor {
  user_id: string | null
  name: string
  role_code: string
  sector_id: string | null
  sector_name: string
}

export const SYSTEM_ACTOR: Actor = {
  user_id: null,
  name: 'Sistema',
  role_code: 'SISTEMA',
  sector_id: null,
  sector_name: '—',
}

function sectorName(db: DB, sectorId: string | null) {
  return (sectorId && db.sectors.find((s) => s.id === sectorId)?.name) || '—'
}

/** Determina con qué rol y sector actúa el usuario (queda en la auditoría). */
export function actorFor(ctx: Ctx, companyId: string, permission?: string, preferRole?: T.RoleCode): Actor {
  const { db, userId } = ctx
  if (!userId) return SYSTEM_ACTOR
  const profile = getProfile(db, userId)
  if (!profile) fail('SIN_SESION', 'La sesión no es válida. Volvé a ingresar.')
  const name = fullName(profile)
  const member = getMember(db, userId, companyId)
  const memberRoles = member?.is_active ? getMemberRoles(db, member.id) : []
  const build = (mr: T.MemberRole): Actor => ({
    user_id: userId,
    name,
    role_code: mr.role_code,
    sector_id: mr.sector_id,
    sector_name: sectorName(db, mr.sector_id),
  })
  if (preferRole) {
    const mr = memberRoles.find((r) => r.role_code === preferRole)
    if (mr) return build(mr)
  }
  if (permission) {
    const mr = memberRoles.find(
      (r) => !ROLES[r.role_code].isSupervisor && ROLE_PERMISSIONS[r.role_code].includes(permission),
    )
    if (mr) return build(mr)
  }
  const supervisorRole = memberRoles.find((r) => ROLES[r.role_code].isSupervisor)
  if (supervisorRole) return build(supervisorRole)
  if (isInstanceAdmin(profile)) {
    return { user_id: userId, name, role_code: profile.app_role, sector_id: null, sector_name: '—' }
  }
  if (memberRoles[0]) return build(memberRoles[0])
  return { user_id: userId, name, role_code: profile.app_role, sector_id: null, sector_name: '—' }
}

export function requirePermission(ctx: Ctx, companyId: string, permission: string): Actor {
  if (!ctx.userId) return SYSTEM_ACTOR
  const eff = effectivePermissions(ctx.db, ctx.userId, companyId)
  if (!can(eff, permission)) {
    const module = permissionModule(permission)
    if (!isModuleEnabled(ctx.db, companyId, module)) {
      fail('MODULO_BLOQUEADO', `El módulo "${MODULES[module].name}" está bloqueado por el docente.`)
    }
    fail(
      'SIN_PERMISO',
      `Tu rol no tiene permiso para esta acción. Corresponde a: ${rolesWithPermission(permission)}.`,
      'Cada sector tiene funciones propias. Pedí la intervención del sector que corresponde.',
    )
  }
  return actorFor(ctx, companyId, permission)
}

export function requireSupervisor(ctx: Ctx, companyId: string): Actor {
  if (!ctx.userId) return SYSTEM_ACTOR
  const eff = effectivePermissions(ctx.db, ctx.userId, companyId)
  if (!eff.supervisor) fail('SIN_PERMISO', 'Sólo el docente o la administración de la escuela pueden hacer esto.')
  return actorFor(ctx, companyId)
}

// ============================================================ Utilidades de documentos

export function getCompany(db: DB, companyId: string) {
  const c = db.companies.find((x) => x.id === companyId)
  if (!c) fail('EMPRESA_INEXISTENTE', 'La empresa no existe.')
  return c
}

export function getDoc(db: DB, id: string, docType?: T.DocType) {
  const d = db.documents.find((x) => x.id === id)
  if (!d || (docType && d.doc_type !== docType)) fail('DOCUMENTO_INEXISTENTE', 'El documento no existe.')
  return d
}

export function statusLabel(docType: T.DocType, status: string) {
  return DOC_STATUSES[docType][status]?.label ?? status
}

export function docPath(db: DB, doc: T.Document) {
  const company = db.companies.find((c) => c.id === doc.company_id)
  return `/e/${company?.slug}/${DOC_TYPES[doc.doc_type].path}/${doc.display_number}`
}

function nextNumber(db: DB, companyId: string, docType: T.DocType) {
  let seq = db.documentSequences.find((s) => s.company_id === companyId && s.doc_type === docType)
  if (!seq) {
    seq = { company_id: companyId, doc_type: docType, next_number: 1 }
    db.documentSequences.push(seq)
  }
  const number = seq.next_number
  seq.next_number += 1
  return { number, display: `${DOC_TYPES[docType].prefix}-${String(number).padStart(5, '0')}` }
}

export function businessDate(company: T.Company) {
  return todayAR() || company.start_date
}

function newDocument(
  ctx: Ctx,
  companyId: string,
  docType: T.DocType,
  actor: Actor,
  fields: Partial<T.Document>,
): T.Document {
  const company = getCompany(ctx.db, companyId)
  const { number, display } = nextNumber(ctx.db, companyId, docType)
  const doc: T.Document = {
    id: uid(),
    company_id: companyId,
    doc_type: docType,
    number,
    display_number: display,
    status: 'BORRADOR',
    document_date: businessDate(company),
    sector_id: actor.sector_id,
    supplier_id: null,
    customer_id: null,
    subtotal: 0,
    tax_total: 0,
    total: 0,
    notes: '',
    status_reason: '',
    created_at: ctx.now,
    created_by: ctx.userId,
    updated_at: ctx.now,
    updated_by: ctx.userId,
    ...fields,
  }
  ctx.db.documents.push(doc)
  return doc
}

function link(ctx: Ctx, companyId: string, fromId: string, toId: string) {
  if (!ctx.db.docLinks.some((l) => l.from_document_id === fromId && l.to_document_id === toId)) {
    ctx.db.docLinks.push({ company_id: companyId, from_document_id: fromId, to_document_id: toId, created_at: ctx.now })
  }
}

function getProduct(db: DB, companyId: string, productId: string) {
  const p = db.products.find((x) => x.id === productId && x.company_id === companyId)
  if (!p) fail('PRODUCTO_INEXISTENTE', 'El producto no existe en esta empresa.')
  return p
}

function productLabel(p: T.Product) {
  return `${p.code} ${p.name}`
}

// ============================================================ Auditoría

export interface AuditInput {
  company_id: string | null
  actor: Actor
  action: string
  entity_type: string
  entity_id: string | null
  entity_label: string
  document_id?: string | null
  from_status?: string | null
  to_status?: string | null
  summary: string
  changes?: T.AuditEvent['changes']
}

export function logAudit(ctx: Ctx, e: AuditInput) {
  ctx.db.seq.audit += 1
  ctx.db.audit.push({
    id: ctx.db.seq.audit,
    company_id: e.company_id,
    occurred_at: ctx.now,
    actor_user_id: e.actor.user_id,
    actor_name: e.actor.name,
    actor_role_code: e.actor.role_code,
    actor_sector_name: e.actor.sector_name,
    action: e.action,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    entity_label: e.entity_label,
    document_id: e.document_id ?? null,
    from_status: e.from_status ?? null,
    to_status: e.to_status ?? null,
    summary: e.summary,
    changes: e.changes ?? null,
  })
}

function diff<R extends object>(before: R, after: R, keys: (keyof R)[]) {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[String(k)] = { from: before[k], to: after[k] }
  }
  return changes
}

// ============================================================ Notificaciones y tareas

export function usersWithRole(db: DB, companyId: string, role: T.RoleCode): string[] {
  const memberIds = new Set(
    db.memberRoles.filter((r) => r.company_id === companyId && r.role_code === role).map((r) => r.member_id),
  )
  return db.members.filter((m) => memberIds.has(m.id) && m.is_active).map((m) => m.user_id)
}

interface NotificationInput {
  type: string
  title: string
  body: string
  link_path: string
  document_id?: string | null
  task_id?: string | null
}

function notifyUsers(ctx: Ctx, companyId: string, userIds: string[], n: NotificationInput, exclude?: string | null) {
  for (const userId of new Set(userIds)) {
    if (userId === exclude) continue
    ctx.db.notifications.push({
      id: uid(),
      company_id: companyId,
      recipient_user_id: userId,
      type: n.type,
      title: n.title,
      body: n.body,
      link_path: n.link_path,
      document_id: n.document_id ?? null,
      task_id: n.task_id ?? null,
      read_at: null,
      created_at: ctx.now,
    })
  }
}

function notifyRoles(ctx: Ctx, companyId: string, roles: T.RoleCode[], n: NotificationInput, exclude?: string | null) {
  notifyUsers(
    ctx,
    companyId,
    roles.flatMap((r) => usersWithRole(ctx.db, companyId, r)),
    n,
    exclude,
  )
}

function openTasksForStatus(ctx: Ctx, doc: T.Document, actor: Actor) {
  for (const rule of TASK_RULES.filter((r) => r.docType === doc.doc_type && r.status === doc.status)) {
    let role: T.RoleCode | null = null
    let user: string | null = null
    if (rule.assignee === 'ROLE') role = rule.role ?? null
    if (rule.assignee === 'APPROVER') {
      role =
        ctx.db.approvalRequests.find((a) => a.document_id === doc.id && a.status === 'PENDIENTE')?.approver_role ??
        'GERENCIA'
    }
    if (rule.assignee === 'CREATOR') user = doc.created_by
    const title = rule.title.replace('{number}', doc.display_number).replace('{total}', money(doc.total))
    const task: T.Task = {
      id: uid(),
      company_id: doc.company_id,
      document_id: doc.id,
      task_type: rule.taskType,
      title,
      description: rule.description,
      origin_status: doc.status,
      context: {},
      assigned_role: role,
      assigned_user_id: user,
      status: 'PENDIENTE',
      priority: doc.pr?.priority ?? 'NORMAL',
      source: 'SISTEMA',
      claimed_by: null,
      claimed_at: null,
      completed_by: null,
      completed_at: null,
      created_by: actor.user_id,
      created_at: ctx.now,
    }
    ctx.db.tasks.push(task)
    const recipients = user ? [user] : role ? usersWithRole(ctx.db, doc.company_id, role) : []
    notifyUsers(
      ctx,
      doc.company_id,
      recipients,
      {
        type: 'NUEVA_TAREA',
        title: `Nueva tarea: ${title}`,
        body: rule.description,
        link_path: docPath(ctx.db, doc),
        document_id: doc.id,
        task_id: task.id,
      },
      actor.user_id,
    )
  }
}

function closeTasksForStatus(ctx: Ctx, docId: string, originStatus: string, byUser: string | null) {
  for (const task of ctx.db.tasks) {
    if (
      task.document_id === docId &&
      task.origin_status === originStatus &&
      (task.status === 'PENDIENTE' || task.status === 'EN_CURSO')
    ) {
      task.status = 'RESUELTA'
      task.completed_by = byUser
      task.completed_at = ctx.now
    }
  }
}

// ============================================================ Motor de transiciones

interface TransitionOptions {
  comment?: string
  to?: string
  actor?: Actor
  summary?: string
}

export function findTransition(
  docType: T.DocType,
  from: string,
  action: T.TransitionAction,
  to?: string,
): TransitionInfo | undefined {
  return TRANSITIONS.find(
    (t) => t.docType === docType && t.from === from && t.action === action && (!to || t.to === to),
  )
}

/** Única puerta para cambiar el estado de un documento (private.transition_document). */
export function transition(ctx: Ctx, doc: T.Document, action: T.TransitionAction, opts: TransitionOptions = {}): Actor {
  const tr = findTransition(doc.doc_type, doc.status, action, opts.to)
  if (!tr) {
    fail(
      'TRANSICION_INVALIDA',
      `${doc.display_number} está en estado "${statusLabel(doc.doc_type, doc.status)}" y no admite esta acción.`,
    )
  }
  const comment = opts.comment?.trim() ?? ''
  if (tr.requiresComment && comment.length < 3) {
    fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  }
  const actor = opts.actor ?? (tr.permission ? requirePermission(ctx, doc.company_id, tr.permission) : SYSTEM_ACTOR)
  const from = doc.status
  doc.status = tr.to
  doc.updated_at = ctx.now
  doc.updated_by = actor.user_id
  if (comment && (action === 'REJECT' || action === 'CANCEL' || action === 'CLOSE')) doc.status_reason = comment

  closeTasksForStatus(ctx, doc.id, from, actor.user_id)
  openTasksForStatus(ctx, doc, actor)

  const summary =
    opts.summary ??
    (action === 'SYSTEM'
      ? `${doc.display_number} pasó a "${statusLabel(doc.doc_type, tr.to)}"`
      : `${ACTION_VERBS[action]} ${doc.display_number}${comment ? ` — ${comment}` : ''}`)
  logAudit(ctx, {
    company_id: doc.company_id,
    actor,
    action,
    entity_type: DOC_TYPES[doc.doc_type].resource,
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    from_status: from,
    to_status: tr.to,
    summary,
  })
  return actor
}

// ============================================================ Stock

function totalStock(db: DB, productId: string) {
  return round3(db.stockBalances.filter((b) => b.product_id === productId).reduce((s, b) => s + b.qty_on_hand, 0))
}

interface MovementInput {
  company_id: string
  product_id: string
  warehouse_id: string
  type: T.MovementType
  quantity: number
  unit_cost?: number
  document_id: string | null
  document_line_id: string | null
  date: string
}

export function postMovement(ctx: Ctx, m: MovementInput) {
  const { db } = ctx
  const product = getProduct(db, m.company_id, m.product_id)
  if (!product.is_stockable) return
  const company = getCompany(db, m.company_id)
  let bal = db.stockBalances.find((b) => b.product_id === m.product_id && b.warehouse_id === m.warehouse_id)
  if (!bal) {
    bal = {
      company_id: m.company_id,
      product_id: m.product_id,
      warehouse_id: m.warehouse_id,
      qty_on_hand: 0,
      qty_reserved: 0,
      avg_unit_cost: 0,
      last_movement_at: null,
    }
    db.stockBalances.push(bal)
  }
  const before = totalStock(db, m.product_id)
  const newQty = round3(bal.qty_on_hand + m.quantity)
  if (newQty < -EPS && !company.settings.allow_negative_stock) {
    const wh = db.warehouses.find((w) => w.id === m.warehouse_id)?.name ?? 'el depósito'
    fail(
      'STOCK_INSUFICIENTE',
      `Stock insuficiente de ${productLabel(product)}: hay ${fmtQty(bal.qty_on_hand, product.uom_code)} en ${wh}.`,
      'El sistema no permite stock negativo: no se puede sacar lo que no está.',
    )
  }
  let cost: number
  if (m.quantity > 0) {
    cost = m.unit_cost ?? (bal.avg_unit_cost || product.standard_cost)
    bal.avg_unit_cost = newQty > 0 ? round4((bal.qty_on_hand * bal.avg_unit_cost + m.quantity * cost) / newQty) : cost
  } else {
    cost = bal.avg_unit_cost || product.standard_cost
  }
  bal.qty_on_hand = newQty
  bal.last_movement_at = ctx.now
  db.seq.movement += 1
  db.stockMovements.push({
    id: db.seq.movement,
    company_id: m.company_id,
    product_id: m.product_id,
    warehouse_id: m.warehouse_id,
    movement_type: m.type,
    quantity: m.quantity,
    unit_cost: round4(cost),
    total_cost: round2(m.quantity * cost),
    balance_qty: newQty,
    balance_avg_cost: bal.avg_unit_cost,
    document_id: m.document_id,
    document_line_id: m.document_line_id,
    movement_date: m.date,
    created_by: ctx.userId,
    created_at: ctx.now,
  })
  const after = totalStock(db, m.product_id)
  if (product.min_stock > 0) {
    if (after < product.min_stock && before >= product.min_stock) raiseStockAlert(ctx, product)
    if (after >= product.min_stock) resolveStockTasks(ctx, product.id, 'Stock repuesto por encima del mínimo')
  }
}

export function raiseStockAlert(ctx: Ctx, product: T.Product) {
  const { db } = ctx
  const open = db.tasks.some(
    (t) =>
      t.task_type === 'REPONER_STOCK' &&
      t.context.product_id === product.id &&
      (t.status === 'PENDIENTE' || t.status === 'EN_CURSO'),
  )
  if (open) return
  const company = getCompany(db, product.company_id)
  const stock = totalStock(db, product.id)
  const task: T.Task = {
    id: uid(),
    company_id: product.company_id,
    document_id: null,
    task_type: 'REPONER_STOCK',
    title: `Evaluar reposición de ${productLabel(product)}`,
    description: `Stock ${fmtQty(stock, product.uom_code)}, por debajo del mínimo (${fmtQty(product.min_stock, product.uom_code)}). Evaluá crear una solicitud de compra.`,
    origin_status: null,
    context: { product_id: product.id },
    assigned_role: 'DEPOSITO',
    assigned_user_id: null,
    status: 'PENDIENTE',
    priority: 'ALTA',
    source: 'SISTEMA',
    claimed_by: null,
    claimed_at: null,
    completed_by: null,
    completed_at: null,
    created_by: null,
    created_at: ctx.now,
  }
  db.tasks.push(task)
  notifyRoles(ctx, product.company_id, ['DEPOSITO', 'COMPRAS'], {
    type: 'STOCK_MINIMO',
    title: `Stock mínimo alcanzado: ${product.code}`,
    body: `${product.name}: ${fmtQty(stock, product.uom_code)} (mínimo ${fmtQty(product.min_stock, product.uom_code)}).`,
    link_path: `/e/${company.slug}/stock`,
    task_id: task.id,
  })
  logAudit(ctx, {
    company_id: product.company_id,
    actor: SYSTEM_ACTOR,
    action: 'ALERT',
    entity_type: 'product',
    entity_id: product.id,
    entity_label: productLabel(product),
    summary: `Alerta de stock mínimo: ${productLabel(product)} (${fmtQty(stock, product.uom_code)})`,
  })
}

function resolveStockTasks(ctx: Ctx, productId: string, _reason: string) {
  for (const t of ctx.db.tasks) {
    if (
      t.task_type === 'REPONER_STOCK' &&
      t.context.product_id === productId &&
      (t.status === 'PENDIENTE' || t.status === 'EN_CURSO')
    ) {
      t.status = 'RESUELTA'
      t.completed_by = ctx.userId
      t.completed_at = ctx.now
    }
  }
}

/** Genera alertas para todo producto que ya esté bajo el mínimo (datos iniciales). */
export function scanStockAlerts(ctx: Ctx, companyId: string) {
  for (const p of ctx.db.products.filter((x) => x.company_id === companyId && x.is_stockable && x.min_stock > 0)) {
    if (totalStock(ctx.db, p.id) < p.min_stock) raiseStockAlert(ctx, p)
  }
}

// ============================================================ Recalculos derivados

function recomputeRequisition(ctx: Ctx, prId: string) {
  const { db } = ctx
  const doc = getDoc(db, prId, 'PURCHASE_REQUISITION')
  const lines = db.prLines.filter((l) => l.document_id === prId)
  for (const line of lines) {
    line.qty_ordered = round3(
      db.poLines
        .filter((pl) => pl.requisition_line_id === line.id)
        .filter((pl) => db.documents.find((d) => d.id === pl.document_id)?.status !== 'ANULADO')
        .reduce((s, pl) => s + pl.quantity, 0),
    )
  }
  if (!['SOLICITADO', 'ORDENADO_PARCIAL', 'ORDENADO'].includes(doc.status)) return
  const full = lines.every((l) => l.qty_ordered >= l.quantity - EPS)
  const some = lines.some((l) => l.qty_ordered > EPS)
  const target = full ? 'ORDENADO' : some ? 'ORDENADO_PARCIAL' : 'SOLICITADO'
  if (target !== doc.status) transition(ctx, doc, 'SYSTEM', { to: target })
}

function recomputePurchaseOrder(ctx: Ctx, poId: string) {
  const { db } = ctx
  const doc = getDoc(db, poId, 'PURCHASE_ORDER')
  if (!['ENVIADO', 'RECIBIDO_PARCIAL', 'RECIBIDO'].includes(doc.status)) return
  const lines = db.poLines.filter((l) => l.document_id === poId)
  const full = lines.every((l) => l.qty_received >= l.quantity - EPS)
  const some = lines.some((l) => l.qty_received > EPS)
  const target = full ? 'RECIBIDO' : some ? 'RECIBIDO_PARCIAL' : 'ENVIADO'
  if (target !== doc.status) transition(ctx, doc, 'SYSTEM', { to: target })
}

function requisitionsOfOrder(db: DB, poId: string): string[] {
  const reqLineIds = new Set(
    db.poLines.filter((l) => l.document_id === poId && l.requisition_line_id).map((l) => l.requisition_line_id),
  )
  return [...new Set(db.prLines.filter((l) => reqLineIds.has(l.id)).map((l) => l.document_id))]
}

// ============================================================ Solicitud de compra

export interface RequisitionInput {
  needed_by: string | null
  priority: T.Priority
  reason: string
  notes: string
  lines: { product_id: string; quantity: number; notes?: string }[]
}

function validateRequisition(ctx: Ctx, companyId: string, input: RequisitionInput) {
  if (input.reason.trim().length < 5) {
    fail(
      'DATO_INVALIDO',
      'Explicá el motivo de la solicitud (mínimo 5 caracteres).',
      'Toda compra empieza con una necesidad justificada.',
    )
  }
  const lines = input.lines.filter((l) => l.product_id)
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un producto.')
  for (const l of lines) {
    const p = getProduct(ctx.db, companyId, l.product_id)
    if (!p.is_active) fail('DATO_INVALIDO', `${productLabel(p)} está inactivo.`)
    if (!(l.quantity > 0)) fail('DATO_INVALIDO', `La cantidad de ${p.code} debe ser mayor que cero.`)
  }
  if (input.needed_by && input.needed_by < todayAR())
    fail('DATO_INVALIDO', 'La fecha necesaria no puede ser anterior a hoy.')
  return lines
}

function writeRequisitionLines(ctx: Ctx, doc: T.Document, lines: RequisitionInput['lines']) {
  ctx.db.prLines = ctx.db.prLines.filter((l) => l.document_id !== doc.id)
  lines.forEach((l, i) => {
    ctx.db.prLines.push({
      id: uid(),
      company_id: doc.company_id,
      document_id: doc.id,
      line_no: i + 1,
      product_id: l.product_id,
      quantity: round3(l.quantity),
      qty_ordered: 0,
      notes: l.notes ?? '',
    })
  })
}

function assertSameSectorOrCreator(ctx: Ctx, doc: T.Document) {
  if (!ctx.userId) return
  const eff = effectivePermissions(ctx.db, ctx.userId, doc.company_id)
  if (eff.supervisor || doc.created_by === ctx.userId) return
  const member = getMember(ctx.db, ctx.userId, doc.company_id)
  const sectors = member ? getMemberRoles(ctx.db, member.id).map((r) => r.sector_id) : []
  if (!doc.sector_id || !sectors.includes(doc.sector_id)) {
    fail('SIN_PERMISO', 'Sólo quien creó el documento o su mismo sector pueden modificarlo.')
  }
}

export function cmdCreateRequisition(ctx: Ctx, companyId: string, input: RequisitionInput, submit: boolean) {
  const actor = requirePermission(ctx, companyId, 'purchase_requisition.create')
  const lines = validateRequisition(ctx, companyId, input)
  const doc = newDocument(ctx, companyId, 'PURCHASE_REQUISITION', actor, {
    notes: input.notes,
    pr: { needed_by: input.needed_by, priority: input.priority, reason: input.reason.trim() },
  })
  writeRequisitionLines(ctx, doc, lines)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'purchase_requisition',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number} (${lines.length} ítem${lines.length > 1 ? 's' : ''})`,
  })
  if (submit) submitRequisition(ctx, doc)
  return { id: doc.id, display_number: doc.display_number }
}

export function cmdUpdateRequisition(ctx: Ctx, docId: string, input: RequisitionInput) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_REQUISITION')
  const actor = requirePermission(ctx, doc.company_id, 'purchase_requisition.update')
  if (doc.status !== 'BORRADOR') fail('TRANSICION_INVALIDA', 'Sólo se puede modificar una solicitud en borrador.')
  assertSameSectorOrCreator(ctx, doc)
  const lines = validateRequisition(ctx, doc.company_id, input)
  doc.pr = { needed_by: input.needed_by, priority: input.priority, reason: input.reason.trim() }
  doc.notes = input.notes
  doc.updated_at = ctx.now
  doc.updated_by = ctx.userId
  writeRequisitionLines(ctx, doc, lines)
  logAudit(ctx, {
    company_id: doc.company_id,
    actor,
    action: 'UPDATE',
    entity_type: 'purchase_requisition',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    summary: `Modificó ${doc.display_number}`,
  })
}

function submitRequisition(ctx: Ctx, doc: T.Document) {
  assertSameSectorOrCreator(ctx, doc)
  transition(ctx, doc, 'SUBMIT', { summary: `Envió ${doc.display_number} a Compras` })
  // La solicitud atiende las alertas de stock mínimo de sus productos.
  const productIds = new Set(ctx.db.prLines.filter((l) => l.document_id === doc.id).map((l) => l.product_id))
  for (const t of ctx.db.tasks) {
    if (
      t.task_type === 'REPONER_STOCK' &&
      productIds.has(t.context.product_id) &&
      (t.status === 'PENDIENTE' || t.status === 'EN_CURSO')
    ) {
      t.status = 'RESUELTA'
      t.completed_by = ctx.userId
      t.completed_at = ctx.now
    }
  }
}

export function cmdSubmitRequisition(ctx: Ctx, docId: string) {
  submitRequisition(ctx, getDoc(ctx.db, docId, 'PURCHASE_REQUISITION'))
}

export function cmdRejectRequisition(ctx: Ctx, docId: string, reason: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_REQUISITION')
  transition(ctx, doc, 'REJECT', { comment: reason })
  notifyUsers(
    ctx,
    doc.company_id,
    doc.created_by ? [doc.created_by] : [],
    {
      type: 'SC_RECHAZADA',
      title: `${doc.display_number} fue rechazada por Compras`,
      body: reason,
      link_path: docPath(ctx.db, doc),
      document_id: doc.id,
    },
    ctx.userId,
  )
}

export function cmdCancelRequisition(ctx: Ctx, docId: string, reason: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_REQUISITION')
  assertSameSectorOrCreator(ctx, doc)
  transition(ctx, doc, 'CANCEL', { comment: reason })
}

export function cmdCloseRequisition(ctx: Ctx, docId: string, reason: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_REQUISITION')
  transition(ctx, doc, 'CLOSE', { comment: reason })
}

// ============================================================ Orden de compra

export interface PurchaseOrderInput {
  supplier_id: string
  expected_date: string | null
  warehouse_id: string
  payment_terms_days: number
  delivery_terms: string
  notes: string
  lines: {
    product_id: string
    requisition_line_id: string | null
    quantity: number
    unit_price: number
    vat_rate: number
  }[]
}

function validatePurchaseOrder(ctx: Ctx, companyId: string, input: PurchaseOrderInput, currentDocId?: string) {
  const { db } = ctx
  const supplier = db.suppliers.find((s) => s.id === input.supplier_id && s.company_id === companyId)
  if (!supplier) fail('DATO_INVALIDO', 'Elegí un proveedor.')
  if (!supplier.is_active) fail('DATO_INVALIDO', `El proveedor ${supplier.legal_name} está inactivo.`)
  if (!db.warehouses.some((w) => w.id === input.warehouse_id && w.company_id === companyId))
    fail('DATO_INVALIDO', 'Elegí el depósito de destino.')
  const lines = input.lines.filter((l) => l.product_id)
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un ítem.')
  const usedByReqLine = new Map<string, number>()
  for (const l of lines) {
    const p = getProduct(db, companyId, l.product_id)
    if (!p.is_active) fail('DATO_INVALIDO', `${productLabel(p)} está inactivo.`)
    if (!(l.quantity > 0)) fail('DATO_INVALIDO', `La cantidad de ${p.code} debe ser mayor que cero.`)
    if (!(l.unit_price >= 0)) fail('DATO_INVALIDO', `Indicá el precio unitario de ${p.code}.`)
    if (l.requisition_line_id) {
      const rl = db.prLines.find((x) => x.id === l.requisition_line_id && x.company_id === companyId)
      if (!rl) fail('DATO_INVALIDO', 'La línea de solicitud vinculada no existe.')
      const req = getDoc(db, rl.document_id, 'PURCHASE_REQUISITION')
      if (!['SOLICITADO', 'ORDENADO_PARCIAL', 'ORDENADO'].includes(req.status)) {
        fail('TRANSICION_INVALIDA', `${req.display_number} no está pendiente de atención.`)
      }
      if (rl.product_id !== l.product_id)
        fail('DATO_INVALIDO', `El producto no coincide con el de ${req.display_number}.`)
      const orderedElsewhere = db.poLines
        .filter((pl) => pl.requisition_line_id === rl.id && pl.document_id !== currentDocId)
        .filter((pl) => db.documents.find((d) => d.id === pl.document_id)?.status !== 'ANULADO')
        .reduce((s, pl) => s + pl.quantity, 0)
      const used = (usedByReqLine.get(rl.id) ?? 0) + l.quantity
      usedByReqLine.set(rl.id, used)
      const pending = round3(rl.quantity - orderedElsewhere)
      if (used > pending + EPS) {
        fail(
          'CANTIDAD_EXCEDE_PENDIENTE',
          `${p.code}: la cantidad supera lo pendiente de ${req.display_number} (${fmtQty(pending, p.uom_code)}).`,
          'Si hace falta comprar más, agregá una línea sin vínculo a la solicitud.',
        )
      }
    }
  }
  return { supplier, lines }
}

function writePurchaseOrderLines(ctx: Ctx, doc: T.Document, lines: PurchaseOrderInput['lines']) {
  ctx.db.poLines = ctx.db.poLines.filter((l) => l.document_id !== doc.id)
  let subtotal = 0
  let tax = 0
  lines.forEach((l, i) => {
    const line_subtotal = round2(l.quantity * l.unit_price)
    const line_tax = round2((line_subtotal * l.vat_rate) / 100)
    subtotal += line_subtotal
    tax += line_tax
    ctx.db.poLines.push({
      id: uid(),
      company_id: doc.company_id,
      document_id: doc.id,
      line_no: i + 1,
      product_id: l.product_id,
      requisition_line_id: l.requisition_line_id,
      quantity: round3(l.quantity),
      unit_price: round4(l.unit_price),
      vat_rate: l.vat_rate,
      line_subtotal,
      line_tax,
      line_total: round2(line_subtotal + line_tax),
      qty_received: 0,
    })
  })
  doc.subtotal = round2(subtotal)
  doc.tax_total = round2(tax)
  doc.total = round2(subtotal + tax)
}

function syncOrderLinks(ctx: Ctx, doc: T.Document, previousRequisitions: string[]) {
  const current = requisitionsOfOrder(ctx.db, doc.id)
  ctx.db.docLinks = ctx.db.docLinks.filter(
    (l) => !(l.to_document_id === doc.id && !current.includes(l.from_document_id)),
  )
  for (const prId of current) link(ctx, doc.company_id, prId, doc.id)
  for (const prId of new Set([...previousRequisitions, ...current])) recomputeRequisition(ctx, prId)
}

export function cmdCreatePurchaseOrder(ctx: Ctx, companyId: string, input: PurchaseOrderInput) {
  const actor = requirePermission(ctx, companyId, 'purchase_order.create')
  const { supplier, lines } = validatePurchaseOrder(ctx, companyId, input)
  const doc = newDocument(ctx, companyId, 'PURCHASE_ORDER', actor, {
    supplier_id: supplier.id,
    notes: input.notes,
    po: {
      expected_date: input.expected_date,
      warehouse_id: input.warehouse_id,
      payment_terms_days: input.payment_terms_days,
      delivery_terms: input.delivery_terms,
      approved_at: null,
      sent_at: null,
    },
  })
  writePurchaseOrderLines(ctx, doc, lines)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'purchase_order',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number} a ${supplier.legal_name} por ${money(doc.total)}`,
  })
  syncOrderLinks(ctx, doc, [])
  return { id: doc.id, display_number: doc.display_number }
}

export function cmdUpdatePurchaseOrder(ctx: Ctx, docId: string, input: PurchaseOrderInput) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_ORDER')
  const actor = requirePermission(ctx, doc.company_id, 'purchase_order.update')
  if (doc.status !== 'BORRADOR')
    fail('TRANSICION_INVALIDA', 'Sólo se puede modificar una orden en borrador. Si fue rechazada, primero reabrila.')
  const previous = requisitionsOfOrder(ctx.db, doc.id)
  const { supplier, lines } = validatePurchaseOrder(ctx, doc.company_id, input, doc.id)
  doc.supplier_id = supplier.id
  doc.notes = input.notes
  doc.po = {
    ...doc.po!,
    expected_date: input.expected_date,
    warehouse_id: input.warehouse_id,
    payment_terms_days: input.payment_terms_days,
    delivery_terms: input.delivery_terms,
  }
  doc.updated_at = ctx.now
  doc.updated_by = ctx.userId
  writePurchaseOrderLines(ctx, doc, lines)
  logAudit(ctx, {
    company_id: doc.company_id,
    actor,
    action: 'UPDATE',
    entity_type: 'purchase_order',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    summary: `Modificó ${doc.display_number} (total ${money(doc.total)})`,
  })
  syncOrderLinks(ctx, doc, previous)
}

export function findApprovalRule(db: DB, companyId: string, docType: T.DocType, amount: number) {
  return db.approvalRules
    .filter((r) => r.company_id === companyId && r.doc_type === docType && r.is_active)
    .sort((a, b) => a.level - b.level || a.min_amount - b.min_amount)
    .find((r) => amount >= r.min_amount - EPS && (r.max_amount == null || amount <= r.max_amount + EPS))
}

export function cmdSubmitPurchaseOrder(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_ORDER')
  requirePermission(ctx, doc.company_id, 'purchase_order.create')
  if (doc.status !== 'BORRADOR') fail('TRANSICION_INVALIDA', `${doc.display_number} no está en borrador.`)
  const rule = findApprovalRule(ctx.db, doc.company_id, 'PURCHASE_ORDER', doc.total)
  if (!rule) fail('SIN_REGLA_APROBACION', 'No hay una regla de aprobación para este monto. Avisá al docente.')
  ctx.db.approvalRequests.push({
    id: uid(),
    company_id: doc.company_id,
    document_id: doc.id,
    rule_id: rule.id,
    level: rule.level,
    approver_role: rule.approver_role,
    amount: doc.total,
    status: 'PENDIENTE',
    requested_by: ctx.userId ?? '',
    requested_at: ctx.now,
    decided_by: null,
    decided_at: null,
    comment: '',
  })
  transition(ctx, doc, 'SUBMIT', {
    summary: `Envió ${doc.display_number} a aprobación (${money(doc.total)}: aprueba ${ROLES[rule.approver_role].name})`,
  })
}

function pendingApproval(db: DB, docId: string) {
  const req = db.approvalRequests.find((a) => a.document_id === docId && a.status === 'PENDIENTE')
  if (!req) fail('TRANSICION_INVALIDA', 'La orden ya no está pendiente de aprobación.')
  return req
}

/** Verifica rol aprobador y separación de funciones. Devuelve el actor. */
function approverActor(ctx: Ctx, doc: T.Document, req: T.ApprovalRequest): Actor {
  requirePermission(ctx, doc.company_id, 'purchase_order.approve')
  const eff = effectivePermissions(ctx.db, ctx.userId!, doc.company_id)
  if (!eff.supervisor && !eff.roles.includes(req.approver_role)) {
    fail(
      'APROBADOR_INCORRECTO',
      `Esta orden debe aprobarla ${ROLES[req.approver_role].name}: el total (${money(req.amount)}) corresponde a ese nivel de autorización.`,
      'Los niveles de autorización dependen del monto de la operación.',
    )
  }
  const company = getCompany(ctx.db, doc.company_id)
  const rule = ctx.db.approvalRules.find((r) => r.id === req.rule_id)
  if (
    !eff.supervisor &&
    company.settings.sod_enabled &&
    (rule?.require_different_user ?? true) &&
    doc.created_by === ctx.userId
  ) {
    fail(
      'SEPARACION_FUNCIONES',
      'No podés aprobar una orden de compra que creaste vos.',
      'Separación de funciones: quien compra no autoriza su propia compra. Pedile a otro integrante del sector aprobador que la revise.',
    )
  }
  return eff.supervisor ? actorFor(ctx, doc.company_id) : actorFor(ctx, doc.company_id, undefined, req.approver_role)
}

export function cmdApprovePurchaseOrder(ctx: Ctx, docId: string, comment: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_ORDER')
  const req = pendingApproval(ctx.db, doc.id)
  const actor = approverActor(ctx, doc, req)
  req.status = 'APROBADO'
  req.decided_by = ctx.userId
  req.decided_at = ctx.now
  req.comment = comment.trim()
  doc.po = { ...doc.po!, approved_at: ctx.now }
  transition(ctx, doc, 'APPROVE', {
    actor,
    comment,
    summary: `Aprobó ${doc.display_number} por ${money(doc.total)}${comment.trim() ? ` — ${comment.trim()}` : ''}`,
  })
  notifyUsers(
    ctx,
    doc.company_id,
    doc.created_by ? [doc.created_by] : [],
    {
      type: 'OC_APROBADA',
      title: `${doc.display_number} fue aprobada`,
      body: `Aprobó: ${actor.name} (${actor.sector_name}).`,
      link_path: docPath(ctx.db, doc),
      document_id: doc.id,
    },
    ctx.userId,
  )
}

export function cmdRejectPurchaseOrder(ctx: Ctx, docId: string, reason: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_ORDER')
  const req = pendingApproval(ctx.db, doc.id)
  const actor = approverActor(ctx, doc, req)
  if (reason.trim().length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo del rechazo.')
  req.status = 'RECHAZADO'
  req.decided_by = ctx.userId
  req.decided_at = ctx.now
  req.comment = reason.trim()
  transition(ctx, doc, 'REJECT', { actor, comment: reason })
}

export function cmdWithdrawPurchaseOrder(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_ORDER')
  const eff = effectivePermissions(ctx.db, ctx.userId!, doc.company_id)
  if (!eff.supervisor && doc.created_by !== ctx.userId)
    fail('SIN_PERMISO', 'Sólo quien creó la orden puede retirarla de aprobación.')
  const req = pendingApproval(ctx.db, doc.id)
  req.status = 'CANCELADO'
  req.decided_at = ctx.now
  transition(ctx, doc, 'WITHDRAW')
}

export function cmdReopenPurchaseOrder(ctx: Ctx, docId: string) {
  transition(ctx, getDoc(ctx.db, docId, 'PURCHASE_ORDER'), 'REOPEN')
}

export function cmdSendPurchaseOrder(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_ORDER')
  const supplier = ctx.db.suppliers.find((s) => s.id === doc.supplier_id)
  transition(ctx, doc, 'SEND', { summary: `Envió ${doc.display_number} al proveedor ${supplier?.legal_name ?? ''}` })
  doc.po = { ...doc.po!, sent_at: ctx.now }
}

export function cmdCancelPurchaseOrder(ctx: Ctx, docId: string, reason: string) {
  const doc = getDoc(ctx.db, docId, 'PURCHASE_ORDER')
  if (ctx.db.poLines.some((l) => l.document_id === doc.id && l.qty_received > EPS)) {
    fail('TRANSICION_INVALIDA', 'La orden tiene recepciones confirmadas: no se puede anular. Usá "Cerrar saldo".')
  }
  const reqs = requisitionsOfOrder(ctx.db, doc.id)
  transition(ctx, doc, 'CANCEL', { comment: reason })
  for (const prId of reqs) recomputeRequisition(ctx, prId)
}

export function cmdClosePurchaseOrder(ctx: Ctx, docId: string, reason: string) {
  transition(ctx, getDoc(ctx.db, docId, 'PURCHASE_ORDER'), 'CLOSE', { comment: reason })
}

// ============================================================ Recepción

export interface GoodsReceiptInput {
  purchase_order_id: string
  warehouse_id: string
  supplier_delivery_note: string
  carrier_name: string
  notes: string
  lines: { po_line_id: string; quantity: number; notes?: string }[]
}

function receivedInConfirmed(db: DB, poLineId: string) {
  return db.poLines.find((l) => l.id === poLineId)?.qty_received ?? 0
}

export function cmdCreateGoodsReceipt(ctx: Ctx, companyId: string, input: GoodsReceiptInput, confirm: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'goods_receipt.create')
  const po = getDoc(db, input.purchase_order_id, 'PURCHASE_ORDER')
  if (po.company_id !== companyId) fail('DATO_INVALIDO', 'La orden no pertenece a esta empresa.')
  if (!['ENVIADO', 'RECIBIDO_PARCIAL'].includes(po.status)) {
    fail(
      'TRANSICION_INVALIDA',
      `${po.display_number} está "${statusLabel('PURCHASE_ORDER', po.status)}": sólo se reciben órdenes enviadas al proveedor.`,
    )
  }
  if (input.supplier_delivery_note.trim().length < 3) {
    fail(
      'DATO_INVALIDO',
      'Ingresá el número de remito del proveedor.',
      'El remito es el comprobante que acompaña la mercadería: se controla contra la OC.',
    )
  }
  if (!db.warehouses.some((w) => w.id === input.warehouse_id && w.company_id === companyId))
    fail('DATO_INVALIDO', 'Elegí el depósito.')
  const lines = input.lines.filter((l) => l.quantity > 0)
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá la cantidad recibida de al menos un ítem.')
  const doc = newDocument(ctx, companyId, 'GOODS_RECEIPT', actor, {
    supplier_id: po.supplier_id,
    notes: input.notes,
    gr: {
      purchase_order_id: po.id,
      warehouse_id: input.warehouse_id,
      supplier_delivery_note: input.supplier_delivery_note.trim(),
      carrier_name: input.carrier_name.trim(),
      received_at: null,
    },
  })
  let total = 0
  lines.forEach((l, i) => {
    const pl = db.poLines.find((x) => x.id === l.po_line_id && x.document_id === po.id)
    if (!pl) fail('DATO_INVALIDO', 'Una línea no corresponde a la orden de compra.')
    const p = getProduct(db, companyId, pl.product_id)
    const pending = round3(pl.quantity - receivedInConfirmed(db, pl.id))
    if (l.quantity > pending + EPS) {
      fail(
        'CANTIDAD_EXCEDE_PENDIENTE',
        `${p.code}: se reciben ${fmtQty(l.quantity)} pero sólo quedan ${fmtQty(pending, p.uom_code)} pendientes.`,
        'No se puede recibir más de lo ordenado. Si llegó de más, se devuelve o se gestiona una nueva OC.',
      )
    }
    total += l.quantity * pl.unit_price
    db.grLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      po_line_id: pl.id,
      product_id: pl.product_id,
      quantity: round3(l.quantity),
      unit_cost: pl.unit_price,
      notes: l.notes ?? '',
    })
  })
  doc.subtotal = round2(total)
  doc.total = round2(total)
  link(ctx, companyId, po.id, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'goods_receipt',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number} contra ${po.display_number} (remito ${doc.gr!.supplier_delivery_note})`,
  })
  if (confirm) confirmReceipt(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

function confirmReceipt(ctx: Ctx, doc: T.Document) {
  const { db } = ctx
  const po = getDoc(db, doc.gr!.purchase_order_id, 'PURCHASE_ORDER')
  if (!['ENVIADO', 'RECIBIDO_PARCIAL'].includes(po.status)) {
    fail(
      'TRANSICION_INVALIDA',
      `${po.display_number} ya no admite recepciones (estado "${statusLabel('PURCHASE_ORDER', po.status)}").`,
    )
  }
  const actor = transition(ctx, doc, 'CONFIRM', {
    summary: `Confirmó ${doc.display_number}: ingresó mercadería de ${po.display_number} (remito ${doc.gr!.supplier_delivery_note})`,
  })
  for (const line of db.grLines.filter((l) => l.document_id === doc.id)) {
    const pl = db.poLines.find((x) => x.id === line.po_line_id)!
    const pending = round3(pl.quantity - pl.qty_received)
    if (line.quantity > pending + EPS) {
      const p = getProduct(db, doc.company_id, line.product_id)
      fail(
        'CANTIDAD_EXCEDE_PENDIENTE',
        `${p.code}: la cantidad supera lo pendiente de la orden (${fmtQty(pending, p.uom_code)}).`,
      )
    }
    pl.qty_received = round3(pl.qty_received + line.quantity)
    postMovement(ctx, {
      company_id: doc.company_id,
      product_id: line.product_id,
      warehouse_id: doc.gr!.warehouse_id,
      type: 'RECEPCION_COMPRA',
      quantity: line.quantity,
      unit_cost: line.unit_cost,
      document_id: doc.id,
      document_line_id: line.id,
      date: doc.document_date,
    })
  }
  doc.gr = { ...doc.gr!, received_at: ctx.now }
  recomputePurchaseOrder(ctx, po.id)
  const full = po.status === 'RECIBIDO'
  notifyRoles(
    ctx,
    doc.company_id,
    ['COMPRAS'],
    {
      type: 'OC_RECIBIDA',
      title: `${po.display_number} ${full ? 'recibida' : 'recibida parcialmente'}`,
      body: `Depósito registró ${doc.display_number} (remito ${doc.gr!.supplier_delivery_note}).`,
      link_path: docPath(db, po),
      document_id: po.id,
    },
    actor.user_id,
  )
  const requesters = requisitionsOfOrder(db, po.id)
    .map((id) => db.documents.find((d) => d.id === id)?.created_by)
    .filter((x): x is string => !!x)
  const productNames = [
    ...new Set(
      db.grLines
        .filter((l) => l.document_id === doc.id)
        .map((l) => db.products.find((p) => p.id === l.product_id)?.code),
    ),
  ].join(', ')
  notifyUsers(
    ctx,
    doc.company_id,
    requesters,
    {
      type: 'MATERIAL_DISPONIBLE',
      title: `Material disponible: ${productNames}`,
      body: `Ingresó al stock con ${doc.display_number}.`,
      link_path: docPath(db, doc),
      document_id: doc.id,
    },
    actor.user_id,
  )
}

export function cmdConfirmGoodsReceipt(ctx: Ctx, docId: string) {
  confirmReceipt(ctx, getDoc(ctx.db, docId, 'GOODS_RECEIPT'))
}

export function cmdCancelGoodsReceipt(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'GOODS_RECEIPT')
  if (doc.status === 'CONFIRMADO') {
    const eff = effectivePermissions(db, ctx.userId!, doc.company_id)
    const company = getCompany(db, doc.company_id)
    if (
      company.settings.sod_enabled &&
      !eff.supervisor &&
      !eff.roles.includes('GERENCIA') &&
      doc.created_by === ctx.userId
    ) {
      fail(
        'SEPARACION_FUNCIONES',
        'No podés anular una recepción que registraste vos.',
        'Otro integrante de Depósito o Gerencia debe revisar y anular.',
      )
    }
    const po = getDoc(db, doc.gr!.purchase_order_id, 'PURCHASE_ORDER')
    if (po.status === 'CERRADO')
      fail('TRANSICION_INVALIDA', `${po.display_number} está cerrada: la recepción ya no puede anularse.`)
    transition(ctx, doc, 'CANCEL', {
      comment: reason,
      summary: `Anuló ${doc.display_number} con contramovimiento — ${reason.trim()}`,
    })
    for (const line of db.grLines.filter((l) => l.document_id === doc.id)) {
      const pl = db.poLines.find((x) => x.id === line.po_line_id)!
      pl.qty_received = round3(pl.qty_received - line.quantity)
      postMovement(ctx, {
        company_id: doc.company_id,
        product_id: line.product_id,
        warehouse_id: doc.gr!.warehouse_id,
        type: 'ANULACION_RECEPCION',
        quantity: -line.quantity,
        document_id: doc.id,
        document_line_id: line.id,
        date: businessDate(company),
      })
    }
    recomputePurchaseOrder(ctx, po.id)
    return
  }
  transition(ctx, doc, 'CANCEL', { comment: reason })
}

// ============================================================ Ajuste de stock

export interface StockAdjustmentInput {
  warehouse_id: string
  reason_code: T.AdjustmentReason
  notes: string
  lines: { product_id: string; quantity_delta: number; unit_cost?: number; notes?: string }[]
}

export function cmdCreateStockAdjustment(ctx: Ctx, companyId: string, input: StockAdjustmentInput, confirm: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'stock_adjustment.create')
  if (!db.warehouses.some((w) => w.id === input.warehouse_id && w.company_id === companyId))
    fail('DATO_INVALIDO', 'Elegí el depósito.')
  if (input.notes.trim().length < 3 && input.reason_code === 'OTRO')
    fail('DATO_INVALIDO', 'Explicá el motivo del ajuste.')
  const lines = input.lines.filter((l) => l.product_id && l.quantity_delta !== 0)
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un producto con una cantidad distinta de cero.')
  const doc = newDocument(ctx, companyId, 'STOCK_ADJUSTMENT', actor, {
    notes: input.notes,
    sa: { warehouse_id: input.warehouse_id, reason_code: input.reason_code },
  })
  let total = 0
  lines.forEach((l, i) => {
    const p = getProduct(db, companyId, l.product_id)
    if (!p.is_stockable)
      fail('DATO_INVALIDO', `${p.code} es un ${PRODUCT_TYPES[p.product_type].toLowerCase()}: no lleva stock.`)
    const bal = db.stockBalances.find((b) => b.product_id === p.id && b.warehouse_id === input.warehouse_id)
    const cost = l.unit_cost && l.unit_cost > 0 ? l.unit_cost : bal?.avg_unit_cost || p.standard_cost
    total += l.quantity_delta * cost
    db.saLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      product_id: p.id,
      quantity_delta: round3(l.quantity_delta),
      unit_cost: round4(cost),
      notes: l.notes ?? '',
    })
  })
  doc.subtotal = round2(total)
  doc.total = round2(total)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'stock_adjustment',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number} (${lines.length} ítem${lines.length > 1 ? 's' : ''})`,
  })
  if (confirm) confirmAdjustment(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

function confirmAdjustment(ctx: Ctx, doc: T.Document) {
  transition(ctx, doc, 'CONFIRM')
  for (const line of ctx.db.saLines.filter((l) => l.document_id === doc.id)) {
    const type: T.MovementType =
      doc.sa!.reason_code === 'INVENTARIO_INICIAL' && line.quantity_delta > 0
        ? 'STOCK_INICIAL'
        : line.quantity_delta > 0
          ? 'AJUSTE_POSITIVO'
          : 'AJUSTE_NEGATIVO'
    postMovement(ctx, {
      company_id: doc.company_id,
      product_id: line.product_id,
      warehouse_id: doc.sa!.warehouse_id,
      type,
      quantity: line.quantity_delta,
      unit_cost: line.unit_cost,
      document_id: doc.id,
      document_line_id: line.id,
      date: doc.document_date,
    })
  }
}

export function cmdConfirmStockAdjustment(ctx: Ctx, docId: string) {
  confirmAdjustment(ctx, getDoc(ctx.db, docId, 'STOCK_ADJUSTMENT'))
}

export function cmdCancelStockAdjustment(ctx: Ctx, docId: string, reason: string) {
  transition(ctx, getDoc(ctx.db, docId, 'STOCK_ADJUSTMENT'), 'CANCEL', { comment: reason })
}

// ============================================================ Maestros

export type MasterKind = 'customer' | 'supplier' | 'product'

const MASTER_LABEL: Record<MasterKind, string> = { customer: 'cliente', supplier: 'proveedor', product: 'producto' }

function masterTable(db: DB, kind: MasterKind): (T.Customer | T.Supplier | T.Product)[] {
  return kind === 'customer' ? db.customers : kind === 'supplier' ? db.suppliers : db.products
}

function masterLabel(kind: MasterKind, row: T.Customer | T.Supplier | T.Product) {
  return kind === 'product' ? productLabel(row as T.Product) : `${row.code} ${(row as T.Partner).legal_name}`
}

export function cmdSaveMaster(
  ctx: Ctx,
  kind: MasterKind,
  companyId: string,
  input: Record<string, unknown> & { id?: string },
) {
  const { db } = ctx
  const isNew = !input.id
  const actor = requirePermission(ctx, companyId, `${kind}.${isNew ? 'create' : 'update'}`)
  const table = masterTable(db, kind)
  const code = String(input.code ?? '')
    .trim()
    .toUpperCase()
  if (!code) fail('DATO_INVALIDO', 'Ingresá el código.')
  if (table.some((r) => r.company_id === companyId && r.code === code && r.id !== input.id)) {
    fail('DATO_INVALIDO', `Ya existe un ${MASTER_LABEL[kind]} con el código ${code}.`)
  }
  const nameField = kind === 'product' ? 'name' : 'legal_name'
  if (String(input[nameField] ?? '').trim().length < 2)
    fail('DATO_INVALIDO', kind === 'product' ? 'Ingresá la descripción del producto.' : 'Ingresá la razón social.')
  const clean: Record<string, unknown> = { ...input, code }
  if (kind === 'product') clean.is_stockable = input.product_type !== 'SERVICIO'
  delete clean.id
  delete clean.company_id

  if (isNew) {
    const row = {
      ...clean,
      id: uid(),
      company_id: companyId,
      is_active: true,
      created_at: ctx.now,
      created_by: ctx.userId,
      updated_at: ctx.now,
      updated_by: ctx.userId,
    } as unknown as T.Customer & T.Supplier & T.Product
    table.push(row)
    logAudit(ctx, {
      company_id: companyId,
      actor,
      action: 'CREATE',
      entity_type: kind,
      entity_id: row.id,
      entity_label: masterLabel(kind, row),
      summary: `Dio de alta el ${MASTER_LABEL[kind]} ${masterLabel(kind, row)}`,
    })
    return row.id
  }
  const row = table.find((r) => r.id === input.id && r.company_id === companyId)
  if (!row) fail('DATO_INVALIDO', `El ${MASTER_LABEL[kind]} no existe.`)
  const before = { ...row }
  Object.assign(row, clean, { updated_at: ctx.now, updated_by: ctx.userId })
  const keys = Object.keys(clean) as (keyof typeof row)[]
  const changes = diff(before, row, keys)
  if (Object.keys(changes).length) {
    logAudit(ctx, {
      company_id: companyId,
      actor,
      action: 'UPDATE',
      entity_type: kind,
      entity_id: row.id,
      entity_label: masterLabel(kind, row),
      summary: `Modificó el ${MASTER_LABEL[kind]} ${masterLabel(kind, row)}`,
      changes,
    })
  }
  return row.id
}

export function cmdSetMasterActive(ctx: Ctx, kind: MasterKind, companyId: string, id: string, active: boolean) {
  const actor = requirePermission(ctx, companyId, `${kind}.update`)
  const row = masterTable(ctx.db, kind).find((r) => r.id === id && r.company_id === companyId)
  if (!row) fail('DATO_INVALIDO', `El ${MASTER_LABEL[kind]} no existe.`)
  row.is_active = active
  row.updated_at = ctx.now
  row.updated_by = ctx.userId
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: active ? 'ACTIVATE' : 'DEACTIVATE',
    entity_type: kind,
    entity_id: row.id,
    entity_label: masterLabel(kind, row),
    summary: `${active ? 'Activó' : 'Desactivó'} el ${MASTER_LABEL[kind]} ${masterLabel(kind, row)}`,
  })
}

// ============================================================ Tareas y notificaciones

export function cmdClaimTask(ctx: Ctx, taskId: string, claim: boolean) {
  const task = ctx.db.tasks.find((t) => t.id === taskId)
  if (!task) fail('DATO_INVALIDO', 'La tarea no existe.')
  if (task.status !== 'PENDIENTE' && task.status !== 'EN_CURSO')
    fail('TRANSICION_INVALIDA', 'La tarea ya está resuelta.')
  if (claim) {
    if (task.claimed_by && task.claimed_by !== ctx.userId) {
      fail('TAREA_TOMADA', `La tarea ya la tomó ${fullName(getProfile(ctx.db, task.claimed_by))}.`)
    }
    task.claimed_by = ctx.userId
    task.claimed_at = ctx.now
    task.status = 'EN_CURSO'
  } else {
    task.claimed_by = null
    task.claimed_at = null
    task.status = 'PENDIENTE'
  }
}

export function cmdMarkNotificationsRead(ctx: Ctx, ids: string[] | 'all', companyId: string) {
  for (const n of ctx.db.notifications) {
    if (n.recipient_user_id !== ctx.userId || n.company_id !== companyId || n.read_at) continue
    if (ids === 'all' || ids.includes(n.id)) n.read_at = ctx.now
  }
}

// ============================================================ Panel docente

export function cmdAssignRole(ctx: Ctx, companyId: string, userId: string, role: T.RoleCode, sectorId: string | null) {
  const actor = requireSupervisor(ctx, companyId)
  const { db } = ctx
  let member = getMember(db, userId, companyId)
  if (!member) {
    member = { id: uid(), company_id: companyId, user_id: userId, job_title: '', is_active: true }
    db.members.push(member)
  }
  if (db.memberRoles.some((r) => r.member_id === member.id && r.role_code === role && r.sector_id === sectorId)) {
    fail('DATO_INVALIDO', 'Esa asignación ya existe.')
  }
  db.memberRoles.push({ id: uid(), company_id: companyId, member_id: member.id, role_code: role, sector_id: sectorId })
  const profile = getProfile(db, userId)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'ASSIGN_ROLE',
    entity_type: 'member_role',
    entity_id: member.id,
    entity_label: fullName(profile),
    summary: `Asignó el rol ${ROLES[role].name} (${sectorName(db, sectorId)}) a ${fullName(profile)}`,
  })
}

export function cmdRemoveRole(ctx: Ctx, companyId: string, memberRoleId: string) {
  const actor = requireSupervisor(ctx, companyId)
  const { db } = ctx
  const mr = db.memberRoles.find((r) => r.id === memberRoleId && r.company_id === companyId)
  if (!mr) fail('DATO_INVALIDO', 'La asignación no existe.')
  const member = db.members.find((m) => m.id === mr.member_id)
  if (mr.role_code === 'DOCENTE' && member?.user_id === ctx.userId)
    fail('DATO_INVALIDO', 'No podés quitarte tu propio rol de supervisor.')
  db.memberRoles = db.memberRoles.filter((r) => r.id !== memberRoleId)
  const profile = getProfile(db, member?.user_id ?? null)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'REMOVE_ROLE',
    entity_type: 'member_role',
    entity_id: mr.member_id,
    entity_label: fullName(profile),
    summary: `Quitó el rol ${ROLES[mr.role_code].name} a ${fullName(profile)}`,
  })
}

export interface StudentInput {
  first_name: string
  last_name: string
  username: string
  password: string
}

export function cmdCreateStudent(ctx: Ctx, companyId: string, input: StudentInput) {
  const actor = requireSupervisor(ctx, companyId)
  const { db } = ctx
  const username = input.username.trim().toLowerCase()
  if (!/^[a-z0-9._-]{3,30}$/.test(username))
    fail('DATO_INVALIDO', 'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto o guion.')
  if (db.profiles.some((p) => p.username === username)) fail('DATO_INVALIDO', `El usuario ${username} ya existe.`)
  if (input.first_name.trim().length < 2 || input.last_name.trim().length < 2)
    fail('DATO_INVALIDO', 'Ingresá nombre y apellido.')
  if (input.password.length < 6) fail('DATO_INVALIDO', 'La contraseña inicial debe tener al menos 6 caracteres.')
  const profile: T.Profile = {
    id: uid(),
    username,
    password: input.password,
    first_name: input.first_name.trim(),
    last_name: input.last_name.trim(),
    app_role: 'ESTUDIANTE',
    is_active: true,
    must_change_password: false,
    created_at: ctx.now,
  }
  db.profiles.push(profile)
  db.members.push({ id: uid(), company_id: companyId, user_id: profile.id, job_title: '', is_active: true })
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'profile',
    entity_id: profile.id,
    entity_label: fullName(profile),
    summary: `Dio de alta al estudiante ${fullName(profile)} (${username})`,
  })
  return profile.id
}

export function cmdSetModule(ctx: Ctx, companyId: string, module: T.ModuleCode, enabled: boolean) {
  const actor = requireSupervisor(ctx, companyId)
  const row = ctx.db.companyModules.find((m) => m.company_id === companyId && m.module_code === module)
  if (row) row.is_enabled = enabled
  else ctx.db.companyModules.push({ company_id: companyId, module_code: module, is_enabled: enabled })
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'SETTINGS',
    entity_type: 'company_module',
    entity_id: companyId,
    entity_label: MODULES[module].name,
    summary: `${enabled ? 'Habilitó' : 'Bloqueó'} el módulo ${MODULES[module].name}`,
  })
}

export function cmdUpdateCompanySettings(ctx: Ctx, companyId: string, settings: Partial<T.CompanySettings>) {
  const actor = requireSupervisor(ctx, companyId)
  const company = getCompany(ctx.db, companyId)
  const before = { ...company.settings }
  company.settings = { ...company.settings, ...settings }
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'SETTINGS',
    entity_type: 'company',
    entity_id: companyId,
    entity_label: company.legal_name,
    summary: 'Cambió la configuración de control interno de la empresa',
    changes: diff(before, company.settings, ['sod_enabled', 'allow_negative_stock']),
  })
}
