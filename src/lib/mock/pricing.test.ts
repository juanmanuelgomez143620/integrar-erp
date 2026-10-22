// Pruebas de las listas de precios y los presupuestos (docs/FASE_4_VENTAS_Y_CLIENTES.md §6) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from './db'
import {
  BusinessError,
  cmdAcceptSalesQuote,
  cmdAdjustPriceList,
  cmdCancelSalesQuote,
  cmdCreatePriceList,
  cmdCreateSalesOrder,
  cmdCreateSalesQuote,
  cmdExpireSalesQuote,
  cmdRejectSalesQuote,
  cmdSaveMaster,
  cmdSendSalesQuote,
  cmdSetPriceListActive,
  cmdSetPriceListPrice,
  cmdUpdatePriceList,
  type Ctx,
  type SalesQuoteInput,
} from './engine'
import { documentDetail, listPriceLists, priceListDetail, salesCatalog, salesCustomers } from './queries'
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
const list = (code: string) => db.priceLists.find((l) => l.code === code)!
const priceIn = (listCode: string, productCode: string) =>
  db.priceListItems.find((i) => i.price_list_id === list(listCode).id && i.product_id === product(productCode).id)
    ?.unit_price

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

/** Lista mayorista: los precios de venta con un 10 % menos. */
const wholesale = () =>
  cmdCreatePriceList(ctx('ventas'), companyId(), {
    code: 'may',
    name: 'Mayorista',
    description: 'Para mueblerías y distribuidores',
    copy_from: 'SALE_PRICE',
    percent: -10,
  })

/** Asigna la lista a un cliente desde su ficha. */
const assign = (customerCode: string, listId: string) =>
  cmdSaveMaster(ctx('ventas'), 'customer', companyId(), {
    id: customer(customerCode).id,
    code: customerCode,
    legal_name: customer(customerCode).legal_name,
    price_list_id: listId,
  })

const quote = (customerCode: string, lines: [string, number, number?][], over: Partial<SalesQuoteInput> = {}) => ({
  customer_id: customer(customerCode).id,
  warehouse_id: warehouse('DEP-PT').id,
  valid_until: '2027-05-29',
  payment_terms_days: 30,
  customer_reference: 'Pedido de precios 12',
  notes: '',
  lines: lines.map(([code, quantity, price]) => ({
    product_id: product(code).id,
    quantity,
    unit_price: price ?? product(code).sale_price!,
  })),
  ...over,
})

describe('listas de precios', () => {
  it('se crea copiando los precios de venta con un porcentaje, y se actualiza por porcentaje o por producto', () => {
    const { id } = wholesale()
    expect(list('MAY')).toMatchObject({ id, name: 'Mayorista', is_active: true })
    // Sólo lo que se vende: productos terminados, mercaderías y servicios con precio.
    expect(priceIn('MAY', 'PT-001')).toBe(product('PT-001').sale_price! * 0.9)
    expect(priceIn('MAY', 'MP-001')).toBeUndefined()
    const before = priceIn('MAY', 'PT-002')!
    cmdAdjustPriceList(ctx('ventas'), companyId(), id, 8)
    expect(priceIn('MAY', 'PT-002')).toBe(Math.round(before * 1.08 * 100) / 100)
    cmdSetPriceListPrice(ctx('ventas'), companyId(), id, product('PT-002').id, 120000)
    expect(priceIn('MAY', 'PT-002')).toBe(120000)
    cmdSetPriceListPrice(ctx('ventas'), companyId(), id, product('SV-001').id, null)
    expect(priceIn('MAY', 'SV-001')).toBeUndefined()
    cmdUpdatePriceList(ctx('ventas'), companyId(), id, { name: 'Mayorista 2027', description: '' })
    const detail = priceListDetail(db, userId('gerencia'), companyId(), 'MAY')!
    expect(detail.list.name).toBe('Mayorista 2027')
    expect(detail.missing.map((p) => p.code)).toContain('SV-001')
    expect(detail.items.map((i) => i.product.code)).not.toContain('MP-001')
    // La auditoría guarda cada cambio.
    expect(db.audit.filter((e) => e.entity_type === 'price_list').map((e) => e.summary)).toEqual([
      expect.stringContaining('Creó la lista de precios MAY Mayorista con'),
      expect.stringContaining('un +8 %'),
      expect.stringContaining('Cambió el precio de PT-002'),
      'Sacó SV-001 de la lista de precios MAY Mayorista',
      'Modificó la lista de precios MAY Mayorista 2027',
    ])
  })

  it('validaciones: código, nombre, porcentaje, precios y quién las arma', () => {
    const base = { code: 'MIN', name: 'Minorista', description: '', copy_from: '', percent: 0 }
    expectBusinessError(() => cmdCreatePriceList(ctx('tesoreria'), companyId(), base), 'SIN_PERMISO')
    expectBusinessError(
      () => cmdCreatePriceList(ctx('ventas'), companyId(), { ...base, code: 'MIN LISTA' }),
      'DATO_INVALIDO',
    )
    expectBusinessError(() => cmdCreatePriceList(ctx('ventas'), companyId(), { ...base, name: 'M' }), 'DATO_INVALIDO')
    expectBusinessError(
      () => cmdCreatePriceList(ctx('ventas'), companyId(), { ...base, percent: -90 }),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreatePriceList(ctx('ventas'), companyId(), { ...base, percent: 1.005 }),
      'DATO_INVALIDO',
    )
    const { id } = cmdCreatePriceList(ctx('ventas'), companyId(), base)
    expect(listPriceLists(db, userId('ventas'), companyId())).toEqual([
      expect.objectContaining({ items: 0, customers: 0 }),
    ])
    expectBusinessError(() => cmdCreatePriceList(ctx('ventas'), companyId(), base), 'DATO_INVALIDO')
    expectBusinessError(() => cmdAdjustPriceList(ctx('ventas'), companyId(), id, 5), 'DATO_INVALIDO')
    expectBusinessError(
      () => cmdSetPriceListPrice(ctx('ventas'), companyId(), id, product('MP-001').id, 100),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdSetPriceListPrice(ctx('ventas'), companyId(), id, product('PT-001').id, 10.001),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdSetPriceListPrice(ctx('ventas'), companyId(), id, product('PT-001').id, null),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdSetPriceListPrice(ctx('deposito'), companyId(), id, product('PT-001').id, 100),
      'SIN_PERMISO',
    )
  })

  it('el pedido propone el precio de la lista del cliente y mide la bonificación contra él', () => {
    const { id } = wholesale()
    assign('CLI-001', id)
    const row = salesCustomers(db, userId('ventas'), companyId()).find((c) => c.code === 'CLI-001')!
    expect(row.price_list).toEqual({ id, code: 'MAY', name: 'Mayorista' })
    const mesa = salesCatalog(db, userId('ventas'), companyId()).find((p) => p.code === 'PT-001')!
    expect(mesa.list_prices).toEqual([{ price_list_id: id, unit_price: product('PT-001').sale_price! * 0.9 }])
    const r = cmdCreateSalesOrder(
      ctx('ventas'),
      companyId(),
      {
        customer_id: customer('CLI-001').id,
        warehouse_id: warehouse('DEP-PT').id,
        delivery_date: null,
        payment_terms_days: 30,
        customer_reference: '',
        notes: '',
        lines: [{ product_id: product('PT-001').id, quantity: 1, unit_price: 450000 }],
      },
      false,
    )
    const line = db.soLines.find((l) => l.document_id === r.id)!
    expect(line.list_price).toBe(product('PT-001').sale_price! * 0.9)
    // Desactivada, deja de proponerse: vuelve el precio de venta.
    cmdSetPriceListActive(ctx('ventas'), companyId(), id, false)
    expect(salesCustomers(db, userId('ventas'), companyId()).find((c) => c.code === 'CLI-001')!.price_list).toBeNull()
    // Una lista desactivada no se asigna a otro cliente.
    expectBusinessError(() => assign('CLI-002', id), 'DATO_INVALIDO')
  })
})

describe('presupuesto', () => {
  it('enviado y aceptado: genera el pedido en borrador con los mismos ítems y precios', () => {
    const { id } = wholesale()
    assign('CLI-001', id)
    const r = cmdCreateSalesQuote(
      ctx('ventas'),
      companyId(),
      quote('CLI-001', [
        ['PT-001', 2, 460000],
        ['SV-001', 1],
      ]),
      false,
    )
    const pre = byNumber(r.display_number)
    expect(pre.status).toBe('BORRADOR')
    expect(db.tasks.some((t) => t.document_id === pre.id && t.task_type === 'ENVIAR_PRE')).toBe(true)
    // El precio de lista del presupuesto es el de la lista del cliente.
    expect(db.qtLines.find((l) => l.document_id === pre.id && l.line_no === 1)!.list_price).toBe(
      product('PT-001').sale_price! * 0.9,
    )
    cmdSendSalesQuote(ctx('ventas'), pre.id)
    expect(pre.status).toBe('ENVIADO')
    expect(
      db.tasks.some((t) => t.document_id === pre.id && t.task_type === 'SEGUIR_PRE' && t.assigned_role === 'VENTAS'),
    ).toBe(true)
    // La lista cambia después: el presupuesto conserva sus precios.
    cmdAdjustPriceList(ctx('ventas'), companyId(), id, 10)
    const order = cmdAcceptSalesQuote(ctx('ventas'), pre.id)
    expect(pre.status).toBe('ACEPTADO')
    const pv = byNumber(order.display_number)
    expect(pv).toMatchObject({ status: 'BORRADOR', total: pre.total, customer_id: customer('CLI-001').id })
    expect(pv.so).toMatchObject({ payment_terms_days: 30, customer_reference: 'Pedido de precios 12' })
    const lines = db.soLines.filter((l) => l.document_id === pv.id).sort((a, b) => a.line_no - b.line_no)
    expect(lines.map((l) => [l.quantity, l.unit_price, l.list_price])).toEqual([
      [2, 460000, product('PT-001').sale_price! * 0.9],
      [1, product('SV-001').sale_price!, product('SV-001').sale_price! * 0.9],
    ])
    const detail = documentDetail(db, userId('ventas'), companyId(), 'SALES_QUOTE', pre.display_number)!
    expect(detail.sales_quote).toMatchObject({ expired: false, order: { display_number: pv.display_number } })
    expect(detail.flow.map((n) => n.doc_type)).toEqual(['SALES_QUOTE', 'SALES_ORDER'])
    expect(detail.next_step.text).toContain(pv.display_number)
    expect(db.tasks.some((t) => t.document_id === pv.id && t.task_type === 'CONFIRMAR_PV')).toBe(true)
  })

  it('rechazado con el motivo del cliente; vencido sólo pasada la validez; anulado', () => {
    const rejected = cmdCreateSalesQuote(ctx('ventas'), companyId(), quote('CLI-002', [['PT-003', 1]]), true)
    expectBusinessError(() => cmdRejectSalesQuote(ctx('ventas'), rejected.id, ''), 'MOTIVO_REQUERIDO')
    cmdRejectSalesQuote(ctx('ventas'), rejected.id, 'Compró en otra mueblería')
    expect(byNumber(rejected.display_number)).toMatchObject({
      status: 'RECHAZADO',
      status_reason: 'Compró en otra mueblería',
    })
    const late = cmdCreateSalesQuote(ctx('ventas'), companyId(), quote('CLI-003', [['PT-004', 1]]), true)
    expectBusinessError(() => cmdExpireSalesQuote(ctx('ventas'), late.id), 'TRANSICION_INVALIDA')
    // Pasó el tiempo: la oferta venció.
    byNumber(late.display_number).qt!.valid_until = '2027-05-13'
    const detail = documentDetail(db, userId('ventas'), companyId(), 'SALES_QUOTE', late.display_number)!
    expect(detail.sales_quote!.expired).toBe(true)
    expect(detail.actions.find((a) => a.action === 'CONFIRM')).toMatchObject({ enabled: false })
    expectBusinessError(() => cmdAcceptSalesQuote(ctx('ventas'), late.id), 'TRANSICION_INVALIDA')
    cmdExpireSalesQuote(ctx('ventas'), late.id)
    expect(byNumber(late.display_number).status).toBe('VENCIDO')
    const wrong = cmdCreateSalesQuote(ctx('ventas'), companyId(), quote('CLI-004', [['PT-002', 3]]), false)
    cmdCancelSalesQuote(ctx('ventas'), wrong.id, 'Se cargó al cliente equivocado')
    expect(byNumber(wrong.display_number).status).toBe('ANULADO')
  })

  it('validaciones: la validez, lo que se vende, el cliente y quién lo prepara', () => {
    expectBusinessError(
      () =>
        cmdCreateSalesQuote(
          ctx('ventas'),
          companyId(),
          quote('CLI-001', [['PT-001', 1]], { valid_until: '2027-05-13' }),
          false,
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () =>
        cmdCreateSalesQuote(
          ctx('ventas'),
          companyId(),
          quote('CLI-001', [['PT-001', 1]], { valid_until: 'mañana' }),
          false,
        ),
      'DATO_INVALIDO',
    )
    // Una fecha que no existe (JS la correría al 1 de julio).
    expectBusinessError(
      () =>
        cmdCreateSalesQuote(
          ctx('ventas'),
          companyId(),
          quote('CLI-001', [['PT-001', 1]], { valid_until: '2027-06-31' }),
          false,
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSalesQuote(ctx('ventas'), companyId(), quote('CLI-001', [['MP-001', 1, 1000]]), false),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSalesQuote(ctx('ventas'), companyId(), quote('CLI-001', []), false),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSalesQuote(ctx('deposito'), companyId(), quote('CLI-001', [['PT-001', 1]]), false),
      'SIN_PERMISO',
    )
    // Un borrador vencido no se envía.
    const draft = cmdCreateSalesQuote(ctx('ventas'), companyId(), quote('CLI-001', [['PT-001', 1]]), false)
    byNumber(draft.display_number).qt!.valid_until = '2027-05-13'
    expectBusinessError(() => cmdSendSalesQuote(ctx('ventas'), draft.id), 'TRANSICION_INVALIDA')
  })
})
