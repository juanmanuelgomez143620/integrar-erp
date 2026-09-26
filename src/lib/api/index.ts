// Capa de acceso a datos de la interfaz.
//
// HOY: usa el backend simulado del navegador (src/lib/mock).
// CON SUPABASE: cada `query` pasará a ser una consulta con RLS y cada
// `command` una llamada `supabase.rpc(...)` con el mismo nombre y forma de
// datos. La interfaz no cambia.

import type * as T from '../domain/types'
import { onDatabaseChange, read, resetDatabase, transact, type DB } from '../mock/db'
import * as E from '../mock/engine'
import * as Q from '../mock/queries'
import { DEMO_PASSWORD } from '../mock/seed'

export { BusinessError } from '../mock/engine'
export type {
  AvailableAction,
  CompanyContext,
  Dashboard,
  DetailLine,
  DocumentDetail,
  DocumentListItem,
  FlowNode,
  MeContext,
  MemberView,
  PendingRequisitionLine,
  ProductDetail,
  ProductRow,
  ReceivableOrder,
  StockRow,
  TaskItem,
} from '../mock/queries'
export type { GoodsReceiptInput, PurchaseOrderInput, RequisitionInput, StockAdjustmentInput, StudentInput, MasterKind } from '../mock/engine'

const SESSION_KEY = 'integrar-erp.session'

export function currentUserId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function requireUser() {
  const id = currentUserId()
  if (!id) throw new E.BusinessError('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
  return id
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function query<R>(fn: (db: DB, userId: string) => R): Promise<R> {
  await wait(40)
  const userId = requireUser()
  return read((db) => fn(db, userId))
}

async function command<R>(fn: (ctx: E.Ctx) => R): Promise<R> {
  await wait(150)
  const userId = requireUser()
  return transact((db) => fn({ db, userId, now: new Date().toISOString() }))
}

// ------------------------------------------------------------ Autenticación

export const auth = {
  async login(username: string, password: string) {
    await wait(250)
    const name = username.trim().toLowerCase()
    const profile = read((db) => db.profiles.find((p) => p.username === name))
    if (!profile || profile.password !== password) throw new E.BusinessError('CREDENCIALES', 'Usuario o contraseña incorrectos.')
    if (!profile.is_active) throw new E.BusinessError('USUARIO_INACTIVO', 'Tu usuario está desactivado. Consultá a tu docente.')
    sessionStorage.setItem(SESSION_KEY, profile.id)
    return profile.id
  },
  /** Acceso rápido de demostración (sólo backend simulado). */
  loginAs(username: string) {
    return auth.login(username, DEMO_PASSWORD)
  },
  logout() {
    sessionStorage.removeItem(SESSION_KEY)
  },
  demoUsers() {
    return read(Q.demoUsers)
  },
}

// ------------------------------------------------------------ Consultas

export const api = {
  me: () => query(Q.meContext),
  companyContext: (slug: string) => query((db, u) => Q.companyContext(db, u, slug)),
  customers: (companyId: string) => query((db, u) => Q.listCustomers(db, u, companyId)),
  suppliers: (companyId: string) => query((db, u) => Q.listSuppliers(db, u, companyId)),
  products: (companyId: string) => query((db, u) => Q.listProducts(db, u, companyId)),
  product: (companyId: string, code: string) => query((db, u) => Q.productDetail(db, u, companyId, code)),
  stock: (companyId: string) => query((db, u) => Q.listStock(db, u, companyId)),
  documents: (companyId: string, docType: T.DocType) => query((db, u) => Q.listDocuments(db, u, companyId, docType)),
  document: (companyId: string, docType: T.DocType, number: string) => query((db, u) => Q.documentDetail(db, u, companyId, docType, number)),
  documentById: (docId: string) => query((db, u) => Q.documentDetailById(db, u, docId)),
  pendingRequisitionLines: (companyId: string) => query((db, u) => Q.pendingRequisitionLines(db, u, companyId)),
  receivableOrders: (companyId: string) => query((db, u) => Q.receivableOrders(db, u, companyId)),
  tasks: (companyId: string, scope: 'mine' | 'all', includeClosed = false) => query((db, u) => Q.listTasks(db, u, companyId, scope, includeClosed)),
  notifications: (companyId: string) => query((db, u) => Q.listNotifications(db, u, companyId)),
  audit: (companyId: string) => query((db, u) => Q.listAudit(db, u, companyId)),
  dashboard: (companyId: string) => query((db, u) => Q.dashboard(db, u, companyId)),
  members: (companyId: string) => query((db, u) => Q.listMembers(db, u, companyId)),
  users: () => query((db) => db.profiles.map(({ password: _p, ...rest }) => rest)),
}

// ------------------------------------------------------------ Comandos (futuras RPC)

export const commands = {
  createRequisition: (companyId: string, input: E.RequisitionInput, submit: boolean) => command((c) => E.cmdCreateRequisition(c, companyId, input, submit)),
  updateRequisition: (docId: string, input: E.RequisitionInput) => command((c) => E.cmdUpdateRequisition(c, docId, input)),
  submitRequisition: (docId: string) => command((c) => E.cmdSubmitRequisition(c, docId)),
  rejectRequisition: (docId: string, reason: string) => command((c) => E.cmdRejectRequisition(c, docId, reason)),
  cancelRequisition: (docId: string, reason: string) => command((c) => E.cmdCancelRequisition(c, docId, reason)),
  closeRequisition: (docId: string, reason: string) => command((c) => E.cmdCloseRequisition(c, docId, reason)),

  createPurchaseOrder: (companyId: string, input: E.PurchaseOrderInput) => command((c) => E.cmdCreatePurchaseOrder(c, companyId, input)),
  updatePurchaseOrder: (docId: string, input: E.PurchaseOrderInput) => command((c) => E.cmdUpdatePurchaseOrder(c, docId, input)),
  submitPurchaseOrder: (docId: string) => command((c) => E.cmdSubmitPurchaseOrder(c, docId)),
  approvePurchaseOrder: (docId: string, comment: string) => command((c) => E.cmdApprovePurchaseOrder(c, docId, comment)),
  rejectPurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdRejectPurchaseOrder(c, docId, reason)),
  withdrawPurchaseOrder: (docId: string) => command((c) => E.cmdWithdrawPurchaseOrder(c, docId)),
  reopenPurchaseOrder: (docId: string) => command((c) => E.cmdReopenPurchaseOrder(c, docId)),
  sendPurchaseOrder: (docId: string) => command((c) => E.cmdSendPurchaseOrder(c, docId)),
  cancelPurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdCancelPurchaseOrder(c, docId, reason)),
  closePurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdClosePurchaseOrder(c, docId, reason)),

  createGoodsReceipt: (companyId: string, input: E.GoodsReceiptInput, confirm: boolean) => command((c) => E.cmdCreateGoodsReceipt(c, companyId, input, confirm)),
  confirmGoodsReceipt: (docId: string) => command((c) => E.cmdConfirmGoodsReceipt(c, docId)),
  cancelGoodsReceipt: (docId: string, reason: string) => command((c) => E.cmdCancelGoodsReceipt(c, docId, reason)),

  createStockAdjustment: (companyId: string, input: E.StockAdjustmentInput, confirm: boolean) => command((c) => E.cmdCreateStockAdjustment(c, companyId, input, confirm)),
  confirmStockAdjustment: (docId: string) => command((c) => E.cmdConfirmStockAdjustment(c, docId)),
  cancelStockAdjustment: (docId: string, reason: string) => command((c) => E.cmdCancelStockAdjustment(c, docId, reason)),

  saveMaster: (kind: E.MasterKind, companyId: string, input: Record<string, unknown> & { id?: string }) => command((c) => E.cmdSaveMaster(c, kind, companyId, input)),
  setMasterActive: (kind: E.MasterKind, companyId: string, id: string, active: boolean) => command((c) => E.cmdSetMasterActive(c, kind, companyId, id, active)),

  claimTask: (taskId: string, claim: boolean) => command((c) => E.cmdClaimTask(c, taskId, claim)),
  markNotificationsRead: (companyId: string, ids: string[] | 'all') => command((c) => E.cmdMarkNotificationsRead(c, ids, companyId)),

  assignRole: (companyId: string, userId: string, role: T.RoleCode, sectorId: string | null) => command((c) => E.cmdAssignRole(c, companyId, userId, role, sectorId)),
  removeRole: (companyId: string, memberRoleId: string) => command((c) => E.cmdRemoveRole(c, companyId, memberRoleId)),
  createStudent: (companyId: string, input: E.StudentInput) => command((c) => E.cmdCreateStudent(c, companyId, input)),
  setModule: (companyId: string, module: T.ModuleCode, enabled: boolean) => command((c) => E.cmdSetModule(c, companyId, module, enabled)),
  updateCompanySettings: (companyId: string, settings: Partial<T.CompanySettings>) => command((c) => E.cmdUpdateCompanySettings(c, companyId, settings)),

  async resetDemoData() {
    await wait(300)
    resetDatabase()
  },
}

/** Suscripción a cambios (hoy: otras pestañas; con Supabase: Realtime). */
export const realtime = { subscribe: onDatabaseChange }
