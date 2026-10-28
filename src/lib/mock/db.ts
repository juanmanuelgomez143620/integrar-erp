// Base de datos simulada en el navegador (localStorage).
// Reemplaza a Supabase mientras se desarrolla la interfaz: cada "comando" se
// ejecuta sobre una copia y sólo se guarda si termina sin error (todo o nada),
// igual que una transacción de PostgreSQL. Los cambios se propagan a otras
// pestañas con el evento `storage`, simulando el tiempo real.

import type * as T from '../domain/types'
import { DEMO_BOM_OPERATIONS, DEMO_BOMS, DEMO_WORK_CENTERS } from '../domain/boms'
import { DEMO_EMPLOYEES, DEMO_JOB_CATEGORIES, DEMO_LABOR_AGREEMENTS, MONTH_HOURS } from '../domain/employees'
import {
  insertBaseChart,
  insertBasePostingRules,
  insertBomOperations,
  insertBoms,
  insertDriver,
  insertEmployees,
  insertJobCategories,
  insertLaborAgreements,
  insertWorkCenters,
  round2,
  startAccounting,
} from './engine'
import { buildSeed } from './seed'

export interface DocumentSequence {
  company_id: string
  doc_type: T.DocType
  next_number: number
}

export interface DB {
  version: number
  seededAt: string
  seq: { audit: number; movement: number }
  school: T.SchoolSettings
  profiles: T.Profile[]
  courses: T.Course[]
  companies: T.Company[]
  islands: T.Island[]
  sectors: T.Sector[]
  warehouses: T.Warehouse[]
  members: T.Member[]
  memberRoles: T.MemberRole[]
  companyModules: T.CompanyModule[]
  customers: T.Customer[]
  suppliers: T.Supplier[]
  products: T.Product[]
  documentSequences: DocumentSequence[]
  documents: T.Document[]
  prLines: T.RequisitionLine[]
  poLines: T.PurchaseOrderLine[]
  grLines: T.GoodsReceiptLine[]
  saLines: T.StockAdjustmentLine[]
  jeLines: T.JournalEntryLine[]
  siLines: T.SupplierInvoiceLine[]
  opLines: T.PaymentOrderLine[]
  rfqLines: T.RfqLine[]
  rfqSuppliers: T.RfqSupplier[]
  sqLines: T.SupplierQuoteLine[]
  brLines: T.BankReconciliationLine[]
  soLines: T.SalesOrderLine[]
  dnLines: T.DeliveryNoteLine[]
  fvLines: T.SalesInvoiceLine[]
  rcLines: T.CustomerReceiptLine[]
  qtLines: T.SalesQuoteLine[]
  priceLists: T.PriceList[]
  priceListItems: T.PriceListItem[]
  boms: T.Bom[]
  bomLines: T.BomLine[]
  prdLines: T.ProductionOrderLine[]
  workCenters: T.WorkCenter[]
  bomOperations: T.BomOperation[]
  prdOperations: T.ProductionOrderOperation[]
  laborAgreements: T.LaborAgreement[]
  jobCategories: T.JobCategory[]
  employees: T.Employee[]
  pyLines: T.PayrollLine[]
  postingRules: T.PostingRule[]
  accounts: T.Account[]
  fiscalYears: T.FiscalYear[]
  fiscalPeriods: T.FiscalPeriod[]
  docLinks: T.DocumentLink[]
  stockMovements: T.StockMovement[]
  stockBalances: T.StockBalance[]
  approvalRules: T.ApprovalRule[]
  approvalRequests: T.ApprovalRequest[]
  tasks: T.Task[]
  notifications: T.Notification[]
  audit: T.AuditEvent[]
}

export const DB_VERSION = 18
const STORAGE_KEY = 'integrar-erp.mockdb'

/** Cierre de sesión por inactividad por defecto: cubre el recreo entre dos clases en una PC compartida. */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 15

let cache: DB | null = null
const listeners = new Set<() => void>()

/** Nunca informar una operación exitosa si el navegador no guardó sus datos. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageError'
  }
}

const COLLECTIONS = [
  'profiles',
  'courses',
  'companies',
  'islands',
  'sectors',
  'warehouses',
  'members',
  'memberRoles',
  'companyModules',
  'customers',
  'suppliers',
  'products',
  'documentSequences',
  'documents',
  'prLines',
  'poLines',
  'grLines',
  'saLines',
  'jeLines',
  'siLines',
  'opLines',
  'rfqLines',
  'rfqSuppliers',
  'sqLines',
  'brLines',
  'soLines',
  'dnLines',
  'fvLines',
  'rcLines',
  'qtLines',
  'priceLists',
  'priceListItems',
  'boms',
  'bomLines',
  'prdLines',
  'workCenters',
  'bomOperations',
  'prdOperations',
  'laborAgreements',
  'jobCategories',
  'employees',
  'pyLines',
  'postingRules',
  'accounts',
  'fiscalYears',
  'fiscalPeriods',
  'docLinks',
  'stockMovements',
  'stockBalances',
  'approvalRules',
  'approvalRequests',
  'tasks',
  'notifications',
  'audit',
] as const

/** Colecciones que aparecieron después de la versión 1: una base anterior todavía no las tiene. */
const COLLECTION_SINCE: Partial<Record<(typeof COLLECTIONS)[number], number>> = {
  jeLines: 3,
  accounts: 3,
  fiscalYears: 3,
  fiscalPeriods: 3,
  siLines: 4,
  postingRules: 4,
  opLines: 5,
  rfqLines: 6,
  rfqSuppliers: 6,
  sqLines: 6,
  brLines: 7,
  soLines: 8,
  dnLines: 8,
  fvLines: 9,
  rcLines: 10,
  qtLines: 11,
  priceLists: 11,
  priceListItems: 11,
  boms: 12,
  bomLines: 12,
  prdLines: 12,
  workCenters: 13,
  bomOperations: 13,
  prdOperations: 13,
}

function isDatabase(value: unknown): value is DB {
  if (!value || typeof value !== 'object') return false
  const db = value as DB
  return (
    Number.isInteger(db.version) &&
    db.version >= 1 &&
    typeof db.seededAt === 'string' &&
    !!db.school &&
    typeof db.school === 'object' &&
    !!db.seq &&
    Number.isFinite(db.seq.audit) &&
    Number.isFinite(db.seq.movement) &&
    COLLECTIONS.every((key) => Array.isArray(db[key]) || (COLLECTION_SINCE[key] ?? 1) > db.version)
  )
}

/**
 * Pasos para llevar una base guardada con una versión anterior a la actual
 * sin perder lo que cargaron docentes y estudiantes. Cada paso lleva de la
 * versión N a la N + 1.
 */
const UPGRADES: Record<number, (db: DB) => void> = {
  // v1 → v2: contacto de la escuela y cierre de sesión por inactividad.
  1: (db) => {
    const v1 = db.school as Partial<T.SchoolSettings>
    db.school = {
      ...db.school,
      contact_email: v1.contact_email ?? '',
      session_timeout_minutes: v1.session_timeout_minutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES,
    }
  },
  // v2 → v3: contabilidad (Fase 2). Cada empresa recibe el plan de cuentas básico,
  // el ejercicio en curso y su asiento de apertura.
  2: (db) => {
    db.jeLines ??= []
    db.accounts ??= []
    db.fiscalYears ??= []
    db.fiscalPeriods ??= []
    db.siLines ??= []
    db.postingRules ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) startAccounting(ctx, company.id)
  },
  // v3 → v4: facturas de proveedor y reglas de imputación automática (Fase 3).
  3: (db) => {
    db.siLines ??= []
    db.postingRules ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) insertBasePostingRules(ctx, company.id)
  },
  // v4 → v5: órdenes de pago (Fase 3b) y la regla de imputación de los pagos.
  4: (db) => {
    db.opLines ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) insertBasePostingRules(ctx, company.id)
  },
  // v5 → v6: solicitudes de cotización y cotizaciones de proveedores (Fase 3c).
  5: (db) => {
    db.rfqLines ??= []
    db.rfqSuppliers ??= []
    db.sqLines ??= []
  },
  // v6 → v7: conciliaciones bancarias y medio de pago de las órdenes de pago (Fase 3d.2):
  // las ya pagadas se toman como pagadas por transferencia.
  6: (db) => {
    db.brLines ??= []
    for (const d of db.documents)
      if (d.op) d.op = { ...d.op, payment_method: d.op.payment_method ?? (d.op.paid_on ? 'TRANSFERENCIA' : null) }
  },
  // v7 → v8: pedidos de venta y remitos (Fase 4a) y las reglas del costo de lo vendido. Lo
  // reservado sale de los pedidos en curso: el saldo de stock ya no lo guarda aparte.
  7: (db) => {
    db.soLines ??= []
    db.dnLines ??= []
    for (const b of db.stockBalances) delete (b as Partial<{ qty_reserved: number }>).qty_reserved
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) insertBasePostingRules(ctx, company.id)
  },
  // v8 → v9: facturas de venta (Fase 4b) y las reglas del asiento de venta.
  8: (db) => {
    db.fvLines ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) insertBasePostingRules(ctx, company.id)
  },
  // v9 → v10: recibos de cobro (Fase 4c) y la regla del asiento de cobro.
  9: (db) => {
    db.rcLines ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) insertBasePostingRules(ctx, company.id)
  },
  // v10 → v11: listas de precios y presupuestos (Fase 4d); los clientes todavía no tienen lista.
  10: (db) => {
    db.qtLines ??= []
    db.priceLists ??= []
    db.priceListItems ??= []
    for (const c of db.customers) c.price_list_id ??= null
  },
  // v11 → v12: listas de materiales y órdenes de producción (Fase 5a), con las reglas del
  // consumo y de la producción terminada, y las listas de la demo en cada empresa que tenga esos productos.
  11: (db) => {
    db.boms ??= []
    db.bomLines ??= []
    db.prdLines ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) {
      insertBasePostingRules(ctx, company.id)
      insertBoms(ctx, company.id, DEMO_BOMS)
    }
  },
  // v12 → v13: centros de trabajo y costos de conversión (Fase 5b): las cuentas de la conversión
  // aplicada y su regla, y los centros y las horas de la demo en cada empresa que tenga esos productos.
  12: (db) => {
    db.workCenters ??= []
    db.bomOperations ??= []
    db.prdOperations ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) {
      if (db.accounts.some((a) => a.company_id === company.id)) insertBaseChart(ctx, company.id)
      insertBasePostingRules(ctx, company.id)
      insertWorkCenters(ctx, company.id, DEMO_WORK_CENTERS)
      insertBomOperations(ctx, company.id, DEMO_BOM_OPERATIONS)
    }
  },
  // v13 → v14: categorías y legajos del personal (Fase 6a), con los de la demo en cada empresa que
  // todavía no tenga legajos.
  13: (db) => {
    db.jobCategories ??= []
    db.employees ??= []
    // Las categorías de la demo ya vienen en un convenio (Fase 6d).
    db.laborAgreements ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) {
      insertLaborAgreements(ctx, company.id, DEMO_LABOR_AGREEMENTS)
      insertJobCategories(ctx, company.id, DEMO_JOB_CATEGORIES)
      insertEmployees(ctx, company.id, DEMO_EMPLOYEES)
    }
  },
  // v14 → v15: liquidaciones de sueldos (Fase 6b): la cuenta de la mano de obra directa real y
  // las reglas del asiento de sueldos.
  14: (db) => {
    db.pyLines ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) {
      if (db.accounts.some((a) => a.company_id === company.id)) insertBaseChart(ctx, company.id)
      insertBasePostingRules(ctx, company.id)
    }
  },
  // v15 → v16: pago de sueldos y cargas sociales (Fase 6c): las reglas de sus asientos y,
  // en las liquidaciones que ya había, los datos de los pagos (vacíos).
  15: (db) => {
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) insertBasePostingRules(ctx, company.id)
    for (const doc of db.documents)
      if (doc.py)
        doc.py = {
          ...doc.py,
          salaries_paid_on: doc.py.salaries_paid_on ?? null,
          salaries_account_id: doc.py.salaries_account_id ?? null,
          charges_paid_on: doc.py.charges_paid_on ?? null,
          charges_account_id: doc.py.charges_account_id ?? null,
        }
  },
  // v16 → v17: declaraciones de impuestos (Fase 7a): las reglas de los asientos del IVA y de su pago.
  16: (db) => {
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) insertBasePostingRules(ctx, company.id)
  },
  // v17 → v18: convenios colectivos (Fase 6d): los de la demo en cada empresa; cada categoría
  // que no tiene convenio pasa al suyo (las del taller y la del depósito, a Madera y por hora: lo
  // que cobraban en un mes completo; la de encargado, fuera de convenio; las demás, a Comercio);
  // la categoría y el legajo del chofer si faltan; la cuenta Sindicatos a pagar con sus reglas; y
  // en las liquidaciones que ya había, sin convenio y con los porcentajes de su liquidación.
  17: (db) => {
    db.laborAgreements ??= []
    const ctx = { db, userId: null, now: new Date().toISOString() }
    for (const company of db.companies) {
      if (db.accounts.some((a) => a.company_id === company.id)) insertBaseChart(ctx, company.id)
      insertBasePostingRules(ctx, company.id)
      insertLaborAgreements(ctx, company.id, DEMO_LABOR_AGREEMENTS)
      const agreement = (code: string) =>
        db.laborAgreements.find((a) => a.company_id === company.id && a.code === code)!
      for (const category of db.jobCategories.filter((c) => c.company_id === company.id && !c.agreement_id)) {
        const own = agreement(
          category.code === 'ENCARGADO'
            ? 'FUERA'
            : category.is_direct_labor || category.code === 'OPERARIO'
              ? 'MADERA'
              : 'COMERCIO',
        )
        category.agreement_id = own.id
        if (own.pay_basis === 'HOURLY') category.basic_salary = round2(category.basic_salary / MONTH_HOURS)
      }
      insertJobCategories(ctx, company.id, DEMO_JOB_CATEGORIES)
      insertDriver(
        ctx,
        company.id,
        DEMO_EMPLOYEES.find((e) => e.category === 'CHOFER')!,
      )
    }
    for (const line of db.pyLines) {
      const rates = db.documents.find((d) => d.id === line.document_id)?.py?.rates
      Object.assign(line, {
        agreement_id: line.agreement_id ?? null,
        pay_basis: line.pay_basis ?? 'MONTHLY',
        seniority_pct: line.seniority_pct ?? rates?.seniority_pct ?? 0,
        attendance_pct: line.attendance_pct ?? rates?.attendance_pct ?? 0,
        union_pct: line.union_pct ?? 0,
        union_employer_pct: line.union_employer_pct ?? 0,
        hours_worked: line.hours_worked ?? 0,
        union_dues: line.union_dues ?? 0,
        union_contribution: line.union_contribution ?? 0,
      })
    }
  },
}

/** Actualiza una base guardada a DB_VERSION; null si no hay forma de hacerlo. */
export function upgradeDatabase(db: DB): DB | null {
  while (db.version < DB_VERSION) {
    const step = UPGRADES[db.version]
    if (!step) return null
    step(db)
    db.version += 1
  }
  return db.version === DB_VERSION ? db : null
}

function readStorage(): DB | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    throw new StorageError(
      'No se puede acceder a los datos del navegador. Habilitá el almacenamiento local y volvé a intentar.',
    )
  }
  if (!raw) return null
  let stored: DB
  try {
    stored = JSON.parse(raw) as DB
  } catch {
    throw new StorageError(
      'Los datos guardados no se pueden leer. Se conservaron sin cambios; pedí ayuda al administrador para recuperarlos.',
    )
  }
  if (!isDatabase(stored))
    throw new StorageError(
      'La base guardada está incompleta. Se conservaron los datos sin cambios; pedí ayuda al administrador.',
    )
  if (stored.version > DB_VERSION) {
    // Otra pestaña ya usa una versión más nueva de la aplicación: recargar trae
    // el código nuevo. Nunca se pisan esos datos con una base de demostración vieja.
    throw new StorageError(
      'Los datos pertenecen a una versión más nueva de la aplicación. Actualizá esta página antes de continuar.',
    )
  }
  const storedVersion = stored.version
  const upgraded = upgradeDatabase(stored)
  if (upgraded) {
    if (storedVersion !== DB_VERSION) writeStorage(upgraded)
    return upgraded
  }
  throw new StorageError('Esta versión no puede actualizar la base guardada. Los datos se conservaron sin cambios.')
}

function writeStorage(db: DB) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    throw new StorageError(
      'No se guardaron los cambios. El almacenamiento del navegador está lleno o bloqueado; liberá espacio y volvé a intentar.',
    )
  }
}

function loadFresh(): DB {
  const stored = readStorage()
  if (stored) return stored
  const seeded = buildSeed()
  writeStorage(seeded)
  return seeded
}

function emit() {
  listeners.forEach((fn) => fn())
}

/** Lectura: usa la copia en memoria (se invalida cuando otra pestaña escribe). */
export function read<R>(fn: (db: DB) => R): R {
  if (!cache) cache = loadFresh()
  return fn(cache)
}

/** Escritura atómica: si `fn` lanza un error, no se guarda nada. */
export function transact<R>(fn: (db: DB) => R): R {
  const draft = structuredClone(loadFresh())
  const result = fn(draft)
  writeStorage(draft)
  cache = draft
  emit()
  return result
}

/**
 * La auditoría se declara "de sólo inserción" (ARCHITECTURE.md, decisión
 * 009), así que reiniciar no puede simplemente destruirla junto con el
 * resto: antes de reconstruir, se archiva la base completa (incluida su
 * auditoría) bajo una clave propia. No hay todavía una pantalla para
 * consultar el archivo; por ahora es una red de contención recuperable a
 * mano desde localStorage, no una papelera de reciclaje con vencimiento.
 */
function archive(serialized: string) {
  try {
    localStorage.setItem(`integrar-erp.archive.${new Date().toISOString()}.${crypto.randomUUID()}`, serialized)
  } catch {
    throw new StorageError(
      'No se pudo guardar la copia de respaldo. El reinicio se canceló y los datos actuales se conservaron.',
    )
  }
}

export function resetDatabase() {
  const previous = readStorage()
  if (previous) archive(JSON.stringify(previous))
  const seeded = buildSeed()
  writeStorage(seeded)
  cache = seeded
  emit()
}

export function onDatabaseChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      cache = null
      emit()
    }
  })
}
