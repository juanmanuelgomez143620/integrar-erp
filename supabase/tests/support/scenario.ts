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
  // La vencida trae una percepción de ingresos brutos (Fase 7b).
  const overdue = E.cmdCreateSupplierInvoice(
    as('compras1'),
    company,
    { ...invoice(oc2.id, '7', '2201', [[oc2Line.id, 20, 1300]], addDays(todayAR(), -40)), perception: 390 },
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
  E.cmdPayPaymentOrder(as('tesoreria'), demoPayment.id, '00000451', 'CHEQUE')
  const partial = E.cmdCreatePaymentOrder(as('contabilidad'), company, payment(overdue.id, 10000), true)
  E.cmdApprovePaymentOrder(as('gerencia'), partial.id, '')
  E.cmdPayPaymentOrder(as('tesoreria'), partial.id, '')
  E.cmdCreatePaymentOrder(as('tesoreria'), company, payment(overdue.id, 5000, '1.1.01.01'), false)
  const rejectedPayment = E.cmdCreatePaymentOrder(as('contabilidad'), company, payment(overdue.id, 3000), true)
  E.cmdRejectPaymentOrder(as('gerencia'), rejectedPayment.id, 'Primero se paga lo vencido de otros proveedores')
  const reverted = E.cmdCreatePaymentOrder(as('contabilidad'), company, payment(overdue.id, 2000), true)
  E.cmdApprovePaymentOrder(as('gerencia'), reverted.id, '')
  E.cmdPayPaymentOrder(as('tesoreria'), reverted.id, '12345', 'CHEQUE')
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

  // Transferencias, sólo entre la caja y el banco (otras pruebas necesitan el
  // fondo fijo y los valores a depositar sin saldo): se confirma el depósito de
  // la demo, una extracción se confirma y se anula, otra queda confirmada y una
  // en borrador.
  const funds = (from: string, to: string, amount: number, reference = ''): E.FundsTransferInput => ({
    from_account_id: treasury(from),
    to_account_id: treasury(to),
    amount,
    reference,
    notes: '',
  })
  const demoTransfer = db.documents.find((d) => d.company_id === company && d.doc_type === 'FUNDS_TRANSFER')!
  E.cmdConfirmFundsTransfer(as('tesoreria'), demoTransfer.id)
  const twice = E.cmdCreateFundsTransfer(
    as('tesoreria'),
    company,
    funds('1.1.01.03', '1.1.01.01', 50000, 'Extracción por ventanilla'),
    true,
  )
  E.cmdCancelFundsTransfer(as('tesoreria'), twice.id, 'Se cargó dos veces')
  E.cmdCreateFundsTransfer(as('tesoreria'), company, funds('1.1.01.03', '1.1.01.01', 80000, 'Cheque 000045'), true)
  E.cmdCreateFundsTransfer(as('tesoreria'), company, funds('1.1.01.01', '1.1.01.03', 30000), false)

  // Conciliaciones a la fecha de la apertura (sólo ella figura en el extracto):
  // la del banco queda confirmada; una de la caja, anulada. Lo de hoy queda sin
  // conciliar para las pruebas de comandos (y el cheque de la demo, sin debitar).
  const opening = `${todayAR().slice(0, 4)}-01-01`
  const openingLines = (code: string) => E.accountLinesUpTo(db, treasury(code), opening).map(({ line }) => line.id)
  const reconciliation = (code: string, balance: number, notes = ''): E.BankReconciliationInput => ({
    account_id: treasury(code),
    statement_date: opening,
    statement_balance: balance,
    journal_line_ids: openingLines(code),
    notes,
  })
  E.cmdCreateBankReconciliation(as('contabilidad'), company, reconciliation('1.1.01.03', 12500000))
  const count = E.cmdCreateBankReconciliation(
    as('contabilidad'),
    company,
    reconciliation('1.1.01.01', 850000, 'Arqueo de prueba'),
  )
  E.cmdCancelBankReconciliation(as('contabilidad'), count.id, 'Era un arqueo, no un extracto')

  // Ventas: pedidos en cada estado y remitos despachados (uno con el flete, otro
  // parcial que deja una mesa bajo el mínimo), anulados y en preparación.
  const customer = (code: string) => db.customers.find((c) => c.company_id === company && c.code === code)!.id
  const salesOrder = (customerCode: string, lines: [string, number][]): E.SalesOrderInput => ({
    customer_id: customer(customerCode),
    warehouse_id: warehouse('DEP-PT'),
    delivery_date: null,
    payment_terms_days: 30,
    customer_reference: '',
    notes: '',
    lines: lines.map(([code, quantity]) => ({
      product_id: product(code).id,
      quantity,
      unit_price: product(code).sale_price!,
    })),
  })
  const orderLines = (orderId: string) =>
    db.soLines.filter((l) => l.document_id === orderId).sort((a, b) => a.line_no - b.line_no)
  const delivery = (orderId: string, quantities?: number[]): E.DeliveryNoteInput => ({
    sales_order_id: orderId,
    carrier_name: 'Transporte propio',
    notes: '',
    lines: orderLines(orderId).map((l, i) => ({ so_line_id: l.id, quantity: quantities?.[i] ?? l.quantity })),
  })
  const demoOrder = (number: string) =>
    db.documents.find((d) => d.company_id === company && d.display_number === number)!
  const demoDelivery = db.documents.find((d) => d.company_id === company && d.doc_type === 'DELIVERY_NOTE')!
  E.cmdConfirmDeliveryNote(as('deposito'), demoDelivery.id)
  const credit = demoOrder('PV-00002')
  E.cmdApproveSalesOrder(as('gerencia'), credit.id, 'Cliente de muchos años')
  E.cmdCreateDeliveryNote(as('deposito'), company, delivery(credit.id, [1]), true)
  E.cmdCreateDeliveryNote(as('deposito'), company, delivery(credit.id, [1]), false)
  const returned = E.cmdCreateSalesOrder(
    as('ventas'),
    company,
    salesOrder('CLI-002', [
      ['PT-003', 2],
      ['MR-001', 1],
    ]),
    true,
  )
  const returnedDelivery = E.cmdCreateDeliveryNote(as('deposito'), company, delivery(returned.id), true)
  E.cmdCancelDeliveryNote(as('gerencia'), returnedDelivery.id, 'El cliente no estaba: la mercadería volvió')
  const closedOrder = E.cmdCreateSalesOrder(as('ventas'), company, salesOrder('CLI-003', [['PT-004', 2]]), true)
  E.cmdCreateDeliveryNote(as('deposito'), company, delivery(closedOrder.id, [1]), true)
  E.cmdCloseSalesOrder(as('ventas'), closedOrder.id, 'El cliente ya no quiere la segunda cama')
  E.cmdCreateSalesOrder(as('ventas'), company, salesOrder('CLI-008', [['PT-002', 3]]), false)
  const rejectedOrder = E.cmdCreateSalesOrder(as('ventas'), company, salesOrder('CLI-006', [['PT-004', 3]]), true)
  E.cmdRejectSalesOrder(as('gerencia'), rejectedOrder.id, 'Supera el crédito: que pague la mitad por adelantado')
  const cancelledOrder = E.cmdCreateSalesOrder(as('ventas'), company, salesOrder('CLI-010', [['PT-002', 1]]), false)
  E.cmdCancelSalesOrder(as('ventas'), cancelledOrder.id, 'Se cargó al cliente equivocado')
  E.cmdCreateSalesOrder(as('ventas'), company, salesOrder('CLI-005', [['SV-001', 1]]), true)

  // Facturas de venta: la del pedido de la demo (letra A, ya vencida: el cliente
  // queda moroso y su pedido siguiente espera a Gerencia), una anulada con su
  // contraasiento, un borrador y una B a un consumidor final.
  const saleInvoice = (orderId: string): E.SalesInvoiceInput => ({
    sales_order_id: orderId,
    notes: '',
    lines: orderLines(orderId).flatMap((l) =>
      l.qty_delivered - E.salesInvoicedQuantity(db, l.id) > 0
        ? [{ so_line_id: l.id, quantity: l.qty_delivered - E.salesInvoicedQuantity(db, l.id) }]
        : [],
    ),
  })
  const demoInvoice = E.cmdCreateSalesInvoice(as('ventas'), company, saleInvoice(demoOrder('PV-00001').id), true)
  db.documents.find((d) => d.id === demoInvoice.id)!.fv!.due_date = addDays(todayAR(), -10)
  const wrongSale = E.cmdCreateSalesInvoice(as('ventas'), company, saleInvoice(closedOrder.id), true)
  E.cmdCancelSalesInvoice(as('ventas'), wrongSale.id, 'Se facturó al cliente equivocado')
  E.cmdCreateSalesInvoice(as('ventas'), company, saleInvoice(credit.id), false)
  const counter = E.cmdCreateSalesOrder(as('ventas'), company, salesOrder('CLI-009', [['PT-002', 1]]), true)
  E.cmdCreateDeliveryNote(as('deposito'), company, delivery(counter.id), true)
  const counterInvoice = E.cmdCreateSalesInvoice(as('ventas'), company, saleInvoice(counter.id), true)
  E.cmdCreateSalesOrder(as('ventas'), company, salesOrder('CLI-001', [['PT-002', 2]]), true)

  // Cobros: una parte de la factura vencida de la demo con un cheque del cliente
  // (a Valores a depositar, y después depositado en el banco), uno anulado con
  // su contraasiento, uno en borrador que reserva otra parte y la factura B
  // cobrada completa en efectivo.
  const collection = (
    invoiceId: string,
    amount: number,
    method: E.CustomerReceiptInput['payment_method'],
    code: string,
    reference = '',
  ): E.CustomerReceiptInput => ({
    customer_id: db.documents.find((d) => d.id === invoiceId)!.customer_id!,
    treasury_account_id: treasury(code),
    payment_method: method,
    reference,
    notes: '',
    lines: [{ invoice_id: invoiceId, amount }],
  })
  // El cliente retiene ingresos brutos (Fase 7b): el cheque es por el resto.
  const chequeReceipt = E.cmdCreateCustomerReceipt(
    as('tesoreria'),
    company,
    { ...collection(demoInvoice.id, 505000, 'CHEQUE', '1.1.01.04', '00004567'), retention: 5000 },
    true,
  )
  E.cmdCreateFundsTransfer(
    as('tesoreria'),
    company,
    funds('1.1.01.04', '1.1.01.03', 500000, 'Depósito del cheque 00004567'),
    true,
  )
  const bounced = E.cmdCreateCustomerReceipt(
    as('tesoreria'),
    company,
    collection(demoInvoice.id, 300000, 'TRANSFERENCIA', '1.1.01.03', 'TRF 8841'),
    true,
  )
  E.cmdCancelCustomerReceipt(as('tesoreria'), bounced.id, 'El banco rechazó la transferencia')
  E.cmdCreateCustomerReceipt(
    as('tesoreria'),
    company,
    collection(demoInvoice.id, 200000, 'EFECTIVO', '1.1.01.01'),
    false,
  )
  const counterTotal = db.documents.find((d) => d.id === counterInvoice.id)!.total
  E.cmdCreateCustomerReceipt(
    as('tesoreria'),
    company,
    collection(counterInvoice.id, counterTotal, 'EFECTIVO', '1.1.01.01'),
    true,
  )

  // Listas de precios: la mayorista (los precios de venta con un 10 % menos,
  // después +5 % y sin el flete) para CLI-008, y la de empleados, copiada de ella.
  // Presupuestos: uno aceptado (generó su pedido en borrador), uno rechazado,
  // uno enviado, uno vencido y un borrador.
  const wholesale = E.cmdCreatePriceList(as('ventas'), company, {
    code: 'MAY',
    name: 'Mayorista',
    description: 'Mueblerías y distribuidores',
    copy_from: 'SALE_PRICE',
    percent: -10,
  })
  E.cmdAdjustPriceList(as('ventas'), company, wholesale.id, 5)
  E.cmdSetPriceListPrice(as('ventas'), company, wholesale.id, product('SV-001').id, null)
  E.cmdCreatePriceList(as('ventas'), company, {
    code: 'EMP',
    name: 'Empleados',
    description: '',
    copy_from: wholesale.id,
    percent: -5,
  })
  const decoraciones = db.customers.find((c) => c.company_id === company && c.code === 'CLI-008')!
  E.cmdSaveMaster(as('ventas'), 'customer', company, {
    id: decoraciones.id,
    code: decoraciones.code,
    legal_name: decoraciones.legal_name,
    price_list_id: wholesale.id,
  })
  const salesQuote = (customerCode: string, lines: [string, number][]): E.SalesQuoteInput => {
    const buyer = db.customers.find((c) => c.id === customer(customerCode))!
    return {
      customer_id: buyer.id,
      warehouse_id: warehouse('DEP-PT'),
      valid_until: addDays(todayAR(), 15),
      payment_terms_days: 30,
      customer_reference: '',
      notes: '',
      lines: lines.map(([code, quantity]) => ({
        product_id: product(code).id,
        quantity,
        unit_price: E.listPriceFor(db, buyer, product(code)),
      })),
    }
  }
  const accepted = E.cmdCreateSalesQuote(
    as('ventas'),
    company,
    salesQuote('CLI-008', [
      ['PT-002', 4],
      ['PT-003', 1],
    ]),
    true,
  )
  E.cmdAcceptSalesQuote(as('ventas'), accepted.id)
  const declined = E.cmdCreateSalesQuote(as('ventas'), company, salesQuote('CLI-010', [['PT-004', 2]]), true)
  E.cmdRejectSalesQuote(as('ventas'), declined.id, 'Compró en otra mueblería')
  E.cmdCreateSalesQuote(as('ventas'), company, salesQuote('CLI-002', [['PT-001', 1]]), true)
  const late = E.cmdCreateSalesQuote(as('ventas'), company, salesQuote('CLI-006', [['MR-001', 2]]), true)
  db.documents.find((d) => d.id === late.id)!.qt!.valid_until = addDays(todayAR(), -2)
  E.cmdExpireSalesQuote(as('ventas'), late.id)
  E.cmdCreateSalesQuote(as('ventas'), company, salesQuote('CLI-004', [['PT-002', 2]]), false)

  // Un centro de trabajo nuevo, que después se desactivó.
  const painting = E.cmdSaveWorkCenter(as('produccion'), company, {
    id: '',
    code: 'PINTURA',
    name: 'Pintura',
    labor_rate: 7000,
    overhead_rate: 3000,
  })
  E.cmdSetWorkCenterActive(as('produccion'), company, painting.id, false)

  // Producción (además de la orden de la demo, liberada): dos mesas terminadas (con
  // dos pies de tabla de más), cuatro sillas en proceso, dos sillas anuladas después
  // de la entrega y diez placards planificados a los que les faltan placas.
  const productionOrder = (code: string, quantity: number): E.ProductionOrderInput => ({
    product_id: product(code).id,
    quantity,
    materials_warehouse_id: warehouse('DEP-MP'),
    output_warehouse_id: warehouse('DEP-PT'),
    due_date: addDays(todayAR(), 7),
    notes: '',
  })
  const issue = (docId: string, extra: Record<string, number> = {}) =>
    E.cmdIssueProductionOrder(as('deposito'), docId, {
      lines: db.prdLines
        .filter((l) => l.document_id === docId)
        .map((l) => ({
          line_id: l.id,
          quantity: extra[db.products.find((p) => p.id === l.product_id)!.code] ?? l.quantity_planned,
        })),
    })
  const tables = E.cmdCreateProductionOrder(as('produccion'), company, productionOrder('PT-001', 2), true)
  issue(tables.id, { 'MP-001': 22 })
  // En corte se trabajó una hora más que lo previsto; en los demás centros, lo previsto.
  const tableOperations = E.productionOrderOperations(db, tables.id)
  E.cmdFinishProductionOrder(as('produccion'), tables.id, 2, [{ operation_id: tableOperations[0].id, hours: 6 }])
  const chairs = E.cmdCreateProductionOrder(as('produccion'), company, productionOrder('PT-002', 4), true)
  issue(chairs.id)
  const spoiled = E.cmdCreateProductionOrder(as('produccion'), company, productionOrder('PT-002', 2), true)
  issue(spoiled.id)
  E.cmdCancelProductionOrder(as('produccion'), spoiled.id, 'Se cortó mal la madera')
  E.cmdCreateProductionOrder(as('produccion'), company, productionOrder('PT-003', 10), false)

  // RRHH: una categoría nueva (y otra desactivada), un ingreso al taller y una baja.
  const inCompany = <R extends { company_id: string; code: string }>(rows: R[], code: string) =>
    rows.find((r) => r.company_id === company && r.code === code)!
  E.cmdSaveJobCategory(as('rrhh'), company, {
    id: '',
    code: 'LUSTRADOR',
    name: 'Lustrador',
    agreement_id: inCompany(db.laborAgreements, 'MADERA').id,
    basic_salary: 6500,
    is_direct_labor: true,
  })
  E.cmdSetJobCategoryActive(as('rrhh'), company, inCompany(db.jobCategories, 'OPERARIO').id, false)
  E.cmdSaveEmployee(as('rrhh'), company, {
    id: '',
    first_name: 'Rubén',
    last_name: 'Acuña',
    hire_date: addDays(todayAR(), -20),
    category_id: inCompany(db.jobCategories, 'LUSTRADOR').id,
    sector_id: inCompany(db.sectors, 'PRO').id,
    work_center_id: inCompany(db.workCenters, 'TERMINACION').id,
  })
  const leaving = db.employees.find((e) => e.company_id === company && e.file_number === 9)!
  E.cmdTerminateEmployee(as('rrhh'), company, leaving.id, addDays(todayAR(), -3), 'Renuncia')

  // Sueldos: la liquidación del mes pasado, con novedades, confirmada y con los sueldos
  // pagados desde el banco (faltan sus cargas sociales); la de este mes, en borrador.
  const month = (offset: number) => {
    const d = new Date(`${todayAR().slice(0, 7)}-15T12:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() + offset)
    return d.toISOString().slice(0, 7)
  }
  const lastMonth = E.cmdCreatePayroll(as('rrhh'), company, {
    period: month(-1),
    payment_date: `${month(0)}-04`,
    notes: '',
  })
  const lastLines = E.payrollLines(db, lastMonth.id)
  // Dos del taller (por hora) y una administrativa (por mes).
  E.cmdUpdatePayrollLines(as('rrhh'), lastMonth.id, [
    { line_id: lastLines[1].id, days_worked: 0, hours_worked: 160, absence_days: 2, overtime_50: 4, overtime_100: 0 },
    { line_id: lastLines[2].id, days_worked: 0, hours_worked: 176, absence_days: 0, overtime_50: 0, overtime_100: 3.5 },
    { line_id: lastLines[3].id, days_worked: 28, hours_worked: 0, absence_days: 2, overtime_50: 2, overtime_100: 0 },
  ])
  E.cmdSubmitPayroll(as('rrhh'), lastMonth.id)
  E.cmdApprovePayroll(as('gerencia'), lastMonth.id, '')
  E.cmdPayPayrollSalaries(
    as('tesoreria'),
    lastMonth.id,
    db.accounts.find((a) => a.company_id === company && a.code === '1.1.01.03')!.id,
  )
  E.cmdCreatePayroll(as('rrhh'), company, {
    period: month(0),
    payment_date: `${month(1)}-05`,
    notes: 'Faltan las horas extra de la última semana',
  })

  // Impuestos: la factura de la compra de la demo, la de venta de PV-00001, la vencida (con su
  // percepción) y el cobro con cheque (con su retención) se registraron el mes pasado (se corre
  // la fecha de sus asientos), así hay libros IVA y percepciones y retenciones de un mes
  // terminado, y declaraciones con importes.
  for (const invoice of [
    db.documents.find((d) => d.company_id === company && d.display_number === 'FP-00001')!,
    db.documents.find((d) => d.id === demoInvoice.id)!,
    db.documents.find((d) => d.id === overdue.id)!,
    db.documents.find((d) => d.id === chequeReceipt.id)!,
  ]) {
    const entry = db.docLinks
      .filter((l) => l.from_document_id === invoice.id)
      .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
      .find((d) => d.doc_type === 'JOURNAL_ENTRY')!
    entry.document_date = `${month(-1)}-15`
  }

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
