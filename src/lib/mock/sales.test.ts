// Pruebas de los pedidos de venta, los remitos y las facturas de venta (docs/FASE_4_VENTAS_Y_CLIENTES.md §2 a §4)
// sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from './db'
import {
  BusinessError,
  accountBalance,
  cmdApproveSalesOrder,
  cmdCancelDeliveryNote,
  cmdCancelSalesInvoice,
  cmdCancelSalesOrder,
  cmdCloseSalesOrder,
  cmdConfirmDeliveryNote,
  cmdConfirmSalesInvoice,
  cmdConfirmSalesOrder,
  cmdCreateDeliveryNote,
  cmdCreateSalesInvoice,
  cmdCreateSalesOrder,
  cmdRejectSalesOrder,
  onHandQuantity,
  reservedQuantity,
  type Ctx,
  type SalesOrderInput,
} from './engine'
import {
  customerAccount,
  dispatchableOrders,
  documentDetail,
  invoiceableSalesOrders,
  listReceivables,
  listStock,
  salesCatalog,
  salesCustomers,
} from './queries'
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
const byNumber = (number: string) => db.documents.find((d) => d.display_number === number)!
const product = (code: string) => db.products.find((p) => p.code === code)!
const customer = (code: string) => db.customers.find((c) => c.code === code)!
const warehouse = (code: string) => db.warehouses.find((w) => w.code === code)!
const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!.id
const balance = (code: string) => accountBalance(db, account(code))
const linesOf = (docId: string) => db.soLines.filter((l) => l.document_id === docId)

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

const order = (customerCode: string, lines: [string, number, number?][], over: Partial<SalesOrderInput> = {}) => ({
  customer_id: customer(customerCode).id,
  warehouse_id: warehouse('DEP-PT').id,
  delivery_date: null,
  payment_terms_days: 30,
  customer_reference: '',
  notes: '',
  lines: lines.map(([code, quantity, price]) => ({
    product_id: product(code).id,
    quantity,
    unit_price: price ?? product(code).sale_price!,
  })),
  ...over,
})

const dispatchAll = (orderId: string, username = 'deposito') =>
  cmdCreateDeliveryNote(
    ctx(username),
    companyId(),
    {
      sales_order_id: orderId,
      carrier_name: '',
      notes: '',
      lines: linesOf(orderId).map((l) => ({ so_line_id: l.id, quantity: l.quantity - l.qty_delivered })),
    },
    true,
  )

describe('datos de demostración', () => {
  it('un pedido confirmado con su remito en preparación y otro esperando la autorización del crédito', () => {
    expect(byNumber('PV-00001').status).toBe('CONFIRMADO')
    expect(byNumber('PV-00002').status).toBe('PENDIENTE_APROBACION')
    expect(byNumber('PV-00002').so!.credit_reason).toContain('Supera el límite de crédito')
    expect(byNumber('REM-00001').status).toBe('BORRADOR')
    // Las mesas de los dos pedidos están reservadas.
    expect(reservedQuantity(db, product('PT-001').id, warehouse('DEP-PT').id)).toBe(4)
    const row = listStock(db, userId('deposito'), companyId()).find((r) => r.product.code === 'PT-001')!
    expect(row).toMatchObject({ qty: 6, reserved: 4, available: 2 })
  })
})

describe('pedido de venta', () => {
  it('confirmar reserva la mercadería y Depósito recibe la tarea de despacharlo', () => {
    const r = cmdCreateSalesOrder(ctx('ventas'), companyId(), order('CLI-002', [['PT-003', 2]]), true)
    const doc = byNumber(r.display_number)
    expect(doc.status).toBe('CONFIRMADO')
    expect(doc.total).toBe(2 * 640000 * 1.21)
    expect(reservedQuantity(db, product('PT-003').id, warehouse('DEP-PT').id)).toBe(2)
    expect(
      db.tasks.some(
        (t) => t.document_id === doc.id && t.task_type === 'DESPACHAR_PEDIDO' && t.assigned_role === 'DEPOSITO',
      ),
    ).toBe(true)
  })

  it('falta de stock: no se confirma más de lo disponible (lo que hay menos lo reservado)', () => {
    // De PT-001 hay 6 y 4 ya están reservadas.
    const r = cmdCreateSalesOrder(ctx('ventas'), companyId(), order('CLI-003', [['PT-001', 3]]), false)
    expectBusinessError(() => cmdConfirmSalesOrder(ctx('ventas'), r.id), 'STOCK_INSUFICIENTE')
    const detail = documentDetail(db, userId('ventas'), companyId(), 'SALES_ORDER', r.display_number)!
    expect(detail.lines[0].qty_available).toBe(2)
    expect(detail.actions.find((a) => a.action === 'CONFIRM')).toMatchObject({ enabled: false })
    // Con lo disponible, sí.
    cmdCreateSalesOrder(ctx('ventas'), companyId(), order('CLI-003', [['PT-001', 2]]), true)
  })

  it('supera el crédito del cliente: queda pendiente y Gerencia lo autoriza (no quien lo cargó)', () => {
    const doc = byNumber('PV-00002')
    expect(documentDetail(db, userId('gerencia'), companyId(), 'SALES_ORDER', 'PV-00002')!.sales_order).toMatchObject({
      credit_limit: 800000,
      credit_used: 0,
    })
    expectBusinessError(() => cmdApproveSalesOrder(ctx('ventas'), doc.id, ''), 'SIN_PERMISO')
    cmdApproveSalesOrder(ctx('gerencia'), doc.id, 'Cliente de muchos años.')
    expect(doc.status).toBe('CONFIRMADO')
    expect(doc.so!.confirmed_at).not.toBeNull()
  })

  it('el crédito usado suma los pedidos sin facturar', () => {
    const used = salesCustomers(db, userId('ventas'), companyId()).find((c) => c.code === 'CLI-001')!.credit_used
    expect(used).toBe(byNumber('PV-00001').total)
    // Otro pedido que, con el anterior, pasa los $ 4.000.000 del límite.
    const r = cmdCreateSalesOrder(ctx('ventas'), companyId(), order('CLI-001', [['PT-003', 2]]), true)
    expect(byNumber(r.display_number).status).toBe('PENDIENTE_APROBACION')
  })

  it('rechazar libera la reserva', () => {
    cmdRejectSalesOrder(ctx('gerencia'), byNumber('PV-00002').id, 'Tiene que achicar el pedido.')
    expect(byNumber('PV-00002').status).toBe('RECHAZADO')
    expect(reservedQuantity(db, product('PT-001').id, warehouse('DEP-PT').id)).toBe(2)
  })

  it('validaciones: lo que no se vende, ítems repetidos, precios y fechas', () => {
    const c = ctx('ventas')
    expectBusinessError(
      () => cmdCreateSalesOrder(c, companyId(), order('CLI-001', [['MP-001', 10, 2000]]), false),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () =>
        cmdCreateSalesOrder(
          c,
          companyId(),
          order('CLI-001', [
            ['PT-002', 1],
            ['PT-002', 2],
          ]),
          false,
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSalesOrder(c, companyId(), order('CLI-001', [['PT-002', 1, 0]]), false),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () =>
        cmdCreateSalesOrder(c, companyId(), order('CLI-001', [['PT-002', 1]], { delivery_date: '2027-05-01' }), false),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSalesOrder(ctx('compras1'), companyId(), order('CLI-001', [['PT-002', 1]]), false),
      'SIN_PERMISO',
    )
  })

  it('no se anula con entregas ni con un remito en preparación: se cierra el saldo', () => {
    const pv = byNumber('PV-00001')
    expectBusinessError(
      () => cmdCancelSalesOrder(ctx('ventas'), pv.id, 'El cliente se arrepintió.'),
      'TRANSICION_INVALIDA',
    )
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    expect(pv.status).toBe('ENTREGADO')
    const r = cmdCreateSalesOrder(ctx('ventas'), companyId(), order('CLI-002', [['PT-002', 10]]), true)
    const line = linesOf(r.id)[0]
    cmdCreateDeliveryNote(
      ctx('deposito'),
      companyId(),
      { sales_order_id: r.id, carrier_name: '', notes: '', lines: [{ so_line_id: line.id, quantity: 4 }] },
      true,
    )
    expect(byNumber(r.display_number).status).toBe('ENTREGADO_PARCIAL')
    expectBusinessError(() => cmdCancelSalesOrder(ctx('ventas'), r.id, 'Sin efecto.'), 'TRANSICION_INVALIDA')
    cmdCloseSalesOrder(ctx('ventas'), r.id, 'El cliente no quiere el resto.')
    expect(byNumber(r.display_number).status).toBe('CERRADO')
    expect(reservedQuantity(db, product('PT-002').id, warehouse('DEP-PT').id)).toBe(0)
  })
})

describe('remito', () => {
  it('despachar baja el stock al costo promedio, entrega el pedido y registra el costo de lo vendido', () => {
    const pv = byNumber('PV-00001')
    const stockBefore = onHandQuantity(db, product('PT-002').id, warehouse('DEP-PT').id)
    const cmvBefore = balance('5.1.01.01')
    const ptBefore = balance('1.1.05.04')
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const rem = byNumber('REM-00001')
    expect(rem.status).toBe('CONFIRMADO')
    expect(pv.status).toBe('ENTREGADO')
    expect(onHandQuantity(db, product('PT-002').id, warehouse('DEP-PT').id)).toBe(stockBefore - 8)
    // Sillas a 62.000 y mesas a 260.000 (su costo promedio): 8 × 62.000 + 2 × 260.000.
    const cost = 8 * 62000 + 2 * 260000
    expect(balance('5.1.01.01') - cmvBefore).toBe(cost)
    expect(ptBefore - balance('1.1.05.04')).toBe(cost)
    expect(reservedQuantity(db, product('PT-001').id, warehouse('DEP-PT').id)).toBe(2)
    const detail = documentDetail(db, userId('deposito'), companyId(), 'DELIVERY_NOTE', 'REM-00001')!
    expect(detail.delivery!.cost_total).toBe(cost)
    expect(detail.related_order!.display_number).toBe('PV-00001')
    // El flete va en el remito sin mover stock ni costo.
    expect(db.stockMovements.filter((m) => m.document_id === rem.id)).toHaveLength(2)
    expect(db.notifications.some((n) => n.type === 'PEDIDO_DESPACHADO' && n.document_id === pv.id)).toBe(true)
  })

  it('no sale más de lo que falta entregar', () => {
    const pv = byNumber('PV-00001')
    const line = linesOf(pv.id).find((l) => l.product_id === product('PT-002').id)!
    expectBusinessError(
      () =>
        cmdCreateDeliveryNote(
          ctx('deposito'),
          companyId(),
          { sales_order_id: pv.id, carrier_name: '', notes: '', lines: [{ so_line_id: line.id, quantity: 9 }] },
          false,
        ),
      'CANTIDAD_EXCEDE_PENDIENTE',
    )
    // Un pedido pendiente de aprobación todavía no se despacha.
    expectBusinessError(() => dispatchAll(byNumber('PV-00002').id), 'TRANSICION_INVALIDA')
    expect(dispatchableOrders(db, userId('deposito'), companyId()).map((o) => o.order.display_number)).toEqual([
      'PV-00001',
    ])
  })

  it('anular uno despachado devuelve la mercadería y revierte el costo; no lo anula quien lo despachó', () => {
    const rem = byNumber('REM-00001')
    const stockBefore = onHandQuantity(db, product('PT-002').id, warehouse('DEP-PT').id)
    const cmvBefore = balance('5.1.01.01')
    cmdConfirmDeliveryNote(ctx('deposito'), rem.id)
    expectBusinessError(() => cmdCancelDeliveryNote(ctx('deposito'), rem.id, 'Se cargó mal.'), 'SEPARACION_FUNCIONES')
    cmdCancelDeliveryNote(ctx('gerencia'), rem.id, 'Se cargó mal.')
    expect(rem.status).toBe('ANULADO')
    expect(byNumber('PV-00001').status).toBe('CONFIRMADO')
    expect(onHandQuantity(db, product('PT-002').id, warehouse('DEP-PT').id)).toBe(stockBefore)
    expect(balance('5.1.01.01')).toBe(cmvBefore)
    expect(reservedQuantity(db, product('PT-001').id, warehouse('DEP-PT').id)).toBe(4)
  })

  it('en el catálogo de venta, lo disponible descuenta lo reservado', () => {
    const mesa = salesCatalog(db, userId('ventas'), companyId()).find((p) => p.code === 'PT-001')!
    expect(mesa.stock.find((s) => s.warehouse_id === warehouse('DEP-PT').id)).toMatchObject({
      on_hand: 6,
      reserved: 4,
      available: 2,
    })
    expect(salesCatalog(db, userId('ventas'), companyId()).some((p) => p.code === 'MP-001')).toBe(false)
  })
})

describe('factura de venta y cuenta corriente de clientes', () => {
  const invoiceAll = (orderId: string, register = true, username = 'ventas') =>
    cmdCreateSalesInvoice(
      ctx(username),
      companyId(),
      {
        sales_order_id: orderId,
        notes: '',
        lines: linesOf(orderId).map((l) => ({ so_line_id: l.id, quantity: l.qty_delivered })),
      },
      register,
    )

  it('no se factura lo que todavía no salió', () => {
    expectBusinessError(() => invoiceAll(byNumber('PV-00001').id), 'TRANSICION_INVALIDA')
  })

  it('registrar le asigna el número de su letra, genera el asiento de venta y la deuda del cliente', () => {
    const pv = byNumber('PV-00001')
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const deudores = balance('1.1.03.01')
    const ventas = balance('4.1.01.01')
    const iva = balance('2.1.04.01')
    const r = invoiceAll(pv.id)
    const fv = byNumber(r.display_number)
    expect(fv.status).toBe('REGISTRADA')
    expect(fv.fv).toMatchObject({ letter: 'A', point_of_sale: '00001', invoice_number: '00000001' })
    expect(fv.total).toBe(pv.total)
    // Deudores por ventas al debe; ventas, servicios e IVA débito fiscal al haber (el saldo es debe menos haber).
    expect(balance('1.1.03.01') - deudores).toBe(pv.total)
    expect(ventas - balance('4.1.01.01')).toBe(8 * 125000 + 2 * 520000)
    expect(iva - balance('2.1.04.01')).toBe(pv.tax_total)
    expect(documentDetail(db, userId('ventas'), companyId(), 'SALES_ORDER', 'PV-00001')!.next_step.text).toContain(
      'se facturó todo',
    )
    // Nada más para facturar de ese pedido; el remito ya no se anula.
    expect(invoiceableSalesOrders(db, userId('ventas'), companyId())).toEqual([])
    expectBusinessError(() => invoiceAll(pv.id), 'CANTIDAD_EXCEDIDA')
    expectBusinessError(
      () => cmdCancelDeliveryNote(ctx('gerencia'), byNumber('REM-00001').id, 'Error de carga'),
      'TRANSICION_INVALIDA',
    )
    // En la cuenta corriente del cliente, y el crédito que usa no cambia: pasó del pedido a la factura.
    const account = customerAccount(db, userId('tesoreria'), companyId(), customer('CLI-001').id)!
    expect(account.balance).toBe(pv.total)
    expect(account.pending.map((i) => i.invoice_label)).toEqual(['A 00001-00000001'])
    expect(account.credit_used).toBe(pv.total)
    expect(listReceivables(db, userId('gerencia'), companyId()).map((r) => r.customer.code)).toEqual(['CLI-001'])
  })

  it('no se factura más de lo entregado; la letra depende del cliente y el número es correlativo por letra', () => {
    const pv = byNumber('PV-00001')
    const line = linesOf(pv.id).find((l) => l.product_id === product('PT-002').id)!
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const partial = (quantity: number, register = true) =>
      cmdCreateSalesInvoice(
        ctx('ventas'),
        companyId(),
        { sales_order_id: pv.id, notes: '', lines: [{ so_line_id: line.id, quantity }] },
        register,
      )
    expectBusinessError(() => partial(9), 'CANTIDAD_EXCEDIDA')
    const first = partial(3)
    const draft = partial(2, false)
    expect(byNumber(draft.display_number).fv!.invoice_number).toBe('')
    expectBusinessError(() => partial(6), 'CANTIDAD_EXCEDIDA')
    // Anulada, conserva su número; la siguiente sigue la numeración.
    cmdCancelSalesInvoice(ctx('ventas'), first.id, 'Se facturó al precio equivocado')
    cmdConfirmSalesInvoice(ctx('ventas'), draft.id)
    expect(byNumber(first.display_number).fv!.invoice_number).toBe('00000001')
    expect(byNumber(draft.display_number).fv!.invoice_number).toBe('00000002')
    // Un consumidor final recibe factura B, con su propia numeración.
    const counter = cmdCreateSalesOrder(ctx('ventas'), companyId(), order('CLI-009', [['PT-002', 1]]), true)
    cmdCreateDeliveryNote(
      ctx('deposito'),
      companyId(),
      {
        sales_order_id: counter.id,
        carrier_name: '',
        notes: '',
        lines: linesOf(counter.id).map((l) => ({ so_line_id: l.id, quantity: 1 })),
      },
      true,
    )
    const b = invoiceAll(counter.id)
    expect(byNumber(b.display_number).fv).toMatchObject({ letter: 'B', invoice_number: '00000001' })
  })

  it('anular una factura registrada revierte la venta con un contraasiento', () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const deudores = balance('1.1.03.01')
    const r = invoiceAll(byNumber('PV-00001').id)
    expectBusinessError(() => cmdCancelSalesInvoice(ctx('ventas'), r.id, ''), 'MOTIVO_REQUERIDO')
    expectBusinessError(() => cmdCancelSalesInvoice(ctx('tesoreria'), r.id, 'Error de carga'), 'SIN_PERMISO')
    cmdCancelSalesInvoice(ctx('ventas'), r.id, 'Error de carga')
    expect(byNumber(r.display_number).status).toBe('ANULADA')
    expect(balance('1.1.03.01')).toBe(deudores)
    expect(customerAccount(db, userId('ventas'), companyId(), customer('CLI-001').id)!.balance).toBe(0)
  })

  it('cliente moroso: con facturas vencidas, un pedido nuevo necesita la autorización de Gerencia', () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const r = invoiceAll(byNumber('PV-00001').id)
    // Pasó el tiempo: la factura venció.
    byNumber(r.display_number).fv!.due_date = '2027-04-30'
    const row = listReceivables(db, userId('ventas'), companyId())[0]
    expect(row.overdue).toBe(byNumber(r.display_number).total)
    const next = cmdCreateSalesOrder(ctx('ventas'), companyId(), order('CLI-001', [['PT-004', 1]]), true)
    expect(byNumber(next.display_number).status).toBe('PENDIENTE_APROBACION')
    expect(byNumber(next.display_number).so!.credit_reason).toContain('tiene facturas vencidas sin cobrar')
  })
})
