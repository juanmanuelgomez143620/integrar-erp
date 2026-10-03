// Pruebas de los modelos de lectura. Mismo criterio que engine.test.ts:
// trabajan sobre `buildSeed()` y las funciones directamente, sin pasar por
// db.ts ni localStorage.

import { beforeEach, describe, expect, it } from 'vitest'
import { buildSeed } from './seed'
import type { DB } from './db'
import { BusinessError, cmdCreateRequisition, cmdMarkNotificationsRead, cmdSetModule, type Ctx } from './engine'
import {
  exportAudit,
  exportCustomers,
  exportProducts,
  exportStock,
  exportSuppliers,
  listNotifications,
  listStock,
} from './queries'

let db: DB

beforeEach(() => {
  db = buildSeed()
})

// ---------------------------------------------------------------- Helpers

function userId(username: string) {
  return db.profiles.find((p) => p.username === username)!.id
}

function ctx(username: string): Ctx {
  return { db, userId: userId(username), now: new Date().toISOString() }
}

function companyId() {
  return db.companies[0].id
}

function expectBusinessError(fn: () => void, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BusinessError)
    expect((e as BusinessError).code).toBe(code)
    return
  }
  expect.unreachable(`se esperaba BusinessError con código ${code}`)
}

/** Producción envía una SC: cada integrante de Compras recibe un aviso de tarea nueva. */
function submitRequisition(reason = 'Reposición de prueba') {
  return cmdCreateRequisition(
    ctx('produccion'),
    companyId(),
    {
      needed_by: null,
      priority: 'NORMAL',
      reason,
      notes: '',
      lines: [{ product_id: db.products.find((p) => p.code === 'MP-001')!.id, quantity: 5 }],
    },
    true,
  )
}

// ---------------------------------------------------------------- Notificaciones

describe('notificaciones', () => {
  it('cada usuario ve sólo sus avisos, del más nuevo al más viejo', () => {
    const sc = submitRequisition()
    const mine = listNotifications(db, userId('compras1'), companyId(), null)
    expect(mine.some((n) => n.document_id === sc.id)).toBe(true)
    expect(mine.every((n) => n.recipient_user_id === userId('compras1'))).toBe(true)
    for (let i = 1; i < mine.length; i++) expect(mine[i - 1].created_at >= mine[i].created_at).toBe(true)
    // Quien envió la solicitud no recibe un aviso de su propia acción.
    expect(listNotifications(db, userId('produccion'), companyId(), null).some((n) => n.document_id === sc.id)).toBe(
      false,
    )
  })

  it('la campana trae los últimos 60 avisos y el historial, todos', () => {
    for (let i = 0; i < 65; i++) submitRequisition(`Reposición de prueba ${i}`)
    expect(listNotifications(db, userId('compras1'), companyId(), null).length).toBeGreaterThan(60)
    expect(listNotifications(db, userId('compras1'), companyId())).toHaveLength(60)
  })

  it('marcar como leída sólo afecta a los avisos propios', () => {
    const sc = submitRequisition()
    const target = listNotifications(db, userId('compras2'), companyId(), null).find((n) => n.document_id === sc.id)!
    cmdMarkNotificationsRead(ctx('compras1'), [target.id], companyId())
    expect(db.notifications.find((n) => n.id === target.id)!.read_at).toBeNull()
    cmdMarkNotificationsRead(ctx('compras2'), [target.id], companyId())
    expect(db.notifications.find((n) => n.id === target.id)!.read_at).not.toBeNull()
  })

  it('"marcar todas como leídas" no toca los avisos de otra persona', () => {
    submitRequisition()
    cmdMarkNotificationsRead(ctx('compras1'), 'all', companyId())
    expect(listNotifications(db, userId('compras1'), companyId(), null).every((n) => n.read_at)).toBe(true)
    expect(listNotifications(db, userId('compras2'), companyId(), null).some((n) => !n.read_at)).toBe(true)
  })
})

// ---------------------------------------------------------------- Exportaciones

describe('exportaciones a CSV', () => {
  it('quien tiene el permiso *.export recibe el listado completo', () => {
    const customers = db.customers.filter((c) => c.company_id === companyId())
    expect(exportCustomers(db, userId('ventas'), companyId())).toHaveLength(customers.length)
    expect(exportSuppliers(db, userId('compras1'), companyId()).length).toBeGreaterThan(0)
    expect(exportStock(db, userId('deposito'), companyId()).length).toBeGreaterThan(0)
    expect(exportProducts(db, userId('gerencia'), companyId()).length).toBeGreaterThan(0)
    expect(exportAudit(db, userId('auditor'), companyId()).length).toBeGreaterThan(0)
  })

  it('poder consultar un listado no alcanza para exportarlo', () => {
    // Producción ve el stock (stock.read) pero no tiene stock.export.
    expect(listStock(db, userId('produccion'), companyId()).length).toBeGreaterThan(0)
    expectBusinessError(() => exportStock(db, userId('produccion'), companyId()), 'SIN_PERMISO')
    // Depósito da de alta productos, pero exportar el maestro es de Gerencia y Auditoría.
    expectBusinessError(() => exportProducts(db, userId('deposito'), companyId()), 'SIN_PERMISO')
    expectBusinessError(() => exportAudit(db, userId('compras1'), companyId()), 'SIN_PERMISO')
  })

  it('un módulo bloqueado por el docente bloquea también su exportación', () => {
    cmdSetModule(ctx('docente'), companyId(), 'masters', false)
    expectBusinessError(() => exportCustomers(db, userId('ventas'), companyId()), 'MODULO_BLOQUEADO')
  })

  it('el docente, como supervisor, puede exportar cualquier listado', () => {
    expect(exportSuppliers(db, userId('docente'), companyId()).length).toBeGreaterThan(0)
    expect(exportAudit(db, userId('docente'), companyId()).length).toBeGreaterThan(0)
  })
})
