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
export type {
  ChangePasswordInput,
  CourseInput,
  GoodsReceiptInput,
  PurchaseOrderInput,
  RequisitionInput,
  SchoolSettingsInput,
  StockAdjustmentInput,
  StudentCredential,
  StudentInput,
  TeacherInput,
  MasterKind,
} from '../mock/engine'

const SESSION_KEY = 'integrar-erp.session'

export function currentUserId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

/**
 * Exige una sesión con un perfil activo *en este momento*, no sólo al
 * momento de iniciar sesión: si el docente desactiva a un estudiante, la
 * pestaña que ya tenía abierta deja de poder leer o escribir en el próximo
 * pedido, no recién cuando vuelva a ingresar.
 */
function requireActiveUser(db: DB): string {
  const id = currentUserId()
  if (!id) throw new E.BusinessError('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
  const profile = db.profiles.find((p) => p.id === id)
  if (!profile || !profile.is_active) {
    sessionStorage.removeItem(SESSION_KEY)
    throw new E.BusinessError('USUARIO_INACTIVO', 'Tu usuario está desactivado. Consultá a tu docente.')
  }
  return id
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function query<R>(fn: (db: DB, userId: string) => R): Promise<R> {
  await wait(40)
  return read((db) => fn(db, requireActiveUser(db)))
}

async function command<R>(fn: (ctx: E.Ctx) => R): Promise<R> {
  await wait(150)
  return transact((db) => fn({ db, userId: requireActiveUser(db), now: new Date().toISOString() }))
}

// ------------------------------------------------------------ Autenticación

export const auth = {
  async login(username: string, password: string) {
    await wait(250)
    const name = username.trim().toLowerCase()
    const profile = read((db) => db.profiles.find((p) => p.username === name))
    if (!profile || profile.password !== password)
      throw new E.BusinessError('CREDENCIALES', 'Usuario o contraseña incorrectos.')
    if (!profile.is_active)
      throw new E.BusinessError('USUARIO_INACTIVO', 'Tu usuario está desactivado. Consultá a tu docente.')
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
  /** Nombre de la escuela para la pantalla de ingreso (no requiere sesión). */
  async schoolInfo() {
    await wait(40)
    return read(Q.publicSchoolInfo)
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
  document: (companyId: string, docType: T.DocType, number: string) =>
    query((db, u) => Q.documentDetail(db, u, companyId, docType, number)),
  documentById: (docId: string) => query((db, u) => Q.documentDetailById(db, u, docId)),
  pendingRequisitionLines: (companyId: string) => query((db, u) => Q.pendingRequisitionLines(db, u, companyId)),
  receivableOrders: (companyId: string) => query((db, u) => Q.receivableOrders(db, u, companyId)),
  tasks: (companyId: string, scope: 'mine' | 'all', includeClosed = false) =>
    query((db, u) => Q.listTasks(db, u, companyId, scope, includeClosed)),
  notifications: (companyId: string, limit: number | null = 60) =>
    query((db, u) => Q.listNotifications(db, u, companyId, limit)),
  audit: (companyId: string) => query((db, u) => Q.listAudit(db, u, companyId)),
  dashboard: (companyId: string) => query((db, u) => Q.dashboard(db, u, companyId)),
  members: (companyId: string) => query((db, u) => Q.listMembers(db, u, companyId)),
  users: () => query((db) => db.profiles.map(({ password: _p, ...rest }) => rest)),
  courses: () => query((db, u) => Q.listCourses(db, u)),
  teachers: () => query((db, u) => Q.listTeachers(db, u)),

  // Exportaciones: validan el permiso `*.export`, no sólo el de lectura.
  exportCustomers: (companyId: string) => query((db, u) => Q.exportCustomers(db, u, companyId)),
  exportSuppliers: (companyId: string) => query((db, u) => Q.exportSuppliers(db, u, companyId)),
  exportProducts: (companyId: string) => query((db, u) => Q.exportProducts(db, u, companyId)),
  exportStock: (companyId: string) => query((db, u) => Q.exportStock(db, u, companyId)),
  exportAudit: (companyId: string) => query((db, u) => Q.exportAudit(db, u, companyId)),
}

// ------------------------------------------------------------ Comandos (futuras RPC)

export const commands = {
  createRequisition: (companyId: string, input: E.RequisitionInput, submit: boolean) =>
    command((c) => E.cmdCreateRequisition(c, companyId, input, submit)),
  updateRequisition: (docId: string, input: E.RequisitionInput) =>
    command((c) => E.cmdUpdateRequisition(c, docId, input)),
  submitRequisition: (docId: string) => command((c) => E.cmdSubmitRequisition(c, docId)),
  rejectRequisition: (docId: string, reason: string) => command((c) => E.cmdRejectRequisition(c, docId, reason)),
  cancelRequisition: (docId: string, reason: string) => command((c) => E.cmdCancelRequisition(c, docId, reason)),
  closeRequisition: (docId: string, reason: string) => command((c) => E.cmdCloseRequisition(c, docId, reason)),

  createPurchaseOrder: (companyId: string, input: E.PurchaseOrderInput) =>
    command((c) => E.cmdCreatePurchaseOrder(c, companyId, input)),
  updatePurchaseOrder: (docId: string, input: E.PurchaseOrderInput) =>
    command((c) => E.cmdUpdatePurchaseOrder(c, docId, input)),
  submitPurchaseOrder: (docId: string) => command((c) => E.cmdSubmitPurchaseOrder(c, docId)),
  approvePurchaseOrder: (docId: string, comment: string) =>
    command((c) => E.cmdApprovePurchaseOrder(c, docId, comment)),
  rejectPurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdRejectPurchaseOrder(c, docId, reason)),
  withdrawPurchaseOrder: (docId: string) => command((c) => E.cmdWithdrawPurchaseOrder(c, docId)),
  reopenPurchaseOrder: (docId: string) => command((c) => E.cmdReopenPurchaseOrder(c, docId)),
  sendPurchaseOrder: (docId: string) => command((c) => E.cmdSendPurchaseOrder(c, docId)),
  cancelPurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdCancelPurchaseOrder(c, docId, reason)),
  closePurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdClosePurchaseOrder(c, docId, reason)),

  createGoodsReceipt: (companyId: string, input: E.GoodsReceiptInput, confirm: boolean) =>
    command((c) => E.cmdCreateGoodsReceipt(c, companyId, input, confirm)),
  confirmGoodsReceipt: (docId: string) => command((c) => E.cmdConfirmGoodsReceipt(c, docId)),
  cancelGoodsReceipt: (docId: string, reason: string) => command((c) => E.cmdCancelGoodsReceipt(c, docId, reason)),

  createStockAdjustment: (companyId: string, input: E.StockAdjustmentInput, confirm: boolean) =>
    command((c) => E.cmdCreateStockAdjustment(c, companyId, input, confirm)),
  confirmStockAdjustment: (docId: string) => command((c) => E.cmdConfirmStockAdjustment(c, docId)),
  cancelStockAdjustment: (docId: string, reason: string) =>
    command((c) => E.cmdCancelStockAdjustment(c, docId, reason)),

  saveMaster: (kind: E.MasterKind, companyId: string, input: Record<string, unknown> & { id?: string }) =>
    command((c) => E.cmdSaveMaster(c, kind, companyId, input)),
  setMasterActive: (kind: E.MasterKind, companyId: string, id: string, active: boolean) =>
    command((c) => E.cmdSetMasterActive(c, kind, companyId, id, active)),

  claimTask: (taskId: string, claim: boolean) => command((c) => E.cmdClaimTask(c, taskId, claim)),
  markNotificationsRead: (companyId: string, ids: string[] | 'all') =>
    command((c) => E.cmdMarkNotificationsRead(c, ids, companyId)),

  assignRole: (companyId: string, userId: string, role: T.RoleCode, sectorId: string | null) =>
    command((c) => E.cmdAssignRole(c, companyId, userId, role, sectorId)),
  removeRole: (companyId: string, memberRoleId: string) => command((c) => E.cmdRemoveRole(c, companyId, memberRoleId)),
  createStudent: (companyId: string, input: E.StudentInput) => command((c) => E.cmdCreateStudent(c, companyId, input)),
  createStudentsBulk: (companyId: string, rows: { first_name: string; last_name: string }[]) =>
    command((c) => E.cmdCreateStudentsBulk(c, companyId, rows)),
  resetPassword: (companyId: string, userId: string, newPassword: string) =>
    command((c) => E.cmdResetPassword(c, companyId, userId, newPassword)),
  setModule: (companyId: string, module: T.ModuleCode, enabled: boolean) =>
    command((c) => E.cmdSetModule(c, companyId, module, enabled)),
  updateCompanySettings: (companyId: string, settings: Partial<T.CompanySettings>) =>
    command((c) => E.cmdUpdateCompanySettings(c, companyId, settings)),

  changePassword: (input: E.ChangePasswordInput) => command((c) => E.cmdChangePassword(c, input)),
  createTeacher: (input: E.TeacherInput) => command((c) => E.cmdCreateTeacher(c, input)),
  createCourse: (input: E.CourseInput) => command((c) => E.cmdCreateCourse(c, input)),
  updateSchoolSettings: (input: E.SchoolSettingsInput) => command((c) => E.cmdUpdateSchoolSettings(c, input)),

  async resetDemoData() {
    await wait(300)
    resetDatabase()
  },
}

/** Suscripción a cambios (hoy: otras pestañas; con Supabase: Realtime). */
export const realtime = { subscribe: onDatabaseChange }
