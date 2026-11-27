// Pruebas de los escenarios (docs/FASE_8G_ESCENARIOS.md, 8g.1) sobre buildSeed() y los cmd*: el docente
// inicia un escenario, llega el pedido de la situación de partida con las consignas de cada isla, y los
// criterios se evalúan sobre la auditoría entre el inicio y el fin.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdApproveSalesOrder,
  cmdCancelSalesOrder,
  cmdConfirmSalesOrder,
  cmdEndScenario,
  cmdStartScenario,
  onHandQuantity,
  reservedQuantity,
  type Ctx,
} from './engine'
import { scenarioView } from './queries'
import { buildSeed } from './seed'

let db: DB

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2027-05-14T10:00:00-03:00'))
  db = buildSeed()
})

afterEach(() => {
  vi.useRealTimers()
})

const userId = (username: string) => db.profiles.find((p) => p.username === username)!.id
const ctx = (username: string): Ctx => ({ db, userId: userId(username), now: new Date().toISOString() })
const companyId = () => db.companies[0].id
const byNumber = (n: string) => db.documents.find((d) => d.company_id === companyId() && d.display_number === n)!

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

/** El estado de los criterios del escenario en curso, por clave. */
function criteria() {
  return Object.fromEntries(
    scenarioView(db, userId('docente'), companyId()).current!.criteria.map((c) => [c.key, c.done]),
  )
}

describe('los escenarios (Fase 8g.1)', () => {
  it('falta de stock: llega un pedido por más de lo disponible, con las consignas de Ventas, Producción y Depósito', () => {
    for (const username of ['gerencia', 'ventas'])
      expectBusinessError(() => cmdStartScenario(ctx(username), companyId(), 'FALTA_STOCK'), 'SIN_PERMISO')
    expectBusinessError(() => cmdStartScenario(ctx('docente'), companyId(), 'OTRO'), 'DATO_INVALIDO')
    const { order } = cmdStartScenario(ctx('docente'), companyId(), 'FALTA_STOCK')
    const doc = byNumber(order)
    expect(doc).toMatchObject({ status: 'RECIBIDO', so: { customer_reference: 'OC 9001' } })
    const run = db.scenarioRuns[0]
    expect(run).toMatchObject({ scenario: 'FALTA_STOCK', status: 'EN_CURSO', context: { order_id: doc.id } })
    // El producto terminado con lista de materiales que menos tiene disponible, por 6 unidades más.
    const line = db.soLines.find((l) => l.document_id === doc.id)!
    const product = db.products.find((p) => p.id === line.product_id)!
    expect(product.product_type).toBe('PRODUCTO_TERMINADO')
    const available =
      onHandQuantity(db, product.id, product.default_warehouse_id!) -
      reservedQuantity(db, product.id, product.default_warehouse_id!, doc.id)
    expect(line.quantity).toBe(Math.floor(Math.max(available, 0)) + 6)
    expect(run.context).toMatchObject({
      quantity: line.quantity,
      available: Math.max(available, 0),
      credit_limit: null,
    })
    // La consigna de cada isla, como tarea del rol, con el enlace al pedido.
    const tasks = db.tasks.filter((t) => t.task_type === 'CONSIGNA_ESCENARIO')
    expect(tasks.map((t) => t.assigned_role).sort()).toEqual(['DEPOSITO', 'PRODUCCION', 'VENTAS'])
    expect(
      tasks.every(
        (t) => t.source === 'ESCENARIO' && t.document_id === doc.id && t.title === 'Escenario «Falta de stock»',
      ),
    ).toBe(true)
    // Ventas no lo puede confirmar completo; todos los criterios, pendientes.
    expectBusinessError(() => cmdConfirmSalesOrder(ctx('ventas'), doc.id), 'STOCK_INSUFICIENTE')
    expect(Object.values(criteria())).toEqual([false, false, false, false, false])
    const view = scenarioView(db, userId('ventas'), companyId())
    expect(view.current).toMatchObject({
      labels: { order, quantity: line.quantity, product: `${product.code} ${product.name}` },
    })
    expect(view.history).toEqual([])
    // De a uno por empresa.
    expectBusinessError(() => cmdStartScenario(ctx('docente'), companyId(), 'VENTA_CREDITO'), 'TRANSICION_INVALIDA')
    // Ventas lo rechaza con el motivo: el primer criterio, logrado.
    vi.setSystemTime(new Date('2027-05-14T11:00:00-03:00'))
    cmdCancelSalesOrder(ctx('ventas'), doc.id, 'No hay stock para todo: cargamos lo disponible en otro pedido')
    expect(criteria()).toMatchObject({ FS_RECHAZO: true, FS_DISPONIBLE: false })
    // El docente lo termina: las consignas se cierran y queda el resultado.
    vi.setSystemTime(new Date('2027-05-14T12:00:00-03:00'))
    expect(cmdEndScenario(ctx('docente'), companyId())).toEqual({ done: 1, total: 5 })
    expect(tasks.every((t) => t.status === 'RESUELTA')).toBe(true)
    expect(db.audit.at(-1)!.summary).toBe('Terminó el escenario «Falta de stock»: 1 de 5 criterios logrados')
    const after = scenarioView(db, userId('docente'), companyId())
    expect(after.current).toBeNull()
    expect(after.history[0]).toMatchObject({ status: 'TERMINADO', scenario: 'FALTA_STOCK' })
    expect(after.history[0].criteria.filter((c) => c.done).map((c) => c.key)).toEqual(['FS_RECHAZO'])
    expect(scenarioView(db, userId('ventas'), companyId()).history).toEqual([])
    expectBusinessError(() => cmdEndScenario(ctx('docente'), companyId()), 'TRANSICION_INVALIDA')
  })

  it('venta a crédito: el pedido supera el límite por lo justo; Ventas lo confirma y Gerencia decide', () => {
    const { order } = cmdStartScenario(ctx('docente'), companyId(), 'VENTA_CREDITO')
    const doc = byNumber(order)
    const customer = db.customers.find((c) => c.id === doc.customer_id)!
    // El cliente con el límite más bajo; el pedido lo supera, y con una unidad menos no lo superaría.
    const limits = db.customers
      .filter((c) => c.company_id === companyId() && c.is_active && c.credit_limit !== null && c.credit_limit > 0)
      .map((c) => c.credit_limit!)
    expect(customer.credit_limit).toBe(Math.min(...limits))
    expect(doc.total).toBeGreaterThan(customer.credit_limit!)
    const line = db.soLines.find((l) => l.document_id === doc.id)!
    expect((doc.total / line.quantity) * (line.quantity - 1)).toBeLessThanOrEqual(customer.credit_limit! + 0.01)
    expect(db.scenarioRuns[0].context).toMatchObject({ credit_limit: customer.credit_limit, available: null })
    const tasks = db.tasks.filter((t) => t.task_type === 'CONSIGNA_ESCENARIO')
    expect(tasks.map((t) => t.assigned_role).sort()).toEqual(['DEPOSITO', 'GERENCIA', 'TESORERIA', 'VENTAS'])
    // Ventas lo confirma: va a Gerencia por el crédito.
    vi.setSystemTime(new Date('2027-05-14T11:00:00-03:00'))
    cmdConfirmSalesOrder(ctx('ventas'), doc.id)
    expect(doc.status).toBe('PENDIENTE_APROBACION')
    expect(criteria()).toMatchObject({ VC_REVISA: true, VC_DECIDE: false })
    // Gerencia lo autoriza.
    cmdApproveSalesOrder(ctx('gerencia'), doc.id, 'El cliente paga bien')
    expect(doc.status).toBe('CONFIRMADO')
    expect(criteria()).toMatchObject({ VC_REVISA: true, VC_DECIDE: true, VC_DESPACHO: false })
    expect(cmdEndScenario(ctx('docente'), companyId())).toEqual({ done: 2, total: 5 })
  })

  it('lo que pasa después de terminarlo no cuenta', () => {
    const { order } = cmdStartScenario(ctx('docente'), companyId(), 'FALTA_STOCK')
    vi.setSystemTime(new Date('2027-05-14T11:00:00-03:00'))
    cmdEndScenario(ctx('docente'), companyId())
    vi.setSystemTime(new Date('2027-05-14T12:00:00-03:00'))
    cmdCancelSalesOrder(ctx('ventas'), byNumber(order).id, 'Tarde')
    const [run] = scenarioView(db, userId('docente'), companyId()).history
    expect(run.criteria.every((c) => !c.done)).toBe(true)
    // Y se puede iniciar otro.
    expect(cmdStartScenario(ctx('docente'), companyId(), 'VENTA_CREDITO').order).toMatch(/^PV-\d{5}$/)
  })

  it('al actualizar una base guardada (v37), no hay corridas', () => {
    const { scenarioRuns: _runs, ...v37 } = structuredClone(db)
    const upgraded = upgradeDatabase({ ...v37, version: 37 } as DB)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.scenarioRuns).toEqual([])
  })
})
