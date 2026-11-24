// Pruebas de la actividad del entorno (docs/FASE_9_LA_EMPRESA_CRECE.md, 9d.1 a 9d.3) sobre buildSeed() y los
// cmd*: el docente genera la semana y llegan los pedidos de los clientes, que Ventas confirma o rechaza; los
// avisos de entrega de los proveedores, que Depósito recibe, y el parte de novedades del personal, para RRHH.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import type * as T from '../domain/types'
import {
  BusinessError,
  cmdApprovePurchaseOrder,
  cmdCancelSalesOrder,
  cmdConfirmSalesOrder,
  cmdCreateGoodsReceipt,
  cmdCreatePurchaseOrder,
  cmdGenerateEnvironmentWeek,
  cmdSendPurchaseOrder,
  cmdSubmitPurchaseOrder,
  isoWeek,
  weekCustomerOrders,
  type Ctx,
} from './engine'
import { documentDetail, environmentView, listTasks, receivableOrders, staffReport } from './queries'
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
      `Generó la actividad de la semana 2027-W19: ${orders.length} pedidos de clientes, 0 avisos de entrega de proveedores y ${db.staffNovelties.length} novedades del personal`,
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

  it('al actualizar una base guardada (v34), quedan las semanas y los avisos vacíos', () => {
    const { environmentWeeks: _weeks, deliveryNotices: _notices, staffNovelties: _staff, ...v34 } = structuredClone(db)
    const upgraded = upgradeDatabase({ ...v34, version: 34 } as DB)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.environmentWeeks).toEqual([])
    expect(upgraded.deliveryNotices).toEqual([])
    expect(upgraded.staffNovelties).toEqual([])
  })
})

/** Arma y envía una orden de compra de MP-001 a PRV-001, con su fecha de entrega comprometida. */
function sentOrder(quantity: number, expected: string | null) {
  const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), {
    supplier_id: db.suppliers.find((s) => s.code === 'PRV-001')!.id,
    expected_date: expected,
    warehouse_id: db.warehouses.find((w) => w.code === 'DEP-MP')!.id,
    payment_terms_days: 30,
    delivery_terms: 'Entrega en planta',
    notes: '',
    lines: [
      {
        product_id: db.products.find((p) => p.code === 'MP-001')!.id,
        requisition_line_id: null,
        quantity,
        unit_price: 1000,
        vat_rate: 21,
      },
    ],
  })
  cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
  cmdApprovePurchaseOrder(ctx('compras2'), oc.id, 'OK')
  cmdSendPurchaseOrder(ctx('compras1'), oc.id)
  return db.documents.find((d) => d.id === oc.id)!
}

/** Depósito recibe una cantidad de la única línea de la orden, con el remito que diga. */
function receive(order: T.Document, quantity: number, note: string) {
  const line = db.poLines.find((l) => l.document_id === order.id)!
  cmdCreateGoodsReceipt(
    ctx('deposito'),
    companyId(),
    {
      purchase_order_id: order.id,
      warehouse_id: order.po!.warehouse_id,
      supplier_delivery_note: note,
      carrier_name: '',
      notes: '',
      lines: [{ po_line_id: line.id, quantity }],
    },
    true,
  )
}

describe('las entregas de los proveedores (Fase 9d.2)', () => {
  it('avisan las órdenes enviadas que vencen en la semana o sin fecha, con su remito y lo pendiente', () => {
    const thisWeek = sentOrder(10, '2027-05-15')
    sentOrder(5, '2027-05-20')
    const undated = sentOrder(8, null)
    const { notices } = cmdGenerateEnvironmentWeek(ctx('docente'), companyId())
    expect(notices).toEqual([thisWeek.display_number, undated.display_number])
    const [first, second] = db.deliveryNotices
    expect(first).toMatchObject({
      purchase_order_id: thisWeek.id,
      week: '2027-W19',
      carrier_name: 'Reparto del proveedor',
      arrives_on: '2027-05-15',
      lines: [{ quantity: 10 }],
    })
    expect(first.delivery_note).toMatch(/^\d{4}-\d{8}$/)
    // Sin fecha comprometida, llega hoy.
    expect(second).toMatchObject({ purchase_order_id: undated.id, arrives_on: '2027-05-14', lines: [{ quantity: 8 }] })
    expect(db.audit.at(-1)!.summary).toMatch(
      /: \d+ pedidos de clientes, 2 avisos de entrega de proveedores y \d+ novedades del personal$/,
    )
    // Depósito recibe la notificación, con el enlace a la orden de compra.
    const supplier = db.suppliers.find((s) => s.code === 'PRV-001')!.legal_name
    const sent = db.notifications.filter(
      (n) => n.type === 'AVISO_ENTREGA' && n.recipient_user_id === userId('deposito'),
    )
    expect(sent.map((n) => n.document_id)).toEqual([thisWeek.id, undated.id])
    expect(sent[0].title).toBe(`${supplier} entrega ${thisWeek.display_number} el 15/05/2027`)
    expect(sent[0].body).toContain(`remito ${first.delivery_note}`)
  })

  it('la recepción trae el aviso y lo da por recibido; la semana siguiente avisa el saldo', () => {
    const order = sentOrder(10, '2027-05-15')
    const later = sentOrder(5, '2027-05-20')
    cmdGenerateEnvironmentWeek(ctx('docente'), companyId())
    const notice = db.deliveryNotices[0]
    const receivable = receivableOrders(db, userId('deposito'), companyId())
    expect(receivable.find((r) => r.order.id === order.id)!.notice).toEqual({
      delivery_note: notice.delivery_note,
      carrier_name: 'Reparto del proveedor',
      arrives_on: '2027-05-15',
      lines: notice.lines,
    })
    expect(receivable.find((r) => r.order.id === later.id)!.notice).toBeNull()
    // Llegan 6 de las 10: el aviso queda recibido y la orden, recibida en parte.
    vi.setSystemTime(new Date('2027-05-15T10:00:00-03:00'))
    receive(order, 6, notice.delivery_note)
    expect(environmentView(db, userId('docente'), companyId()).weeks[0].notices).toEqual([
      {
        purchase_order: order.display_number,
        supplier: db.suppliers.find((s) => s.code === 'PRV-001')!.legal_name,
        delivery_note: notice.delivery_note,
        arrives_on: '2027-05-15',
        received: true,
      },
    ])
    expect(
      receivableOrders(db, userId('deposito'), companyId()).find((r) => r.order.id === order.id)!.notice,
    ).toBeNull()
    // La semana siguiente, el saldo de la primera y la que vencía después.
    vi.setSystemTime(new Date('2027-05-17T10:00:00-03:00'))
    expect(cmdGenerateEnvironmentWeek(ctx('docente'), companyId()).notices).toEqual([
      order.display_number,
      later.display_number,
    ])
    expect(db.deliveryNotices[1]).toMatchObject({
      purchase_order_id: order.id,
      week: '2027-W20',
      arrives_on: '2027-05-17',
      lines: [{ quantity: 4 }],
    })
    expect(db.deliveryNotices[2]).toMatchObject({ purchase_order_id: later.id, arrives_on: '2027-05-20' })
  })

  it('un aviso sin recibir no se repite la semana siguiente', () => {
    sentOrder(10, null)
    expect(cmdGenerateEnvironmentWeek(ctx('docente'), companyId()).notices).toHaveLength(1)
    vi.setSystemTime(new Date('2027-05-17T10:00:00-03:00'))
    expect(cmdGenerateEnvironmentWeek(ctx('docente'), companyId()).notices).toEqual([])
    expect(db.audit.at(-1)!.summary).toMatch(/pedidos de clientes, 0 avisos de entrega de proveedores y /)
  })
})

describe('el parte de novedades del personal (Fase 9d.3)', () => {
  it('trae la semana anterior: ausencias de legajos distintos y horas extra, con la notificación a RRHH', () => {
    const { novelties } = cmdGenerateEnvironmentWeek(ctx('docente'), companyId())
    const parte = db.staffNovelties
    expect(parte).toHaveLength(novelties)
    // La semana anterior a la 2027-W19: del lunes 3 al sábado 8 de mayo.
    for (const n of parte) {
      expect(n.week).toBe('2027-W19')
      expect(n.day >= '2027-05-03' && n.day <= '2027-05-08').toBe(true)
      const employee = db.employees.find((e) => e.id === n.employee_id)!
      expect(employee.status).toBe('ACTIVO')
      if (n.kind === 'AUSENCIA') {
        expect(n.hours).toBe(0)
        expect(isoWeekday(n.day)).toBeLessThanOrEqual(5)
      } else {
        expect(n.hours).toBeGreaterThanOrEqual(2)
        expect(n.hours).toBeLessThanOrEqual(4)
        expect(n.kind).toBe(isoWeekday(n.day) === 6 ? 'EXTRA_100' : 'EXTRA_50')
      }
    }
    const absences = parte.filter((n) => n.kind === 'AUSENCIA')
    expect(absences.length).toBeLessThanOrEqual(2)
    expect(new Set(absences.map((n) => n.employee_id)).size).toBe(absences.length)
    const overtime = parte.filter((n) => n.kind !== 'AUSENCIA')
    expect(overtime.length).toBeGreaterThanOrEqual(2)
    expect(overtime.length).toBeLessThanOrEqual(5)
    // RRHH recibe la notificación, con el enlace a las liquidaciones.
    const sent = db.notifications.filter((n) => n.type === 'PARTE_NOVEDADES' && n.recipient_user_id === userId('rrhh'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      title: 'Llegó el parte de novedades del 03/05/2027 al 08/05/2027',
      link_path: `/e/${db.companies[0].slug}/rrhh/liquidaciones`,
    })
    expect(sent[0].body).toMatch(/^\d+ ausencias? sin aviso y \d+ horas extra: /)
    // El panel del docente lo resume.
    expect(environmentView(db, userId('docente'), companyId()).weeks[0].staff).toEqual({
      absences: absences.length,
      overtime_hours: overtime.reduce((s, n) => s + n.hours, 0),
    })
  })

  it('cada novedad cuenta para el mes de su día: el parte de una semana entre dos meses', () => {
    // La 2027-W23 trae la semana del lunes 31 de mayo al sábado 5 de junio.
    vi.setSystemTime(new Date('2027-06-08T10:00:00-03:00'))
    cmdGenerateEnvironmentWeek(ctx('docente'), companyId())
    const total = (rows: ReturnType<typeof staffReport>) =>
      rows.reduce((s, r) => s + r.absence_days + r.overtime_50 + r.overtime_100, 0)
    const may = staffReport(db, userId('rrhh'), companyId(), '2027-05')
    const june = staffReport(db, userId('rrhh'), companyId(), '2027-06')
    const byMonth = (prefix: string) =>
      db.staffNovelties
        .filter((n) => n.day.startsWith(prefix))
        .reduce((s, n) => s + (n.kind === 'AUSENCIA' ? 1 : n.hours), 0)
    expect(total(may)).toBe(byMonth('2027-05'))
    expect(total(june)).toBe(byMonth('2027-06'))
    expect(total(may) + total(june)).toBeGreaterThan(0)
    // Por legajo, en orden de legajo.
    const files = [...may, ...june].map((r) => db.employees.find((e) => e.id === r.employee_id)!.file_number)
    expect(june.map((r) => db.employees.find((e) => e.id === r.employee_id)!.file_number)).toEqual(
      [...june.map((r) => db.employees.find((e) => e.id === r.employee_id)!.file_number)].sort((a, b) => a - b),
    )
    expect(files.length).toBe(may.length + june.length)
    // Lo lee quien ve las liquidaciones.
    expect(() => staffReport(db, userId('ventas'), companyId(), '2027-06')).toThrow()
  })
})
