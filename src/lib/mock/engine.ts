// Motor de negocio simulado. Cada función exportada `cmd*` equivale a una
// función RPC de PostgreSQL (DATABASE.md §13): valida permiso, estado,
// separación de funciones y datos, aplica efectos y registra auditoría,
// tareas y notificaciones. Se ejecuta dentro de `transact` (todo o nada).

import {
  ACTION_VERBS,
  ADJUSTMENT_REASONS,
  DOC_STATUSES,
  DOC_TYPES,
  MODULES,
  POSTING_EVENTS,
  PRODUCT_TYPES,
  ROLES,
  ROLE_ORDER,
  ROLE_PERMISSIONS,
  SELLABLE_PRODUCT_TYPES,
  TASK_RULES,
  TRANSITIONS,
  UNITS,
  VAT_CONDITIONS,
  VAT_RATES,
  permissionModule,
  type TransitionInfo,
} from '../domain/catalog'
import {
  ACCOUNT_CODE_PATTERN,
  BASE_CHART,
  BASE_POSTING_RULES,
  IMPUTABLE_LEVEL,
  INVENTORY_ACCOUNTS,
  OPENING_BALANCES,
  OPENING_BALANCING_ACCOUNT,
  TREASURY_RUBRO,
  accountLevel,
  accountTypeOf,
  normalSideOf,
  parentCode,
} from '../domain/chart-of-accounts'
import { MAX_BULK_STUDENTS, baseUsername, uniqueUsername } from '../domain/students'
import type * as T from '../domain/types'
import { addDays, date as fmtDate, money, qty as fmtQty, todayAR } from '../format'
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

/**
 * SUPERADMIN es quien instala y sostiene la instancia (el proveedor): tiene
 * supervisor completo en cualquier empresa, igual que un DOCENTE.
 *
 * ADMIN es la administración de la escuela (altas de docentes y cursos, a
 * nivel institución): no opera dentro de una empresa simulada, así que NO
 * hereda supervisor ahí. Si alguna vez necesita actuar dentro de una, debe
 * dársele un rol de empresa explícito (member + memberRole), igual que a
 * cualquier otro miembro.
 */
export function isInstanceAdmin(p: T.Profile | undefined): boolean {
  return p?.app_role === 'SUPERADMIN'
}

export function getMember(db: DB, userId: string, companyId: string) {
  return db.members.find((m) => m.user_id === userId && m.company_id === companyId)
}

/** Roles de un integrante en el orden del catálogo (y por sector): el mismo que usa la base. */
export function getMemberRoles(db: DB, memberId: string) {
  const sectorCode = (r: T.MemberRole) => db.sectors.find((s) => s.id === r.sector_id)?.code ?? ''
  return db.memberRoles
    .filter((r) => r.member_id === memberId)
    .sort(
      (a, b) =>
        ROLE_ORDER.indexOf(a.role_code) - ROLE_ORDER.indexOf(b.role_code) ||
        (sectorCode(a) < sectorCode(b) ? -1 : sectorCode(a) > sectorCode(b) ? 1 : 0),
    )
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
  // Quien hizo la operación, aunque el cambio sea automático (como el disparador set_updated de la base).
  doc.updated_by = ctx.userId
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
  if (!Number.isFinite(m.quantity) || round3(m.quantity) === 0)
    fail('DATO_INVALIDO', 'La cantidad del movimiento debe ser finita y distinta de cero (hasta 3 decimales).')
  if (m.unit_cost !== undefined && (!Number.isFinite(m.unit_cost) || m.unit_cost < 0))
    fail('DATO_INVALIDO', 'El costo unitario debe ser un número finito mayor o igual que cero.')
  if (!db.warehouses.some((w) => w.id === m.warehouse_id && w.company_id === m.company_id))
    fail('DATO_INVALIDO', 'Elegí un depósito de esta empresa.')
  if (!product.is_stockable) return
  const company = getCompany(db, m.company_id)
  let bal = db.stockBalances.find((b) => b.product_id === m.product_id && b.warehouse_id === m.warehouse_id)
  if (!bal) {
    bal = {
      company_id: m.company_id,
      product_id: m.product_id,
      warehouse_id: m.warehouse_id,
      qty_on_hand: 0,
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

/** Un borrador todavía no compromete a la empresa con el proveedor: no cuenta como "ya ordenado". */
function coversRequisitionLine(db: DB, poDocId: string): boolean {
  const status = db.documents.find((d) => d.id === poDocId)?.status
  return !!status && status !== 'ANULADO' && status !== 'BORRADOR'
}

function recomputeRequisition(ctx: Ctx, prId: string) {
  const { db } = ctx
  const doc = getDoc(db, prId, 'PURCHASE_REQUISITION')
  const lines = db.prLines.filter((l) => l.document_id === prId)
  for (const line of lines) {
    line.qty_ordered = round3(
      db.poLines
        .filter((pl) => pl.requisition_line_id === line.id)
        .filter((pl) => coversRequisitionLine(db, pl.document_id))
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
  const lines = input.lines.filter((l) => l.product_id).map((l) => ({ ...l, quantity: round3(l.quantity) }))
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un producto.')
  for (const l of lines) {
    const p = getProduct(ctx.db, companyId, l.product_id)
    if (!p.is_active) fail('DATO_INVALIDO', `${productLabel(p)} está inactivo.`)
    if (!Number.isFinite(l.quantity) || !(l.quantity > 0))
      fail('DATO_INVALIDO', `La cantidad de ${p.code} debe ser mayor que cero y tener hasta 3 decimales.`)
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

/** Los borradores reservan cantidades, aunque todavía no cambien el estado de la SC. */
export function requisitionAvailableQuantity(db: DB, lineId: string, currentDocId?: string): number {
  const line = db.prLines.find((l) => l.id === lineId)
  if (!line) return 0
  const reserved = db.poLines
    .filter((l) => l.requisition_line_id === lineId && l.document_id !== currentDocId)
    .filter((l) => db.documents.some((d) => d.id === l.document_id && d.status !== 'ANULADO'))
    .reduce((sum, l) => sum + l.quantity, 0)
  return round3(line.quantity - reserved)
}

function validatePurchaseOrder(ctx: Ctx, companyId: string, input: PurchaseOrderInput, currentDocId?: string) {
  const { db } = ctx
  const supplier = db.suppliers.find((s) => s.id === input.supplier_id && s.company_id === companyId)
  if (!supplier) fail('DATO_INVALIDO', 'Elegí un proveedor.')
  if (!supplier.is_active) fail('DATO_INVALIDO', `El proveedor ${supplier.legal_name} está inactivo.`)
  if (!db.warehouses.some((w) => w.id === input.warehouse_id && w.company_id === companyId))
    fail('DATO_INVALIDO', 'Elegí el depósito de destino.')
  if (!Number.isInteger(input.payment_terms_days) || input.payment_terms_days < 0)
    fail('DATO_INVALIDO', 'El plazo de pago debe ser una cantidad entera de días mayor o igual que cero.')
  const lines = input.lines
    .filter((l) => l.product_id)
    .map((l) => ({ ...l, quantity: round3(l.quantity), unit_price: round4(l.unit_price) }))
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un ítem.')
  const usedByReqLine = new Map<string, number>()
  for (const l of lines) {
    const p = getProduct(db, companyId, l.product_id)
    if (!p.is_active) fail('DATO_INVALIDO', `${productLabel(p)} está inactivo.`)
    if (!Number.isFinite(l.quantity) || !(l.quantity > 0))
      fail('DATO_INVALIDO', `La cantidad de ${p.code} debe ser mayor que cero y tener hasta 3 decimales.`)
    if (!Number.isFinite(l.unit_price) || !(l.unit_price >= 0))
      fail('DATO_INVALIDO', `Indicá un precio unitario válido para ${p.code}.`)
    if (!VAT_RATES.includes(l.vat_rate)) fail('DATO_INVALIDO', `La alícuota de IVA de ${p.code} no es válida.`)
    if (!Number.isFinite(l.quantity * l.unit_price * (1 + l.vat_rate / 100)))
      fail('DATO_INVALIDO', `El importe de ${p.code} es demasiado grande.`)
    if (l.requisition_line_id) {
      const rl = db.prLines.find((x) => x.id === l.requisition_line_id && x.company_id === companyId)
      if (!rl) fail('DATO_INVALIDO', 'La línea de solicitud vinculada no existe.')
      const req = getDoc(db, rl.document_id, 'PURCHASE_REQUISITION')
      if (!['SOLICITADO', 'ORDENADO_PARCIAL', 'ORDENADO'].includes(req.status)) {
        fail('TRANSICION_INVALIDA', `${req.display_number} no está pendiente de atención.`)
      }
      if (rl.product_id !== l.product_id)
        fail('DATO_INVALIDO', `El producto no coincide con el de ${req.display_number}.`)
      const used = (usedByReqLine.get(rl.id) ?? 0) + l.quantity
      usedByReqLine.set(rl.id, used)
      const pending = requisitionAvailableQuantity(db, rl.id, currentDocId)
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
  // Recién ahora deja de ser un borrador: las solicitudes que cubre pasan a "Ordenada"/"Ordenada parcialmente".
  for (const prId of requisitionsOfOrder(ctx.db, doc.id)) recomputeRequisition(ctx, prId)
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
  // Vuelve a ser un borrador: las solicitudes que cubría dejan de contarla como "ya ordenado".
  for (const prId of requisitionsOfOrder(ctx.db, doc.id)) recomputeRequisition(ctx, prId)
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
  const deliveryNote = input.supplier_delivery_note.trim()
  if (deliveryNote.length < 3) {
    fail(
      'DATO_INVALIDO',
      'Ingresá el número de remito del proveedor.',
      'El remito es el comprobante que acompaña la mercadería: se controla contra la OC.',
    )
  }
  const duplicate = db.documents.find(
    (d) =>
      d.doc_type === 'GOODS_RECEIPT' &&
      d.status !== 'ANULADO' &&
      d.gr?.purchase_order_id === po.id &&
      d.gr.supplier_delivery_note.trim().toUpperCase() === deliveryNote.toUpperCase(),
  )
  if (duplicate) {
    fail(
      'REMITO_DUPLICADO',
      `Ya existe ${duplicate.display_number} con el remito ${deliveryNote} contra ${po.display_number}.`,
      'Revisá si esta entrega ya se registró antes de cargarla de nuevo. Si fue un error, anulá la recepción anterior primero.',
    )
  }
  if (!db.warehouses.some((w) => w.id === input.warehouse_id && w.company_id === companyId))
    fail('DATO_INVALIDO', 'Elegí el depósito.')
  for (const line of input.lines) {
    if (!Number.isFinite(line.quantity) || line.quantity < 0 || (line.quantity > 0 && round3(line.quantity) === 0))
      fail(
        'DATO_INVALIDO',
        'Las cantidades recibidas deben ser números mayores o iguales que cero (hasta 3 decimales).',
      )
  }
  const lines = input.lines.filter((l) => l.quantity > 0).map((l) => ({ ...l, quantity: round3(l.quantity) }))
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá la cantidad recibida de al menos un ítem.')
  const receivedByLine = new Map<string, number>()
  for (const line of lines) {
    const pl = db.poLines.find((l) => l.id === line.po_line_id && l.document_id === po.id)
    if (!pl) fail('DATO_INVALIDO', 'Una línea no corresponde a la orden de compra.')
    const p = getProduct(db, companyId, pl.product_id)
    const pending = round3(pl.quantity - receivedInConfirmed(db, pl.id))
    const received = round3((receivedByLine.get(pl.id) ?? 0) + line.quantity)
    receivedByLine.set(pl.id, received)
    if (received > pending + EPS) {
      fail(
        'CANTIDAD_EXCEDE_PENDIENTE',
        `${p.code}: se reciben ${fmtQty(received)} pero sólo quedan ${fmtQty(pending, p.uom_code)} pendientes.`,
        'No se puede recibir más de lo ordenado. Si llegó de más, se devuelve o se gestiona una nueva OC.',
      )
    }
  }
  const doc = newDocument(ctx, companyId, 'GOODS_RECEIPT', actor, {
    supplier_id: po.supplier_id,
    notes: input.notes,
    gr: {
      purchase_order_id: po.id,
      warehouse_id: input.warehouse_id,
      supplier_delivery_note: deliveryNote,
      carrier_name: input.carrier_name.trim(),
      received_at: null,
    },
  })
  let total = 0
  lines.forEach((l, i) => {
    const pl = db.poLines.find((x) => x.id === l.po_line_id && x.document_id === po.id)!
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
    // Lo facturado nunca queda por encima de lo recibido.
    for (const line of db.grLines.filter((l) => l.document_id === doc.id)) {
      const pl = db.poLines.find((x) => x.id === line.po_line_id)!
      const invoiced = invoicedQuantity(db, pl.id)
      if (invoiced > round3(pl.qty_received - line.quantity) + EPS) {
        const p = getProduct(db, doc.company_id, line.product_id)
        fail(
          'TRANSICION_INVALIDA',
          `No se puede anular ${doc.display_number}: de ${p.code} ya se facturaron ${fmtQty(invoiced, p.uom_code)}. Primero hay que anular la factura del proveedor.`,
          'Lo facturado nunca puede superar lo recibido (control por oposición).',
        )
      }
    }
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
  if (!Object.hasOwn(ADJUSTMENT_REASONS, input.reason_code))
    fail('DATO_INVALIDO', 'Elegí un motivo válido para el ajuste.')
  if (input.notes.trim().length < 3 && input.reason_code === 'OTRO')
    fail('DATO_INVALIDO', 'Explicá el motivo del ajuste.')
  const lines = input.lines
    .filter((l) => l.product_id && l.quantity_delta !== 0)
    .map((l) => {
      if (!Number.isFinite(l.quantity_delta) || round3(l.quantity_delta) === 0)
        fail('DATO_INVALIDO', 'La cantidad del ajuste debe ser finita y distinta de cero (hasta 3 decimales).')
      if (l.unit_cost !== undefined && (!Number.isFinite(l.unit_cost) || l.unit_cost < 0))
        fail('DATO_INVALIDO', 'El costo unitario debe ser un número finito mayor o igual que cero.')
      const p = getProduct(db, companyId, l.product_id)
      if (!p.is_stockable)
        fail('DATO_INVALIDO', `${p.code} es un ${PRODUCT_TYPES[p.product_type].toLowerCase()}: no lleva stock.`)
      const bal = db.stockBalances.find((b) => b.product_id === p.id && b.warehouse_id === input.warehouse_id)
      const cost = l.unit_cost ?? (bal?.avg_unit_cost || p.standard_cost)
      return { ...l, quantity_delta: round3(l.quantity_delta), unit_cost: round4(cost) }
    })
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un producto con una cantidad distinta de cero.')
  const doc = newDocument(ctx, companyId, 'STOCK_ADJUSTMENT', actor, {
    notes: input.notes,
    sa: { warehouse_id: input.warehouse_id, reason_code: input.reason_code },
  })
  let total = 0
  lines.forEach((l, i) => {
    const cost = l.unit_cost
    total += l.quantity_delta * cost
    db.saLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      product_id: l.product_id,
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

/** Sólo campos editables; las referencias y los importes se validan también fuera del formulario. */
function masterData(
  db: DB,
  kind: MasterKind,
  companyId: string,
  input: Record<string, unknown>,
  previous?: T.Customer | T.Supplier | T.Product,
) {
  const source: Record<string, unknown> = { ...previous, ...input }
  const text = (key: string, fallback = '') => {
    const value = source[key] ?? fallback
    if (typeof value !== 'string') fail('DATO_INVALIDO', `El campo ${key} debe ser texto.`)
    return value.trim()
  }
  const number = (key: string, fallback: number | null, integer = false, positive = false) => {
    const value = source[key] === undefined ? fallback : source[key]
    if (value === null && fallback === null) return null
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isSafeInteger(value)) ||
      (positive && value <= 0)
    ) {
      fail(
        'DATO_INVALIDO',
        `El campo ${key} debe ser ${integer ? 'un entero' : 'un número'} ${positive ? 'mayor que cero' : 'no negativo'}.`,
      )
    }
    return value
  }
  if (kind === 'product') {
    const productType = text('product_type')
    const uom = text('uom_code')
    if (!Object.hasOwn(PRODUCT_TYPES, productType)) fail('DATO_INVALIDO', 'Elegí un tipo de producto válido.')
    if (!Object.hasOwn(UNITS, uom)) fail('DATO_INVALIDO', 'Elegí una unidad de medida válida.')
    const vat = number('vat_rate', 21)!
    if (!VAT_RATES.includes(vat)) fail('DATO_INVALIDO', 'Elegí una alícuota de IVA válida.')
    const supplierId = text('default_supplier_id') || null
    const warehouseId = text('default_warehouse_id') || null
    const supplier = db.suppliers.find((s) => s.id === supplierId && s.company_id === companyId)
    if (
      supplierId &&
      (!supplier || (!supplier.is_active && supplierId !== (previous as T.Product | undefined)?.default_supplier_id))
    ) {
      fail('DATO_INVALIDO', 'El proveedor habitual debe estar activo y pertenecer a esta empresa.')
    }
    if (warehouseId && !db.warehouses.some((w) => w.id === warehouseId && w.company_id === companyId)) {
      fail('DATO_INVALIDO', 'El depósito habitual no existe en esta empresa.')
    }
    const stockable = productType !== 'SERVICIO'
    if (previous) {
      const p = previous as T.Product
      const used = [
        ...db.prLines,
        ...db.poLines,
        ...db.grLines,
        ...db.saLines,
        ...db.stockMovements,
        ...db.stockBalances,
      ].some((line) => line.product_id === p.id)
      if (used && (p.uom_code !== uom || p.is_stockable !== stockable)) {
        fail(
          'DATO_INVALIDO',
          'No se puede cambiar la unidad ni convertir entre producto y servicio cuando hay documentos o movimientos. Creá otro producto.',
        )
      }
    }
    const minStock = number('min_stock', 0)!
    const reorderQty = number('reorder_qty', null, false, true)
    if (
      !UNITS[uom].decimals &&
      (!Number.isInteger(minStock) || (reorderQty != null && !Number.isInteger(reorderQty)))
    ) {
      fail('DATO_INVALIDO', `La unidad ${uom} requiere cantidades enteras.`)
    }
    return {
      name: text('name'),
      description: text('description'),
      category: text('category'),
      product_type: productType,
      uom_code: uom,
      is_stockable: stockable,
      standard_cost: number('standard_cost', 0),
      sale_price: number('sale_price', null),
      vat_rate: vat,
      min_stock: stockable ? minStock : 0,
      reorder_qty: stockable ? reorderQty : null,
      default_supplier_id: supplierId,
      default_warehouse_id: stockable ? warehouseId : null,
      location: stockable ? text('location') : '',
    }
  }
  const vatCondition = text('vat_condition', 'RESPONSABLE_INSCRIPTO')
  if (!Object.hasOwn(VAT_CONDITIONS, vatCondition)) fail('DATO_INVALIDO', 'Elegí una condición frente al IVA válida.')
  const taxId = text('tax_id')
  if (taxId && !/^\d{2}-\d{8}-\d$/.test(taxId)) fail('DATO_INVALIDO', 'El CUIT debe tener el formato 30-12345678-9.')
  const email = text('email')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('DATO_INVALIDO', 'Ingresá un email válido.')
  return {
    legal_name: text('legal_name'),
    trade_name: text('trade_name'),
    tax_id: taxId,
    vat_condition: vatCondition,
    address_line: text('address_line'),
    city: text('city'),
    province: text('province'),
    phone: text('phone'),
    email,
    contact_name: text('contact_name'),
    payment_terms_days: number('payment_terms_days', 0, true),
    notes: text('notes'),
    ...(kind === 'customer'
      ? { credit_limit: number('credit_limit', null) }
      : { category: text('category'), lead_time_days: number('lead_time_days', null, true) }),
  }
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
  const previous = isNew ? undefined : table.find((r) => r.id === input.id && r.company_id === companyId)
  if (!isNew && !previous) fail('DATO_INVALIDO', `El ${MASTER_LABEL[kind]} no existe.`)
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
  const clean: Record<string, unknown> = { ...masterData(db, kind, companyId, input, previous), code }

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
  if (typeof active !== 'boolean') fail('DATO_INVALIDO', 'Indicá si el registro está activo.')
  if (row.is_active === active) return
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

// ============================================================ Contabilidad (docs/FASE_2_CONTABILIDAD.md)

const MONTHS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
]

/** Comparación de nombres sin mayúsculas ni acentos (private.sort_key en la base). */
const nameKey = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()

export const accountLabel = (a: T.Account) => `${a.code} ${a.name}`

function getAccount(db: DB, companyId: string, id: string) {
  const a = db.accounts.find((x) => x.id === id && x.company_id === companyId)
  if (!a) fail('DATO_INVALIDO', 'La cuenta no existe en esta empresa.')
  return a
}

/** Asientos que están en el libro diario: los registrados y los anulados después de registrarse. */
export function isPosted(doc: T.Document) {
  return doc.doc_type === 'JOURNAL_ENTRY' && doc.je?.entry_number != null
}

/** Saldo (debe − haber) de una cuenta imputable según los asientos del libro diario. */
export function accountBalance(db: DB, accountId: string) {
  const posted = new Set(db.documents.filter(isPosted).map((d) => d.id))
  return round2(
    db.jeLines
      .filter((l) => l.account_id === accountId && posted.has(l.document_id))
      .reduce((sum, l) => sum + l.debit - l.credit, 0),
  )
}

function hasPostedMovements(db: DB, accountId: string) {
  const posted = new Set(db.documents.filter(isPosted).map((d) => d.id))
  return db.jeLines.some((l) => l.account_id === accountId && posted.has(l.document_id))
}

function insertBaseChart(ctx: Ctx, companyId: string) {
  for (const [code, name, description = '', contra = false] of BASE_CHART) {
    const type = accountTypeOf(code)
    const level = accountLevel(code)
    ctx.db.accounts.push({
      id: uid(),
      company_id: companyId,
      code,
      name,
      account_type: type,
      normal_side: normalSideOf(type, contra),
      level,
      is_imputable: level === IMPUTABLE_LEVEL,
      description,
      is_active: true,
      created_at: ctx.now,
      created_by: null,
      updated_at: ctx.now,
      updated_by: null,
    })
  }
}

function createFiscalYear(ctx: Ctx, companyId: string, year: number): T.FiscalYear {
  const fiscalYear: T.FiscalYear = {
    id: uid(),
    company_id: companyId,
    name: `Ejercicio ${year}`,
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
    created_at: ctx.now,
  }
  ctx.db.fiscalYears.push(fiscalYear)
  MONTHS.forEach((month, i) => {
    const mm = String(i + 1).padStart(2, '0')
    const lastDay = new Date(Date.UTC(year, i + 1, 0)).getUTCDate()
    ctx.db.fiscalPeriods.push({
      id: uid(),
      company_id: companyId,
      fiscal_year_id: fiscalYear.id,
      number: i + 1,
      name: `${month} ${year}`,
      start_date: `${year}-${mm}-01`,
      end_date: `${year}-${mm}-${lastDay}`,
      status: 'ABIERTO',
      closed_by: null,
      closed_at: null,
    })
  })
  return fiscalYear
}

export interface JournalEntryInput {
  document_date: string
  description: string
  lines: { account_id: string; debit: number; credit: number; notes?: string }[]
}

type EntryLine = JournalEntryInput['lines'][number]

const isMoney = (n: number) => Number.isFinite(n) && n >= 0 && round2(n) === n

/** Controles del borrador: puede quedar desbalanceado, pero cada línea tiene que ser válida. */
function validateEntry(db: DB, companyId: string, input: JournalEntryInput): EntryLine[] {
  if (input.description.trim().length < 3)
    fail('DATO_INVALIDO', 'Escribí la leyenda del asiento: qué hecho económico registra.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.document_date) || Number.isNaN(Date.parse(input.document_date)))
    fail('DATO_INVALIDO', 'Indicá la fecha del asiento.')
  const lines = input.lines.filter((l) => l.account_id || l.debit || l.credit)
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos una línea con cuenta e importe.')
  if (lines.length > 40) fail('DATO_INVALIDO', 'Un asiento admite hasta 40 líneas.')
  lines.forEach((l, i) => {
    if (!l.account_id) fail('DATO_INVALIDO', `Elegí la cuenta de la línea ${i + 1}.`)
    const account = getAccount(db, companyId, l.account_id)
    if (!account.is_imputable)
      fail(
        'DATO_INVALIDO',
        `${accountLabel(account)} es un rubro: agrupa otras cuentas. Elegí una cuenta imputable (de nivel 4).`,
      )
    if (!account.is_active) fail('DATO_INVALIDO', `La cuenta ${accountLabel(account)} está desactivada.`)
    if (!isMoney(l.debit) || !isMoney(l.credit))
      fail('DATO_INVALIDO', `Los importes de la línea ${i + 1} deben ser positivos y tener hasta 2 decimales.`)
    if (l.debit > 0 && l.credit > 0)
      fail('DATO_INVALIDO', `La línea ${i + 1} tiene importe al debe y al haber: cada línea va de un solo lado.`)
    if (!(l.debit > 0 || l.credit > 0)) fail('DATO_INVALIDO', `Indicá el importe de la línea ${i + 1}.`)
  })
  return lines.map((l) => ({
    account_id: l.account_id,
    debit: l.debit,
    credit: l.credit,
    notes: l.notes?.trim() ?? '',
  }))
}

function writeEntryLines(ctx: Ctx, doc: T.Document, lines: EntryLine[]) {
  ctx.db.jeLines = ctx.db.jeLines.filter((l) => l.document_id !== doc.id)
  lines.forEach((l, i) => {
    ctx.db.jeLines.push({
      id: uid(),
      company_id: doc.company_id,
      document_id: doc.id,
      line_no: i + 1,
      account_id: l.account_id,
      debit: l.debit,
      credit: l.credit,
      notes: l.notes ?? '',
    })
  })
  const total = round2(lines.reduce((sum, l) => sum + l.debit, 0))
  doc.subtotal = total
  doc.total = total
}

function newEntry(
  ctx: Ctx,
  companyId: string,
  actor: Actor,
  date: string,
  header: Pick<T.JournalEntryHeader, 'description' | 'origin' | 'reverses_id'>,
  lines: EntryLine[],
) {
  const doc = newDocument(ctx, companyId, 'JOURNAL_ENTRY', actor, {
    document_date: date,
    je: { ...header, fiscal_year_id: null, entry_number: null, posted_at: null },
  })
  writeEntryLines(ctx, doc, lines)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'journal_entry',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number} (${lines.length} línea${lines.length === 1 ? '' : 's'})`,
  })
  return doc
}

function requireTransition(doc: T.Document, action: T.TransitionAction) {
  if (!findTransition(doc.doc_type, doc.status, action))
    fail(
      'TRANSICION_INVALIDA',
      `${doc.display_number} está en estado "${statusLabel(doc.doc_type, doc.status)}" y no admite esta acción.`,
    )
}

/**
 * Registra el asiento en el libro diario (private.post_journal_entry): partida
 * doble, cuentas activas, período abierto y fecha correlativa; le asigna el
 * número de asiento del ejercicio.
 */
function postEntry(ctx: Ctx, doc: T.Document, summary?: (entryNumber: number) => string, actor?: Actor) {
  const { db } = ctx
  requireTransition(doc, 'CONFIRM')
  const lines = db.jeLines.filter((l) => l.document_id === doc.id).sort((a, b) => a.line_no - b.line_no)
  if (lines.length < 2 || !lines.some((l) => l.debit > 0) || !lines.some((l) => l.credit > 0))
    fail(
      'ASIENTO_INCOMPLETO',
      'Un asiento tiene al menos una cuenta al debe y otra al haber.',
      'En la partida doble, todo hecho económico afecta como mínimo a dos cuentas.',
    )
  for (const l of lines) {
    const account = getAccount(db, doc.company_id, l.account_id)
    if (!account.is_active || !account.is_imputable)
      fail('DATO_INVALIDO', `La cuenta ${accountLabel(account)} no admite movimientos: corregí el borrador.`)
  }
  const debit = round2(lines.reduce((sum, l) => sum + l.debit, 0))
  const credit = round2(lines.reduce((sum, l) => sum + l.credit, 0))
  if (debit !== credit)
    fail(
      'ASIENTO_DESBALANCEADO',
      `El asiento no balancea: el debe suma ${money(debit)} y el haber ${money(credit)} (diferencia ${money(Math.abs(round2(debit - credit)))}).`,
      'En la partida doble, lo que se debita tiene que ser igual a lo que se acredita.',
    )
  const company = getCompany(db, doc.company_id)
  const date = doc.document_date
  if (date > businessDate(company)) fail('FECHA_INVALIDA', 'La fecha del asiento no puede ser posterior a hoy.')
  const period = db.fiscalPeriods.find(
    (p) => p.company_id === doc.company_id && p.start_date <= date && date <= p.end_date,
  )
  if (!period)
    fail(
      'SIN_EJERCICIO',
      `No hay un ejercicio abierto que incluya el ${fmtDate(date)}.`,
      'El docente abre los ejercicios en "Ejercicios y períodos".',
    )
  if (period.status === 'CERRADO')
    fail(
      'PERIODO_CERRADO',
      `${period.name} está cerrado: no se registran asientos en ese mes.`,
      'Si hace falta, el docente puede reabrir el período.',
    )
  const last = db.documents
    .filter((d) => d.company_id === doc.company_id && isPosted(d) && d.je!.fiscal_year_id === period.fiscal_year_id)
    .reduce<T.Document | null>((max, d) => (!max || d.je!.entry_number! > max.je!.entry_number! ? d : max), null)
  if (last && date < last.document_date)
    fail(
      'FECHA_INVALIDA',
      `El libro diario es correlativo: el último asiento registrado (N.º ${last.je!.entry_number}) es del ${fmtDate(last.document_date)}. Usá esa fecha o una posterior.`,
      'En un libro encuadernado no se puede intercalar un asiento entre dos ya registrados.',
    )
  const number = (last?.je!.entry_number ?? 0) + 1
  transition(ctx, doc, 'CONFIRM', {
    actor,
    summary: summary?.(number) ?? `Registró ${doc.display_number} como asiento N.º ${number} del libro diario`,
  })
  doc.je = { ...doc.je!, fiscal_year_id: period.fiscal_year_id, entry_number: number, posted_at: ctx.now }
}

export function cmdCreateJournalEntry(ctx: Ctx, companyId: string, input: JournalEntryInput, confirm: boolean) {
  const actor = requirePermission(ctx, companyId, 'journal_entry.create')
  const lines = validateEntry(ctx.db, companyId, input)
  const doc = newEntry(
    ctx,
    companyId,
    actor,
    input.document_date,
    { description: input.description.trim(), origin: 'MANUAL', reverses_id: null },
    lines,
  )
  if (confirm) postEntry(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

export function cmdUpdateJournalEntry(ctx: Ctx, docId: string, input: JournalEntryInput) {
  const doc = getDoc(ctx.db, docId, 'JOURNAL_ENTRY')
  const actor = requirePermission(ctx, doc.company_id, 'journal_entry.update')
  if (doc.status !== 'BORRADOR')
    fail(
      'TRANSICION_INVALIDA',
      `${doc.display_number} ya no es un borrador: no se modifica. Si tiene un error, se anula con un contraasiento.`,
    )
  const lines = validateEntry(ctx.db, doc.company_id, input)
  const before = { document_date: doc.document_date, description: doc.je!.description, total: doc.total }
  doc.document_date = input.document_date
  doc.je = { ...doc.je!, description: input.description.trim() }
  doc.updated_at = ctx.now
  doc.updated_by = ctx.userId
  writeEntryLines(ctx, doc, lines)
  const changes = diff(
    before,
    { document_date: doc.document_date, description: doc.je.description, total: doc.total },
    ['document_date', 'description', 'total'],
  )
  logAudit(ctx, {
    company_id: doc.company_id,
    actor,
    action: 'UPDATE',
    entity_type: 'journal_entry',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    summary: `Modificó ${doc.display_number}`,
    changes: Object.keys(changes).length ? changes : null,
  })
}

export function cmdConfirmJournalEntry(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'JOURNAL_ENTRY')
  requirePermission(ctx, doc.company_id, 'journal_entry.create')
  postEntry(ctx, doc)
}

/**
 * El borrador se anula sin más. Un asiento registrado no se borra ni se
 * modifica: se anula con un contraasiento (mismas cuentas, debe y haber
 * invertidos, fecha de hoy) y los dos quedan en el libro diario.
 */
export function cmdCancelJournalEntry(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'JOURNAL_ENTRY')
  if (doc.status !== 'CONFIRMADO') {
    transition(ctx, doc, 'CANCEL', { comment: reason })
    return
  }
  const actor = requirePermission(ctx, doc.company_id, 'journal_entry.cancel')
  const comment = reason.trim()
  if (comment.length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  if (doc.je!.origin === 'CONTRAASIENTO')
    fail('DATO_INVALIDO', 'Un contraasiento no se anula. Si hubo un error, registrá el asiento correcto.')
  reverseEntry(ctx, doc, actor, comment)
}

/**
 * Contraasiento de un asiento registrado: las mismas cuentas con el debe y el
 * haber invertidos, con fecha de hoy; el original queda anulado. Con un actor
 * dado (anulación de una factura) no exige los permisos de Contabilidad.
 */
function reverseEntry(ctx: Ctx, doc: T.Document, actor: Actor, comment: string, withActor = false) {
  const { db } = ctx
  const lines = db.jeLines
    .filter((l) => l.document_id === doc.id)
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, notes: l.notes }))
  const reversal = newEntry(
    ctx,
    doc.company_id,
    actor,
    businessDate(getCompany(db, doc.company_id)),
    {
      description: `Anulación del asiento N.º ${doc.je!.entry_number} (${doc.display_number}): ${comment}`,
      origin: 'CONTRAASIENTO',
      reverses_id: doc.id,
    },
    lines,
  )
  postEntry(
    ctx,
    reversal,
    (n) => `Registró ${reversal.display_number}, contraasiento de ${doc.display_number}, como asiento N.º ${n}`,
    withActor ? actor : undefined,
  )
  link(ctx, doc.company_id, doc.id, reversal.id)
  transition(ctx, doc, 'CANCEL', {
    comment,
    actor,
    summary: `Anuló ${doc.display_number} con el contraasiento ${reversal.display_number} — ${comment}`,
  })
  return reversal
}

export interface AccountInput {
  code: string
  name: string
  description: string
  is_contra: boolean
}

/** Alta de una cuenta imputable dentro de un rubro existente, o cambio de nombre y descripción. */
export function cmdSaveAccount(ctx: Ctx, companyId: string, input: AccountInput & { id?: string }) {
  const { db } = ctx
  const isNew = !input.id
  const actor = requirePermission(ctx, companyId, isNew ? 'account.create' : 'account.update')
  const name = input.name.trim()
  const description = input.description.trim()
  if (name.length < 3) fail('DATO_INVALIDO', 'Ingresá el nombre de la cuenta.')
  if (db.accounts.some((a) => a.company_id === companyId && a.id !== input.id && nameKey(a.name) === nameKey(name)))
    fail('DATO_INVALIDO', `Ya existe una cuenta llamada "${name}".`)
  if (isNew) {
    const code = input.code.trim()
    if (!ACCOUNT_CODE_PATTERN.test(code) || accountLevel(code) !== IMPUTABLE_LEVEL)
      fail('DATO_INVALIDO', 'El código de una cuenta nueva tiene cuatro niveles, por ejemplo 1.1.01.05.')
    if (!db.accounts.some((a) => a.company_id === companyId && a.code === parentCode(code)))
      fail(
        'DATO_INVALIDO',
        `No existe el rubro ${parentCode(code)}: las cuentas nuevas van dentro de un rubro del plan.`,
      )
    if (db.accounts.some((a) => a.company_id === companyId && a.code === code))
      fail('DATO_INVALIDO', `Ya existe la cuenta ${code}.`)
    const type = accountTypeOf(code)
    const account: T.Account = {
      id: uid(),
      company_id: companyId,
      code,
      name,
      account_type: type,
      normal_side: normalSideOf(type, input.is_contra),
      level: IMPUTABLE_LEVEL,
      is_imputable: true,
      description,
      is_active: true,
      created_at: ctx.now,
      created_by: ctx.userId,
      updated_at: ctx.now,
      updated_by: ctx.userId,
    }
    db.accounts.push(account)
    logAudit(ctx, {
      company_id: companyId,
      actor,
      action: 'CREATE',
      entity_type: 'account',
      entity_id: account.id,
      entity_label: accountLabel(account),
      summary: `Dio de alta la cuenta ${accountLabel(account)}`,
    })
    return account.id
  }
  const account = getAccount(db, companyId, input.id!)
  if (!account.is_imputable) fail('DATO_INVALIDO', 'Los rubros del plan de cuentas no se modifican.')
  const side = normalSideOf(account.account_type, input.is_contra)
  if (side !== account.normal_side && hasPostedMovements(db, account.id))
    fail('DATO_INVALIDO', 'La cuenta ya tiene movimientos: no se puede cambiar si es regularizadora.')
  const before = { ...account }
  Object.assign(account, { name, description, normal_side: side, updated_at: ctx.now, updated_by: ctx.userId })
  const changes = diff(before, account, ['name', 'description', 'normal_side'])
  if (Object.keys(changes).length) {
    logAudit(ctx, {
      company_id: companyId,
      actor,
      action: 'UPDATE',
      entity_type: 'account',
      entity_id: account.id,
      entity_label: accountLabel(account),
      summary: `Modificó la cuenta ${accountLabel(account)}`,
      changes,
    })
  }
  return account.id
}

export function cmdSetAccountActive(ctx: Ctx, companyId: string, accountId: string, active: boolean) {
  const actor = requirePermission(ctx, companyId, 'account.update')
  const account = getAccount(ctx.db, companyId, accountId)
  if (!account.is_imputable) fail('DATO_INVALIDO', 'Sólo se desactivan cuentas imputables (de nivel 4).')
  if (account.is_active === active) return
  const balance = accountBalance(ctx.db, account.id)
  if (!active && balance !== 0)
    fail(
      'DATO_INVALIDO',
      `La cuenta ${accountLabel(account)} tiene saldo (${money(Math.abs(balance))}): primero hay que dejarla en cero.`,
    )
  account.is_active = active
  account.updated_at = ctx.now
  account.updated_by = ctx.userId
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: active ? 'ACTIVATE' : 'DEACTIVATE',
    entity_type: 'account',
    entity_id: account.id,
    entity_label: accountLabel(account),
    summary: `${active ? 'Activó' : 'Desactivó'} la cuenta ${accountLabel(account)}`,
  })
}

/** El docente abre un ejercicio nuevo (año calendario) con sus doce períodos mensuales. */
export function cmdOpenFiscalYear(ctx: Ctx, companyId: string, year: number) {
  const actor = requireSupervisor(ctx, companyId)
  const current = Number(businessDate(getCompany(ctx.db, companyId)).slice(0, 4))
  if (!Number.isInteger(year) || year < 2000 || year > current + 1)
    fail('DATO_INVALIDO', `Elegí un año válido, hasta ${current + 1}.`)
  if (ctx.db.fiscalYears.some((y) => y.company_id === companyId && y.start_date === `${year}-01-01`))
    fail('DATO_INVALIDO', `El ejercicio ${year} ya existe.`)
  const fiscalYear = createFiscalYear(ctx, companyId, year)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'OPEN_FISCAL_YEAR',
    entity_type: 'fiscal_year',
    entity_id: fiscalYear.id,
    entity_label: fiscalYear.name,
    summary: `Abrió el ${fiscalYear.name.toLowerCase()} con sus doce períodos mensuales`,
  })
  return fiscalYear.id
}

/** Contabilidad cierra un mes cuando terminó de revisarlo; sólo el docente lo reabre. */
export function cmdSetPeriodStatus(
  ctx: Ctx,
  companyId: string,
  periodId: string,
  status: T.FiscalPeriod['status'],
  reason: string,
) {
  const period = ctx.db.fiscalPeriods.find((p) => p.id === periodId && p.company_id === companyId)
  if (!period) fail('DATO_INVALIDO', 'El período no existe en esta empresa.')
  if (status !== 'ABIERTO' && status !== 'CERRADO') fail('DATO_INVALIDO', 'Indicá si el período se abre o se cierra.')
  const closing = status === 'CERRADO'
  const actor = closing ? requirePermission(ctx, companyId, 'fiscal_period.update') : requireSupervisor(ctx, companyId)
  if (period.status === status) fail('DATO_INVALIDO', `${period.name} ya está ${closing ? 'cerrado' : 'abierto'}.`)
  const comment = reason.trim()
  if (!closing && comment.length < 3)
    fail('MOTIVO_REQUERIDO', 'Indicá el motivo de la reapertura: queda registrado en la auditoría.')
  period.status = status
  period.closed_by = closing ? ctx.userId : null
  period.closed_at = closing ? ctx.now : null
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: closing ? 'CLOSE_PERIOD' : 'REOPEN_PERIOD',
    entity_type: 'fiscal_period',
    entity_id: period.id,
    entity_label: period.name,
    summary: `${closing ? 'Cerró' : 'Reabrió'} el período ${period.name}${comment ? ` — ${comment}` : ''}`,
  })
}

/**
 * Contabilidad de una empresa nueva (plantilla o curso): plan de cuentas
 * básico, ejercicio del año en curso y asiento N.º 1 de apertura al 1.º de
 * enero. Los bienes de cambio salen del inventario inicial, así el mayor
 * coincide con el stock; la diferencia va a resultados no asignados.
 */
export function startAccounting(ctx: Ctx, companyId: string) {
  const { db } = ctx
  const company = getCompany(db, companyId)
  if (!db.accounts.some((a) => a.company_id === companyId)) insertBaseChart(ctx, companyId)
  insertBasePostingRules(ctx, companyId)
  const year = Number(businessDate(company).slice(0, 4))
  const fiscalYear =
    db.fiscalYears.find((y) => y.company_id === companyId && y.start_date === `${year}-01-01`) ??
    createFiscalYear(ctx, companyId, year)
  if (db.documents.some((d) => d.company_id === companyId && d.doc_type === 'JOURNAL_ENTRY')) return

  const amounts = new Map<string, number>()
  const add = (code: string, amount: number) => {
    const account = db.accounts.find((a) => a.company_id === companyId && a.code === code && a.is_imputable)
    if (account) amounts.set(account.id, (amounts.get(account.id) ?? 0) + amount)
  }
  for (const b of OPENING_BALANCES) add(b.code, b.debit - b.credit)
  for (const adj of db.documents.filter(
    (d) =>
      d.company_id === companyId &&
      d.doc_type === 'STOCK_ADJUSTMENT' &&
      d.status === 'CONFIRMADO' &&
      d.sa?.reason_code === 'INVENTARIO_INICIAL',
  )) {
    for (const l of db.saLines.filter((x) => x.document_id === adj.id)) {
      const code = INVENTORY_ACCOUNTS[getProduct(db, companyId, l.product_id).product_type]
      if (code) add(code, l.quantity_delta * l.unit_cost)
    }
  }
  add(OPENING_BALANCING_ACCOUNT, -[...amounts.values()].reduce((sum, n) => sum + n, 0))
  const code = (id: string) => db.accounts.find((a) => a.id === id)!.code
  const lines = [...amounts]
    .map(([account_id, net]) => ({ account_id, net: round2(net) }))
    .filter((l) => l.net !== 0)
    .sort((a, b) => Number(b.net > 0) - Number(a.net > 0) || (code(a.account_id) < code(b.account_id) ? -1 : 1))
    .map((l) => ({ account_id: l.account_id, debit: Math.max(l.net, 0), credit: Math.max(-l.net, 0), notes: '' }))
  const doc = newEntry(
    ctx,
    companyId,
    SYSTEM_ACTOR,
    fiscalYear.start_date,
    {
      description: `Asiento de apertura del ${fiscalYear.name.toLowerCase()}: saldos iniciales de la empresa.`,
      origin: 'APERTURA',
      reverses_id: null,
    },
    lines,
  )
  postEntry(ctx, doc, (n) => `Registró ${doc.display_number}, asiento N.º ${n} de apertura del ejercicio`)
}

// ============================================================ Imputación automática (docs/FASE_3_COMPRAS_Y_TESORERIA.md §2)

/** Reglas base de una empresa, sin pisar las que ya tiene (idempotente). */
export function insertBasePostingRules(ctx: Ctx, companyId: string) {
  const { db } = ctx
  for (const rule of BASE_POSTING_RULES) {
    if (db.postingRules.some((r) => r.company_id === companyId && r.event === rule.event && r.key === rule.key))
      continue
    const account = db.accounts.find((a) => a.company_id === companyId && a.code === rule.code)
    if (!account) continue
    db.postingRules.push({ id: uid(), company_id: companyId, event: rule.event, key: rule.key, account_id: account.id })
  }
}

const postingLabel = (event: string, key: string) =>
  `${POSTING_EVENTS[event]?.label ?? event}: ${POSTING_EVENTS[event]?.keys[key]?.toLowerCase() ?? key}`

function ruleAccount(db: DB, companyId: string, event: string, key: string) {
  const rule = db.postingRules.find((r) => r.company_id === companyId && r.event === event && r.key === key)
  const account = rule && db.accounts.find((a) => a.id === rule.account_id)
  if (!account)
    fail(
      'FALTA_IMPUTACION',
      `Falta definir la cuenta de "${postingLabel(event, key)}" en la imputación automática.`,
      'Contabilidad la define en Contabilidad → Imputación automática.',
    )
  if (!account.is_active || !account.is_imputable)
    fail(
      'FALTA_IMPUTACION',
      `La cuenta ${accountLabel(account)} de "${postingLabel(event, key)}" no admite movimientos.`,
      'Contabilidad la corrige en Contabilidad → Imputación automática.',
    )
  return account
}

/** Un importe del asiento automático: va a la cuenta de una regla o a una cuenta dada. */
type PostingAmount = ({ key: string } | { account_id: string }) & { debit: number; credit: number }

/**
 * Asiento automático de un evento (private.post_event): cada importe va a la
 * cuenta de su regla (o a una cuenta dada, como la caja o el banco de un pago);
 * se registra con fecha de hoy (la de registración) con las validaciones de
 * siempre y queda vinculado al documento que lo originó.
 */
function postEvent(
  ctx: Ctx,
  actor: Actor,
  source: T.Document,
  event: string,
  description: string,
  amounts: PostingAmount[],
) {
  const { db } = ctx
  const lines: EntryLine[] = []
  for (const a of amounts) {
    const debit = round2(a.debit)
    const credit = round2(a.credit)
    if (!debit && !credit) continue
    const account =
      'account_id' in a
        ? getAccount(db, source.company_id, a.account_id)
        : ruleAccount(db, source.company_id, event, a.key)
    const same = lines.find((l) => l.account_id === account.id && l.debit > 0 === debit > 0)
    if (same) {
      same.debit = round2(same.debit + debit)
      same.credit = round2(same.credit + credit)
    } else lines.push({ account_id: account.id, debit, credit, notes: '' })
  }
  const entry = newEntry(
    ctx,
    source.company_id,
    actor,
    businessDate(getCompany(db, source.company_id)),
    { description, origin: 'AUTOMATICO', reverses_id: null },
    lines,
  )
  postEntry(
    ctx,
    entry,
    (n) => `Registró ${entry.display_number}, asiento automático N.º ${n} de ${source.display_number}`,
    actor,
  )
  link(ctx, source.company_id, source.id, entry.id)
  return entry
}

/** El asiento automático vigente de un documento (registrado, no anulado). */
function automaticEntryOf(db: DB, docId: string) {
  const ids = new Set(db.docLinks.filter((l) => l.from_document_id === docId).map((l) => l.to_document_id))
  return db.documents.find(
    (d) =>
      ids.has(d.id) && d.doc_type === 'JOURNAL_ENTRY' && d.je?.origin === 'AUTOMATICO' && d.status === 'CONFIRMADO',
  )
}

/** Contabilidad cambia la cuenta de una regla de imputación. */
export function cmdSavePostingRule(ctx: Ctx, companyId: string, ruleId: string, accountId: string) {
  const actor = requirePermission(ctx, companyId, 'posting_rule.update')
  const rule = ctx.db.postingRules.find((r) => r.id === ruleId && r.company_id === companyId)
  if (!rule) fail('DATO_INVALIDO', 'La regla de imputación no existe en esta empresa.')
  const account = getAccount(ctx.db, companyId, accountId)
  if (!account.is_imputable || !account.is_active)
    fail('DATO_INVALIDO', `Elegí una cuenta imputable y activa: ${accountLabel(account)} no admite movimientos.`)
  if (rule.account_id === account.id) return
  const before = accountLabel(ctx.db.accounts.find((a) => a.id === rule.account_id)!)
  rule.account_id = account.id
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'UPDATE',
    entity_type: 'posting_rule',
    entity_id: rule.id,
    entity_label: postingLabel(rule.event, rule.key),
    summary: `Cambió la imputación de "${postingLabel(rule.event, rule.key)}" a ${accountLabel(account)}`,
    changes: { account: { from: before, to: accountLabel(account) } },
  })
}

// ============================================================ Facturas de proveedor (docs/FASE_3_COMPRAS_Y_TESORERIA.md §3)

export interface SupplierInvoiceInput {
  purchase_order_id: string
  point_of_sale: string
  invoice_number: string
  document_date: string
  notes: string
  lines: { po_line_id: string; quantity: number; unit_price: number }[]
}

/** Estados de una factura que generó deuda (registrada, con o sin pagos). */
export const INVOICED_STATUSES = ['REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA']

/** Cantidad de una línea de OC ya facturada en facturas registradas (salvo una). */
export function invoicedQuantity(db: DB, poLineId: string, exceptDocId?: string) {
  const docs = new Set(
    db.documents
      .filter((d) => d.doc_type === 'SUPPLIER_INVOICE' && INVOICED_STATUSES.includes(d.status) && d.id !== exceptDocId)
      .map((d) => d.id),
  )
  return round3(
    db.siLines.filter((l) => l.po_line_id === poLineId && docs.has(l.document_id)).reduce((s, l) => s + l.quantity, 0),
  )
}

const invoiceLabel = (si: T.SupplierInvoiceHeader) => `${si.letter} ${si.point_of_sale}-${si.invoice_number}`

/** Control por oposición: no se factura más de lo recibido menos lo ya facturado. */
function assertInvoiceable(db: DB, poLine: T.PurchaseOrderLine, quantity: number, exceptDocId?: string) {
  const invoiced = invoicedQuantity(db, poLine.id, exceptDocId)
  const available = round3(poLine.qty_received - invoiced)
  if (quantity > available + EPS) {
    const p = db.products.find((x) => x.id === poLine.product_id)!
    fail(
      'CANTIDAD_EXCEDIDA',
      `${p.code}: se recibieron ${fmtQty(poLine.qty_received, p.uom_code)} y ya se facturaron ${fmtQty(invoiced, p.uom_code)}; como mucho se pueden facturar ${fmtQty(Math.max(available, 0), p.uom_code)}.`,
      'Se paga lo que efectivamente llegó: la factura se controla contra la orden de compra y la recepción.',
    )
  }
}

export function cmdCreateSupplierInvoice(ctx: Ctx, companyId: string, input: SupplierInvoiceInput, register: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'supplier_invoice.create')
  const order = db.documents.find(
    (d) => d.id === input.purchase_order_id && d.company_id === companyId && d.doc_type === 'PURCHASE_ORDER',
  )
  if (!order) fail('DATO_INVALIDO', 'Elegí la orden de compra que factura el proveedor.')
  if (!['ENVIADO', 'RECIBIDO_PARCIAL', 'RECIBIDO', 'CERRADO'].includes(order.status))
    fail(
      'DATO_INVALIDO',
      `${order.display_number} está en estado "${statusLabel(order.doc_type, order.status)}": se factura una orden enviada al proveedor.`,
    )
  const supplier = db.suppliers.find((s) => s.id === order.supplier_id)!
  const pos = input.point_of_sale.trim()
  const number = input.invoice_number.trim()
  if (!/^\d{1,5}$/.test(pos)) fail('DATO_INVALIDO', 'El punto de venta tiene hasta 5 números (por ejemplo, 00003).')
  if (!/^\d{1,8}$/.test(number))
    fail('DATO_INVALIDO', 'El número de la factura tiene hasta 8 números (por ejemplo, 00004521).')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.document_date) || Number.isNaN(Date.parse(input.document_date)))
    fail('DATO_INVALIDO', 'Indicá la fecha de la factura.')
  if (input.document_date > businessDate(getCompany(db, companyId)))
    fail('DATO_INVALIDO', 'La fecha de la factura no puede ser posterior a hoy.')
  const letter: T.SupplierInvoiceHeader['letter'] = supplier.vat_condition === 'RESPONSABLE_INSCRIPTO' ? 'A' : 'C'
  const header: T.SupplierInvoiceHeader = {
    purchase_order_id: order.id,
    letter,
    point_of_sale: pos.padStart(5, '0'),
    invoice_number: number.padStart(8, '0'),
    // Vence según el plazo de pago pactado en la orden de compra.
    due_date: addDays(input.document_date, order.po!.payment_terms_days),
    registered_at: null,
  }
  const duplicate = db.documents.find(
    (d) =>
      d.company_id === companyId &&
      d.doc_type === 'SUPPLIER_INVOICE' &&
      d.status !== 'ANULADA' &&
      d.supplier_id === supplier.id &&
      d.si!.letter === letter &&
      d.si!.point_of_sale === header.point_of_sale &&
      d.si!.invoice_number === header.invoice_number,
  )
  if (duplicate)
    fail(
      'DATO_INVALIDO',
      `Ya está cargada la factura ${invoiceLabel(header)} de ${supplier.legal_name} (${duplicate.display_number}).`,
    )
  const lines = input.lines
    .filter((l) => l.po_line_id && l.quantity)
    .map((l) => {
      const poLine = db.poLines.find((x) => x.id === l.po_line_id && x.document_id === order.id)
      if (!poLine) fail('DATO_INVALIDO', 'Una de las líneas no pertenece a la orden de compra.')
      if (!Number.isFinite(l.quantity) || !(l.quantity > 0) || round3(l.quantity) !== l.quantity)
        fail('DATO_INVALIDO', 'Las cantidades deben ser mayores que cero y tener hasta 3 decimales.')
      if (!Number.isFinite(l.unit_price) || l.unit_price < 0 || round4(l.unit_price) !== l.unit_price)
        fail('DATO_INVALIDO', 'Los precios deben ser positivos y tener hasta 4 decimales.')
      assertInvoiceable(db, poLine, l.quantity)
      const subtotal = round2(l.quantity * l.unit_price)
      const tax = letter === 'A' ? round2((subtotal * poLine.vat_rate) / 100) : 0
      return { poLine, quantity: l.quantity, unit_price: l.unit_price, subtotal, tax }
    })
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá qué cantidades factura el proveedor.')
  const doc = newDocument(ctx, companyId, 'SUPPLIER_INVOICE', actor, {
    document_date: input.document_date,
    supplier_id: supplier.id,
    notes: input.notes.trim(),
    si: header,
  })
  lines.forEach((l, i) => {
    db.siLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      po_line_id: l.poLine.id,
      product_id: l.poLine.product_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
      vat_rate: l.poLine.vat_rate,
      line_subtotal: l.subtotal,
      line_tax: l.tax,
      line_total: round2(l.subtotal + l.tax),
    })
  })
  doc.subtotal = round2(lines.reduce((s, l) => s + l.subtotal, 0))
  doc.tax_total = round2(lines.reduce((s, l) => s + l.tax, 0))
  doc.total = round2(doc.subtotal + doc.tax_total)
  link(ctx, companyId, order.id, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'supplier_invoice',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number}: factura ${invoiceLabel(header)} de ${supplier.legal_name} contra ${order.display_number}`,
  })
  if (register) registerInvoice(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

/** Registra la factura: controla otra vez las cantidades, genera el asiento de compra y la deuda. */
function registerInvoice(ctx: Ctx, doc: T.Document) {
  const { db } = ctx
  requireTransition(doc, 'CONFIRM')
  const lines = db.siLines.filter((l) => l.document_id === doc.id).sort((a, b) => a.line_no - b.line_no)
  for (const l of lines)
    assertInvoiceable(
      db,
      db.poLines.find((x) => x.id === l.po_line_id)!,
      l.quantity,
      doc.id,
    )
  const supplier = db.suppliers.find((s) => s.id === doc.supplier_id)!
  const si = doc.si!
  const actor = transition(ctx, doc, 'CONFIRM', {
    summary: `Registró ${doc.display_number}: factura ${invoiceLabel(si)} de ${supplier.legal_name} por ${money(doc.total)}`,
  })
  doc.si = { ...si, registered_at: ctx.now }
  // Con letra A el IVA va a crédito fiscal; con letra C es parte del costo.
  const byType = new Map<string, number>()
  for (const l of lines) {
    const type = db.products.find((p) => p.id === l.product_id)!.product_type
    byType.set(type, (byType.get(type) ?? 0) + (si.letter === 'A' ? l.line_subtotal : l.line_total))
  }
  postEvent(
    ctx,
    actor,
    doc,
    'COMPRA',
    `Compra según ${doc.display_number}: factura ${invoiceLabel(si)} de ${supplier.legal_name}.`,
    [
      ...Object.keys(PRODUCT_TYPES)
        .filter((type) => byType.has(type))
        .map((type) => ({ key: type, debit: byType.get(type)!, credit: 0 })),
      { key: 'IVA_CREDITO', debit: si.letter === 'A' ? doc.tax_total : 0, credit: 0 },
      { key: 'PROVEEDORES', debit: 0, credit: doc.total },
    ],
  )
}

export function cmdConfirmSupplierInvoice(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'SUPPLIER_INVOICE')
  requirePermission(ctx, doc.company_id, 'supplier_invoice.create')
  registerInvoice(ctx, doc)
}

/**
 * El borrador se anula sin más. Una factura registrada y sin pagos se anula con
 * el contraasiento de su asiento de compra, y deja de figurar en la deuda.
 */
export function cmdCancelSupplierInvoice(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'SUPPLIER_INVOICE')
  if (doc.status !== 'REGISTRADA') {
    transition(ctx, doc, 'CANCEL', { comment: reason })
    return
  }
  const actor = requirePermission(ctx, doc.company_id, 'supplier_invoice.cancel')
  const comment = reason.trim()
  if (comment.length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  const order = activeOrderWith(db, doc.id)
  if (order)
    fail(
      'TRANSICION_INVALIDA',
      `${doc.display_number} está en la orden de pago ${order.display_number}: primero hay que anular esa orden.`,
    )
  const entry = automaticEntryOf(db, doc.id)
  const reversal = entry ? reverseEntry(ctx, entry, actor, `${doc.display_number} anulada: ${comment}`, true) : null
  transition(ctx, doc, 'CANCEL', {
    comment,
    actor,
    summary: `Anuló ${doc.display_number}${reversal ? ` y su asiento con el contraasiento ${reversal.display_number}` : ''} — ${comment}`,
  })
}

// ============================================================ Órdenes de pago (docs/FASE_3_COMPRAS_Y_TESORERIA.md §5)

export interface PaymentOrderInput {
  supplier_id: string
  /** Caja o banco desde el que se paga. */
  treasury_account_id: string
  notes: string
  lines: { invoice_id: string; amount: number }[]
}

/** Órdenes de pago en curso: reservan el saldo de sus facturas hasta pagarse o anularse. */
export const ACTIVE_PAYMENT_STATUSES = ['BORRADOR', 'PENDIENTE_APROBACION', 'APROBADA']

/** Facturas que todavía se pueden pagar. */
const PAYABLE_STATUSES = ['REGISTRADA', 'PAGADA_PARCIAL']

const orderLines = (db: DB, docId: string) =>
  db.opLines.filter((l) => l.document_id === docId).sort((a, b) => a.line_no - b.line_no)

/** Lo que aplican a una factura las órdenes de pago en esos estados (salvo una). */
function appliedToInvoice(db: DB, invoiceId: string, statuses: string[], exceptDocId?: string) {
  const orders = new Set(
    db.documents
      .filter((d) => d.doc_type === 'PAYMENT_ORDER' && statuses.includes(d.status) && d.id !== exceptDocId)
      .map((d) => d.id),
  )
  return round2(
    db.opLines.filter((l) => l.invoice_id === invoiceId && orders.has(l.document_id)).reduce((s, l) => s + l.amount, 0),
  )
}

/** Lo pagado de una factura: sus órdenes de pago pagadas. */
export const invoicePaid = (db: DB, invoiceId: string) => appliedToInvoice(db, invoiceId, ['PAGADA'])

/** Lo reservado de una factura en órdenes de pago en curso (salvo una). */
export const invoiceCommitted = (db: DB, invoiceId: string, exceptDocId?: string) =>
  appliedToInvoice(db, invoiceId, ACTIVE_PAYMENT_STATUSES, exceptDocId)

/** La primera orden de pago en curso que incluye una factura. */
function activeOrderWith(db: DB, invoiceId: string) {
  const ids = new Set(db.opLines.filter((l) => l.invoice_id === invoiceId).map((l) => l.document_id))
  return db.documents
    .filter((d) => ids.has(d.id) && ACTIVE_PAYMENT_STATUSES.includes(d.status))
    .sort((a, b) => a.number - b.number)[0]
}

/** Caja o banco de la empresa: una cuenta imputable y activa del rubro Caja y bancos. */
function treasuryAccount(db: DB, companyId: string, accountId: string) {
  const account = db.accounts.find((a) => a.id === accountId && a.company_id === companyId)
  if (!account || !account.is_imputable || !account.code.startsWith(`${TREASURY_RUBRO}.`))
    fail('DATO_INVALIDO', 'Elegí la caja o el banco desde el que se paga (una cuenta de Caja y bancos).')
  if (!account.is_active) fail('DATO_INVALIDO', `La cuenta ${accountLabel(account)} está desactivada.`)
  return account
}

/** Quien registró una factura: la confirmación en su historial. */
export function invoiceRegistrant(db: DB, invoiceId: string) {
  return db.audit.find((e) => e.document_id === invoiceId && e.action === 'CONFIRM')?.actor_user_id ?? null
}

/** Estado de una factura según lo pagado: registrada, pagada parcialmente o pagada. */
function recomputeInvoice(ctx: Ctx, invoiceId: string) {
  const invoice = getDoc(ctx.db, invoiceId, 'SUPPLIER_INVOICE')
  if (![...PAYABLE_STATUSES, 'PAGADA'].includes(invoice.status)) return
  const paid = invoicePaid(ctx.db, invoice.id)
  const target = paid >= invoice.total - EPS ? 'PAGADA' : paid > EPS ? 'PAGADA_PARCIAL' : 'REGISTRADA'
  if (target !== invoice.status) transition(ctx, invoice, 'SYSTEM', { to: target })
}

export function cmdCreatePaymentOrder(ctx: Ctx, companyId: string, input: PaymentOrderInput, submit: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'payment_order.create')
  const supplier = db.suppliers.find((s) => s.id === input.supplier_id && s.company_id === companyId)
  if (!supplier) fail('DATO_INVALIDO', 'Elegí el proveedor al que se le paga.')
  const account = treasuryAccount(db, companyId, input.treasury_account_id)
  const seen = new Set<string>()
  const lines = input.lines
    .filter((l) => l.invoice_id && l.amount)
    .map((l) => {
      const invoice = db.documents.find(
        (d) => d.id === l.invoice_id && d.company_id === companyId && d.doc_type === 'SUPPLIER_INVOICE',
      )
      if (!invoice || invoice.supplier_id !== supplier.id)
        fail('DATO_INVALIDO', `Una de las facturas no es de ${supplier.legal_name}.`)
      if (seen.has(invoice.id)) fail('DATO_INVALIDO', `${invoice.display_number} está dos veces en la orden.`)
      seen.add(invoice.id)
      if (!PAYABLE_STATUSES.includes(invoice.status))
        fail(
          'DATO_INVALIDO',
          `${invoice.display_number} está en estado "${statusLabel(invoice.doc_type, invoice.status)}": se pagan facturas registradas con saldo.`,
        )
      if (!Number.isFinite(l.amount) || !(l.amount > 0) || round2(l.amount) !== l.amount)
        fail('DATO_INVALIDO', 'Los importes deben ser mayores que cero y tener hasta 2 decimales.')
      const pending = round2(invoice.total - invoicePaid(db, invoice.id))
      const committed = invoiceCommitted(db, invoice.id)
      const available = round2(pending - committed)
      if (l.amount > available + EPS)
        fail(
          'IMPORTE_EXCEDIDO',
          `${invoice.display_number}: el saldo es ${money(pending)}${committed > 0 ? ` y ya hay ${money(committed)} en otras órdenes de pago en curso` : ''}; como mucho se pueden pagar ${money(Math.max(available, 0))}.`,
          'Una factura no se paga dos veces: lo que está en una orden de pago en curso queda reservado.',
        )
      return { invoice, amount: l.amount }
    })
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá qué facturas se pagan y cuánto de cada una.')
  const doc = newDocument(ctx, companyId, 'PAYMENT_ORDER', actor, {
    supplier_id: supplier.id,
    notes: input.notes.trim(),
    op: { treasury_account_id: account.id, payment_reference: '', paid_on: null, payment_method: null },
  })
  lines.forEach((l, i) => {
    db.opLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      invoice_id: l.invoice.id,
      amount: l.amount,
    })
  })
  doc.subtotal = round2(lines.reduce((s, l) => s + l.amount, 0))
  doc.total = doc.subtotal
  for (const l of lines) link(ctx, companyId, l.invoice.id, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'payment_order',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number}: pago a ${supplier.legal_name} por ${money(doc.total)} desde ${accountLabel(account)}`,
  })
  if (submit) submitPaymentOrder(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

function submitPaymentOrder(ctx: Ctx, doc: T.Document) {
  transition(ctx, doc, 'SUBMIT', { summary: `Envió ${doc.display_number} a aprobación (${money(doc.total)})` })
}

export function cmdSubmitPaymentOrder(ctx: Ctx, docId: string) {
  submitPaymentOrder(ctx, getDoc(ctx.db, docId, 'PAYMENT_ORDER'))
}

/** Gerencia aprueba o rechaza; quien preparó la orden no decide sobre ella. */
function decidePaymentOrder(ctx: Ctx, docId: string, action: 'APPROVE' | 'REJECT', comment: string) {
  const doc = getDoc(ctx.db, docId, 'PAYMENT_ORDER')
  requireTransition(doc, action)
  const actor = requirePermission(ctx, doc.company_id, 'payment_order.approve')
  const eff = effectivePermissions(ctx.db, ctx.userId!, doc.company_id)
  if (!eff.supervisor && getCompany(ctx.db, doc.company_id).settings.sod_enabled && doc.created_by === ctx.userId)
    fail(
      'SEPARACION_FUNCIONES',
      'No podés aprobar ni rechazar una orden de pago que preparaste vos.',
      'Separación de funciones: quien prepara un pago no lo autoriza.',
    )
  transition(ctx, doc, action, {
    actor,
    comment,
    summary:
      action === 'APPROVE'
        ? `Aprobó ${doc.display_number} por ${money(doc.total)}${comment.trim() ? ` — ${comment.trim()}` : ''}`
        : undefined,
  })
}

export function cmdApprovePaymentOrder(ctx: Ctx, docId: string, comment: string) {
  decidePaymentOrder(ctx, docId, 'APPROVE', comment)
}

export function cmdRejectPaymentOrder(ctx: Ctx, docId: string, reason: string) {
  decidePaymentOrder(ctx, docId, 'REJECT', reason)
}

/** Cómo se nombra cada medio de pago dentro de una frase: "por transferencia", "con cheque"… */
const PAYMENT_VIA: Record<T.PaymentMethod, { phrase: string; noun: string }> = {
  TRANSFERENCIA: { phrase: 'por transferencia', noun: 'transferencia' },
  CHEQUE: { phrase: 'con cheque', noun: 'cheque' },
  EFECTIVO: { phrase: 'en efectivo', noun: 'efectivo' },
}

/**
 * Tesorería paga: controla de nuevo los saldos de las facturas y el de la caja
 * o el banco, genera el asiento de pago y actualiza el estado de cada factura.
 * Con cheque, la referencia es su número (obligatorio).
 */
export function cmdPayPaymentOrder(
  ctx: Ctx,
  docId: string,
  reference: string,
  method: T.PaymentMethod = 'TRANSFERENCIA',
) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'PAYMENT_ORDER')
  requireTransition(doc, 'PAY')
  const actor = requirePermission(ctx, doc.company_id, 'payment_order.pay')
  const ref = reference.trim()
  if (ref.length > 60) fail('DATO_INVALIDO', 'La referencia del pago tiene hasta 60 caracteres.')
  if (!Object.hasOwn(PAYMENT_VIA, method))
    fail('DATO_INVALIDO', 'Elegí el medio de pago: transferencia, cheque o efectivo.')
  if (method === 'CHEQUE' && !/^\d{1,8}$/.test(ref))
    fail('DATO_INVALIDO', 'Indicá el número del cheque (hasta 8 números).', 'Queda en el registro de cheques emitidos.')
  const company = getCompany(db, doc.company_id)
  const eff = effectivePermissions(db, ctx.userId!, doc.company_id)
  const lines = orderLines(db, doc.id)
  for (const l of lines) {
    const invoice = getDoc(db, l.invoice_id, 'SUPPLIER_INVOICE')
    if (company.settings.sod_enabled && !eff.supervisor && invoiceRegistrant(db, invoice.id) === ctx.userId)
      fail(
        'SEPARACION_FUNCIONES',
        `No podés pagar ${invoice.display_number}: la registraste vos.`,
        'Separación de funciones: quien registra una deuda no la paga. Tiene que pagarla otro integrante de Tesorería.',
      )
  }
  for (const l of lines) {
    const invoice = getDoc(db, l.invoice_id, 'SUPPLIER_INVOICE')
    const pending = round2(invoice.total - invoicePaid(db, invoice.id))
    if (!PAYABLE_STATUSES.includes(invoice.status) || l.amount > pending + EPS)
      fail(
        'IMPORTE_EXCEDIDO',
        `${invoice.display_number}: el saldo pendiente es ${money(Math.max(pending, 0))} y la orden paga ${money(l.amount)}.`,
      )
  }
  const account = treasuryAccount(db, doc.company_id, doc.op!.treasury_account_id)
  const balance = accountBalance(db, account.id)
  if (doc.total > balance + EPS)
    fail(
      'SALDO_INSUFICIENTE',
      `No alcanza el saldo de ${accountLabel(account)}: hay ${money(balance)} y la orden es por ${money(doc.total)}.`,
      'Antes de pagar hay que controlar que haya fondos; por ejemplo, depositar el efectivo en el banco.',
    )
  const supplier = db.suppliers.find((s) => s.id === doc.supplier_id)!
  const via = PAYMENT_VIA[method]
  const number = ref ? ` N.º ${ref}` : ''
  transition(ctx, doc, 'PAY', {
    actor,
    summary: `Pagó ${doc.display_number} ${via.phrase}${number}: ${money(doc.total)} a ${supplier.legal_name} desde ${accountLabel(account)}`,
  })
  doc.op = { ...doc.op!, payment_reference: ref, paid_on: businessDate(company), payment_method: method }
  postEvent(
    ctx,
    actor,
    doc,
    'PAGO',
    `Pago a ${supplier.legal_name} según ${doc.display_number} (${via.noun}${number}).`,
    [
      { key: 'PROVEEDORES', debit: doc.total, credit: 0 },
      { account_id: account.id, debit: 0, credit: doc.total },
    ],
  )
  for (const l of lines) recomputeInvoice(ctx, l.invoice_id)
}

/**
 * Antes de pagarse, la orden se anula sin más. Una orden pagada se anula con
 * el contraasiento de su pago, y sus facturas vuelven a tener saldo.
 */
export function cmdCancelPaymentOrder(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'PAYMENT_ORDER')
  if (doc.status !== 'PAGADA') {
    transition(ctx, doc, 'CANCEL', { comment: reason })
    return
  }
  const actor = requirePermission(ctx, doc.company_id, 'payment_order.cancel')
  const comment = reason.trim()
  if (comment.length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  const entry = automaticEntryOf(db, doc.id)
  const reversal = entry ? reverseEntry(ctx, entry, actor, `${doc.display_number} anulada: ${comment}`, true) : null
  transition(ctx, doc, 'CANCEL', {
    comment,
    actor,
    summary: `Anuló ${doc.display_number}${reversal ? ` y su pago con el contraasiento ${reversal.display_number}` : ''} — ${comment}`,
  })
  for (const l of orderLines(db, doc.id)) recomputeInvoice(ctx, l.invoice_id)
}

// ============================================================ Cotizaciones (docs/FASE_3_COMPRAS_Y_TESORERIA.md §6)

export interface RfqInput {
  /** Fecha límite para que respondan los proveedores. */
  response_due: string
  warehouse_id: string
  notes: string
  /** Proveedores invitados a cotizar. */
  supplier_ids: string[]
  lines: { product_id: string; quantity: number; requisition_line_id: string | null; notes?: string }[]
}

export interface SupplierQuoteInput {
  rfq_id: string
  supplier_id: string
  supplier_reference: string
  valid_until: string
  delivery_days: number
  payment_terms_days: number
  notes: string
  /** Sólo los ítems que cotiza. Si el proveedor no discrimina IVA, su precio es el final y va sin IVA. */
  lines: { rfq_line_id: string; unit_price: number; vat_rate: number }[]
}

/** Proveedores a los que, como mínimo, se pide cotización (a validar). */
export const MIN_RFQ_SUPPLIERS = 2

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))

export const rfqLinesOf = (db: DB, rfqId: string) =>
  db.rfqLines.filter((l) => l.document_id === rfqId).sort((a, b) => a.line_no - b.line_no)

/** Las cotizaciones de una solicitud que no se anularon, por número. */
export function quotesOf(db: DB, rfqId: string) {
  return db.documents
    .filter((d) => d.doc_type === 'SUPPLIER_QUOTE' && d.sq?.rfq_id === rfqId && d.status !== 'ANULADA')
    .sort((a, b) => a.number - b.number)
}

/** Vigente: recibida y con la oferta todavía válida. */
export function quoteIsValid(db: DB, quote: T.Document) {
  return quote.status === 'RECIBIDA' && quote.sq!.valid_until >= businessDate(getCompany(db, quote.company_id))
}

/**
 * La más conveniente por precio: entre las vigentes que cotizan todos los
 * ítems, la de menor costo para la empresa (el neto: el IVA de un responsable
 * inscripto es crédito fiscal, y quien no lo discrimina cotiza sin IVA) y, a
 * igual costo, la de menor plazo de entrega (a validar).
 */
export function bestQuote(db: DB, rfq: T.Document): T.Document | null {
  const items = rfqLinesOf(db, rfq.id).length
  return (
    quotesOf(db, rfq.id)
      .filter((q) => quoteIsValid(db, q) && db.sqLines.filter((l) => l.document_id === q.id).length === items)
      .sort((a, b) => a.subtotal - b.subtotal || a.sq!.delivery_days - b.sq!.delivery_days || a.number - b.number)[0] ??
    null
  )
}

/** La orden de compra que nació de una cotización adjudicada. */
export function orderFromQuote(db: DB, quoteId: string) {
  const ids = new Set(db.docLinks.filter((l) => l.from_document_id === quoteId).map((l) => l.to_document_id))
  return db.documents
    .filter((d) => ids.has(d.id) && d.doc_type === 'PURCHASE_ORDER')
    .sort((a, b) => a.number - b.number)[0]
}

function validateRfqLines(ctx: Ctx, companyId: string, input: RfqInput['lines']) {
  const { db } = ctx
  const lines = input.filter((l) => l.product_id).map((l) => ({ ...l, quantity: round3(l.quantity) }))
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un ítem para cotizar.')
  const usedByReqLine = new Map<string, number>()
  for (const l of lines) {
    const p = getProduct(db, companyId, l.product_id)
    if (!p.is_active) fail('DATO_INVALIDO', `${productLabel(p)} está inactivo.`)
    if (!Number.isFinite(l.quantity) || !(l.quantity > 0))
      fail('DATO_INVALIDO', `La cantidad de ${p.code} debe ser mayor que cero y tener hasta 3 decimales.`)
    if (!l.requisition_line_id) continue
    const rl = db.prLines.find((x) => x.id === l.requisition_line_id && x.company_id === companyId)
    if (!rl) fail('DATO_INVALIDO', 'La línea de solicitud vinculada no existe.')
    const req = getDoc(db, rl.document_id, 'PURCHASE_REQUISITION')
    if (!['SOLICITADO', 'ORDENADO_PARCIAL'].includes(req.status))
      fail('TRANSICION_INVALIDA', `${req.display_number} no está pendiente de atención.`)
    if (rl.product_id !== l.product_id)
      fail('DATO_INVALIDO', `El producto no coincide con el de ${req.display_number}.`)
    const used = (usedByReqLine.get(rl.id) ?? 0) + l.quantity
    usedByReqLine.set(rl.id, used)
    const pending = requisitionAvailableQuantity(db, rl.id)
    if (used > pending + EPS)
      fail(
        'CANTIDAD_EXCEDE_PENDIENTE',
        `${p.code}: la cantidad supera lo pendiente de ${req.display_number} (${fmtQty(pending, p.uom_code)}).`,
        'Si hace falta cotizar más, agregá una línea sin vínculo a la solicitud.',
      )
  }
  return lines
}

export function cmdCreateRfq(ctx: Ctx, companyId: string, input: RfqInput, send: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'rfq.create')
  if (!isIsoDate(input.response_due)) fail('DATO_INVALIDO', 'Indicá hasta cuándo pueden responder los proveedores.')
  if (input.response_due < businessDate(getCompany(db, companyId)))
    fail('DATO_INVALIDO', 'La fecha límite para responder no puede ser anterior a hoy.')
  if (!db.warehouses.some((w) => w.id === input.warehouse_id && w.company_id === companyId))
    fail('DATO_INVALIDO', 'Elegí el depósito de entrega.')
  const suppliers = [...new Set(input.supplier_ids.filter(Boolean))].map((id) => {
    const s = db.suppliers.find((x) => x.id === id && x.company_id === companyId)
    if (!s) fail('DATO_INVALIDO', 'Uno de los proveedores invitados no existe en esta empresa.')
    if (!s.is_active) fail('DATO_INVALIDO', `El proveedor ${s.legal_name} está inactivo.`)
    return s
  })
  if (suppliers.length < MIN_RFQ_SUPPLIERS)
    fail(
      'DATO_INVALIDO',
      'Invitá al menos a dos proveedores: la idea es comparar sus ofertas.',
      'Pedir más de un precio permite elegir con fundamento.',
    )
  const lines = validateRfqLines(ctx, companyId, input.lines)
  const doc = newDocument(ctx, companyId, 'RFQ', actor, {
    notes: input.notes.trim(),
    rq: { response_due: input.response_due, warehouse_id: input.warehouse_id, award_reason: '' },
  })
  lines.forEach((l, i) => {
    db.rfqLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      product_id: l.product_id,
      quantity: l.quantity,
      requisition_line_id: l.requisition_line_id ?? null,
      notes: (l.notes ?? '').trim(),
    })
  })
  for (const s of suppliers) db.rfqSuppliers.push({ company_id: companyId, document_id: doc.id, supplier_id: s.id })
  const requisitions = new Set(
    lines
      .filter((l) => l.requisition_line_id)
      .map((l) => db.prLines.find((x) => x.id === l.requisition_line_id)!.document_id),
  )
  for (const prId of requisitions) link(ctx, companyId, prId, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'rfq',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number}: pide cotización a ${suppliers.length} proveedores (${lines.length} ítem${lines.length > 1 ? 's' : ''})`,
  })
  if (send) sendRfq(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

function sendRfq(ctx: Ctx, doc: T.Document) {
  const invited = ctx.db.rfqSuppliers.filter((s) => s.document_id === doc.id).length
  transition(ctx, doc, 'SUBMIT', { summary: `Envió ${doc.display_number} a ${invited} proveedores` })
}

export function cmdSendRfq(ctx: Ctx, docId: string) {
  sendRfq(ctx, getDoc(ctx.db, docId, 'RFQ'))
}

/** Anular la solicitud descarta las cotizaciones que seguían en juego. */
export function cmdCancelRfq(ctx: Ctx, docId: string, reason: string) {
  const doc = getDoc(ctx.db, docId, 'RFQ')
  transition(ctx, doc, 'CANCEL', { comment: reason })
  for (const q of quotesOf(ctx.db, doc.id).filter((x) => x.status === 'RECIBIDA'))
    transition(ctx, q, 'SYSTEM', { to: 'DESCARTADA' })
}

export function cmdCreateSupplierQuote(ctx: Ctx, companyId: string, input: SupplierQuoteInput) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'supplier_quote.create')
  const rfq = db.documents.find((d) => d.id === input.rfq_id && d.company_id === companyId && d.doc_type === 'RFQ')
  if (!rfq) fail('DATO_INVALIDO', 'Elegí la solicitud de cotización que responde el proveedor.')
  if (rfq.status !== 'ENVIADA')
    fail(
      'TRANSICION_INVALIDA',
      `${rfq.display_number} está en estado "${statusLabel(rfq.doc_type, rfq.status)}": se cargan cotizaciones de una solicitud enviada a los proveedores.`,
    )
  const supplier = db.suppliers.find((s) => s.id === input.supplier_id && s.company_id === companyId)
  if (!supplier || !db.rfqSuppliers.some((s) => s.document_id === rfq.id && s.supplier_id === supplier.id))
    fail('DATO_INVALIDO', `Elegí uno de los proveedores invitados a cotizar en ${rfq.display_number}.`)
  if (!supplier.is_active) fail('DATO_INVALIDO', `El proveedor ${supplier.legal_name} está inactivo.`)
  const previous = quotesOf(db, rfq.id).find((q) => q.supplier_id === supplier.id)
  if (previous)
    fail(
      'DATO_INVALIDO',
      `Ya está cargada la cotización de ${supplier.legal_name} (${previous.display_number}). Si cambió su oferta, anulala y cargá la nueva.`,
    )
  if (!isIsoDate(input.valid_until)) fail('DATO_INVALIDO', 'Indicá hasta cuándo vale la oferta.')
  if (input.valid_until < businessDate(getCompany(db, companyId)))
    fail('DATO_INVALIDO', 'La oferta ya está vencida: pedile al proveedor que la renueve.')
  if (!Number.isInteger(input.delivery_days) || input.delivery_days < 0)
    fail('DATO_INVALIDO', 'El plazo de entrega es una cantidad entera de días (0 o más).')
  if (!Number.isInteger(input.payment_terms_days) || input.payment_terms_days < 0)
    fail('DATO_INVALIDO', 'La condición de pago es una cantidad entera de días (0 = contado).')
  const reference = input.supplier_reference.trim()
  if (reference.length > 40) fail('DATO_INVALIDO', 'La referencia del proveedor tiene hasta 40 caracteres.')
  // Quien no es responsable inscripto no discrimina IVA: cotiza el precio final.
  const discriminates = supplier.vat_condition === 'RESPONSABLE_INSCRIPTO'
  const items = rfqLinesOf(db, rfq.id)
  const seen = new Set<string>()
  const lines = input.lines
    .filter((l) => l.rfq_line_id)
    .map((l) => {
      const item = items.find((x) => x.id === l.rfq_line_id)
      if (!item) fail('DATO_INVALIDO', `Uno de los ítems no es de ${rfq.display_number}.`)
      if (seen.has(item.id)) fail('DATO_INVALIDO', `El ítem ${item.line_no} está dos veces en la cotización.`)
      seen.add(item.id)
      const p = db.products.find((x) => x.id === item.product_id)!
      if (!Number.isFinite(l.unit_price) || !(l.unit_price > 0) || round4(l.unit_price) !== l.unit_price)
        fail('DATO_INVALIDO', `El precio de ${p.code} debe ser mayor que cero y tener hasta 4 decimales.`)
      const vat = discriminates ? l.vat_rate : 0
      if (!VAT_RATES.includes(vat)) fail('DATO_INVALIDO', `La alícuota de IVA de ${p.code} no es válida.`)
      const subtotal = round2(item.quantity * l.unit_price)
      return { item, unit_price: l.unit_price, vat, subtotal, tax: round2((subtotal * vat) / 100) }
    })
    .sort((a, b) => a.item.line_no - b.item.line_no)
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá el precio de al menos un ítem.')
  const doc = newDocument(ctx, companyId, 'SUPPLIER_QUOTE', actor, {
    status: 'RECIBIDA',
    supplier_id: supplier.id,
    notes: input.notes.trim(),
    sq: {
      rfq_id: rfq.id,
      supplier_reference: reference,
      valid_until: input.valid_until,
      delivery_days: input.delivery_days,
      payment_terms_days: input.payment_terms_days,
    },
  })
  lines.forEach((l, i) => {
    db.sqLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      rfq_line_id: l.item.id,
      product_id: l.item.product_id,
      quantity: l.item.quantity,
      unit_price: l.unit_price,
      vat_rate: l.vat,
      line_subtotal: l.subtotal,
      line_tax: l.tax,
      line_total: round2(l.subtotal + l.tax),
    })
  })
  doc.subtotal = round2(lines.reduce((s, l) => s + l.subtotal, 0))
  doc.tax_total = round2(lines.reduce((s, l) => s + l.tax, 0))
  doc.total = round2(doc.subtotal + doc.tax_total)
  link(ctx, companyId, rfq.id, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'supplier_quote',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'RECIBIDA',
    summary: `Cargó ${doc.display_number}: cotización de ${supplier.legal_name} para ${rfq.display_number} por ${money(doc.total)}`,
  })
  return { id: doc.id, display_number: doc.display_number }
}

export function cmdCancelSupplierQuote(ctx: Ctx, docId: string, reason: string) {
  transition(ctx, getDoc(ctx.db, docId, 'SUPPLIER_QUOTE'), 'CANCEL', { comment: reason })
}

/**
 * Adjudica la solicitud a una cotización vigente: genera la OC en borrador con
 * sus precios y condiciones, y descarta las demás. Si no es la más conveniente
 * por precio, hay que justificar la elección.
 */
export function cmdAwardRfq(ctx: Ctx, docId: string, quoteId: string, reason: string) {
  const { db } = ctx
  const rfq = getDoc(db, docId, 'RFQ')
  requireTransition(rfq, 'AWARD')
  const actor = requirePermission(ctx, rfq.company_id, 'rfq.award')
  const quote = quotesOf(db, rfq.id).find((q) => q.id === quoteId && q.status === 'RECIBIDA')
  if (!quote) fail('DATO_INVALIDO', `Elegí una de las cotizaciones recibidas para ${rfq.display_number}.`)
  const supplier = db.suppliers.find((s) => s.id === quote.supplier_id)!
  if (!quoteIsValid(db, quote))
    fail(
      'OFERTA_VENCIDA',
      `La oferta de ${supplier.legal_name} venció el ${fmtDate(quote.sq!.valid_until)}: pedile que la renueve y cargá la nueva cotización.`,
    )
  const comment = reason.trim()
  const best = bestQuote(db, rfq)
  if (quote.id !== best?.id && comment.length < 10)
    fail(
      'MOTIVO_REQUERIDO',
      best
        ? `${quote.display_number} no es la más conveniente por precio (es ${best.display_number}): explicá por qué la elegís, en al menos 10 caracteres.`
        : `Ninguna cotización vigente cubre todos los ítems: explicá por qué elegís ${quote.display_number}, en al menos 10 caracteres.`,
      'Justificar la elección es parte del control: queda en la solicitud y Gerencia la ve al aprobar la orden de compra.',
    )
  const items = rfqLinesOf(db, rfq.id)
  const reference = quote.sq!.supplier_reference
  const order = cmdCreatePurchaseOrder(ctx, rfq.company_id, {
    supplier_id: supplier.id,
    expected_date: addDays(businessDate(getCompany(db, rfq.company_id)), quote.sq!.delivery_days),
    warehouse_id: rfq.rq!.warehouse_id,
    payment_terms_days: quote.sq!.payment_terms_days,
    delivery_terms: '',
    notes: `Según la cotización ${quote.display_number}${reference ? ` (referencia del proveedor: ${reference})` : ''}.`,
    lines: db.sqLines
      .filter((l) => l.document_id === quote.id)
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => ({
        product_id: l.product_id,
        requisition_line_id: items.find((x) => x.id === l.rfq_line_id)!.requisition_line_id,
        quantity: l.quantity,
        unit_price: l.unit_price,
        vat_rate: l.vat_rate,
      })),
  })
  link(ctx, rfq.company_id, quote.id, order.id)
  rfq.rq = { ...rfq.rq!, award_reason: comment }
  transition(ctx, rfq, 'AWARD', {
    actor,
    summary: `Adjudicó ${rfq.display_number} a ${supplier.legal_name} (${quote.display_number}) y generó ${order.display_number} en borrador${comment ? ` — ${comment}` : ''}`,
  })
  for (const q of quotesOf(db, rfq.id).filter((x) => x.status === 'RECIBIDA'))
    transition(ctx, q, 'SYSTEM', { to: q.id === quote.id ? 'ADJUDICADA' : 'DESCARTADA' })
  return order
}

// ============================================================ Transferencias entre cuentas (docs/FASE_3_COMPRAS_Y_TESORERIA.md §7)

export interface FundsTransferInput {
  from_account_id: string
  to_account_id: string
  amount: number
  /** Número de la boleta de depósito o de la transferencia. */
  reference: string
  notes: string
}

/** Una caja o un banco de la empresa para transferir: cuenta imputable y activa del rubro Caja y bancos. */
function fundsAccount(db: DB, companyId: string, accountId: string, side: 'origen' | 'destino') {
  const account = db.accounts.find((a) => a.id === accountId && a.company_id === companyId)
  if (!account || !account.is_imputable || !account.code.startsWith(`${TREASURY_RUBRO}.`))
    fail('DATO_INVALIDO', `Elegí la cuenta de ${side}: una caja o un banco de la empresa.`)
  if (!account.is_active) fail('DATO_INVALIDO', `La cuenta ${accountLabel(account)} está desactivada.`)
  return account
}

export function cmdCreateFundsTransfer(ctx: Ctx, companyId: string, input: FundsTransferInput, confirm: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'funds_transfer.create')
  const from = fundsAccount(db, companyId, input.from_account_id, 'origen')
  const to = fundsAccount(db, companyId, input.to_account_id, 'destino')
  if (from.id === to.id) fail('DATO_INVALIDO', 'La cuenta de origen y la de destino tienen que ser distintas.')
  if (!Number.isFinite(input.amount) || !(input.amount > 0) || round2(input.amount) !== input.amount)
    fail('DATO_INVALIDO', 'El importe debe ser mayor que cero y tener hasta 2 decimales.')
  const reference = input.reference.trim()
  if (reference.length > 60) fail('DATO_INVALIDO', 'La referencia tiene hasta 60 caracteres.')
  const doc = newDocument(ctx, companyId, 'FUNDS_TRANSFER', actor, {
    notes: input.notes.trim(),
    subtotal: input.amount,
    total: input.amount,
    ft: { from_account_id: from.id, to_account_id: to.id, reference, transferred_on: null },
  })
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'funds_transfer',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number}: ${money(doc.total)} de ${accountLabel(from)} a ${accountLabel(to)}`,
  })
  if (confirm) confirmFundsTransfer(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

/** Confirma la transferencia: controla el saldo de la cuenta de origen y genera el asiento. */
function confirmFundsTransfer(ctx: Ctx, doc: T.Document) {
  const { db } = ctx
  requireTransition(doc, 'CONFIRM')
  const from = fundsAccount(db, doc.company_id, doc.ft!.from_account_id, 'origen')
  const to = fundsAccount(db, doc.company_id, doc.ft!.to_account_id, 'destino')
  const balance = accountBalance(db, from.id)
  if (doc.total > balance + EPS)
    fail(
      'SALDO_INSUFICIENTE',
      `No alcanza el saldo de ${accountLabel(from)}: hay ${money(balance)} y la transferencia es por ${money(doc.total)}.`,
      'Transferí un importe menor o desde otra cuenta.',
    )
  const actor = transition(ctx, doc, 'CONFIRM', {
    summary: `Confirmó ${doc.display_number}: ${money(doc.total)} de ${accountLabel(from)} a ${accountLabel(to)}`,
  })
  const reference = doc.ft!.reference
  doc.ft = { ...doc.ft!, transferred_on: businessDate(getCompany(db, doc.company_id)) }
  postEvent(
    ctx,
    actor,
    doc,
    'TRANSFERENCIA',
    `Transferencia de ${from.name} a ${to.name} según ${doc.display_number}${reference ? ` (${reference})` : ''}.`,
    [
      { account_id: to.id, debit: doc.total, credit: 0 },
      { account_id: from.id, debit: 0, credit: doc.total },
    ],
  )
}

export function cmdConfirmFundsTransfer(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'FUNDS_TRANSFER')
  requirePermission(ctx, doc.company_id, 'funds_transfer.create')
  confirmFundsTransfer(ctx, doc)
}

/**
 * El borrador se anula sin más. Una transferencia confirmada se anula con el
 * contraasiento de su asiento, si los fondos todavía están en la cuenta de destino.
 */
export function cmdCancelFundsTransfer(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'FUNDS_TRANSFER')
  if (doc.status !== 'CONFIRMADA') {
    transition(ctx, doc, 'CANCEL', { comment: reason })
    return
  }
  const actor = requirePermission(ctx, doc.company_id, 'funds_transfer.cancel')
  const comment = reason.trim()
  if (comment.length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  const to = db.accounts.find((a) => a.id === doc.ft!.to_account_id)!
  const balance = accountBalance(db, to.id)
  if (doc.total > balance + EPS)
    fail(
      'SALDO_INSUFICIENTE',
      `No se puede anular: en ${accountLabel(to)} hay ${money(balance)} y la transferencia fue por ${money(doc.total)}.`,
      'Los fondos ya se usaron: para devolverlos, prepará otra transferencia.',
    )
  const entry = automaticEntryOf(db, doc.id)
  const reversal = entry ? reverseEntry(ctx, entry, actor, `${doc.display_number} anulada: ${comment}`, true) : null
  transition(ctx, doc, 'CANCEL', {
    comment,
    actor,
    summary: `Anuló ${doc.display_number}${reversal ? ` y su asiento con el contraasiento ${reversal.display_number}` : ''} — ${comment}`,
  })
}

// ============================================================ Conciliación bancaria (docs/FASE_3_COMPRAS_Y_TESORERIA.md §7)

export interface BankReconciliationInput {
  account_id: string
  statement_date: string
  statement_balance: number
  /** Los movimientos del mayor que figuran en el extracto. */
  journal_line_ids: string[]
  notes: string
}

/** Un movimiento del mayor de una cuenta, con su asiento. */
export interface AccountLine {
  line: T.JournalEntryLine
  doc: T.Document
}

/** Movimientos de una cuenta en asientos registrados hasta una fecha, en el orden del libro diario. */
export function accountLinesUpTo(db: DB, accountId: string, upTo: string): AccountLine[] {
  const docs = new Map(
    db.documents
      .filter((d) => d.doc_type === 'JOURNAL_ENTRY' && d.je?.entry_number != null && d.document_date <= upTo)
      .map((d) => [d.id, d]),
  )
  return db.jeLines
    .filter((l) => l.account_id === accountId && docs.has(l.document_id))
    .map((line) => ({ line, doc: docs.get(line.document_id)! }))
    .sort(
      (a, b) =>
        (a.doc.document_date < b.doc.document_date ? -1 : a.doc.document_date > b.doc.document_date ? 1 : 0) ||
        a.doc.je!.entry_number! - b.doc.je!.entry_number! ||
        a.line.line_no - b.line.line_no,
    )
}

const confirmedReconciliations = (db: DB, accountId: string) =>
  db.documents
    .filter((d) => d.doc_type === 'BANK_RECONCILIATION' && d.status === 'CONFIRMADA' && d.br!.account_id === accountId)
    .sort((a, b) => a.number - b.number)

/** Movimientos conciliados por las conciliaciones confirmadas de una cuenta (hasta una, si se indica). */
export function reconciledLineIds(db: DB, accountId: string, upToNumber = Infinity) {
  const docs = new Set(
    confirmedReconciliations(db, accountId)
      .filter((d) => d.number <= upToNumber)
      .map((d) => d.id),
  )
  return new Set(db.brLines.filter((l) => docs.has(l.document_id)).map((l) => l.journal_line_id))
}

/** La última conciliación confirmada de una cuenta. */
export const lastReconciliation = (db: DB, accountId: string) => confirmedReconciliations(db, accountId).at(-1)

/**
 * Contabilidad concilia un banco: con el saldo del extracto y los movimientos
 * del mayor que figuran en él, el saldo según libros menos lo que el banco
 * todavía no acreditó, más lo que todavía no debitó, tiene que dar el del extracto.
 */
export function cmdCreateBankReconciliation(ctx: Ctx, companyId: string, input: BankReconciliationInput) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'bank_reconciliation.create')
  const account = db.accounts.find((a) => a.id === input.account_id && a.company_id === companyId)
  if (!account || !account.is_imputable || !account.code.startsWith(`${TREASURY_RUBRO}.`))
    fail('DATO_INVALIDO', 'Elegí el banco que se concilia (una cuenta de Caja y bancos).')
  if (!isIsoDate(input.statement_date)) fail('DATO_INVALIDO', 'Indicá la fecha del extracto.')
  if (input.statement_date > businessDate(getCompany(db, companyId)))
    fail('DATO_INVALIDO', 'La fecha del extracto no puede ser posterior a hoy.')
  const last = lastReconciliation(db, account.id)
  if (last && input.statement_date <= last.br!.statement_date)
    fail(
      'DATO_INVALIDO',
      `La fecha del extracto tiene que ser posterior a la de la última conciliación de la cuenta (${last.display_number}, al ${fmtDate(last.br!.statement_date)}).`,
    )
  if (!Number.isFinite(input.statement_balance) || round2(input.statement_balance) !== input.statement_balance)
    fail('DATO_INVALIDO', 'El saldo del extracto es un importe con hasta 2 decimales.')
  const lines = accountLinesUpTo(db, account.id, input.statement_date)
  const reconciled = reconciledLineIds(db, account.id)
  const open = lines.filter(({ line }) => !reconciled.has(line.id))
  const marked = new Set<string>()
  for (const id of input.journal_line_ids) {
    if (marked.has(id)) fail('DATO_INVALIDO', 'Un movimiento está dos veces en la conciliación.')
    if (!open.some(({ line }) => line.id === id))
      fail(
        'DATO_INVALIDO',
        'Uno de los movimientos marcados no es de esta cuenta, es posterior al extracto o ya está conciliado.',
      )
    marked.add(id)
  }
  const pending = open.filter(({ line }) => !marked.has(line.id))
  const book = round2(lines.reduce((s, { line }) => s + line.debit - line.credit, 0))
  const pendingDebits = round2(pending.reduce((s, { line }) => s + line.debit, 0))
  const pendingCredits = round2(pending.reduce((s, { line }) => s + line.credit, 0))
  const expected = round2(book - pendingDebits + pendingCredits)
  if (expected !== input.statement_balance)
    fail(
      'CONCILIACION_NO_CIERRA',
      `No cierra: según libros, sin lo pendiente, el extracto tendría que decir ${money(expected)} y dice ${money(input.statement_balance)} (diferencia de ${money(round2(input.statement_balance - expected))}).`,
      'Revisá qué movimientos figuran en el extracto. Si el banco registró algo que no está en los libros (comisiones, intereses), Contabilidad lo registra con un asiento y vuelve a conciliar.',
    )
  const doc = newDocument(ctx, companyId, 'BANK_RECONCILIATION', actor, {
    status: 'CONFIRMADA',
    notes: input.notes.trim(),
    br: {
      account_id: account.id,
      statement_date: input.statement_date,
      statement_balance: input.statement_balance,
      book_balance: book,
      pending_debits: pendingDebits,
      pending_credits: pendingCredits,
    },
  })
  lines
    .filter(({ line }) => marked.has(line.id))
    .forEach(({ line }, i) =>
      db.brLines.push({
        id: uid(),
        company_id: companyId,
        document_id: doc.id,
        line_no: i + 1,
        journal_line_id: line.id,
      }),
    )
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'bank_reconciliation',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'CONFIRMADA',
    summary: `Concilió ${accountLabel(account)} al ${fmtDate(input.statement_date)} con ${doc.display_number}: ${marked.size} movimiento${marked.size === 1 ? '' : 's'} en el extracto, saldo ${money(input.statement_balance)}`,
  })
  return { id: doc.id, display_number: doc.display_number }
}

/** Anular una conciliación deja sus movimientos pendientes otra vez: sólo la última de cada cuenta. */
export function cmdCancelBankReconciliation(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'BANK_RECONCILIATION')
  requirePermission(ctx, doc.company_id, 'bank_reconciliation.cancel')
  const last = lastReconciliation(db, doc.br!.account_id)
  if (doc.status === 'CONFIRMADA' && last && last.id !== doc.id)
    fail('TRANSICION_INVALIDA', `Sólo se anula la última conciliación de la cuenta (${last.display_number}).`)
  transition(ctx, doc, 'CANCEL', { comment: reason })
}

// ============================================================ Pedidos de venta (docs/FASE_4_VENTAS_Y_CLIENTES.md §2)

export interface SalesOrderInput {
  customer_id: string
  /** Depósito desde el que se entrega: ahí se controla y se reserva el stock. */
  warehouse_id: string
  delivery_date: string | null
  payment_terms_days: number
  customer_reference: string
  notes: string
  /** Precio unitario sin IVA: se propone el de venta del producto. */
  lines: { product_id: string; quantity: number; unit_price: number }[]
}

/** Pedidos en curso: lo que les falta entregar está reservado en su depósito. */
export const ACTIVE_SALES_STATUSES = ['PENDIENTE_APROBACION', 'CONFIRMADO', 'ENTREGADO_PARCIAL']

/** Pedidos que ya usan el crédito del cliente: los en curso y los terminados, mientras no se facturen (4b). */
const CREDIT_STATUSES = [...ACTIVE_SALES_STATUSES, 'ENTREGADO', 'CERRADO']

export const salesOrderLines = (db: DB, docId: string) =>
  db.soLines.filter((l) => l.document_id === docId).sort((a, b) => a.line_no - b.line_no)

export const deliveryNoteLines = (db: DB, docId: string) =>
  db.dnLines.filter((l) => l.document_id === docId).sort((a, b) => a.line_no - b.line_no)

/** Lo que hay de un producto en un depósito. */
export function onHandQuantity(db: DB, productId: string, warehouseId: string) {
  return db.stockBalances.find((b) => b.product_id === productId && b.warehouse_id === warehouseId)?.qty_on_hand ?? 0
}

/** Lo reservado de un producto en un depósito: lo que les falta entregar a los pedidos en curso (salvo uno). */
export function reservedQuantity(db: DB, productId: string, warehouseId: string, exceptDocId?: string) {
  const orders = new Set(
    db.documents
      .filter(
        (d) =>
          d.doc_type === 'SALES_ORDER' &&
          ACTIVE_SALES_STATUSES.includes(d.status) &&
          d.so!.warehouse_id === warehouseId &&
          d.id !== exceptDocId,
      )
      .map((d) => d.id),
  )
  return round3(
    db.soLines
      .filter((l) => l.product_id === productId && orders.has(l.document_id))
      .reduce((s, l) => s + Math.max(l.quantity - l.qty_delivered, 0), 0),
  )
}

/** Importe con IVA de una cantidad de un ítem, redondeado como las líneas: neto e IVA por separado. */
const amountWithVat = (quantity: number, unitPrice: number, vatRate: number) => {
  const net = round2(quantity * unitPrice)
  return round2(net + round2((net * vatRate) / 100))
}

/** Facturas de venta que generaron deuda: registradas, cobradas en parte o cobradas. */
export const INVOICED_SALES_STATUSES = ['REGISTRADA', 'COBRADA_PARCIAL', 'COBRADA']

/** Lo facturado de un ítem del pedido en facturas registradas (salvo una). */
export function salesInvoicedQuantity(db: DB, soLineId: string, exceptDocId?: string) {
  const docs = new Set(
    db.documents
      .filter(
        (d) => d.doc_type === 'SALES_INVOICE' && INVOICED_SALES_STATUSES.includes(d.status) && d.id !== exceptDocId,
      )
      .map((d) => d.id),
  )
  return round3(
    db.fvLines.filter((l) => l.so_line_id === soLineId && docs.has(l.document_id)).reduce((s, l) => s + l.quantity, 0),
  )
}

/** Lo que aplican a una factura de venta los recibos de cobro en esos estados (salvo uno). */
function appliedToSalesInvoice(db: DB, invoiceId: string, statuses: string[], exceptDocId?: string) {
  const receipts = new Set(
    db.documents
      .filter((d) => d.doc_type === 'CUSTOMER_RECEIPT' && statuses.includes(d.status) && d.id !== exceptDocId)
      .map((d) => d.id),
  )
  return round2(
    db.rcLines
      .filter((l) => l.invoice_id === invoiceId && receipts.has(l.document_id))
      .reduce((s, l) => s + l.amount, 0),
  )
}

/** Lo cobrado de una factura de venta: sus recibos de cobro confirmados. */
export const salesInvoiceCollected = (db: DB, invoiceId: string) => appliedToSalesInvoice(db, invoiceId, ['CONFIRMADO'])

/** Lo reservado de una factura de venta en recibos de cobro en borrador (salvo uno). */
export const salesInvoiceCommitted = (db: DB, invoiceId: string, exceptDocId?: string) =>
  appliedToSalesInvoice(db, invoiceId, ['BORRADOR'], exceptDocId)

/** Lo que falta cobrar de una factura de venta registrada: su total menos lo cobrado. */
export const salesInvoicePending = (db: DB, invoice: T.Document) =>
  round2(invoice.total - salesInvoiceCollected(db, invoice.id))

/** Facturas de venta registradas de un cliente, por número. */
function customerInvoices(db: DB, customerId: string) {
  return db.documents
    .filter(
      (d) =>
        d.doc_type === 'SALES_INVOICE' && d.customer_id === customerId && INVOICED_SALES_STATUSES.includes(d.status),
    )
    .sort((a, b) => a.number - b.number)
}

/**
 * Lo que un pedido usa del crédito del cliente, con IVA: lo pedido (si sigue en
 * curso) o lo entregado (si terminó), menos lo que ya se facturó (eso está en
 * la deuda del cliente).
 */
function creditUsedByOrder(db: DB, order: T.Document) {
  const finished = !ACTIVE_SALES_STATUSES.includes(order.status)
  return round2(
    salesOrderLines(db, order.id).reduce((s, l) => {
      const uninvoiced = Math.max(
        round3((finished ? l.qty_delivered : l.quantity) - salesInvoicedQuantity(db, l.id)),
        0,
      )
      return s + amountWithVat(uninvoiced, l.unit_price, l.vat_rate)
    }, 0),
  )
}

/** El crédito que usa un cliente: sus facturas sin cobrar y sus pedidos todavía sin facturar (salvo uno). */
export function customerCreditUsed(db: DB, customerId: string, exceptDocId?: string) {
  const orders = db.documents
    .filter(
      (d) =>
        d.doc_type === 'SALES_ORDER' &&
        d.customer_id === customerId &&
        CREDIT_STATUSES.includes(d.status) &&
        d.id !== exceptDocId,
    )
    .reduce((s, d) => s + creditUsedByOrder(db, d), 0)
  const invoices = customerInvoices(db, customerId).reduce((s, d) => s + salesInvoicePending(db, d), 0)
  return round2(orders + invoices)
}

/** Lo vencido y sin cobrar de un cliente: el cliente moroso. */
export function customerOverdue(db: DB, customerId: string, today: string) {
  return round2(
    customerInvoices(db, customerId)
      .filter((d) => d.fv!.due_date < today)
      .reduce((s, d) => s + salesInvoicePending(db, d), 0),
  )
}

/** Por qué el pedido necesita la autorización de Gerencia (cliente moroso o sin crédito); vacío si no. */
function creditReason(db: DB, doc: T.Document) {
  const customer = db.customers.find((c) => c.id === doc.customer_id)!
  const reasons: string[] = []
  const overdue = customerOverdue(db, customer.id, businessDate(getCompany(db, doc.company_id)))
  if (overdue > EPS) reasons.push(`${customer.legal_name} tiene facturas vencidas sin cobrar por ${money(overdue)}.`)
  if (customer.credit_limit != null) {
    const used = round2(customerCreditUsed(db, customer.id, doc.id) + doc.total)
    if (used > customer.credit_limit + EPS)
      reasons.push(
        `Supera el límite de crédito de ${customer.legal_name} (${money(customer.credit_limit)}): con este pedido llegaría a ${money(used)} entre lo que debe y lo pedido sin facturar.`,
      )
  }
  return reasons.join(' ')
}

function validateSalesOrder(ctx: Ctx, companyId: string, input: SalesOrderInput) {
  const { db } = ctx
  const company = getCompany(db, companyId)
  const customer = db.customers.find((c) => c.id === input.customer_id && c.company_id === companyId)
  if (!customer) fail('DATO_INVALIDO', 'Elegí el cliente.')
  if (!customer.is_active) fail('DATO_INVALIDO', `El cliente ${customer.legal_name} está inactivo.`)
  if (!db.warehouses.some((w) => w.id === input.warehouse_id && w.company_id === companyId))
    fail('DATO_INVALIDO', 'Elegí el depósito desde el que se entrega.')
  if (!Number.isInteger(input.payment_terms_days) || input.payment_terms_days < 0 || input.payment_terms_days > 365)
    fail('DATO_INVALIDO', 'La condición de pago es una cantidad entera de días, de 0 (contado) a 365.')
  if (input.delivery_date !== null) {
    if (!isIsoDate(input.delivery_date)) fail('DATO_INVALIDO', 'La fecha de entrega no es válida.')
    if (input.delivery_date < businessDate(company))
      fail('DATO_INVALIDO', 'La fecha de entrega pedida no puede ser anterior a hoy.')
  }
  if (input.customer_reference.trim().length > 60)
    fail('DATO_INVALIDO', 'La referencia del cliente tiene hasta 60 caracteres.')
  const seen = new Set<string>()
  const lines = input.lines
    .filter((l) => l.product_id)
    .map((l) => {
      const p = getProduct(db, companyId, l.product_id)
      if (!p.is_active) fail('DATO_INVALIDO', `${productLabel(p)} está inactivo.`)
      if (!SELLABLE_PRODUCT_TYPES.includes(p.product_type))
        fail(
          'DATO_INVALIDO',
          `${p.code} es ${PRODUCT_TYPES[p.product_type].toLowerCase()}: no se vende.`,
          'Se venden los productos terminados, las mercaderías de reventa y los servicios.',
        )
      if (seen.has(p.id)) fail('DATO_INVALIDO', `${p.code} está dos veces: sumá las cantidades en un solo ítem.`)
      seen.add(p.id)
      if (!Number.isFinite(l.quantity) || !(l.quantity > 0) || round3(l.quantity) !== l.quantity)
        fail('DATO_INVALIDO', `La cantidad de ${p.code} debe ser mayor que cero y tener hasta 3 decimales.`)
      if (!Number.isFinite(l.unit_price) || !(l.unit_price > 0) || round4(l.unit_price) !== l.unit_price)
        fail('DATO_INVALIDO', `El precio de ${p.code} debe ser mayor que cero y tener hasta 4 decimales.`)
      // Quien no es responsable inscripto no factura IVA: su precio es el final.
      const vatRate = company.vat_condition === 'RESPONSABLE_INSCRIPTO' ? p.vat_rate : 0
      if (!Number.isFinite(l.quantity * l.unit_price * (1 + vatRate / 100)))
        fail('DATO_INVALIDO', `El importe de ${p.code} es demasiado grande.`)
      return { product: p, quantity: l.quantity, unit_price: l.unit_price, vat_rate: vatRate }
    })
  if (!lines.length) fail('DATO_INVALIDO', 'Agregá al menos un ítem.')
  return { customer, lines }
}

export function cmdCreateSalesOrder(ctx: Ctx, companyId: string, input: SalesOrderInput, confirm: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'sales_order.create')
  const { customer, lines } = validateSalesOrder(ctx, companyId, input)
  const doc = newDocument(ctx, companyId, 'SALES_ORDER', actor, {
    customer_id: customer.id,
    notes: input.notes.trim(),
    so: {
      warehouse_id: input.warehouse_id,
      delivery_date: input.delivery_date,
      payment_terms_days: input.payment_terms_days,
      customer_reference: input.customer_reference.trim(),
      credit_reason: '',
      confirmed_at: null,
    },
  })
  lines.forEach((l, i) => {
    const subtotal = round2(l.quantity * l.unit_price)
    const tax = round2((subtotal * l.vat_rate) / 100)
    db.soLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      product_id: l.product.id,
      quantity: l.quantity,
      list_price: l.product.sale_price ?? 0,
      unit_price: l.unit_price,
      vat_rate: l.vat_rate,
      line_subtotal: subtotal,
      line_tax: tax,
      line_total: round2(subtotal + tax),
      qty_delivered: 0,
    })
  })
  const docLines = salesOrderLines(db, doc.id)
  doc.subtotal = round2(docLines.reduce((s, l) => s + l.line_subtotal, 0))
  doc.tax_total = round2(docLines.reduce((s, l) => s + l.line_tax, 0))
  doc.total = round2(doc.subtotal + doc.tax_total)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'sales_order',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number} a ${customer.legal_name} por ${money(doc.total)}`,
  })
  if (confirm) confirmSalesOrder(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

/**
 * Confirmar: controla el stock disponible de cada ítem (lo que hay menos lo
 * reservado para otros pedidos) y el crédito del cliente. Si alcanza el
 * crédito, queda confirmado; si no, espera la autorización de Gerencia. En los
 * dos casos lo que falta entregar queda reservado.
 */
function confirmSalesOrder(ctx: Ctx, doc: T.Document) {
  const { db } = ctx
  requireTransition(doc, 'CONFIRM')
  const company = getCompany(db, doc.company_id)
  const warehouse = db.warehouses.find((w) => w.id === doc.so!.warehouse_id)!
  if (!company.settings.allow_negative_stock) {
    for (const l of salesOrderLines(db, doc.id)) {
      const p = getProduct(db, doc.company_id, l.product_id)
      if (!p.is_stockable) continue
      const onHand = onHandQuantity(db, p.id, warehouse.id)
      const reserved = reservedQuantity(db, p.id, warehouse.id, doc.id)
      const available = round3(onHand - reserved)
      if (l.quantity > available + EPS)
        fail(
          'STOCK_INSUFICIENTE',
          `${p.code}: hay ${fmtQty(onHand, p.uom_code)} en ${warehouse.name}${reserved > 0 ? ` y ${fmtQty(reserved, p.uom_code)} están reservados para otros pedidos` : ''}; quedan ${fmtQty(Math.max(available, 0), p.uom_code)} disponibles y el pedido lleva ${fmtQty(l.quantity, p.uom_code)}.`,
          'Falta stock: pedí lo disponible y el resto en otro pedido cuando haya mercadería (la repone Compras o la fabrica Producción).',
        )
    }
  }
  const customer = db.customers.find((c) => c.id === doc.customer_id)!
  const reason = creditReason(db, doc)
  doc.so = { ...doc.so!, credit_reason: reason, confirmed_at: reason ? null : ctx.now }
  transition(ctx, doc, 'CONFIRM', {
    to: reason ? 'PENDIENTE_APROBACION' : 'CONFIRMADO',
    summary: reason
      ? `Confirmó ${doc.display_number} a ${customer.legal_name} por ${money(doc.total)}: supera el crédito del cliente y lo autoriza Gerencia`
      : `Confirmó ${doc.display_number} a ${customer.legal_name} por ${money(doc.total)} y reservó la mercadería`,
  })
}

export function cmdConfirmSalesOrder(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'SALES_ORDER')
  requirePermission(ctx, doc.company_id, 'sales_order.create')
  confirmSalesOrder(ctx, doc)
}

/** Gerencia autoriza o rechaza el crédito; quien cargó el pedido no decide sobre él (SoD-8). */
function decideSalesOrder(ctx: Ctx, docId: string, action: 'APPROVE' | 'REJECT', comment: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'SALES_ORDER')
  requireTransition(doc, action)
  const actor = requirePermission(ctx, doc.company_id, 'sales_order.approve')
  const eff = effectivePermissions(db, ctx.userId!, doc.company_id)
  if (!eff.supervisor && getCompany(db, doc.company_id).settings.sod_enabled && doc.created_by === ctx.userId)
    fail(
      'SEPARACION_FUNCIONES',
      'No podés autorizar ni rechazar el crédito de un pedido que cargaste vos.',
      'Separación de funciones: quien vende no autoriza su propia excepción de crédito.',
    )
  const text = comment.trim()
  if (action === 'APPROVE') doc.so = { ...doc.so!, confirmed_at: ctx.now }
  transition(ctx, doc, action, {
    actor,
    comment,
    summary:
      action === 'APPROVE'
        ? `Autorizó el crédito de ${doc.display_number} por ${money(doc.total)}${text ? ` — ${text}` : ''}`
        : undefined,
  })
  notifyUsers(
    ctx,
    doc.company_id,
    doc.created_by ? [doc.created_by] : [],
    {
      type: action === 'APPROVE' ? 'PEDIDO_AUTORIZADO' : 'PEDIDO_RECHAZADO',
      title: `${doc.display_number} ${action === 'APPROVE' ? 'fue autorizado' : 'fue rechazado'}`,
      body:
        action === 'APPROVE'
          ? `Gerencia autorizó el crédito: Depósito ya puede despacharlo.`
          : `Gerencia no autorizó el crédito: ${text}`,
      link_path: docPath(db, doc),
      document_id: doc.id,
    },
    ctx.userId,
  )
}

export function cmdApproveSalesOrder(ctx: Ctx, docId: string, comment: string) {
  decideSalesOrder(ctx, docId, 'APPROVE', comment)
}

export function cmdRejectSalesOrder(ctx: Ctx, docId: string, reason: string) {
  decideSalesOrder(ctx, docId, 'REJECT', reason)
}

/** Un remito en preparación de un pedido: hay que despacharlo o anularlo antes de anular o cerrar el pedido. */
function draftDeliveryOf(db: DB, orderId: string) {
  return db.documents
    .filter((d) => d.doc_type === 'DELIVERY_NOTE' && d.status === 'BORRADOR' && d.dn!.sales_order_id === orderId)
    .sort((a, b) => a.number - b.number)[0]
}

function assertNoDraftDelivery(db: DB, order: T.Document) {
  const draft = draftDeliveryOf(db, order.id)
  if (draft)
    fail(
      'TRANSICION_INVALIDA',
      `${draft.display_number} está en preparación para ${order.display_number}: Depósito tiene que despacharlo o anularlo primero.`,
    )
}

export function cmdCancelSalesOrder(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'SALES_ORDER')
  if (salesOrderLines(db, doc.id).some((l) => l.qty_delivered > EPS))
    fail('TRANSICION_INVALIDA', `${doc.display_number} tiene entregas: no se puede anular. Usá "Cerrar saldo".`)
  assertNoDraftDelivery(db, doc)
  transition(ctx, doc, 'CANCEL', { comment: reason })
}

export function cmdCloseSalesOrder(ctx: Ctx, docId: string, reason: string) {
  const doc = getDoc(ctx.db, docId, 'SALES_ORDER')
  assertNoDraftDelivery(ctx.db, doc)
  transition(ctx, doc, 'CLOSE', { comment: reason })
}

/** Estado del pedido según lo entregado: confirmado, entregado parcialmente o entregado. */
function recomputeSalesOrder(ctx: Ctx, orderId: string) {
  const doc = getDoc(ctx.db, orderId, 'SALES_ORDER')
  if (!['CONFIRMADO', 'ENTREGADO_PARCIAL', 'ENTREGADO'].includes(doc.status)) return
  const lines = salesOrderLines(ctx.db, doc.id)
  const full = lines.every((l) => l.qty_delivered >= l.quantity - EPS)
  const some = lines.some((l) => l.qty_delivered > EPS)
  const target = full ? 'ENTREGADO' : some ? 'ENTREGADO_PARCIAL' : 'CONFIRMADO'
  if (target !== doc.status) transition(ctx, doc, 'SYSTEM', { to: target })
}

// ============================================================ Remitos (docs/FASE_4_VENTAS_Y_CLIENTES.md §3)

export interface DeliveryNoteInput {
  sales_order_id: string
  carrier_name: string
  notes: string
  lines: { so_line_id: string; quantity: number; notes?: string }[]
}

export function cmdCreateDeliveryNote(ctx: Ctx, companyId: string, input: DeliveryNoteInput, confirm: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'delivery_note.create')
  const order = db.documents.find(
    (d) => d.id === input.sales_order_id && d.company_id === companyId && d.doc_type === 'SALES_ORDER',
  )
  if (!order) fail('DATO_INVALIDO', 'Elegí el pedido de venta que se despacha.')
  if (!['CONFIRMADO', 'ENTREGADO_PARCIAL'].includes(order.status))
    fail(
      'TRANSICION_INVALIDA',
      `${order.display_number} está "${statusLabel('SALES_ORDER', order.status)}": se despachan pedidos confirmados.`,
    )
  const carrier = input.carrier_name.trim()
  if (carrier.length > 80) fail('DATO_INVALIDO', 'El transportista tiene hasta 80 caracteres.')
  for (const line of input.lines) {
    if (!Number.isFinite(line.quantity) || line.quantity < 0 || round3(line.quantity) !== line.quantity)
      fail(
        'DATO_INVALIDO',
        'Las cantidades que salen deben ser números mayores o iguales que cero (hasta 3 decimales).',
      )
  }
  const lines = input.lines.filter((l) => l.quantity > 0)
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá qué sale de al menos un ítem.')
  const byLine = new Map<string, number>()
  for (const line of lines) {
    const sl = db.soLines.find((l) => l.id === line.so_line_id && l.document_id === order.id)
    if (!sl) fail('DATO_INVALIDO', 'Uno de los ítems no es del pedido de venta.')
    const p = getProduct(db, companyId, sl.product_id)
    const total = round3((byLine.get(sl.id) ?? 0) + line.quantity)
    byLine.set(sl.id, total)
    const pending = round3(sl.quantity - sl.qty_delivered)
    if (total > pending + EPS)
      fail(
        'CANTIDAD_EXCEDE_PENDIENTE',
        `${p.code}: salen ${fmtQty(total, p.uom_code)} pero sólo faltan entregar ${fmtQty(pending, p.uom_code)}.`,
        'No se entrega más de lo que pidió el cliente: si quiere más, Ventas carga otro pedido.',
      )
  }
  const customer = db.customers.find((c) => c.id === order.customer_id)!
  const doc = newDocument(ctx, companyId, 'DELIVERY_NOTE', actor, {
    customer_id: customer.id,
    notes: input.notes.trim(),
    dn: { sales_order_id: order.id, warehouse_id: order.so!.warehouse_id, carrier_name: carrier, dispatched_at: null },
  })
  let total = 0
  lines.forEach((l, i) => {
    const sl = db.soLines.find((x) => x.id === l.so_line_id)!
    total += round2(l.quantity * sl.unit_price)
    db.dnLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      so_line_id: sl.id,
      product_id: sl.product_id,
      quantity: l.quantity,
      unit_cost: 0,
      notes: (l.notes ?? '').trim(),
    })
  })
  // Valorizado a los precios del pedido (sin IVA).
  doc.subtotal = round2(total)
  doc.total = doc.subtotal
  link(ctx, companyId, order.id, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'delivery_note',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number} para ${order.display_number} de ${customer.legal_name}`,
  })
  if (confirm) dispatchDeliveryNote(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

/**
 * Despachar: la mercadería sale al costo promedio, el pedido suma lo entregado
 * (y libera esa reserva) y se registra el costo de lo vendido.
 */
function dispatchDeliveryNote(ctx: Ctx, doc: T.Document) {
  const { db } = ctx
  const order = getDoc(db, doc.dn!.sales_order_id, 'SALES_ORDER')
  if (!['CONFIRMADO', 'ENTREGADO_PARCIAL'].includes(order.status))
    fail(
      'TRANSICION_INVALIDA',
      `${order.display_number} ya no admite entregas (estado "${statusLabel('SALES_ORDER', order.status)}").`,
    )
  const customer = db.customers.find((c) => c.id === order.customer_id)!
  const actor = transition(ctx, doc, 'CONFIRM', {
    summary: `Despachó ${doc.display_number}: salió la mercadería de ${order.display_number} para ${customer.legal_name}`,
  })
  const costByType = new Map<T.ProductType, number>()
  for (const line of deliveryNoteLines(db, doc.id)) {
    const sl = db.soLines.find((x) => x.id === line.so_line_id)!
    const p = getProduct(db, doc.company_id, line.product_id)
    const pending = round3(sl.quantity - sl.qty_delivered)
    if (line.quantity > pending + EPS)
      fail(
        'CANTIDAD_EXCEDE_PENDIENTE',
        `${p.code}: la cantidad supera lo que falta entregar de ${order.display_number} (${fmtQty(pending, p.uom_code)}).`,
      )
    sl.qty_delivered = round3(sl.qty_delivered + line.quantity)
    if (!p.is_stockable) continue
    postMovement(ctx, {
      company_id: doc.company_id,
      product_id: p.id,
      warehouse_id: doc.dn!.warehouse_id,
      type: 'DESPACHO_VENTA',
      quantity: -line.quantity,
      document_id: doc.id,
      document_line_id: line.id,
      date: doc.document_date,
    })
    const movement = db.stockMovements[db.stockMovements.length - 1]
    line.unit_cost = movement.unit_cost
    costByType.set(p.product_type, round2((costByType.get(p.product_type) ?? 0) - movement.total_cost))
  }
  doc.dn = { ...doc.dn!, dispatched_at: ctx.now }
  recomputeSalesOrder(ctx, order.id)
  const types = (Object.keys(PRODUCT_TYPES) as T.ProductType[]).filter((t) => (costByType.get(t) ?? 0) > 0)
  if (types.length)
    postEvent(
      ctx,
      actor,
      doc,
      'COSTO_VENTA',
      `Costo de lo vendido según ${doc.display_number} (${order.display_number}, ${customer.legal_name}).`,
      [
        ...types.map((t) => ({ key: `COSTO_${t}`, debit: costByType.get(t)!, credit: 0 })),
        ...types.map((t) => ({ key: t, debit: 0, credit: costByType.get(t)! })),
      ],
    )
  const full = order.status === 'ENTREGADO'
  notifyRoles(
    ctx,
    doc.company_id,
    ['VENTAS'],
    {
      type: 'PEDIDO_DESPACHADO',
      title: `${order.display_number} ${full ? 'entregado' : 'entregado parcialmente'}`,
      body: `Depósito despachó ${doc.display_number} para ${customer.legal_name}.`,
      link_path: docPath(db, order),
      document_id: order.id,
    },
    actor.user_id,
  )
}

export function cmdConfirmDeliveryNote(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'DELIVERY_NOTE')
  requirePermission(ctx, doc.company_id, 'delivery_note.create')
  dispatchDeliveryNote(ctx, doc)
}

/**
 * El borrador se anula sin más. Uno despachado vuelve al depósito al costo con
 * que salió, con el contraasiento de su costo; no lo anula quien lo despachó
 * (SoD-3), salvo Gerencia.
 */
export function cmdCancelDeliveryNote(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'DELIVERY_NOTE')
  if (doc.status !== 'CONFIRMADO') {
    transition(ctx, doc, 'CANCEL', { comment: reason })
    return
  }
  const actor = requirePermission(ctx, doc.company_id, 'delivery_note.cancel')
  const comment = reason.trim()
  if (comment.length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  const company = getCompany(db, doc.company_id)
  const eff = effectivePermissions(db, ctx.userId!, doc.company_id)
  if (
    company.settings.sod_enabled &&
    !eff.supervisor &&
    !eff.roles.includes('GERENCIA') &&
    invoiceRegistrant(db, doc.id) === ctx.userId
  )
    fail(
      'SEPARACION_FUNCIONES',
      'No podés anular un remito que despachaste vos.',
      'Otro integrante de Depósito o Gerencia debe revisar y anular.',
    )
  const order = getDoc(db, doc.dn!.sales_order_id, 'SALES_ORDER')
  if (order.status === 'CERRADO')
    fail('TRANSICION_INVALIDA', `${order.display_number} está cerrado: el remito ya no puede anularse.`)
  // Lo facturado nunca queda por encima de lo entregado.
  for (const line of deliveryNoteLines(db, doc.id)) {
    const sl = db.soLines.find((x) => x.id === line.so_line_id)!
    const invoiced = salesInvoicedQuantity(db, sl.id)
    if (invoiced > round3(sl.qty_delivered - line.quantity) + EPS) {
      const p = getProduct(db, doc.company_id, line.product_id)
      fail(
        'TRANSICION_INVALIDA',
        `No se puede anular ${doc.display_number}: de ${p.code} ya se facturaron ${fmtQty(invoiced, p.uom_code)}. Primero hay que anular la factura de venta.`,
        'Lo facturado nunca puede superar lo entregado (control por oposición).',
      )
    }
  }
  const entry = automaticEntryOf(db, doc.id)
  const reversal = entry ? reverseEntry(ctx, entry, actor, `${doc.display_number} anulado: ${comment}`, true) : null
  transition(ctx, doc, 'CANCEL', {
    comment,
    actor,
    summary: `Anuló ${doc.display_number} con contramovimiento${reversal ? ` y el contraasiento ${reversal.display_number}` : ''} — ${comment}`,
  })
  for (const line of deliveryNoteLines(db, doc.id)) {
    const sl = db.soLines.find((x) => x.id === line.so_line_id)!
    sl.qty_delivered = round3(sl.qty_delivered - line.quantity)
    if (!getProduct(db, doc.company_id, line.product_id).is_stockable) continue
    postMovement(ctx, {
      company_id: doc.company_id,
      product_id: line.product_id,
      warehouse_id: doc.dn!.warehouse_id,
      type: 'ANULACION_DESPACHO',
      quantity: line.quantity,
      unit_cost: line.unit_cost,
      document_id: doc.id,
      document_line_id: line.id,
      date: businessDate(company),
    })
  }
  recomputeSalesOrder(ctx, order.id)
}

// ============================================================ Facturas de venta (docs/FASE_4_VENTAS_Y_CLIENTES.md §4)

export interface SalesInvoiceInput {
  sales_order_id: string
  notes: string
  /** Lo que se factura de cada ítem del pedido, a su precio. */
  lines: { so_line_id: string; quantity: number }[]
}

/** Punto de venta de los comprobantes simulados. */
export const SALES_POINT_OF_SALE = '00001'

/** Pedidos con algo entregado que se puede facturar. */
const INVOICEABLE_SALES_STATUSES = ['ENTREGADO_PARCIAL', 'ENTREGADO', 'CERRADO']

/**
 * Letra de la factura (a validar): la empresa responsable inscripta emite A a
 * responsables inscriptos y monotributistas (Ley 27.618) y B a exentos y
 * consumidores finales; si no es responsable inscripta, C.
 */
export function salesLetter(company: T.Company, customer: T.Customer): T.SalesInvoiceHeader['letter'] {
  if (company.vat_condition !== 'RESPONSABLE_INSCRIPTO') return 'C'
  return customer.vat_condition === 'RESPONSABLE_INSCRIPTO' || customer.vat_condition === 'MONOTRIBUTO' ? 'A' : 'B'
}

export const salesInvoiceLabel = (fv: T.SalesInvoiceHeader) =>
  `${fv.letter} ${fv.point_of_sale}-${fv.invoice_number || 'sin número'}`

export const salesInvoiceLines = (db: DB, docId: string) =>
  db.fvLines.filter((l) => l.document_id === docId).sort((a, b) => a.line_no - b.line_no)

/** Control por oposición: no se factura más de lo entregado menos lo ya facturado. */
function assertSalesInvoiceable(db: DB, sl: T.SalesOrderLine, quantity: number) {
  const invoiced = salesInvoicedQuantity(db, sl.id)
  const available = round3(sl.qty_delivered - invoiced)
  if (quantity > available + EPS) {
    const p = db.products.find((x) => x.id === sl.product_id)!
    fail(
      'CANTIDAD_EXCEDIDA',
      `${p.code}: se entregaron ${fmtQty(sl.qty_delivered, p.uom_code)} y ya se facturaron ${fmtQty(invoiced, p.uom_code)}; como mucho se pueden facturar ${fmtQty(Math.max(available, 0), p.uom_code)}.`,
      'Se factura lo que efectivamente salió: la factura se controla contra el pedido y los remitos.',
    )
  }
}

export function cmdCreateSalesInvoice(ctx: Ctx, companyId: string, input: SalesInvoiceInput, register: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'sales_invoice.create')
  const order = db.documents.find(
    (d) => d.id === input.sales_order_id && d.company_id === companyId && d.doc_type === 'SALES_ORDER',
  )
  if (!order) fail('DATO_INVALIDO', 'Elegí el pedido de venta que se factura.')
  if (!INVOICEABLE_SALES_STATUSES.includes(order.status))
    fail(
      'TRANSICION_INVALIDA',
      `${order.display_number} está "${statusLabel('SALES_ORDER', order.status)}": se factura lo entregado, y todavía no salió nada.`,
    )
  for (const line of input.lines) {
    if (!Number.isFinite(line.quantity) || line.quantity < 0 || round3(line.quantity) !== line.quantity)
      fail('DATO_INVALIDO', 'Las cantidades deben ser números mayores o iguales que cero (hasta 3 decimales).')
  }
  const lines = input.lines.filter((l) => l.quantity > 0)
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá qué se factura de al menos un ítem.')
  const byLine = new Map<string, number>()
  for (const line of lines) {
    const sl = db.soLines.find((l) => l.id === line.so_line_id && l.document_id === order.id)
    if (!sl) fail('DATO_INVALIDO', 'Uno de los ítems no es del pedido de venta.')
    const total = round3((byLine.get(sl.id) ?? 0) + line.quantity)
    byLine.set(sl.id, total)
    assertSalesInvoiceable(db, sl, total)
  }
  const company = getCompany(db, companyId)
  const customer = db.customers.find((c) => c.id === order.customer_id)!
  const fv: T.SalesInvoiceHeader = {
    sales_order_id: order.id,
    letter: salesLetter(company, customer),
    point_of_sale: SALES_POINT_OF_SALE,
    invoice_number: '',
    due_date: addDays(businessDate(company), order.so!.payment_terms_days),
    registered_at: null,
  }
  const doc = newDocument(ctx, companyId, 'SALES_INVOICE', actor, {
    customer_id: customer.id,
    notes: input.notes.trim(),
    fv,
  })
  lines.forEach((l, i) => {
    const sl = db.soLines.find((x) => x.id === l.so_line_id)!
    const subtotal = round2(l.quantity * sl.unit_price)
    const tax = round2((subtotal * sl.vat_rate) / 100)
    db.fvLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      so_line_id: sl.id,
      product_id: sl.product_id,
      quantity: l.quantity,
      unit_price: sl.unit_price,
      vat_rate: sl.vat_rate,
      line_subtotal: subtotal,
      line_tax: tax,
      line_total: round2(subtotal + tax),
    })
  })
  const docLines = salesInvoiceLines(db, doc.id)
  doc.subtotal = round2(docLines.reduce((s, l) => s + l.line_subtotal, 0))
  doc.tax_total = round2(docLines.reduce((s, l) => s + l.line_tax, 0))
  doc.total = round2(doc.subtotal + doc.tax_total)
  link(ctx, companyId, order.id, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'sales_invoice',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number}: factura ${fv.letter} a ${customer.legal_name} por ${money(doc.total)} contra ${order.display_number}`,
  })
  if (register) registerSalesInvoice(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

/**
 * Registrar: controla otra vez las cantidades, le asigna el número correlativo
 * de su letra y la fecha de hoy (vence según la condición del pedido), y
 * genera el asiento de venta y la deuda del cliente.
 */
function registerSalesInvoice(ctx: Ctx, doc: T.Document) {
  const { db } = ctx
  requireTransition(doc, 'CONFIRM')
  const lines = salesInvoiceLines(db, doc.id)
  const byLine = new Map<string, number>()
  for (const l of lines) {
    const total = round3((byLine.get(l.so_line_id) ?? 0) + l.quantity)
    byLine.set(l.so_line_id, total)
    assertSalesInvoiceable(
      db,
      db.soLines.find((x) => x.id === l.so_line_id)!,
      total,
    )
  }
  const company = getCompany(db, doc.company_id)
  const order = getDoc(db, doc.fv!.sales_order_id, 'SALES_ORDER')
  const customer = db.customers.find((c) => c.id === doc.customer_id)!
  const last = db.documents
    .filter(
      (d) =>
        d.company_id === doc.company_id &&
        d.doc_type === 'SALES_INVOICE' &&
        d.fv!.letter === doc.fv!.letter &&
        d.fv!.point_of_sale === doc.fv!.point_of_sale &&
        d.fv!.invoice_number,
    )
    .reduce((max, d) => Math.max(max, Number(d.fv!.invoice_number)), 0)
  const today = businessDate(company)
  doc.document_date = today
  doc.fv = {
    ...doc.fv!,
    invoice_number: String(last + 1).padStart(8, '0'),
    due_date: addDays(today, order.so!.payment_terms_days),
  }
  const label = salesInvoiceLabel(doc.fv)
  const actor = transition(ctx, doc, 'CONFIRM', {
    summary: `Registró ${doc.display_number}: factura ${label} a ${customer.legal_name} por ${money(doc.total)}`,
  })
  doc.fv = { ...doc.fv, registered_at: ctx.now }
  const byType = new Map<string, number>()
  for (const l of lines) {
    const type = db.products.find((p) => p.id === l.product_id)!.product_type
    byType.set(type, round2((byType.get(type) ?? 0) + l.line_subtotal))
  }
  postEvent(ctx, actor, doc, 'VENTA', `Venta según ${doc.display_number}: factura ${label} a ${customer.legal_name}.`, [
    { key: 'DEUDORES', debit: doc.total, credit: 0 },
    ...Object.keys(PRODUCT_TYPES)
      .filter((type) => byType.has(type))
      .map((type) => ({ key: type, debit: 0, credit: byType.get(type)! })),
    { key: 'IVA_DEBITO', debit: 0, credit: doc.tax_total },
  ])
}

export function cmdConfirmSalesInvoice(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'SALES_INVOICE')
  requirePermission(ctx, doc.company_id, 'sales_invoice.create')
  registerSalesInvoice(ctx, doc)
}

/**
 * El borrador se anula sin más. Una factura registrada y sin cobros se anula
 * con el contraasiento de su asiento de venta, y deja de figurar en la deuda
 * del cliente; su número no se vuelve a usar.
 */
export function cmdCancelSalesInvoice(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'SALES_INVOICE')
  if (doc.status !== 'REGISTRADA') {
    transition(ctx, doc, 'CANCEL', { comment: reason })
    return
  }
  const actor = requirePermission(ctx, doc.company_id, 'sales_invoice.cancel')
  const comment = reason.trim()
  if (comment.length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  const receipt = draftReceiptWith(db, doc.id)
  if (receipt)
    fail(
      'TRANSICION_INVALIDA',
      `${doc.display_number} está en el recibo de cobro ${receipt.display_number}: primero hay que anular ese recibo.`,
    )
  const entry = automaticEntryOf(db, doc.id)
  const reversal = entry ? reverseEntry(ctx, entry, actor, `${doc.display_number} anulada: ${comment}`, true) : null
  transition(ctx, doc, 'CANCEL', {
    comment,
    actor,
    summary: `Anuló ${doc.display_number}${reversal ? ` y su asiento con el contraasiento ${reversal.display_number}` : ''} — ${comment}`,
  })
}

// ============================================================ Recibos de cobro (docs/FASE_4_VENTAS_Y_CLIENTES.md §5)

export interface CustomerReceiptInput {
  customer_id: string
  /** Caja o banco donde ingresa el dinero (los cheques de terceros, a Valores a depositar). */
  treasury_account_id: string
  payment_method: T.PaymentMethod
  /** Número de la transferencia o del cheque del cliente. */
  reference: string
  notes: string
  lines: { invoice_id: string; amount: number }[]
}

/** Facturas de venta que todavía se pueden cobrar. */
const COLLECTIBLE_STATUSES = ['REGISTRADA', 'COBRADA_PARCIAL']

export const receiptLines = (db: DB, docId: string) =>
  db.rcLines.filter((l) => l.document_id === docId).sort((a, b) => a.line_no - b.line_no)

/** El primer recibo de cobro en borrador que incluye una factura de venta. */
function draftReceiptWith(db: DB, invoiceId: string) {
  const ids = new Set(db.rcLines.filter((l) => l.invoice_id === invoiceId).map((l) => l.document_id))
  return db.documents.filter((d) => ids.has(d.id) && d.status === 'BORRADOR').sort((a, b) => a.number - b.number)[0]
}

/** Caja o banco donde ingresa un cobro: una cuenta imputable y activa del rubro Caja y bancos. */
function receiptAccount(db: DB, companyId: string, accountId: string) {
  const account = db.accounts.find((a) => a.id === accountId && a.company_id === companyId)
  if (!account || !account.is_imputable || !account.code.startsWith(`${TREASURY_RUBRO}.`))
    fail('DATO_INVALIDO', 'Elegí la caja o el banco donde ingresa el cobro (una cuenta de Caja y bancos).')
  if (!account.is_active) fail('DATO_INVALIDO', `La cuenta ${accountLabel(account)} está desactivada.`)
  return account
}

/** Estado de una factura de venta según lo cobrado: registrada, cobrada parcialmente o cobrada. */
function recomputeSalesInvoice(ctx: Ctx, invoiceId: string) {
  const invoice = getDoc(ctx.db, invoiceId, 'SALES_INVOICE')
  if (!INVOICED_SALES_STATUSES.includes(invoice.status)) return
  const collected = salesInvoiceCollected(ctx.db, invoice.id)
  const target = collected >= invoice.total - EPS ? 'COBRADA' : collected > EPS ? 'COBRADA_PARCIAL' : 'REGISTRADA'
  if (target !== invoice.status) transition(ctx, invoice, 'SYSTEM', { to: target })
}

export function cmdCreateCustomerReceipt(ctx: Ctx, companyId: string, input: CustomerReceiptInput, confirm: boolean) {
  const { db } = ctx
  const actor = requirePermission(ctx, companyId, 'customer_receipt.create')
  const customer = db.customers.find((c) => c.id === input.customer_id && c.company_id === companyId)
  if (!customer) fail('DATO_INVALIDO', 'Elegí el cliente que paga.')
  const account = receiptAccount(db, companyId, input.treasury_account_id)
  if (!Object.hasOwn(PAYMENT_VIA, input.payment_method))
    fail('DATO_INVALIDO', 'Elegí el medio de cobro: transferencia, cheque o efectivo.')
  const reference = input.reference.trim()
  if (reference.length > 60) fail('DATO_INVALIDO', 'La referencia del cobro tiene hasta 60 caracteres.')
  if (input.payment_method === 'CHEQUE' && !/^\d{1,8}$/.test(reference))
    fail(
      'DATO_INVALIDO',
      'Indicá el número del cheque del cliente (hasta 8 números).',
      'Los cheques de terceros quedan en Valores a depositar hasta que se depositan en el banco.',
    )
  const seen = new Set<string>()
  const lines = input.lines
    .filter((l) => l.invoice_id && l.amount)
    .map((l) => {
      const invoice = db.documents.find(
        (d) => d.id === l.invoice_id && d.company_id === companyId && d.doc_type === 'SALES_INVOICE',
      )
      if (!invoice || invoice.customer_id !== customer.id)
        fail('DATO_INVALIDO', `Una de las facturas no es de ${customer.legal_name}.`)
      if (seen.has(invoice.id)) fail('DATO_INVALIDO', `${invoice.display_number} está dos veces en el recibo.`)
      seen.add(invoice.id)
      if (!COLLECTIBLE_STATUSES.includes(invoice.status))
        fail(
          'DATO_INVALIDO',
          `${invoice.display_number} está en estado "${statusLabel(invoice.doc_type, invoice.status)}": se cobran facturas registradas con saldo.`,
        )
      if (!Number.isFinite(l.amount) || !(l.amount > 0) || round2(l.amount) !== l.amount)
        fail('DATO_INVALIDO', 'Los importes deben ser mayores que cero y tener hasta 2 decimales.')
      const pending = salesInvoicePending(db, invoice)
      const committed = salesInvoiceCommitted(db, invoice.id)
      const available = round2(pending - committed)
      if (l.amount > available + EPS)
        fail(
          'IMPORTE_EXCEDIDO',
          `${invoice.display_number}: el saldo es ${money(pending)}${committed > 0 ? ` y ya hay ${money(committed)} en otros recibos en borrador` : ''}; como mucho se pueden cobrar ${money(Math.max(available, 0))}.`,
          'Una factura no se cobra dos veces: lo que está en un recibo en borrador queda reservado.',
        )
      return { invoice, amount: l.amount }
    })
  if (!lines.length) fail('DATO_INVALIDO', 'Indicá qué facturas se cobran y cuánto de cada una.')
  const doc = newDocument(ctx, companyId, 'CUSTOMER_RECEIPT', actor, {
    customer_id: customer.id,
    notes: input.notes.trim(),
    rc: { treasury_account_id: account.id, payment_method: input.payment_method, reference, received_on: null },
  })
  lines.forEach((l, i) => {
    db.rcLines.push({
      id: uid(),
      company_id: companyId,
      document_id: doc.id,
      line_no: i + 1,
      invoice_id: l.invoice.id,
      amount: l.amount,
    })
  })
  doc.subtotal = round2(lines.reduce((s, l) => s + l.amount, 0))
  doc.total = doc.subtotal
  for (const l of lines) link(ctx, companyId, l.invoice.id, doc.id)
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'CREATE',
    entity_type: 'customer_receipt',
    entity_id: doc.id,
    entity_label: doc.display_number,
    document_id: doc.id,
    to_status: 'BORRADOR',
    summary: `Creó ${doc.display_number}: cobro a ${customer.legal_name} por ${money(doc.total)} ${PAYMENT_VIA[input.payment_method].phrase} en ${accountLabel(account)}`,
  })
  if (confirm) confirmCustomerReceipt(ctx, doc)
  else openTasksForStatus(ctx, doc, actor)
  return { id: doc.id, display_number: doc.display_number }
}

/**
 * Confirma el cobro: controla de nuevo los saldos de las facturas, genera el
 * asiento (la caja o el banco al debe y Deudores por ventas al haber) y
 * actualiza el estado de cada factura. Quien emitió una factura no registra
 * su cobro (SoD-9).
 */
function confirmCustomerReceipt(ctx: Ctx, doc: T.Document) {
  const { db } = ctx
  requireTransition(doc, 'CONFIRM')
  const company = getCompany(db, doc.company_id)
  const eff = effectivePermissions(db, ctx.userId!, doc.company_id)
  const lines = receiptLines(db, doc.id)
  for (const l of lines) {
    const invoice = getDoc(db, l.invoice_id, 'SALES_INVOICE')
    if (company.settings.sod_enabled && !eff.supervisor && invoiceRegistrant(db, invoice.id) === ctx.userId)
      fail(
        'SEPARACION_FUNCIONES',
        `No podés cobrar ${invoice.display_number}: la emitiste vos.`,
        'Separación de funciones: quien emite una factura no registra su cobro. Tiene que cobrarla otro integrante de Tesorería.',
      )
  }
  for (const l of lines) {
    const invoice = getDoc(db, l.invoice_id, 'SALES_INVOICE')
    const pending = salesInvoicePending(db, invoice)
    if (!COLLECTIBLE_STATUSES.includes(invoice.status) || l.amount > pending + EPS)
      fail(
        'IMPORTE_EXCEDIDO',
        `${invoice.display_number}: el saldo pendiente es ${money(Math.max(pending, 0))} y el recibo cobra ${money(l.amount)}.`,
      )
  }
  const account = receiptAccount(db, doc.company_id, doc.rc!.treasury_account_id)
  const customer = db.customers.find((c) => c.id === doc.customer_id)!
  const via = PAYMENT_VIA[doc.rc!.payment_method]
  const number = doc.rc!.reference ? ` N.º ${doc.rc!.reference}` : ''
  const actor = transition(ctx, doc, 'CONFIRM', {
    summary: `Confirmó ${doc.display_number}: cobró ${money(doc.total)} a ${customer.legal_name} ${via.phrase}${number} en ${accountLabel(account)}`,
  })
  doc.rc = { ...doc.rc!, received_on: businessDate(company) }
  postEvent(
    ctx,
    actor,
    doc,
    'COBRO',
    `Cobro a ${customer.legal_name} según ${doc.display_number} (${via.noun}${number}).`,
    [
      { account_id: account.id, debit: doc.total, credit: 0 },
      { key: 'DEUDORES', debit: 0, credit: doc.total },
    ],
  )
  for (const l of lines) recomputeSalesInvoice(ctx, l.invoice_id)
}

export function cmdConfirmCustomerReceipt(ctx: Ctx, docId: string) {
  const doc = getDoc(ctx.db, docId, 'CUSTOMER_RECEIPT')
  requirePermission(ctx, doc.company_id, 'customer_receipt.create')
  confirmCustomerReceipt(ctx, doc)
}

/**
 * El borrador se anula sin más (lo que reservaba se libera). Un recibo cobrado
 * se anula con el contraasiento de su cobro, si el dinero todavía está en la
 * caja o el banco, y sus facturas vuelven a tener saldo.
 */
export function cmdCancelCustomerReceipt(ctx: Ctx, docId: string, reason: string) {
  const { db } = ctx
  const doc = getDoc(db, docId, 'CUSTOMER_RECEIPT')
  if (doc.status !== 'CONFIRMADO') {
    transition(ctx, doc, 'CANCEL', { comment: reason })
    return
  }
  const actor = requirePermission(ctx, doc.company_id, 'customer_receipt.cancel')
  const comment = reason.trim()
  if (comment.length < 3) fail('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.')
  const account = db.accounts.find((a) => a.id === doc.rc!.treasury_account_id)!
  const balance = accountBalance(db, account.id)
  if (doc.total > balance + EPS)
    fail(
      'SALDO_INSUFICIENTE',
      `No se puede anular: en ${accountLabel(account)} hay ${money(balance)} y el cobro fue por ${money(doc.total)}.`,
      'El dinero ya salió de esa cuenta (por ejemplo, se depositó en el banco): primero hay que anular ese movimiento.',
    )
  const entry = automaticEntryOf(db, doc.id)
  const reversal = entry ? reverseEntry(ctx, entry, actor, `${doc.display_number} anulado: ${comment}`, true) : null
  transition(ctx, doc, 'CANCEL', {
    comment,
    actor,
    summary: `Anuló ${doc.display_number}${reversal ? ` y su cobro con el contraasiento ${reversal.display_number}` : ''} — ${comment}`,
  })
  for (const l of receiptLines(db, doc.id)) recomputeSalesInvoice(ctx, l.invoice_id)
}

// ============================================================ Tareas y notificaciones

export function cmdClaimTask(ctx: Ctx, taskId: string, claim: boolean) {
  const profile = getProfile(ctx.db, ctx.userId)
  if (!profile?.is_active) fail('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
  const task = ctx.db.tasks.find((t) => t.id === taskId)
  if (!task || (!isInstanceAdmin(profile) && !getMember(ctx.db, profile.id, task.company_id)?.is_active))
    fail('DATO_INVALIDO', 'La tarea no existe.')
  const eff = effectivePermissions(ctx.db, profile.id, task.company_id)
  if (task.status !== 'PENDIENTE' && task.status !== 'EN_CURSO')
    fail('TRANSICION_INVALIDA', 'La tarea ya está resuelta.')
  if (claim) {
    const mine =
      task.assigned_user_id === profile.id || (!!task.assigned_role && eff.roles.includes(task.assigned_role))
    if (!mine && !eff.supervisor) fail('SIN_PERMISO', 'Esta tarea corresponde a otro usuario o sector.')
    if (task.claimed_by && task.claimed_by !== ctx.userId) {
      fail('TAREA_TOMADA', `La tarea ya la tomó ${fullName(getProfile(ctx.db, task.claimed_by))}.`)
    }
    task.claimed_by = ctx.userId
    task.claimed_at = ctx.now
    task.status = 'EN_CURSO'
  } else {
    if (task.claimed_by !== profile.id && !eff.supervisor)
      fail('SIN_PERMISO', 'Sólo quien tomó la tarea (o el docente) puede liberarla.')
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
  const profile = getProfile(db, userId)
  if (!profile?.is_active) fail('DATO_INVALIDO', 'Elegí un usuario activo.')
  if (!Object.hasOwn(ROLES, role)) fail('DATO_INVALIDO', 'Elegí un rol válido.')
  if (sectorId && !db.sectors.some((s) => s.id === sectorId && s.company_id === companyId))
    fail('DATO_INVALIDO', 'El sector no pertenece a esta empresa.')
  let member = getMember(db, userId, companyId)
  if (member && !member.is_active) fail('DATO_INVALIDO', 'El integrante está desactivado en esta empresa.')
  if (!member) {
    member = { id: uid(), company_id: companyId, user_id: userId, job_title: '', is_active: true }
    db.members.push(member)
  }
  if (db.memberRoles.some((r) => r.member_id === member.id && r.role_code === role && r.sector_id === sectorId)) {
    fail('DATO_INVALIDO', 'Esa asignación ya existe.')
  }
  db.memberRoles.push({ id: uid(), company_id: companyId, member_id: member.id, role_code: role, sector_id: sectorId })
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
  return insertStudent(ctx, companyId, actor, { ...input, username }).id
}

/** Sin 0/O ni 1/l/I: la contraseña inicial se lee de un papel impreso. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Contraseña inicial aleatoria de 8 caracteres (el estudiante la cambia al ingresar). */
export function initialPassword(): string {
  const chars: string[] = []
  const limit = 256 - (256 % PASSWORD_ALPHABET.length) // descarta bytes que sesgarían el reparto
  while (chars.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && chars.length < 8) chars.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length])
    }
  }
  return chars.join('')
}

export interface StudentCredential {
  user_id: string
  first_name: string
  last_name: string
  username: string
  password: string
}

/**
 * Alta masiva (H-21): el docente pega la lista del curso y el sistema genera
 * usuarios únicos y contraseñas iniciales para imprimir. Se valida todo
 * antes de crear a nadie, así un error no deja la mitad de la lista cargada.
 */
export function cmdCreateStudentsBulk(
  ctx: Ctx,
  companyId: string,
  rows: { first_name: string; last_name: string }[],
): StudentCredential[] {
  const actor = requireSupervisor(ctx, companyId)
  if (!rows.length) fail('DATO_INVALIDO', 'Pegá al menos un estudiante.')
  if (rows.length > MAX_BULK_STUDENTS)
    fail('DATO_INVALIDO', `Se pueden dar de alta hasta ${MAX_BULK_STUDENTS} estudiantes por vez.`)
  rows.forEach((r, i) => {
    if (r.first_name.trim().length < 2 || r.last_name.trim().length < 2)
      fail('DATO_INVALIDO', `Fila ${i + 1}: el apellido y el nombre deben tener al menos 2 letras.`)
  })
  const taken = new Set(ctx.db.profiles.map((p) => p.username))
  return rows.map((r) => {
    const username = uniqueUsername(baseUsername(r.first_name, r.last_name), taken)
    taken.add(username)
    const password = initialPassword()
    const profile = insertStudent(ctx, companyId, actor, { ...r, username, password })
    return { user_id: profile.id, first_name: profile.first_name, last_name: profile.last_name, username, password }
  })
}

function insertStudent(ctx: Ctx, companyId: string, actor: Actor, input: StudentInput): T.Profile {
  const { db } = ctx
  const username = input.username
  const profile: T.Profile = {
    id: uid(),
    username,
    password: input.password,
    first_name: input.first_name.trim(),
    last_name: input.last_name.trim(),
    app_role: 'ESTUDIANTE',
    is_active: true,
    // La contraseña inicial la conoce el docente (y a veces queda impresa
    // para toda la clase): el primer ingreso obliga a cambiarla por una que
    // sólo conozca el estudiante.
    must_change_password: true,
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
  return profile
}

/** Restablece la contraseña de un integrante de la empresa (H-25): la persona vuelve a elegir la suya al ingresar. */
export function cmdResetPassword(ctx: Ctx, companyId: string, userId: string, newPassword: string) {
  const actor = requireSupervisor(ctx, companyId)
  const { db } = ctx
  if (!getMember(db, userId, companyId)) fail('DATO_INVALIDO', 'El usuario no participa en esta empresa.')
  const profile = db.profiles.find((p) => p.id === userId)
  if (!profile) fail('DATO_INVALIDO', 'El usuario no existe.')
  // Un docente no puede tomar la cuenta de otro docente (ni de soporte) por compartir una empresa.
  if (profile.app_role !== 'ESTUDIANTE')
    fail('SIN_PERMISO', 'Sólo se puede restablecer la contraseña de un estudiante.')
  if (newPassword.length < 6) fail('DATO_INVALIDO', 'La contraseña debe tener al menos 6 caracteres.')
  profile.password = newPassword
  profile.must_change_password = true
  logAudit(ctx, {
    company_id: companyId,
    actor,
    action: 'RESET_PASSWORD',
    entity_type: 'profile',
    entity_id: profile.id,
    entity_label: fullName(profile),
    summary: `Restableció la contraseña de ${fullName(profile)}`,
  })
}

export interface ChangePasswordInput {
  current_password: string
  new_password: string
}

/** Cambio de contraseña por el propio usuario: no depende de ninguna empresa. */
export function cmdChangePassword(ctx: Ctx, input: ChangePasswordInput) {
  if (!ctx.userId) fail('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
  const profile = getProfile(ctx.db, ctx.userId)
  if (!profile) fail('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
  if (profile.password !== input.current_password) fail('DATO_INVALIDO', 'La contraseña actual no coincide.')
  if (input.new_password.length < 6) fail('DATO_INVALIDO', 'La contraseña nueva debe tener al menos 6 caracteres.')
  if (input.new_password === input.current_password)
    fail('DATO_INVALIDO', 'Elegí una contraseña distinta de la actual.')
  profile.password = input.new_password
  profile.must_change_password = false
  logAudit(ctx, {
    company_id: null,
    actor: {
      user_id: profile.id,
      name: fullName(profile),
      role_code: profile.app_role,
      sector_id: null,
      sector_name: '—',
    },
    action: 'CHANGE_PASSWORD',
    entity_type: 'profile',
    entity_id: profile.id,
    entity_label: fullName(profile),
    summary: 'Cambió su contraseña',
  })
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

// ============================================================ Administración de la escuela

/**
 * ADMIN es la administración de la escuela (altas de docentes y cursos, a
 * nivel institución): no pertenece a ninguna empresa. SUPERADMIN (el
 * proveedor) puede hacer lo mismo. Ver isInstanceAdmin() más arriba: ese
 * bypass es para operar *dentro* de una empresa; éste es un permiso aparte,
 * a nivel escuela.
 */
export function isSchoolAdmin(p: T.Profile | undefined): boolean {
  return p?.app_role === 'ADMIN' || p?.app_role === 'SUPERADMIN'
}

function requireSchoolAdmin(ctx: Ctx): Actor {
  const profile = getProfile(ctx.db, ctx.userId)
  if (!isSchoolAdmin(profile)) fail('SIN_PERMISO', 'Sólo la administración de la escuela puede hacer esto.')
  return {
    user_id: ctx.userId,
    name: fullName(profile),
    role_code: profile!.app_role,
    sector_id: null,
    sector_name: '—',
  }
}

/** El reinicio reconstruye toda la instancia local, por eso exige administración escolar. */
export function authorizeDemoReset(ctx: Ctx) {
  const profile = getProfile(ctx.db, ctx.userId)
  if (!profile?.is_active) fail('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
  requireSchoolAdmin(ctx)
}

export interface TeacherInput {
  first_name: string
  last_name: string
  username: string
  password: string
}

/** Da de alta la identidad de un docente (H-26). Asignarlo a una empresa/curso es un paso aparte. */
export function cmdCreateTeacher(ctx: Ctx, input: TeacherInput) {
  const actor = requireSchoolAdmin(ctx)
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
    app_role: 'DOCENTE',
    is_active: true,
    must_change_password: true,
    created_at: ctx.now,
  }
  db.profiles.push(profile)
  logAudit(ctx, {
    company_id: null,
    actor,
    action: 'CREATE',
    entity_type: 'profile',
    entity_id: profile.id,
    entity_label: fullName(profile),
    summary: `Dio de alta al docente ${fullName(profile)} (${username})`,
  })
  return profile.id
}

export interface CourseInput {
  academic_year: number
  name: string
  orientation: string
}

/** Da de alta un curso del año lectivo (H-26). No crea la empresa simulada: eso es un paso aparte (H-20). */
export function cmdCreateCourse(ctx: Ctx, input: CourseInput) {
  const actor = requireSchoolAdmin(ctx)
  const { db } = ctx
  const name = input.name.trim()
  if (!name) fail('DATO_INVALIDO', 'Ingresá el nombre del curso (por ejemplo, "5.º A").')
  if (!Number.isInteger(input.academic_year) || input.academic_year < 2020 || input.academic_year > 2100)
    fail('DATO_INVALIDO', 'Indicá un año lectivo válido.')
  if (db.courses.some((c) => c.academic_year === input.academic_year && c.name.toLowerCase() === name.toLowerCase()))
    fail('DATO_INVALIDO', `Ya existe un curso "${name}" en ${input.academic_year}.`)
  const course: T.Course = {
    id: uid(),
    academic_year: input.academic_year,
    name,
    orientation: input.orientation.trim(),
  }
  db.courses.push(course)
  logAudit(ctx, {
    company_id: null,
    actor,
    action: 'CREATE',
    entity_type: 'course',
    entity_id: course.id,
    entity_label: `${course.name} (${course.academic_year})`,
    summary: `Dio de alta el curso ${course.name} (${course.academic_year})`,
  })
  return course.id
}

export interface SchoolSettingsInput {
  official_name: string
  short_name: string
  city: string
  province: string
  contact_email: string
  session_timeout_minutes: number
  logo_path?: string | null
}

/**
 * Datos de la escuela dueña de la instancia (school_settings, una sola fila):
 * los edita la administración escolar, nunca se escriben en el código
 * (CA-15). Incluye la política de cierre de sesión por inactividad.
 */
export function cmdUpdateSchoolSettings(ctx: Ctx, input: SchoolSettingsInput) {
  const actor = requireSchoolAdmin(ctx)
  const official = input.official_name.trim()
  const short = input.short_name.trim()
  const email = input.contact_email.trim()
  const minutes = input.session_timeout_minutes
  const logo = input.logo_path?.trim() ?? null
  if (official.length < 3) fail('DATO_INVALIDO', 'Ingresá el nombre oficial de la escuela.')
  if (short.length < 2 || short.length > 30)
    fail('DATO_INVALIDO', 'El nombre corto debe tener entre 2 y 30 caracteres (por ejemplo, "ENS N.º 9").')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('DATO_INVALIDO', 'El email de contacto no es válido.')
  if (!Number.isInteger(minutes) || (minutes !== 0 && (minutes < 5 || minutes > 240)))
    fail('DATO_INVALIDO', 'El cierre por inactividad va de 5 a 240 minutos (o 0 para no cerrar la sesión).')
  const before = { ...ctx.db.school }
  ctx.db.school = {
    ...ctx.db.school,
    official_name: official,
    short_name: short,
    city: input.city.trim(),
    province: input.province.trim(),
    contact_email: email,
    session_timeout_minutes: minutes,
    logo_path: logo,
  }
  const changes = diff(before, ctx.db.school, [
    'official_name',
    'short_name',
    'city',
    'province',
    'contact_email',
    'session_timeout_minutes',
    'logo_path',
  ])
  if (!Object.keys(changes).length) return
  logAudit(ctx, {
    company_id: null,
    actor,
    action: 'SETTINGS',
    entity_type: 'school_settings',
    entity_id: null,
    entity_label: official,
    summary: 'Cambió los datos de la escuela',
    changes,
  })
}

// ============================================================ Empresas

const slugify = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function uniqueSlug(db: DB, base: string) {
  const taken = new Set(db.companies.map((c) => c.slug))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/**
 * Crea la empresa de un curso a partir de la plantilla (H-20, DATABASE.md §12).
 * Copia la estructura (islas, sectores, depósitos, reglas de aprobación,
 * módulos y control interno), los maestros (proveedores, clientes,
 * productos) y el plan de cuentas; no copia personas ni operaciones, así que
 * la numeración de documentos empieza en 1. Vuelve a cargar el inventario
 * inicial con su documento (y sus alertas de stock mínimo), abre el ejercicio
 * con su asiento de apertura y deja como supervisor al docente que la crea.
 */
export function cmdCreateCompanyFromTemplate(ctx: Ctx, input: { course_id: string }): { id: string; slug: string } {
  const { db } = ctx
  const profile = getProfile(db, ctx.userId)
  if (!profile || (profile.app_role !== 'DOCENTE' && profile.app_role !== 'SUPERADMIN'))
    fail('SIN_PERMISO', 'Sólo un docente puede crear la empresa simulada de su curso.')
  const template = db.companies.find((c) => c.is_template && c.status === 'ACTIVA')
  if (!template) fail('DATO_INVALIDO', 'No hay una empresa plantilla disponible.')
  const course = db.courses.find((c) => c.id === input.course_id)
  if (!course) fail('DATO_INVALIDO', 'Elegí el curso para el que se crea la empresa.')

  const companyId = uid()
  const slug = uniqueSlug(db, slugify(`${template.trade_name} ${course.name} ${course.academic_year}`))
  db.companies.push({
    ...template,
    id: companyId,
    course_id: course.id,
    slug,
    is_template: false,
    status: 'ACTIVA',
    settings: { ...template.settings },
    created_at: ctx.now,
  })
  const audited = { created_at: ctx.now, created_by: ctx.userId, updated_at: ctx.now, updated_by: ctx.userId }
  const of = <R extends { company_id: string }>(rows: R[]) => rows.filter((r) => r.company_id === template.id)
  /** Copia filas de la plantilla con id nuevo y devuelve la correspondencia id viejo → id nuevo. */
  const copy = <R extends { id: string; company_id: string }>(
    rows: R[],
    patch: (row: R) => Partial<R> = () => ({}),
  ) => {
    const ids = new Map<string, string>()
    for (const row of of(rows)) {
      const id = uid()
      ids.set(row.id, id)
      rows.push({ ...row, ...patch(row), id, company_id: companyId })
    }
    return ids
  }

  const islandIds = copy(db.islands)
  copy(db.sectors, (s) => ({ island_id: s.island_id ? (islandIds.get(s.island_id) ?? null) : null }))
  const warehouseIds = copy(db.warehouses)
  copy(db.approvalRules)
  for (const m of of(db.companyModules)) db.companyModules.push({ ...m, company_id: companyId })
  const supplierIds = copy(db.suppliers, () => audited)
  copy(db.customers, () => audited)
  const productIds = copy(db.products, (p) => ({
    ...audited,
    default_supplier_id: p.default_supplier_id ? (supplierIds.get(p.default_supplier_id) ?? null) : null,
    default_warehouse_id: p.default_warehouse_id ? (warehouseIds.get(p.default_warehouse_id) ?? null) : null,
  }))
  const accountIds = copy(db.accounts, () => audited)
  copy(db.postingRules, (r) => ({ account_id: accountIds.get(r.account_id)! }))

  const member: T.Member = {
    id: uid(),
    company_id: companyId,
    user_id: profile.id,
    job_title: 'Docente a cargo',
    is_active: true,
  }
  db.members.push(member)
  db.memberRoles.push({ id: uid(), company_id: companyId, member_id: member.id, role_code: 'DOCENTE', sector_id: null })
  logAudit(ctx, {
    company_id: companyId,
    actor: actorFor(ctx, companyId),
    action: 'CREATE',
    entity_type: 'company',
    entity_id: companyId,
    entity_label: template.legal_name,
    summary: `Creó la empresa para ${course.name} ${course.academic_year} a partir de la plantilla ${template.legal_name}`,
  })

  // Inventario inicial: los mismos ajustes de "Inventario inicial" que tuvo la plantilla.
  const system: Ctx = { ...ctx, userId: null }
  for (const adj of of(db.documents).filter(
    (d) => d.doc_type === 'STOCK_ADJUSTMENT' && d.status === 'CONFIRMADO' && d.sa?.reason_code === 'INVENTARIO_INICIAL',
  )) {
    const lines = db.saLines.filter((l) => l.document_id === adj.id && l.quantity_delta > 0)
    if (!lines.length) continue
    cmdCreateStockAdjustment(
      system,
      companyId,
      {
        warehouse_id: warehouseIds.get(adj.sa!.warehouse_id)!,
        reason_code: 'INVENTARIO_INICIAL',
        notes: 'Carga del inventario inicial de la empresa.',
        lines: lines.map((l) => ({
          product_id: productIds.get(l.product_id)!,
          quantity_delta: l.quantity_delta,
          unit_cost: l.unit_cost,
        })),
      },
      true,
    )
  }
  scanStockAlerts(system, companyId)
  startAccounting(system, companyId)
  return { id: companyId, slug }
}

/**
 * Sube el logo de la escuela a Storage y actualiza school_settings.logo_path.
 * En el simulador no hay Storage real, así que se usa un data URL como placeholder.
 * Con Supabase, la implementación real sube a storage.buckets['school-logos'].
 */
export function cmdUploadSchoolLogo(
  ctx: Ctx,
  file: { name: string; type: string; data: string },
): { logo_path: string } {
  const actor = requireSchoolAdmin(ctx)
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
  if (!allowed.includes(file.type)) fail('DATO_INVALIDO', 'El logo debe ser PNG, JPEG, WebP o SVG.')
  if (file.data.length > 5_000_000) fail('DATO_INVALIDO', 'El archivo es demasiado grande (máx. 5 MB).')
  // En el simulador guardamos el data URL como logo_path (no hay Storage real)
  const logoPath = `data:${file.type};base64,${file.data}`
  const before = { ...ctx.db.school }
  ctx.db.school = {
    ...ctx.db.school,
    logo_path: logoPath,
    updated_at: ctx.now,
    updated_by: ctx.userId,
  } as T.SchoolSettings
  logAudit(ctx, {
    company_id: null,
    actor,
    action: 'UPLOAD_LOGO',
    entity_type: 'school_settings',
    entity_id: null,
    entity_label: ctx.db.school.official_name,
    summary: `Subió el logo de la escuela (${file.name})`,
    changes: { logo_path: { from: before.logo_path, to: logoPath } },
  })
  return { logo_path: logoPath }
}
