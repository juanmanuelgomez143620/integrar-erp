// Pruebas de los modelos de lectura. Mismo criterio que engine.test.ts:
// trabajan sobre `buildSeed()` y las funciones directamente, sin pasar por
// db.ts ni localStorage.

import { beforeEach, describe, expect, it } from 'vitest'
import { buildSeed } from './seed'
import type { DB } from './db'
import { cmdCreateRequisition, cmdMarkNotificationsRead, type Ctx } from './engine'
import { listNotifications } from './queries'

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
