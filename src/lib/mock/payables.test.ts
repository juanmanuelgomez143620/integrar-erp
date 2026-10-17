// Pruebas de la factura de proveedor, la imputación automática y la cuenta
// corriente (docs/FASE_3_COMPRAS_Y_TESORERIA.md) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from './db'
import {
  BusinessError,
  cmdApprovePaymentOrder,
  cmdApprovePurchaseOrder,
  cmdAssignRole,
  cmdCancelGoodsReceipt,
  cmdCancelPaymentOrder,
  cmdCancelSupplierInvoice,
  cmdConfirmSupplierInvoice,
  cmdCreateCompanyFromTemplate,
  cmdCreateCourse,
  cmdCreateGoodsReceipt,
  cmdCreatePaymentOrder,
  cmdCreatePurchaseOrder,
  cmdCreateSupplierInvoice,
  cmdPayPaymentOrder,
  cmdRejectPaymentOrder,
  cmdSavePostingRule,
  cmdSendPurchaseOrder,
  cmdSetPeriodStatus,
  cmdSubmitPaymentOrder,
  cmdSubmitPurchaseOrder,
  type Ctx,
  type SupplierInvoiceInput,
} from './engine'
import {
  documentDetail,
  invoiceableOrders,
  listPayables,
  listPostingRules,
  listTasks,
  paymentCandidates,
  supplierAccount,
  treasuryAccounts,
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
const doc = (id: string) => db.documents.find((d) => d.id === id)!
const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!
const supplierId = (code: string) => db.suppliers.find((s) => s.company_id === companyId() && s.code === code)!.id
const product = (code: string) => db.products.find((p) => p.company_id === companyId() && p.code === code)!
const warehouse = (code: string) => db.warehouses.find((w) => w.code === code)!.id

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

/** Líneas del asiento automático de una factura: [código, debe, haber]. */
function entryLines(invoiceId: string) {
  const link = db.docLinks.find(
    (l) => l.from_document_id === invoiceId && doc(l.to_document_id).je?.origin === 'AUTOMATICO',
  )!
  return db.jeLines
    .filter((l) => l.document_id === link.to_document_id)
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => [db.accounts.find((a) => a.id === l.account_id)!.code, l.debit, l.credit])
}

/** OC enviada a un proveedor por 10 placas MDF a $ 92.000 y una recepción de 6. */
function receivedOrder(supplierCode = 'PRV-002', received = 6) {
  const order = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), {
    supplier_id: supplierId(supplierCode),
    expected_date: null,
    warehouse_id: warehouse('DEP-MP'),
    payment_terms_days: 30,
    delivery_terms: '',
    notes: '',
    lines: [
      { product_id: product('MP-004').id, requisition_line_id: null, quantity: 10, unit_price: 92000, vat_rate: 21 },
    ],
  })
  cmdSubmitPurchaseOrder(ctx('compras1'), order.id)
  cmdApprovePurchaseOrder(ctx('gerencia'), order.id, 'ok')
  cmdSendPurchaseOrder(ctx('compras1'), order.id)
  const line = db.poLines.find((l) => l.document_id === order.id)!
  cmdCreateGoodsReceipt(
    ctx('deposito'),
    companyId(),
    {
      purchase_order_id: order.id,
      warehouse_id: warehouse('DEP-MP'),
      supplier_delivery_note: `R-${Math.random()}`,
      carrier_name: '',
      notes: '',
      lines: [{ po_line_id: line.id, quantity: received }],
    },
    true,
  )
  return { order: order.id, line: line.id }
}

function invoice(
  order: string,
  line: string,
  quantity: number,
  number = '100',
  unitPrice = 92000,
): SupplierInvoiceInput {
  return {
    purchase_order_id: order,
    point_of_sale: '7',
    invoice_number: number,
    document_date: '2027-05-10',
    notes: '',
    lines: [{ po_line_id: line, quantity, unit_price: unitPrice }],
  }
}

describe('factura de proveedor', () => {
  it('la demo registra la factura de la compra de ejemplo con su asiento y su deuda', () => {
    const fp = db.documents.find((d) => d.doc_type === 'SUPPLIER_INVOICE')!
    expect(fp).toMatchObject({
      display_number: 'FP-00001',
      status: 'REGISTRADA',
      subtotal: 220000,
      tax_total: 46200,
      total: 266200,
    })
    expect(fp.si).toMatchObject({ letter: 'A', point_of_sale: '00003', invoice_number: '00012874' })
    expect(entryLines(fp.id)).toEqual([
      ['1.1.05.02', 220000, 0],
      ['1.1.04.01', 46200, 0],
      ['2.1.01.01', 0, 266200],
    ])
    const [payable] = listPayables(db, userId('tesoreria'), companyId())
    expect(payable).toMatchObject({ supplier: { code: 'PRV-009' }, balance: 266200, invoices: 1 })
    const detail = documentDetail(db, userId('compras1'), companyId(), 'SUPPLIER_INVOICE', 'FP-00001')!
    expect(detail.related_order?.display_number).toBe('OC-00001')
    expect(detail.flow.map((f) => f.doc_type)).toEqual([
      'PURCHASE_REQUISITION',
      'PURCHASE_ORDER',
      'GOODS_RECEIPT',
      'SUPPLIER_INVOICE',
      'PAYMENT_ORDER',
      'JOURNAL_ENTRY',
    ])
  })

  it('no factura más de lo recibido; lo facturado se descuenta de lo pendiente', () => {
    const { order, line } = receivedOrder()
    expectBusinessError(
      () => cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 7), true),
      'CANTIDAD_EXCEDIDA',
    )
    const first = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 4), true)
    expect(doc(first.id)).toMatchObject({ status: 'REGISTRADA', total: 445280 })
    const pending = invoiceableOrders(db, userId('compras1'), companyId()).find((o) => o.order.id === order)!
    expect(pending.lines[0]).toMatchObject({ invoiced: 4, pending: 2 })
    expectBusinessError(
      () => cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 3, '101'), true),
      'CANTIDAD_EXCEDIDA',
    )
    // Un borrador no reserva: el control se repite al registrar.
    const draft = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 2, '101'), false)
    const other = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 2, '102'), true)
    expect(doc(other.id).status).toBe('REGISTRADA')
    expectBusinessError(() => cmdConfirmSupplierInvoice(ctx('compras1'), draft.id), 'CANTIDAD_EXCEDIDA')
  })

  it('no se carga dos veces el mismo comprobante del mismo proveedor', () => {
    const { order, line } = receivedOrder()
    cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 1), true)
    expectBusinessError(
      () => cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 1), true),
      'DATO_INVALIDO',
    )
  })

  it('con un proveedor monotributista es factura C: el IVA no se discrimina', () => {
    const { order, line } = receivedOrder('PRV-010', 2)
    const fp = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 2, '1', 50000), true)
    expect(doc(fp.id)).toMatchObject({ tax_total: 0, total: 100000 })
    expect(doc(fp.id).si!.letter).toBe('C')
    expect(entryLines(fp.id)).toEqual([
      ['1.1.05.01', 100000, 0],
      ['2.1.01.01', 0, 100000],
    ])
  })

  it('anular una factura registrada revierte el asiento y la deuda, y libera lo facturado', () => {
    const { order, line } = receivedOrder()
    const fp = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 6), true)
    expectBusinessError(() => cmdCancelSupplierInvoice(ctx('compras1'), fp.id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelSupplierInvoice(ctx('compras1'), fp.id, 'El proveedor la refacturó')
    expect(doc(fp.id)).toMatchObject({ status: 'ANULADA' })
    const entry = db.docLinks.find(
      (l) => l.from_document_id === fp.id && doc(l.to_document_id).je?.origin === 'AUTOMATICO',
    )!
    expect(doc(entry.to_document_id).status).toBe('ANULADO')
    expect(db.documents.some((d) => d.je?.reverses_id === entry.to_document_id)).toBe(true)
    expect(listPayables(db, userId('compras1'), companyId()).map((p) => p.supplier.code)).not.toContain('PRV-002')
    const again = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 6, '200'), true)
    expect(doc(again.id).status).toBe('REGISTRADA')
  })

  it('no se anula una recepción ya facturada: primero se anula la factura', () => {
    const { order, line } = receivedOrder()
    const receipt = db.documents.find((d) => d.doc_type === 'GOODS_RECEIPT' && d.gr?.purchase_order_id === order)!
    const fp = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 2), true)
    expectBusinessError(
      () => cmdCancelGoodsReceipt(ctx('gerencia'), receipt.id, 'Se cargó dos veces'),
      'TRANSICION_INVALIDA',
    )
    cmdCancelSupplierInvoice(ctx('compras1'), fp.id, 'Hay que anular la recepción')
    cmdCancelGoodsReceipt(ctx('gerencia'), receipt.id, 'Se cargó dos veces')
    expect(doc(receipt.id).status).toBe('ANULADO')
  })

  it('respeta los permisos, el período cerrado y las reglas de imputación', () => {
    const { order, line } = receivedOrder()
    expectBusinessError(
      () => cmdCreateSupplierInvoice(ctx('deposito'), companyId(), invoice(order, line, 1), true),
      'SIN_PERMISO',
    )
    expectBusinessError(
      () => cmdCreateSupplierInvoice(ctx('contabilidad'), companyId(), invoice(order, line, 1), true),
      'SIN_PERMISO',
    )
    const may = db.fiscalPeriods.find((p) => p.company_id === companyId() && p.name === 'Mayo 2027')!
    cmdSetPeriodStatus(ctx('contabilidad'), companyId(), may.id, 'CERRADO', '')
    expectBusinessError(
      () => cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 1), true),
      'PERIODO_CERRADO',
    )
    cmdSetPeriodStatus(ctx('docente'), companyId(), may.id, 'ABIERTO', 'Faltaba una factura')
    // (Sin la transacción de la aplicación, el intento anterior quedó a medias: otro número.)
    db.postingRules = db.postingRules.filter((r) => r.key !== 'MATERIA_PRIMA')
    expectBusinessError(
      () => cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 1, '101'), true),
      'FALTA_IMPUTACION',
    )
  })
})

describe('imputación automática', () => {
  it('Contabilidad cambia la cuenta de una regla y la próxima compra la usa', () => {
    const rule = listPostingRules(db, userId('contabilidad'), companyId()).find((r) => r.key === 'MATERIA_PRIMA')!
    expect(rule.account.code).toBe('1.1.05.01')
    expectBusinessError(
      () => cmdSavePostingRule(ctx('compras1'), companyId(), rule.id, account('1.1.05.03').id),
      'SIN_PERMISO',
    )
    expectBusinessError(
      () => cmdSavePostingRule(ctx('contabilidad'), companyId(), rule.id, account('1.1.05').id),
      'DATO_INVALIDO',
    )
    cmdSavePostingRule(ctx('contabilidad'), companyId(), rule.id, account('1.1.05.03').id)
    const { order, line } = receivedOrder()
    const fp = cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 1), true)
    expect(entryLines(fp.id)[0]).toEqual(['1.1.05.03', 92000, 0])
  })

  it('las empresas de los cursos copian las reglas con sus propias cuentas', () => {
    const course = cmdCreateCourse(ctx('admin'), { academic_year: 2027, name: '5.º C', orientation: 'Gestión' })
    const created = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course })
    const rules = db.postingRules.filter((r) => r.company_id === created.id)
    expect(rules).toHaveLength(db.postingRules.filter((r) => r.company_id === companyId()).length)
    expect(rules.every((r) => db.accounts.find((a) => a.id === r.account_id)!.company_id === created.id)).toBe(true)
  })
})

describe('cuenta corriente de proveedores', () => {
  it('lista facturas con saldo acumulado y las pendientes con vencimiento', () => {
    const { order, line } = receivedOrder()
    cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 2), true)
    cmdCreateSupplierInvoice(ctx('compras1'), companyId(), invoice(order, line, 1, '101'), true)
    const account = supplierAccount(db, userId('tesoreria'), companyId(), supplierId('PRV-002'))!
    expect(account.movements.map((m) => m.balance)).toEqual([222640, 333960])
    expect(account.pending.map((p) => p.due_date)).toEqual(['2027-06-09', '2027-06-09'])
    expect(account.balance).toBe(333960)
    expect(supplierAccount(db, userId('tesoreria'), companyId(), 'no-existe')).toBeNull()
    expect(() => listPayables(db, userId('deposito'), companyId())).toThrow()
  })
})

describe('órdenes de pago', () => {
  const demoInvoice = () => db.documents.find((d) => d.doc_type === 'SUPPLIER_INVOICE')!
  const demoOrder = () => db.documents.find((d) => d.doc_type === 'PAYMENT_ORDER')!
  const sector = (code: string) => db.sectors.find((s) => s.company_id === companyId() && s.code === code)!.id
  /** Orden de pago de una factura, desde el banco por defecto. */
  const order = (invoiceId: string, amount: number, from = '1.1.01.03', supplier?: string) => ({
    supplier_id: supplier ?? doc(invoiceId).supplier_id!,
    treasury_account_id: account(from).id,
    notes: '',
    lines: [{ invoice_id: invoiceId, amount }],
  })
  /** Líneas del asiento automático de un documento: [código, debe, haber]. */
  const automaticLines = (docId: string) => entryLines(docId)

  it('la demo deja la orden de pago de su factura esperando la autorización de Gerencia', () => {
    const op = demoOrder()
    expect(op).toMatchObject({ display_number: 'OP-00001', status: 'PENDIENTE_APROBACION', total: 266200 })
    const tasks = listTasks(db, userId('gerencia'), companyId(), 'mine', false)
    expect(tasks.map((t) => t.task_type)).toContain('APROBAR_PAGO')
    // Mientras tanto, la factura sigue con saldo pero ya no se puede reservar de nuevo.
    const [candidate] = paymentCandidates(db, userId('tesoreria'), companyId(), demoInvoice().supplier_id!)
    expect(candidate).toMatchObject({ committed: 266200, available: 0 })
  })

  it('circuito completo: Gerencia aprueba, Tesorería paga, se genera el asiento y la deuda se cancela', () => {
    const op = demoOrder()
    cmdApprovePaymentOrder(ctx('gerencia'), op.id, 'Vence este mes')
    expect(doc(op.id).status).toBe('APROBADA')
    cmdPayPaymentOrder(ctx('tesoreria'), op.id, 'Transferencia 000123')
    expect(doc(op.id)).toMatchObject({ status: 'PAGADA' })
    expect(doc(op.id).op).toMatchObject({ payment_reference: 'Transferencia 000123', paid_on: '2027-05-14' })
    expect(automaticLines(op.id)).toEqual([
      ['2.1.01.01', 266200, 0],
      ['1.1.01.03', 0, 266200],
    ])
    expect(doc(demoInvoice().id).status).toBe('PAGADA')
    const [payable] = listPayables(db, userId('tesoreria'), companyId())
    expect(payable).toMatchObject({ balance: 0, invoices: 0 })
    const statement = supplierAccount(db, userId('tesoreria'), companyId(), demoInvoice().supplier_id!)!
    expect(statement.movements.map((m) => [m.debit, m.credit, m.balance])).toEqual([
      [0, 266200, 266200],
      [266200, 0, 0],
    ])
    expect(statement.pending).toEqual([])
    const bank = treasuryAccounts(db, userId('tesoreria'), companyId()).find((t) => t.account.code === '1.1.01.03')!
    expect(bank.balance).toBe(12500000 + 300000 - 266200)
  })

  it('separación de funciones: quien prepara no aprueba y quien registró la factura no la paga', () => {
    cmdAssignRole(ctx('docente'), companyId(), userId('gerencia'), 'TESORERIA', sector('TES'))
    cmdAssignRole(ctx('docente'), companyId(), userId('compras1'), 'TESORERIA', sector('TES'))
    cmdCancelPaymentOrder(ctx('contabilidad'), demoOrder().id, 'Se prepara de nuevo')
    const own = cmdCreatePaymentOrder(ctx('gerencia'), companyId(), order(demoInvoice().id, 1000), true)
    expectBusinessError(() => cmdApprovePaymentOrder(ctx('gerencia'), own.id, ''), 'SEPARACION_FUNCIONES')
    expectBusinessError(() => cmdApprovePaymentOrder(ctx('tesoreria'), own.id, ''), 'SIN_PERMISO')
    cmdCancelPaymentOrder(ctx('tesoreria'), own.id, 'La prepara Contabilidad')
    const op = cmdCreatePaymentOrder(ctx('contabilidad'), companyId(), order(demoInvoice().id, 1000), true)
    cmdApprovePaymentOrder(ctx('gerencia'), op.id, '')
    // compras1 registró FP-00001.
    expectBusinessError(() => cmdPayPaymentOrder(ctx('compras1'), op.id, ''), 'SEPARACION_FUNCIONES')
    cmdPayPaymentOrder(ctx('tesoreria'), op.id, '')
    expect(doc(demoInvoice().id).status).toBe('PAGADA_PARCIAL')
  })

  it('no se paga más que el saldo ni se reserva dos veces lo mismo', () => {
    const fp = demoInvoice()
    expectBusinessError(
      () => cmdCreatePaymentOrder(ctx('contabilidad'), companyId(), order(fp.id, 100), true),
      'IMPORTE_EXCEDIDO',
    )
    cmdRejectPaymentOrder(ctx('gerencia'), demoOrder().id, 'Esperar al vencimiento')
    expect(doc(demoOrder().id).status).toBe('RECHAZADA')
    expectBusinessError(
      () => cmdCreatePaymentOrder(ctx('contabilidad'), companyId(), order(fp.id, 266200.01), true),
      'IMPORTE_EXCEDIDO',
    )
    expectBusinessError(
      () => cmdCreatePaymentOrder(ctx('contabilidad'), companyId(), order(fp.id, 10.005), true),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreatePaymentOrder(ctx('contabilidad'), companyId(), order(fp.id, 1000, '2.1.01.01'), true),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () =>
        cmdCreatePaymentOrder(
          ctx('contabilidad'),
          companyId(),
          order(fp.id, 1000, '1.1.01.03', supplierId('PRV-001')),
          true,
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdCreatePaymentOrder(ctx('compras1'), companyId(), order(fp.id, 1000), true),
      'SIN_PERMISO',
    )
    const first = cmdCreatePaymentOrder(ctx('contabilidad'), companyId(), order(fp.id, 200000), false)
    expect(doc(first.id).status).toBe('BORRADOR')
    expectBusinessError(
      () => cmdCreatePaymentOrder(ctx('tesoreria'), companyId(), order(fp.id, 66200.01), true),
      'IMPORTE_EXCEDIDO',
    )
    cmdCreatePaymentOrder(ctx('tesoreria'), companyId(), order(fp.id, 66200), true)
    expect(paymentCandidates(db, userId('contabilidad'), companyId(), fp.supplier_id!)[0]).toMatchObject({
      committed: 266200,
      available: 0,
    })
    cmdSubmitPaymentOrder(ctx('contabilidad'), first.id)
    expect(doc(first.id).status).toBe('PENDIENTE_APROBACION')
  })

  it('no se paga si la caja o el banco no tiene saldo', () => {
    cmdCancelPaymentOrder(ctx('contabilidad'), demoOrder().id, 'Se paga desde el fondo fijo')
    const op = cmdCreatePaymentOrder(ctx('contabilidad'), companyId(), order(demoInvoice().id, 5000, '1.1.01.02'), true)
    cmdApprovePaymentOrder(ctx('gerencia'), op.id, '')
    expectBusinessError(() => cmdPayPaymentOrder(ctx('tesoreria'), op.id, ''), 'SALDO_INSUFICIENTE')
    expect(doc(op.id).status).toBe('APROBADA')
  })

  it('una factura en una orden en curso no se anula; una orden pagada se anula con contraasiento', () => {
    const fp = demoInvoice()
    const op = demoOrder()
    expectBusinessError(() => cmdCancelSupplierInvoice(ctx('compras1'), fp.id, 'Error de carga'), 'TRANSICION_INVALIDA')
    cmdApprovePaymentOrder(ctx('gerencia'), op.id, '')
    cmdPayPaymentOrder(ctx('tesoreria'), op.id, '')
    expectBusinessError(() => cmdCancelPaymentOrder(ctx('tesoreria'), op.id, ''), 'MOTIVO_REQUERIDO')
    expectBusinessError(() => cmdCancelPaymentOrder(ctx('gerencia'), op.id, 'Error'), 'SIN_PERMISO')
    cmdCancelPaymentOrder(ctx('tesoreria'), op.id, 'La transferencia fue rechazada')
    expect(doc(op.id).status).toBe('ANULADA')
    expect(doc(fp.id).status).toBe('REGISTRADA')
    const payment = db.docLinks.find(
      (l) => l.from_document_id === op.id && doc(l.to_document_id).je?.origin === 'AUTOMATICO',
    )!
    expect(doc(payment.to_document_id).status).toBe('ANULADO')
    expect(listPayables(db, userId('tesoreria'), companyId())[0]).toMatchObject({ balance: 266200, invoices: 1 })
    // Ya sin órdenes en curso, la factura se puede anular.
    cmdCancelSupplierInvoice(ctx('compras1'), fp.id, 'Error de carga')
    expect(doc(fp.id).status).toBe('ANULADA')
  })
})
