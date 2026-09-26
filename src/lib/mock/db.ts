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

export const DB_VERSION = 1
const STORAGE_KEY = 'integrar-erp.mockdb'

let cache: DB | null = null
const listeners = new Set<() => void>()

function readStorage(): DB | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DB
    return parsed.version === DB_VERSION ? parsed : null
  } catch {
    return null
  }
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

export function resetDatabase() {
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
