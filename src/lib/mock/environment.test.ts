// Pruebas de la actividad del entorno (docs/FASE_9_LA_EMPRESA_CRECE.md, 9d.1) sobre buildSeed() y los cmd*:
// el docente genera la semana y llegan los pedidos de los clientes, que Ventas confirma o rechaza.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdCancelSalesOrder,
  cmdConfirmSalesOrder,
  cmdGenerateEnvironmentWeek,
  isoWeek,
  weekCustomerOrders,
  type Ctx,
} from './engine'
import { documentDetail, environmentView, listTasks } from './queries'
import { buildSeed } from './seed'

let db: DB

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2027-05-14T15:00:00-03:00'))
  db = buildSeed()
})

afterEach(() => {
  vi.useRealTimers()
})

const userId = (username: string) => db.profiles.find((p) => p.username === username)!.id
const ctx = (username: string): Ctx => ({ db, userId: userId(username), now: new Date().toISOString() })
const companyId = () => db.companies[0].id
const byNumber = (n: string) => db.documents.find((d) => d.company_id === companyId() && d.display_number === n)!
const isoWeekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7

function expectBusinessError(fn: () => void, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BusinessError)
    expect((e as BusinessError).code).toBe(code)
    return (e as BusinessError).message
  }
  expect.unreachable(`se esperaba BusinessError con código ${code}`)
}

describe('la actividad del entorno (Fase 9d.1)', () => {
  it('la semana ISO, como la de Postgres (el 1/1/2027 cae en la semana 53 de 2026)', () => {
    expect(isoWeek('2026-11-23')).toBe('2026-W48')
    expect(isoWeek('2026-12-31')).toBe('2026-W53')
    expect(isoWeek('2027-01-01')).toBe('2026-W53')
    expect(isoWeek('2027-01-04')).toBe('2027-W01')
    expect(isoWeek('2027-05-14')).toBe('2027-W19')
  })

  it('la misma semana trae siempre los mismos pedidos, de 8 a 12, con la entrega en el día de reparto de la zona', () => {
    const plan = weekCustomerOrders(db, companyId(), '2027-W19', '2027-05-14')
    const codes = (p: typeof plan) =>
      p.map(
        (o) => `${db.customers.find((c) => c.id === o.customer_id)!.code} ${o.customer_reference} ${o.lines.length}`,
      )
    // Otra empresa con los mismos datos (la demo armada de nuevo) recibe lo mismo.
    const again = buildSeed()
    const other = weekCustomerOrders(again, again.companies[0].id, '2027-W19', '2027-05-14')
    expect(other.map((o) => again.customers.find((c) => c.id === o.customer_id)!.code)).toEqual(
      plan.map((o) => db.customers.find((c) => c.id === o.customer_id)!.code),
    )
    expect(plan.length).toBeGreaterThanOrEqual(8)
    expect(plan.length).toBeLessThanOrEqual(12)
    // Otra semana, otros pedidos.
    expect(codes(weekCustomerOrders(db, companyId(), '2027-W20', '2027-05-21'))).not.toEqual(codes(plan))
    for (const order of plan) {
      const customer = db.customers.find((c) => c.id === order.customer_id)!
      expect(customer.vat_condition).not.toBe('CONSUMIDOR_FINAL')
      expect(order.payment_terms_days).toBe(customer.payment_terms_days)
      expect(order.customer_reference).toMatch(/^OC \d{4}$/)
      expect(order.delivery_date! >= '2027-05-16').toBe(true)
      const zone = db.deliveryZones.find((z) => z.id === customer.zone_id)!
      expect(zone.delivery_days).toContain(isoWeekday(order.delivery_date!))
      expect(new Set(order.lines.map((l) => l.product_id)).size).toBe(order.lines.length)
      for (const line of order.lines) {
        const product = db.products.find((p) => p.id === line.product_id)!
        expect(['PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA']).toContain(product.product_type)
        expect(line.unit_price).toBe(product.sale_price)
        expect(line.quantity).toBeGreaterThanOrEqual(1)
        expect(line.quantity).toBeLessThanOrEqual(5)
      }
    }
  })

  it('el docente genera la semana una vez: llegan los pedidos, recibidos, con la tarea para Ventas', () => {
    for (const username of ['gerencia', 'ventas'])
      expectBusinessError(() => cmdGenerateEnvironmentWeek(ctx(username), companyId()), 'SIN_PERMISO')
    const { week, orders } = cmdGenerateEnvironmentWeek(ctx('docente'), companyId())
    expect(week).toBe('2027-W19')
    const plan = weekCustomerOrders(db, companyId(), week, '2027-05-14')
    expect(orders).toHaveLength(plan.length)
    const first = byNumber(orders[0])
    expect(first.status).toBe('RECIBIDO')
    expect(db.audit.find((a) => a.document_id === first.id)!.summary).toMatch(
      new RegExp(`^Recibió ${orders[0]} de .+ por .+: lo mandó el cliente \\(OC \\d{4}\\)$`),
    )
    expect(db.audit.at(-1)!.summary).toBe(
      `Generó la actividad de la semana 2027-W19: ${orders.length} pedidos de clientes`,
    )
    // La tarea es de Ventas (el rol), con el próximo paso a la vista.
    const tasks = listTasks(db, userId('ventas'), companyId(), 'mine').filter(
      (t) => t.task_type === 'REVISAR_PEDIDO_CLIENTE',
    )
    expect(tasks).toHaveLength(orders.length)
    expect(tasks[0].title).toMatch(/^Revisar PV-\d{5}, que mandó el cliente$/)
    expect(documentDetail(db, userId('ventas'), companyId(), 'SALES_ORDER', orders[0])!.next_step).toMatchObject({
      who: 'Ventas',
    })
    // Una sola vez por semana.
    expect(
      expectBusinessError(() => cmdGenerateEnvironmentWeek(ctx('docente'), companyId()), 'TRANSICION_INVALIDA'),
    ).toBe('La actividad de la semana 2027-W19 ya se generó: la próxima, desde el lunes.')
    // El panel del docente.
    const view = environmentView(db, userId('docente'), companyId())
    expect(view).toMatchObject({ current: '2027-W19', generated: true })
    expect(view.weeks[0]).toMatchObject({ week: '2027-W19', generated_on: '2027-05-14' })
    expect(view.weeks[0].orders.map((o) => o.display_number)).toEqual(orders)
    expect(() => environmentView(db, userId('ventas'), companyId())).toThrow()
    // La semana siguiente se puede generar otra vez.
    vi.setSystemTime(new Date('2027-05-17T10:00:00-03:00'))
    expect(cmdGenerateEnvironmentWeek(ctx('docente'), companyId()).week).toBe('2027-W20')
  })

  it('Ventas confirma el pedido del cliente (stock y crédito) o lo rechaza con el motivo', () => {
    const { orders } = cmdGenerateEnvironmentWeek(ctx('docente'), companyId())
    const results = orders.map((n) => {
      try {
        cmdConfirmSalesOrder(ctx('ventas'), byNumber(n).id)
        return byNumber(n).status
      } catch (e) {
        return (e as BusinessError).code
      }
    })
    // Algunos se confirman y otros no alcanza el stock: Ventas decide.
    expect(results).toContain('CONFIRMADO')
    expect(results).toContain('STOCK_INSUFICIENTE')
    const short = byNumber(orders[results.indexOf('STOCK_INSUFICIENTE')])
    expect(short.status).toBe('RECIBIDO')
    expectBusinessError(() => cmdCancelSalesOrder(ctx('ventas'), short.id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelSalesOrder(ctx('ventas'), short.id, 'Falta stock: se carga lo disponible en otro pedido')
    expect(short.status).toBe('ANULADO')
    // La tarea de revisarlo se cierra al confirmarlo o rechazarlo.
    const confirmed = byNumber(orders[results.indexOf('CONFIRMADO')])
    const open = db.tasks.filter(
      (t) =>
        t.task_type === 'REVISAR_PEDIDO_CLIENTE' &&
        [confirmed.id, short.id].includes(t.document_id!) &&
        ['PENDIENTE', 'EN_CURSO'].includes(t.status),
    )
    expect(open).toEqual([])
  })

  it('al actualizar una base guardada (v34), quedan las semanas vacías', () => {
    const { environmentWeeks: _weeks, ...v34 } = structuredClone(db)
    const upgraded = upgradeDatabase({ ...v34, version: 34 } as DB)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.environmentWeeks).toEqual([])
  })
})
