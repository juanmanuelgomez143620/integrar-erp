// Pruebas de la solicitud de cotización, las cotizaciones de proveedores y la
// adjudicación (docs/FASE_3_COMPRAS_Y_TESORERIA.md §6) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDays, todayAR } from '../format'
import type { DB } from './db'
import {
  BusinessError,
  cmdApprovePurchaseOrder,
  cmdAwardRfq,
  cmdCancelRfq,
  cmdCancelSupplierQuote,
  cmdCreateRfq,
  cmdCreateSupplierQuote,
  cmdSendRfq,
  cmdSubmitPurchaseOrder,
  type Ctx,
  type RfqInput,
  type SupplierQuoteInput,
} from './engine'
import { documentDetail, listTasks } from './queries'
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
const supplierId = (code: string) => db.suppliers.find((s) => s.company_id === companyId() && s.code === code)!.id
const product = (code: string) => db.products.find((p) => p.company_id === companyId() && p.code === code)!
const warehouse = (code: string) => db.warehouses.find((w) => w.code === code)!.id
const rfqDetail = (number = 'SCT-00001', username = 'compras1') =>
  documentDetail(db, userId(username), companyId(), 'RFQ', number)!

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

/** Solicitud sin SC por 5 bisagras y 10 correderas. */
function rfqInput(over: Partial<RfqInput> = {}): RfqInput {
  return {
    response_due: addDays(todayAR(), 3),
    warehouse_id: warehouse('DEP-MP'),
    notes: '',
    supplier_ids: [supplierId('PRV-003'), supplierId('PRV-009'), supplierId('PRV-010')],
    lines: [
      { product_id: product('IN-004').id, quantity: 5, requisition_line_id: null },
      { product_id: product('IN-005').id, quantity: 10, requisition_line_id: null },
    ],
    ...over,
  }
}

function quoteInput(
  rfqId: string,
  supplierCode: string,
  prices: (number | null)[],
  over: Partial<SupplierQuoteInput> = {},
) {
  const items = db.rfqLines.filter((l) => l.document_id === rfqId).sort((a, b) => a.line_no - b.line_no)
  return {
    rfq_id: rfqId,
    supplier_id: supplierId(supplierCode),
    supplier_reference: '',
    valid_until: addDays(todayAR(), 10),
    delivery_days: 5,
    payment_terms_days: 30,
    notes: '',
    lines: items
      .map((l, i) => ({ rfq_line_id: l.id, unit_price: prices[i] ?? 0, vat_rate: 21 }))
      .filter((_, i) => prices[i] != null),
    ...over,
  }
}

describe('la demo', () => {
  it('trae una solicitud enviada a tres proveedores, con dos cotizaciones y la más conveniente marcada', () => {
    const detail = rfqDetail()
    expect(detail.doc.status).toBe('ENVIADA')
    expect(detail.flow.map((f) => f.display_number)).toEqual(['SC-00002', 'SCT-00001', 'COT-00001', 'COT-00002'])
    const rfq = detail.rfq!
    expect(rfq.invited.map((i) => [i.supplier.code, i.quote?.display_number ?? null])).toEqual([
      ['PRV-001', 'COT-00002'],
      ['PRV-002', 'COT-00001'],
      ['PRV-009', null],
    ])
    expect(rfq.quotes.map((q) => [q.display_number, q.subtotal, q.complete])).toEqual([
      ['COT-00001', 5880000, true],
      ['COT-00002', 5740000, true],
    ])
    // La más barata en total (COT-00002) no es la más barata en cada ítem.
    expect(rfq.best_quote_id).toBe(byNumber('COT-00002').id)
    expect(rfq.quotes.map((q) => q.prices.map((p) => p?.lowest))).toEqual([
      [false, true],
      [true, false],
    ])
    expect(listTasks(db, userId('compras1'), companyId(), 'all', false).map((t) => t.title)).toContain(
      'Comparar y adjudicar SCT-00001',
    )
    // La SC atendió las alertas de stock mínimo de sus dos productos.
    expect(byNumber('SC-00002').status).toBe('SOLICITADO')
    const open = db.tasks.filter((t) => t.task_type === 'REPONER_STOCK' && t.status === 'PENDIENTE')
    expect(open.map((t) => t.context.product_id)).not.toContain(product('MP-004').id)
  })
})

describe('solicitud de cotización', () => {
  it('controla proveedores, fechas, cantidades y permisos', () => {
    expectBusinessError(
      () => cmdCreateRfq(ctx('compras1'), companyId(), rfqInput({ supplier_ids: [supplierId('PRV-003')] }), true),
      'DATO_INVALIDO',
    )
    // Repetir un proveedor no suma invitados.
    expectBusinessError(
      () =>
        cmdCreateRfq(
          ctx('compras1'),
          companyId(),
          rfqInput({ supplier_ids: [supplierId('PRV-003'), supplierId('PRV-003')] }),
          true,
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateRfq(ctx('compras1'), companyId(), rfqInput({ response_due: addDays(todayAR(), -1) }), true),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateRfq(ctx('compras1'), companyId(), rfqInput({ lines: [] }), true),
      'DATO_INVALIDO',
    )
    const scLine = db.prLines.find((l) => l.document_id === byNumber('SC-00002').id)!
    expectBusinessError(
      () =>
        cmdCreateRfq(
          ctx('compras1'),
          companyId(),
          rfqInput({
            lines: [{ product_id: scLine.product_id, quantity: scLine.quantity + 1, requisition_line_id: scLine.id }],
          }),
          true,
        ),
      'CANTIDAD_EXCEDE_PENDIENTE',
    )
    expectBusinessError(() => cmdCreateRfq(ctx('deposito'), companyId(), rfqInput(), true), 'SIN_PERMISO')
  })

  it('en borrador espera a quien la preparó; al enviarla, Compras tiene que adjudicarla', () => {
    const rfq = cmdCreateRfq(ctx('compras2'), companyId(), rfqInput(), false)
    expect(rfq.display_number).toBe('SCT-00002')
    const tasks = () =>
      db.tasks.filter((t) => t.document_id === rfq.id).map((t) => [t.task_type, t.status, t.assigned_role])
    expect(tasks()).toEqual([['ENVIAR_SCT', 'PENDIENTE', null]])
    expectBusinessError(
      () => cmdCreateSupplierQuote(ctx('compras1'), companyId(), quoteInput(rfq.id, 'PRV-003', [2000, 9000])),
      'TRANSICION_INVALIDA',
    )
    cmdSendRfq(ctx('compras2'), rfq.id)
    expect(byNumber('SCT-00002').status).toBe('ENVIADA')
    expect(tasks()).toEqual([
      ['ENVIAR_SCT', 'RESUELTA', null],
      ['ADJUDICAR_SCT', 'PENDIENTE', 'COMPRAS'],
    ])
    // Sin cotizaciones vigentes, adjudicar está deshabilitado y explica por qué.
    const award = rfqDetail('SCT-00002').actions.find((a) => a.action === 'AWARD')!
    expect(award).toMatchObject({ enabled: false, reason: 'Todavía no hay cotizaciones vigentes para adjudicar.' })
  })

  it('anularla descarta las cotizaciones que seguían en juego', () => {
    expectBusinessError(() => cmdCancelRfq(ctx('compras1'), byNumber('SCT-00001').id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelRfq(ctx('compras1'), byNumber('SCT-00001').id, 'Se compra con la próxima licitación')
    expect(byNumber('SCT-00001').status).toBe('ANULADA')
    expect([byNumber('COT-00001').status, byNumber('COT-00002').status]).toEqual(['DESCARTADA', 'DESCARTADA'])
    expect(db.tasks.find((t) => t.task_type === 'ADJUDICAR_SCT')!.status).toBe('RESUELTA')
    expect(rfqDetail().rfq!.best_quote_id).toBeNull()
  })
})

describe('cotización de proveedor', () => {
  it('controla proveedor invitado, una por proveedor, validez, plazos y precios', () => {
    const rfq = byNumber('SCT-00001').id
    expectBusinessError(
      () => cmdCreateSupplierQuote(ctx('compras1'), companyId(), quoteInput(rfq, 'PRV-005', [90000, 100000])),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSupplierQuote(ctx('compras1'), companyId(), quoteInput(rfq, 'PRV-002', [90000, 100000])),
      'DATO_INVALIDO',
    )
    const bad: Partial<SupplierQuoteInput>[] = [
      { valid_until: addDays(todayAR(), -1) },
      { delivery_days: -1 },
      { payment_terms_days: 1.5 },
      { supplier_reference: 'x'.repeat(41) },
    ]
    for (const over of bad)
      expectBusinessError(
        () => cmdCreateSupplierQuote(ctx('compras1'), companyId(), quoteInput(rfq, 'PRV-009', [90000, 100000], over)),
        'DATO_INVALIDO',
      )
    expectBusinessError(
      () => cmdCreateSupplierQuote(ctx('compras1'), companyId(), quoteInput(rfq, 'PRV-009', [0, 100000])),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSupplierQuote(ctx('compras1'), companyId(), quoteInput(rfq, 'PRV-009', [null, null])),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreateSupplierQuote(ctx('contabilidad'), companyId(), quoteInput(rfq, 'PRV-009', [90000, 100000])),
      'SIN_PERMISO',
    )
  })

  it('quien no discrimina IVA cotiza el precio final, sin IVA', () => {
    const rfq = cmdCreateRfq(ctx('compras1'), companyId(), rfqInput(), true)
    const quote = cmdCreateSupplierQuote(ctx('compras1'), companyId(), quoteInput(rfq.id, 'PRV-010', [2500, 11000]))
    const detail = documentDetail(db, userId('compras1'), companyId(), 'SUPPLIER_QUOTE', quote.display_number)!
    expect(detail.lines.map((l) => [l.vat_rate, l.line_subtotal, l.line_tax])).toEqual([
      [0, 12500, 0],
      [0, 110000, 0],
    ])
    expect(detail.doc).toMatchObject({ status: 'RECIBIDA', subtotal: 122500, tax_total: 0, total: 122500 })
    expect(detail.quote).toMatchObject({ rfq: { display_number: rfq.display_number }, best: true, expired: false })
  })

  it('anulada sale del cuadro y el proveedor puede cargar otra', () => {
    const first = byNumber('COT-00001')
    cmdCancelSupplierQuote(ctx('compras1'), first.id, 'El proveedor mandó una oferta mejor')
    expect(rfqDetail().rfq!.quotes.map((q) => q.display_number)).toEqual(['COT-00002'])
    const again = cmdCreateSupplierQuote(
      ctx('compras1'),
      companyId(),
      quoteInput(byNumber('SCT-00001').id, 'PRV-002', [88000, 104000], { delivery_days: 7 }),
    )
    expect(again.display_number).toBe('COT-00003')
    expect(rfqDetail().rfq!.best_quote_id).toBe(again.id)
  })
})

describe('adjudicación', () => {
  it('a la más conveniente: genera la OC en borrador con sus precios, condiciones y SC', () => {
    const rfq = byNumber('SCT-00001')
    const best = byNumber('COT-00002')
    const order = cmdAwardRfq(ctx('compras1'), rfq.id, best.id, '')
    const oc = byNumber(order.display_number)
    expect(oc).toMatchObject({ doc_type: 'PURCHASE_ORDER', status: 'BORRADOR', supplier_id: supplierId('PRV-001') })
    expect(oc.po).toMatchObject({
      warehouse_id: warehouse('DEP-MP'),
      payment_terms_days: 15,
      expected_date: addDays(todayAR(), 12),
    })
    const scLines = db.prLines.filter((l) => l.document_id === byNumber('SC-00002').id)
    expect(
      db.poLines
        .filter((l) => l.document_id === oc.id)
        .map((l) => [l.requisition_line_id, l.quantity, l.unit_price, l.vat_rate]),
    ).toEqual([
      [scLines[0].id, 40, 89500, 21],
      [scLines[1].id, 20, 108000, 21],
    ])
    expect([rfq.status, best.status, byNumber('COT-00001').status]).toEqual(['ADJUDICADA', 'ADJUDICADA', 'DESCARTADA'])
    const detail = rfqDetail()
    expect(detail.rfq).toMatchObject({
      awarded_quote_id: best.id,
      best_quote_id: null,
      award_reason: '',
      order: { display_number: order.display_number },
    })
    expect(detail.signatures.map((s) => [s.label, s.name])).toEqual([
      ['Preparó', 'Juan Pérez'],
      ['Adjudicó', 'Juan Pérez'],
    ])
    expect(db.tasks.find((t) => t.task_type === 'ADJUDICAR_SCT')!.status).toBe('RESUELTA')
    // La OC sigue su circuito: al aprobarse, la SC queda ordenada.
    expect(
      documentDetail(db, userId('compras1'), companyId(), 'PURCHASE_ORDER', order.display_number)!.flow.map(
        (f) => f.display_number,
      ),
    ).toEqual(['SC-00002', 'SCT-00001', 'COT-00001', 'COT-00002', order.display_number])
    cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
    cmdApprovePurchaseOrder(ctx('gerencia'), oc.id, 'ok')
    expect(byNumber('SC-00002').status).toBe('ORDENADO')
    expectBusinessError(() => cmdAwardRfq(ctx('compras1'), rfq.id, best.id, ''), 'TRANSICION_INVALIDA')
  })

  it('a otra: exige justificarlo y la deja en la solicitud', () => {
    const rfq = byNumber('SCT-00001')
    const faster = byNumber('COT-00001')
    expectBusinessError(() => cmdAwardRfq(ctx('compras1'), rfq.id, faster.id, 'Rápido'), 'MOTIVO_REQUERIDO')
    const reason = 'Entrega en 7 días: la producción no puede esperar 12.'
    const order = cmdAwardRfq(ctx('compras1'), rfq.id, faster.id, reason)
    expect(byNumber(order.display_number).supplier_id).toBe(supplierId('PRV-002'))
    expect(rfq.rq!.award_reason).toBe(reason)
    expect(byNumber('COT-00002').status).toBe('DESCARTADA')
  })

  it('una cotización parcial genera la OC sólo con lo cotizado y el resto queda pendiente en la SC', () => {
    const rfq = byNumber('SCT-00001')
    const partial = cmdCreateSupplierQuote(ctx('compras2'), companyId(), quoteInput(rfq.id, 'PRV-009', [85000, null]))
    expect(rfqDetail().rfq!.quotes.find((q) => q.id === partial.id)).toMatchObject({ quoted_lines: 1, complete: false })
    expect(rfqDetail().rfq!.best_quote_id).toBe(byNumber('COT-00002').id)
    const order = cmdAwardRfq(
      ctx('compras1'),
      rfq.id,
      partial.id,
      'Las placas MDF son las más baratas; el resto se cotiza aparte.',
    )
    const lines = db.poLines.filter((l) => l.document_id === order.id)
    expect(lines.map((l) => [l.product_id, l.quantity, l.unit_price])).toEqual([[product('MP-004').id, 40, 85000]])
  })

  it('una oferta vencida no se adjudica ni cuenta como la más conveniente', () => {
    const rfq = byNumber('SCT-00001')
    const best = byNumber('COT-00002')
    best.sq!.valid_until = addDays(todayAR(), -1)
    expect(rfqDetail().rfq!.best_quote_id).toBe(byNumber('COT-00001').id)
    expect(rfqDetail().rfq!.quotes.map((q) => q.expired)).toEqual([false, true])
    expectBusinessError(
      () => cmdAwardRfq(ctx('compras1'), rfq.id, best.id, 'Es la más barata de todas'),
      'OFERTA_VENCIDA',
    )
    byNumber('COT-00001').sq!.valid_until = addDays(todayAR(), -2)
    const award = rfqDetail().actions.find((a) => a.action === 'AWARD')!
    expect(award.enabled).toBe(false)
  })

  it('sólo Compras adjudica; Gerencia y Auditoría consultan; Producción no', () => {
    const rfq = byNumber('SCT-00001')
    expectBusinessError(() => cmdAwardRfq(ctx('contabilidad'), rfq.id, byNumber('COT-00002').id, ''), 'SIN_PERMISO')
    expect(rfqDetail('SCT-00001', 'gerencia').actions).toEqual([])
    expect(rfqDetail('SCT-00001', 'auditor').rfq!.quotes).toHaveLength(2)
    expect(() => rfqDetail('SCT-00001', 'produccion')).toThrow('Tu rol no tiene acceso a esta información.')
  })
})
