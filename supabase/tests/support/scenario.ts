// Estado de prueba para comparar lecturas: el seed de la demo más operaciones
// hechas con el motor simulado que dejan documentos en (casi) todos los
// estados, tareas tomadas, avisos leídos y movimientos de stock de cada tipo.

import { addDays, todayAR } from '../../../src/lib/format'
import type { DB } from '../../../src/lib/mock/db'
import * as E from '../../../src/lib/mock/engine'
import { buildSeed } from '../../../src/lib/mock/seed'

export function buildScenario(): DB {
  const db = buildSeed()
  const company = db.companies.find((c) => c.is_template)!.id
  // Cada operación diez segundos después de la anterior (el orden por fecha no
  // tiene empates), entre lo último del seed (hace 26 minutos) y el momento en
  // que se arma: así todo queda antes de lo que hagan las pruebas de comandos.
  let clock = Date.parse(db.seededAt) - 25 * 60_000
  const as = (username: string): E.Ctx => {
    clock += 10_000
    if (clock >= Date.parse(db.seededAt))
      throw new Error('El escenario tiene demasiadas operaciones para su ventana de tiempo.')
    return { db, userId: db.profiles.find((p) => p.username === username)!.id, now: new Date(clock).toISOString() }
  }
  const product = (code: string) => db.products.find((p) => p.code === code)!
  const supplier = (code: string) => db.suppliers.find((s) => s.code === code)!.id
  const warehouse = (code: string) => db.warehouses.find((w) => w.code === code)!.id
  const requisition = (lines: [string, number][], reason = 'Reposición para la producción del mes') => ({
    needed_by: null,
    priority: 'NORMAL' as const,
    reason,
    notes: '',
    lines: lines.map(([code, quantity]) => ({ product_id: product(code).id, quantity })),
  })
  const order = (supplierCode: string, lines: [string, number, number, string | null][]): E.PurchaseOrderInput => ({
    supplier_id: supplier(supplierCode),
    expected_date: null,
    warehouse_id: warehouse('DEP-MP'),
    payment_terms_days: 30,
    delivery_terms: 'Puesto en planta',
    notes: '',
    lines: lines.map(([code, quantity, unit_price, requisition_line_id]) => ({
      product_id: product(code).id,
      requisition_line_id,
      quantity,
      unit_price,
      vat_rate: 21,
    })),
  })

  // SC solicitada y atendida en parte por una OC aprobada, enviada y recibida a medias.
  const sc2 = E.cmdCreateRequisition(
    as('produccion'),
    company,
    requisition([
      ['MP-001', 100],
      ['MP-004', 10],
    ]),
    true,
  )
  const sc2Line = db.prLines.find((l) => l.document_id === sc2.id && l.product_id === product('MP-001').id)!
  const oc2 = E.cmdCreatePurchaseOrder(as('compras1'), company, order('PRV-001', [['MP-001', 60, 1300, sc2Line.id]]))
  E.cmdSubmitPurchaseOrder(as('compras1'), oc2.id)
  E.cmdApprovePurchaseOrder(as('compras2'), oc2.id, 'Precio dentro de lo presupuestado')
  E.cmdSendPurchaseOrder(as('compras1'), oc2.id)
  const oc2Line = db.poLines.find((l) => l.document_id === oc2.id)!
  const receipt = (quantity: number, note: string): E.GoodsReceiptInput => ({
    purchase_order_id: oc2.id,
    warehouse_id: warehouse('DEP-MP'),
    supplier_delivery_note: note,
    carrier_name: 'Transporte Iguazú',
    notes: '',
    lines: [{ po_line_id: oc2Line.id, quantity }],
  })
  E.cmdCreateGoodsReceipt(as('deposito'), company, receipt(30, 'R-0001-00000451'), true)
  E.cmdCreateGoodsReceipt(as('deposito'), company, receipt(10, 'R-0001-00000478'), false)

  // Facturas de esa OC: una vencida (de hace 40 días, a 30 días), una en
  // borrador y una registrada y anulada con el contraasiento de su asiento.
  const invoice = (
    orderId: string,
    pos: string,
    number: string,
    lines: [string, number, number][],
    date = todayAR(),
  ): E.SupplierInvoiceInput => ({
    purchase_order_id: orderId,
    point_of_sale: pos,
    invoice_number: number,
    document_date: date,
    notes: '',
    lines: lines.map(([po_line_id, quantity, unit_price]) => ({ po_line_id, quantity, unit_price })),
  })
  const overdue = E.cmdCreateSupplierInvoice(
    as('compras1'),
    company,
    invoice(oc2.id, '7', '2201', [[oc2Line.id, 20, 1300]], addDays(todayAR(), -40)),
    true,
  )
  E.cmdCreateSupplierInvoice(as('compras2'), company, invoice(oc2.id, '7', '2202', [[oc2Line.id, 5, 1300]]), false)
  const wrongInvoice = E.cmdCreateSupplierInvoice(
    as('compras1'),
    company,
    invoice(oc2.id, '7', '2203', [[oc2Line.id, 5, 1350]]),
    true,
  )
  E.cmdCancelSupplierInvoice(as('compras1'), wrongInvoice.id, 'El precio no es el de la orden de compra')

  // Un servicio de un monotributista, al contado: factura C (el IVA es parte del costo).
  const service = E.cmdCreatePurchaseOrder(as('compras2'), company, {
    ...order('PRV-010', [['SV-001', 1, 38000, null]]),
    payment_terms_days: 0,
  })
  E.cmdSubmitPurchaseOrder(as('compras2'), service.id)
  E.cmdApprovePurchaseOrder(as('compras1'), service.id, 'Flete urgente')
  E.cmdSendPurchaseOrder(as('compras2'), service.id)
  const serviceLine = db.poLines.find((l) => l.document_id === service.id)!
  E.cmdCreateGoodsReceipt(
    as('deposito'),
    company,
    {
      purchase_order_id: service.id,
      warehouse_id: warehouse('DEP-MP'),
      supplier_delivery_note: 'R-0002-00000033',
      carrier_name: '',
      notes: 'Servicio prestado.',
      lines: [{ po_line_id: serviceLine.id, quantity: 1 }],
    },
    true,
  )
  const serviceInvoice = E.cmdCreateSupplierInvoice(
    as('compras2'),
    company,
    invoice(service.id, '2', '845', [[serviceLine.id, 1, 38000]]),
    true,
  )

  // Órdenes de pago en cada estado: la de la demo, aprobada y pagada; un pago
  // parcial de la factura vencida, un borrador desde la caja, una rechazada y
  // una pagada y anulada con su contraasiento; y la del servicio, aprobada.
  const treasury = (code: string) => db.accounts.find((a) => a.company_id === company && a.code === code)!.id
  const payment = (invoiceId: string, amount: number, from = '1.1.01.03'): E.PaymentOrderInput => ({
    supplier_id: db.documents.find((d) => d.id === invoiceId)!.supplier_id!,
    treasury_account_id: treasury(from),
    notes: '',
    lines: [{ invoice_id: invoiceId, amount }],
  })
  const demoPayment = db.documents.find((d) => d.company_id === company && d.doc_type === 'PAYMENT_ORDER')!
  E.cmdApprovePaymentOrder(as('gerencia'), demoPayment.id, 'Vence este mes')
  E.cmdPayPaymentOrder(as('tesoreria'), demoPayment.id, 'Transferencia 000451')
  const partial = E.cmdCreatePaymentOrder(as('contabilidad'), company, payment(overdue.id, 10000), true)
  E.cmdApprovePaymentOrder(as('gerencia'), partial.id, '')
  E.cmdPayPaymentOrder(as('tesoreria'), partial.id, '')
  E.cmdCreatePaymentOrder(as('tesoreria'), company, payment(overdue.id, 5000, '1.1.01.01'), false)
  const rejectedPayment = E.cmdCreatePaymentOrder(as('contabilidad'), company, payment(overdue.id, 3000), true)
  E.cmdRejectPaymentOrder(as('gerencia'), rejectedPayment.id, 'Primero se paga lo vencido de otros proveedores')
  const reverted = E.cmdCreatePaymentOrder(as('contabilidad'), company, payment(overdue.id, 2000), true)
  E.cmdApprovePaymentOrder(as('gerencia'), reverted.id, '')
  E.cmdPayPaymentOrder(as('tesoreria'), reverted.id, 'Cheque 12345')
  E.cmdCancelPaymentOrder(as('tesoreria'), reverted.id, 'El cheque fue rechazado')
  const servicePayment = E.cmdCreatePaymentOrder(
    as('tesoreria'),
    company,
    payment(serviceInvoice.id, 38000, '1.1.01.01'),
    true,
  )
  E.cmdApprovePaymentOrder(as('gerencia'), servicePayment.id, '')

  // SC en borrador y SC rechazada por Compras.
  E.cmdCreateRequisition(as('produccion'), company, requisition([['IN-001', 5]]), false)
  const sc4 = E.cmdCreateRequisition(as('produccion'), company, requisition([['IN-002', 8]]), true)
  E.cmdRejectRequisition(as('compras1'), sc4.id, 'Hay barniz suficiente en el depósito')

  // OC en borrador, OC grande esperando a Gerencia, OC rechazada y OC anulada.
  E.cmdCreatePurchaseOrder(as('compras2'), company, order('PRV-002', [['MP-004', 5, 92000, null]]))
  const big = E.cmdCreatePurchaseOrder(as('compras1'), company, order('PRV-002', [['MP-006', 10, 115000, null]]))
  E.cmdSubmitPurchaseOrder(as('compras1'), big.id)
  const rejected = E.cmdCreatePurchaseOrder(as('compras1'), company, order('PRV-004', [['IN-002', 10, 18000, null]]))
  E.cmdSubmitPurchaseOrder(as('compras1'), rejected.id)
  E.cmdRejectPurchaseOrder(as('compras2'), rejected.id, 'Pedí otra cotización: el precio subió')
  const cancelled = E.cmdCreatePurchaseOrder(as('compras2'), company, order('PRV-005', [['IN-003', 4, 14000, null]]))
  E.cmdCancelPurchaseOrder(as('compras2'), cancelled.id, 'Se cargó por error')

  // Cotizaciones en cada estado. En la solicitud de la demo responde además un
  // proveedor que no cotiza todo, y la oferta más barata ya venció; otra
  // solicitud queda en borrador, otra adjudicada (con su OC en borrador, una
  // cotización anulada y las demás descartadas) y otra anulada.
  const demoRfq = db.documents.find((d) => d.company_id === company && d.doc_type === 'RFQ')!
  const rfqItems = (rfqId: string) =>
    db.rfqLines.filter((l) => l.document_id === rfqId).sort((a, b) => a.line_no - b.line_no)
  const quote = (
    rfqId: string,
    supplierCode: string,
    prices: (number | null)[],
    delivery = 5,
    terms = 30,
  ): E.SupplierQuoteInput => ({
    rfq_id: rfqId,
    supplier_id: supplier(supplierCode),
    supplier_reference: '',
    valid_until: addDays(todayAR(), 7),
    delivery_days: delivery,
    payment_terms_days: terms,
    notes: '',
    lines: rfqItems(rfqId).flatMap((l, i) =>
      prices[i] == null ? [] : [{ rfq_line_id: l.id, unit_price: prices[i]!, vat_rate: 21 }],
    ),
  })
  E.cmdCreateSupplierQuote(as('compras2'), company, quote(demoRfq.id, 'PRV-009', [86000, null], 3, 0))
  // Pasó el tiempo: la oferta más barata de la demo ya venció.
  db.documents.find((d) => d.sq?.rfq_id === demoRfq.id && d.supplier_id === supplier('PRV-001'))!.sq!.valid_until =
    addDays(todayAR(), -1)
  const rfqInput = (suppliers: string[], lines: [string, number][]): E.RfqInput => ({
    response_due: addDays(todayAR(), 4),
    warehouse_id: warehouse('DEP-MP'),
    notes: '',
    supplier_ids: suppliers.map(supplier),
    lines: lines.map(([code, quantity]) => ({ product_id: product(code).id, quantity, requisition_line_id: null })),
  })
  E.cmdCreateRfq(as('compras2'), company, rfqInput(['PRV-003', 'PRV-009'], [['IN-004', 100]]), false)
  const awardedRfq = E.cmdCreateRfq(
    as('compras1'),
    company,
    rfqInput(
      ['PRV-003', 'PRV-005', 'PRV-010'],
      [
        ['IN-003', 10],
        ['IN-004', 50],
      ],
    ),
    true,
  )
  const usual = E.cmdCreateSupplierQuote(as('compras1'), company, quote(awardedRfq.id, 'PRV-003', [14500, 2300], 4))
  const mistaken = E.cmdCreateSupplierQuote(as('compras2'), company, quote(awardedRfq.id, 'PRV-005', [13000, 2100], 2))
  E.cmdCancelSupplierQuote(as('compras2'), mistaken.id, 'Se cargó el precio sin el descuento')
  E.cmdCreateSupplierQuote(as('compras2'), company, quote(awardedRfq.id, 'PRV-005', [12800, 2100], 2))
  E.cmdCreateSupplierQuote(as('compras1'), company, quote(awardedRfq.id, 'PRV-010', [15000, 2600], 1, 0))
  E.cmdAwardRfq(
    as('compras1'),
    awardedRfq.id,
    usual.id,
    'Herrajes Guaraníes es el proveedor habitual y da garantía de un año.',
  )
  const droppedRfq = E.cmdCreateRfq(as('compras2'), company, rfqInput(['PRV-004', 'PRV-009'], [['IN-002', 12]]), true)
  E.cmdCreateSupplierQuote(as('compras2'), company, quote(droppedRfq.id, 'PRV-004', [17500]))
  E.cmdCancelRfq(as('compras1'), droppedRfq.id, 'Producción ya no necesita el barniz este mes')

  // Ajustes: una rotura confirmada y un conteo en borrador.
  E.cmdCreateStockAdjustment(
    as('deposito'),
    company,
    {
      warehouse_id: warehouse('DEP-MP'),
      reason_code: 'ROTURA',
      notes: 'Tablas dañadas por humedad',
      lines: [{ product_id: product('MP-001').id, quantity_delta: -2 }],
    },
    true,
  )
  E.cmdCreateStockAdjustment(
    as('deposito'),
    company,
    {
      warehouse_id: warehouse('DEP-MP'),
      reason_code: 'CONTEO_FISICO',
      notes: '',
      lines: [{ product_id: product('IN-003').id, quantity_delta: 3, unit_cost: 14000 }],
    },
    false,
  )

  // Contabilidad: un asiento registrado, otro anulado con contraasiento, un
  // borrador descartado, una cuenta nueva y un mes cerrado que no es el actual
  // (además de la apertura, el depósito y el borrador del seed).
  const account = (code: string) => db.accounts.find((a) => a.company_id === company && a.code === code)!.id
  const entry = (description: string, debitCode: string, creditCode: string, amount: number): E.JournalEntryInput => ({
    document_date: todayAR(),
    description,
    lines: [
      { account_id: account(debitCode), debit: amount, credit: 0 },
      { account_id: account(creditCode), debit: 0, credit: amount, notes: 'Pago en el día' },
    ],
  })
  E.cmdCreateJournalEntry(
    as('contabilidad'),
    company,
    entry('Compra de útiles de librería en efectivo.', '5.2.02.05', '1.1.01.01', 42500),
    true,
  )
  const wrong = E.cmdCreateJournalEntry(
    as('contabilidad'),
    company,
    entry('Pago de la póliza de seguros por banco.', '5.2.02.06', '1.1.01.03', 120000),
    true,
  )
  E.cmdCancelJournalEntry(as('contabilidad'), wrong.id, 'Se cargó un importe equivocado')
  const discarded = E.cmdCreateJournalEntry(
    as('contabilidad'),
    company,
    entry('Borrador de prueba.', '5.2.02.07', '1.1.01.01', 1000),
    false,
  )
  E.cmdCancelJournalEntry(as('contabilidad'), discarded.id, 'Era una prueba')
  E.cmdSaveAccount(as('contabilidad'), company, {
    code: '1.1.01.05',
    name: 'Banco de la Selva caja de ahorro',
    description: 'Segunda cuenta bancaria (ficticia).',
    is_contra: false,
  })
  const otherMonth = todayAR().slice(5, 7) === '01' ? 12 : 1
  const closed = db.fiscalPeriods.find((p) => p.company_id === company && p.number === otherMonth)!
  E.cmdSetPeriodStatus(as('contabilidad'), company, closed.id, 'CERRADO', '')

  // Una tarea tomada y los avisos de Compras leídos.
  const task = db.tasks.find(
    (t) => t.company_id === company && t.assigned_role === 'COMPRAS' && t.status === 'PENDIENTE',
  )!
  E.cmdClaimTask(as('compras1'), task.id, true)
  E.cmdMarkNotificationsRead(as('compras2'), 'all', company)
  return db
}
