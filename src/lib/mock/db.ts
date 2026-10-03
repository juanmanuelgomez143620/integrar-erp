// Base de datos simulada en el navegador (localStorage).
// Reemplaza a Supabase mientras se desarrolla la interfaz: cada "comando" se
// ejecuta sobre una copia y sólo se guarda si termina sin error (todo o nada),
// igual que una transacción de PostgreSQL. Los cambios se propagan a otras
// pestañas con el evento `storage`, simulando el tiempo real.

import type * as T from '../domain/types'
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
  docLinks: T.DocumentLink[]
  stockMovements: T.StockMovement[]
  stockBalances: T.StockBalance[]
  approvalRules: T.ApprovalRule[]
  approvalRequests: T.ApprovalRequest[]
  tasks: T.Task[]
  notifications: T.Notification[]
  audit: T.AuditEvent[]
}

export const DB_VERSION = 2
const STORAGE_KEY = 'integrar-erp.mockdb'

/** Cierre de sesión por inactividad por defecto: cubre el recreo entre dos clases en una PC compartida. */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 15

let cache: DB | null = null
const listeners = new Set<() => void>()

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
    return null // Sin almacenamiento disponible (modo privado).
  }
  if (!raw) return null
  let stored: DB
  try {
    stored = JSON.parse(raw) as DB
  } catch {
    archive(raw)
    return null
  }
  if (stored.version > DB_VERSION) {
    // Otra pestaña ya usa una versión más nueva de la aplicación: recargar trae
    // el código nuevo. Nunca se pisan esos datos con una base de demostración vieja.
    window.location.reload()
    return stored
  }
  const storedVersion = stored.version
  const upgraded = upgradeDatabase(stored)
  if (upgraded) {
    if (storedVersion !== DB_VERSION) writeStorage(upgraded)
    return upgraded
  }
  // No se puede actualizar: se archiva antes de reemplazarla, igual que al reiniciar.
  archive(raw)
  return null
}

function writeStorage(db: DB) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // Sin almacenamiento disponible (modo privado): la sesión funciona en memoria.
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
    localStorage.setItem(`integrar-erp.archive.${new Date().toISOString()}`, serialized)
  } catch {
    // Sin espacio disponible: no se bloquea el reinicio por esto.
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
    if (event.key === STORAGE_KEY) {
      cache = null
      emit()
    }
  })
}
