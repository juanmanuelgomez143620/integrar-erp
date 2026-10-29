// Pruebas de los libros IVA, de la declaración mensual de IVA y de la de ingresos brutos con sus
// percepciones y retenciones (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §2 y §3) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { money } from '../format'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdAssignRole,
  cmdCancelCustomerReceipt,
  cmdCancelPaymentOrder,
  cmdCancelSalesInvoice,
  cmdCancelSupplierInvoice,
  cmdCancelTaxReturn,
  cmdConfirmDeliveryNote,
  cmdCreateCustomerReceipt,
  cmdCreateSalesInvoice,
  cmdCreateSupplierInvoice,
  cmdCreateTaxReturn,
  cmdPayTaxReturn,
  cmdPresentTaxReturn,
  cmdUpdateCompanySettings,
  cmdApprovePayroll,
  cmdCreatePayroll,
  cmdPayPayrollSalaries,
  cmdSubmitPayroll,
  type Ctx,
  type TaxReturnInput,
} from './engine'
import { cashFlow, cashProjection, documentDetail, ivaBook, obligationsCalendar } from './queries'
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
const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!.id
const round2 = (n: number) => Math.round(n * 100) / 100
const at = (iso: string) => vi.setSystemTime(new Date(`${iso}T10:00:00-03:00`))

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

/** Los asientos automáticos de un documento, por cuenta. */
const entriesOf = (docId: string) =>
  db.docLinks
    .filter((l) => l.from_document_id === docId)
    .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
    .filter((d) => d.doc_type === 'JOURNAL_ENTRY')
    .map((d) =>
      db.jeLines
        .filter((l) => l.document_id === d.id)
        .map((l) => `${db.accounts.find((a) => a.id === l.account_id)!.code} ${l.debit} ${l.credit}`),
    )

/** Despacha el remito de la demo y factura todo el pedido PV-00001 (letra A a un responsable inscripto). */
function invoiceDemoOrder() {
  cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
  const order = byNumber('PV-00001')
  return cmdCreateSalesInvoice(
    ctx('ventas'),
    companyId(),
    {
      sales_order_id: order.id,
      notes: '',
      lines: db.soLines
        .filter((l) => l.document_id === order.id)
        .map((l) => ({ so_line_id: l.id, quantity: l.qty_delivered })),
    },
    true,
  )
}

const input = (over: Partial<TaxReturnInput> = {}): TaxReturnInput => ({
  tax: 'IVA',
  period: '2027-05',
  notes: '',
  ...over,
})

describe('libros IVA', () => {
  it('ventas y compras del mes, por alícuota; la factura anulada resta en el mes de su anulación', () => {
    const fv = byNumber(invoiceDemoOrder().display_number)
    const fp = byNumber('FP-00001')
    const sales = ivaBook(db, userId('contabilidad'), companyId(), '2027-05', true)
    expect(sales.rows).toHaveLength(1)
    expect(sales.rows[0]).toMatchObject({
      sign: 1,
      entry_date: '2027-05-14',
      invoice: { display_number: fv.display_number },
      counterparty: { vat_condition: 'RESPONSABLE_INSCRIPTO' },
      net: fv.subtotal,
      vat: fv.tax_total,
      total: fv.total,
    })
    expect(sales.rows[0].voucher).toMatch(/^A 0+\d+-0+1$/)
    expect(sales).toMatchObject({ net: fv.subtotal, vat: fv.tax_total, total: fv.total })
    expect(sales.by_rate.reduce((s, r) => s + r.vat, 0)).toBeCloseTo(fv.tax_total, 2)
    const purchases = ivaBook(db, userId('contabilidad'), companyId(), '2027-05', false)
    expect(purchases.rows.map((r) => [r.invoice.display_number, r.net, r.vat, r.no_credit])).toEqual([
      ['FP-00001', fp.subtotal, fp.tax_total, 0],
    ])
    expect(purchases.by_rate).toEqual([{ rate: 21, net: 220000, vat: 46200 }])
    // En junio se anula la factura de mayo: mayo no cambia y junio la resta.
    at('2027-06-03')
    cmdCancelSalesInvoice(ctx('ventas'), fv.id, 'Se facturó al cliente equivocado')
    expect(ivaBook(db, userId('contabilidad'), companyId(), '2027-05', true).vat).toBe(fv.tax_total)
    const june = ivaBook(db, userId('contabilidad'), companyId(), '2027-06', true)
    expect(june.rows.map((r) => [r.sign, r.entry_date, r.total])).toEqual([[-1, '2027-06-03', -fv.total]])
    expect(june.vat).toBe(-fv.tax_total)
    // Lo ve quien ve las declaraciones; el mes, bien escrito.
    expect(() => ivaBook(db, userId('ventas'), companyId(), '2027-05', true)).toThrow('Tu rol no tiene acceso')
    expectBusinessError(() => ivaBook(db, userId('contabilidad'), companyId(), '2027-5', true), 'DATO_INVALIDO')
  })
})

describe('declaración mensual de IVA', () => {
  it('preparar, presentar con su asiento, pagar desde el banco y entrar al flujo de fondos', () => {
    const fv = byNumber(invoiceDemoOrder().display_number)
    const debit = fv.tax_total
    const credit = byNumber('FP-00001').tax_total
    at('2027-06-05')
    const created = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input())
    const doc = byNumber(created.display_number)
    expect(created.display_number).toBe('DJ-00001')
    expect(doc).toMatchObject({
      status: 'BORRADOR',
      total: round2(debit - credit),
      tr: {
        tax: 'IVA',
        period: '2027-05',
        due_date: '2027-06-20',
        tax_amount: debit,
        credits: credit,
        previous_balance: 0,
        balance_in_favor: 0,
      },
    })
    expect(db.audit.at(-1)!.summary).toBe(`Creó DJ-00001: IVA de 05/2027, ${money(round2(debit - credit))} a pagar`)
    cmdPresentTaxReturn(ctx('contabilidad'), doc.id)
    expect(doc.status).toBe('PRESENTADA')
    expect(entriesOf(doc.id)).toEqual([
      [`2.1.04.01 ${debit} 0`, `1.1.04.01 0 ${credit}`, `2.1.04.02 0 ${round2(debit - credit)}`],
    ])
    expect(db.tasks.filter((t) => t.document_id === doc.id && t.status === 'PENDIENTE').map((t) => t.title)).toEqual([
      `Pagar DJ-00001 por ${money(doc.total)}`,
    ])
    // Presentada sin pagar: va al flujo proyectado en su vencimiento (a 15 días).
    const fortnight = cashProjection(db, userId('tesoreria'), companyId()).buckets.find((b) => b.key === 'QUINCENA')!
    expect(fortnight).toMatchObject({ taxes: doc.total, tax_items: 1 })
    expectBusinessError(() => cmdPayTaxReturn(ctx('contabilidad'), doc.id, account('1.1.01.03')), 'SIN_PERMISO')
    expectBusinessError(() => cmdPayTaxReturn(ctx('tesoreria'), doc.id, account('1.1.01.02')), 'SALDO_INSUFICIENTE')
    cmdPayTaxReturn(ctx('tesoreria'), doc.id, account('1.1.01.03'))
    expect(doc).toMatchObject({
      status: 'PAGADA',
      tr: { paid_on: '2027-06-05', paid_account_id: account('1.1.01.03') },
    })
    expect(entriesOf(doc.id)[1]).toEqual([`2.1.04.02 ${doc.total} 0`, `1.1.01.03 0 ${doc.total}`])
    const flow = cashFlow(db, userId('tesoreria'), companyId(), '2027-06-01', '2027-06-30')
    expect(flow.concepts.find((c) => c.key === 'IMPUESTOS')).toMatchObject({ outflow: doc.total })
    expect(documentDetail(db, userId('contabilidad'), companyId(), 'TAX_RETURN', 'DJ-00001')!.tax_return).toMatchObject(
      {
        amount_due: doc.total,
        paid_account: { code: '1.1.01.03' },
      },
    )
  })

  it('con más crédito que débito queda saldo a favor, que se descuenta en la del mes siguiente', () => {
    // Mayo sólo tiene la compra de la demo: crédito fiscal sin débito.
    at('2027-06-05')
    const may = byNumber(cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input()).display_number)
    expect(may).toMatchObject({ total: 0, tr: { tax_amount: 0, credits: 46200, balance_in_favor: 46200 } })
    cmdPresentTaxReturn(ctx('contabilidad'), may.id)
    // Sin débito no hay asiento: el crédito queda en IVA crédito fiscal como saldo a favor.
    expect(may.status).toBe('SIN_SALDO')
    expect(entriesOf(may.id)).toEqual([])
    expect(documentDetail(db, userId('tesoreria'), companyId(), 'TAX_RETURN', may.display_number)!.actions).toEqual([])
    // Junio: una venta; el saldo a favor de mayo se usa primero.
    const fv = byNumber(invoiceDemoOrder().display_number)
    at('2027-07-02')
    const june = byNumber(
      cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input({ period: '2027-06' })).display_number,
    )
    const due = round2(fv.tax_total - 46200)
    expect(june).toMatchObject({ total: due, tr: { tax_amount: fv.tax_total, credits: 0, previous_balance: 46200 } })
    cmdPresentTaxReturn(ctx('contabilidad'), june.id)
    expect(entriesOf(june.id)).toEqual([[`2.1.04.01 ${fv.tax_total} 0`, `1.1.04.01 0 46200`, `2.1.04.02 0 ${due}`]])
  })

  it('validaciones: el mes terminado, una por mes, los meses en orden y quién la prepara', () => {
    const create = (over: Partial<TaxReturnInput>, username = 'contabilidad') =>
      expectBusinessError(() => cmdCreateTaxReturn(ctx(username), companyId(), input(over)), 'DATO_INVALIDO')
    expect(create({})).toBe('05/2027 todavía no terminó: la declaración se prepara después de que termine el mes.')
    at('2027-07-05')
    expect(create({ tax: 'GANANCIAS' as never })).toBe('Elegí el impuesto: IVA o ingresos brutos.')
    expect(create({ period: '2027-5' })).toBe('El período es un mes: aaaa-mm.')
    expect(create({ period: '2015-02' })).toBe(
      'La empresa empezó sus actividades el 02/03/2015: no hay declaraciones antes.',
    )
    for (const username of ['tesoreria', 'gerencia', 'ventas'])
      expectBusinessError(() => cmdCreateTaxReturn(ctx(username), companyId(), input()), 'SIN_PERMISO')
    const may = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input())
    expect(create({})).toBe('Ya hay una declaración de IVA de 05/2027: DJ-00001.')
    expect(create({ period: '2027-04' })).toBe(
      'La última declaración de IVA es la de 05/2027 (DJ-00001): no se vuelve a un mes anterior.',
    )
    expect(create({ period: '2027-06' })).toBe('Primero hay que presentar DJ-00001 (IVA de 05/2027).')
    cmdPresentTaxReturn(ctx('contabilidad'), may.id)
    at('2027-08-05')
    expect(create({ period: '2027-07' })).toBe('Falta la declaración de IVA de 06/2027: los meses van en orden.')
  })

  it('anular: el borrador sin más; la presentada, sólo la última y con su contraasiento; SoD-10 al pagar', () => {
    invoiceDemoOrder()
    at('2027-06-05')
    const draft = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input())
    expectBusinessError(() => cmdCancelTaxReturn(ctx('contabilidad'), draft.id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelTaxReturn(ctx('contabilidad'), draft.id, 'Faltaba una factura')
    expect(byNumber('DJ-00001').status).toBe('ANULADA')
    const may = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input())
    cmdPresentTaxReturn(ctx('contabilidad'), may.id)
    at('2027-07-05')
    const june = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input({ period: '2027-06' }))
    // La de mayo no se anula mientras haya una posterior.
    expect(
      documentDetail(db, userId('contabilidad'), companyId(), 'TAX_RETURN', may.display_number)!.actions.find(
        (a) => a.action === 'CANCEL',
      ),
    ).toMatchObject({ enabled: false, reason: 'Sólo se anula la última declaración de IVA: DJ-00003 es posterior.' })
    expectBusinessError(() => cmdCancelTaxReturn(ctx('contabilidad'), may.id, 'Error'), 'TRANSICION_INVALIDA')
    cmdCancelTaxReturn(ctx('contabilidad'), june.id, 'Se rehace')
    cmdCancelTaxReturn(ctx('contabilidad'), may.id, 'Mal calculada')
    expect(db.audit.at(-1)!.summary).toMatch(
      /^Anuló DJ-00002: el contraasiento AS-\d+ revirtió el del impuesto — Mal calculada$/,
    )
    // SoD-10: con el rol de Tesorería, quien preparó o presentó la declaración no la paga (Contabilidad también es Impuestos en la demo).
    cmdAssignRole(
      ctx('docente'),
      companyId(),
      userId('contabilidad'),
      'TESORERIA',
      db.sectors.find((s) => s.code === 'TES')!.id,
    )
    at('2027-07-06')
    const again = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input())
    cmdPresentTaxReturn(ctx('contabilidad'), again.id)
    expect(
      documentDetail(db, userId('contabilidad'), companyId(), 'TAX_RETURN', again.display_number)!.actions.find(
        (a) => a.action === 'PAY',
      ),
    ).toMatchObject({
      enabled: false,
      reason: 'Separación de funciones: liquidaste este impuesto; tiene que pagarlo otro integrante de Tesorería.',
    })
    expect(
      expectBusinessError(
        () => cmdPayTaxReturn(ctx('contabilidad'), again.id, account('1.1.01.03')),
        'SEPARACION_FUNCIONES',
      ),
    ).toBe(`No podés pagar ${again.display_number}: la liquidaste vos.`)
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { sod_enabled: false })
    cmdPayTaxReturn(ctx('contabilidad'), again.id, account('1.1.01.03'))
    expect(byNumber(again.display_number).status).toBe('PAGADA')
    expectBusinessError(() => cmdCancelTaxReturn(ctx('contabilidad'), again.id, 'Tarde'), 'TRANSICION_INVALIDA')
  })

  it('al actualizar una base guardada (v16), cada empresa recibe las reglas del IVA', () => {
    const stored = structuredClone(db)
    stored.postingRules = stored.postingRules.filter((r) => r.event !== 'IVA' && r.event !== 'PAGO_IVA')
    const upgraded = upgradeDatabase({ ...stored, version: 16 })!
    expect(upgraded.version).toBe(DB_VERSION)
    const company = upgraded.companies[0].id
    expect(
      upgraded.postingRules
        .filter((r) => r.company_id === company && (r.event === 'IVA' || r.event === 'PAGO_IVA'))
        .map((r) => `${r.event}:${r.key}`)
        .sort(),
    ).toEqual(['IVA:IVA_A_PAGAR', 'IVA:IVA_CREDITO', 'IVA:IVA_DEBITO', 'PAGO_IVA:IVA_A_PAGAR'])
  })
})

describe('ingresos brutos (Fase 7b): percepciones, retenciones y declaración', () => {
  /** La factura de la orden de compra de la demo, otra vez (con la orden liberada). */
  const invoiceOrder = (perception: number, register = true) => {
    const order = db.documents.find((d) => d.id === byNumber('FP-00001').si!.purchase_order_id)!
    return cmdCreateSupplierInvoice(
      ctx('compras1'),
      companyId(),
      {
        purchase_order_id: order.id,
        point_of_sale: '3',
        invoice_number: '12875',
        document_date: '2027-05-14',
        notes: '',
        lines: db.poLines
          .filter((l) => l.document_id === order.id)
          .map((l) => ({ po_line_id: l.id, quantity: l.quantity, unit_price: l.unit_price })),
        perception,
      },
      register,
    )
  }

  /** Libera la orden de compra de la demo: se anulan su orden de pago y la factura FP-00001. */
  function freeDemoOrder() {
    const op = db.documents.find((d) => d.company_id === companyId() && d.doc_type === 'PAYMENT_ORDER')!
    cmdCancelPaymentOrder(ctx('contabilidad'), op.id, 'Se rehace la factura del proveedor')
    cmdCancelSupplierInvoice(ctx('compras1'), byNumber('FP-00001').id, 'Faltaba la percepción de ingresos brutos')
  }

  /** Rehace la factura del proveedor de la demo con una percepción. */
  function invoiceWithPerception(perception: number) {
    freeDemoOrder()
    return invoiceOrder(perception)
  }

  /** Tesorería cobra toda la factura con una retención del cliente. */
  const collect = (invoiceId: string, retention: number) => {
    const invoice = db.documents.find((d) => d.id === invoiceId)!
    return cmdCreateCustomerReceipt(
      ctx('tesoreria'),
      companyId(),
      {
        customer_id: invoice.customer_id!,
        treasury_account_id: account('1.1.01.03'),
        payment_method: 'TRANSFERENCIA',
        reference: '',
        notes: '',
        lines: [{ invoice_id: invoice.id, amount: invoice.total }],
        retention,
      },
      true,
    )
  }

  it('la percepción de la factura del proveedor: a lo que se le debe, a su cuenta y al libro IVA compras', () => {
    freeDemoOrder()
    const bad = (perception: number) => expectBusinessError(() => invoiceOrder(perception, false), 'DATO_INVALIDO')
    expect(bad(-1)).toBe('La percepción de ingresos brutos es un importe de cero o más, con hasta 2 decimales.')
    bad(10.555)
    const { id } = invoiceOrder(2500)
    const fp = byNumber('FP-00002')
    expect(fp).toMatchObject({ total: round2(fp.subtotal + fp.tax_total + 2500), si: { perception: 2500 } })
    expect(entriesOf(id)).toEqual([
      [`1.1.05.02 ${fp.subtotal} 0`, `1.1.04.01 ${fp.tax_total} 0`, '1.1.04.03 2500 0', `2.1.01.01 0 ${fp.total}`],
    ])
    const book = ivaBook(db, userId('contabilidad'), companyId(), '2027-05', false)
    expect(book.rows.find((r) => r.invoice.id === id)).toMatchObject({ perception: 2500, total: fp.total })
    expect(book.perception).toBe(2500)
  })

  it('la retención del cliente: entra el resto a la caja o el banco; para anular alcanza con ese dinero', () => {
    const fv = byNumber(invoiceDemoOrder().display_number)
    const receipt = (retention: number) => expectBusinessError(() => collect(fv.id, retention), 'DATO_INVALIDO')
    expect(receipt(fv.total)).toBe(
      `La retención (${money(fv.total)}) tiene que ser menor que lo que se cobra (${money(fv.total)}): el resto ingresa a la caja o el banco.`,
    )
    expect(receipt(-5)).toBe('La retención de ingresos brutos es un importe de cero o más, con hasta 2 decimales.')
    receipt(10.555)
    const { id, display_number } = collect(fv.id, 1500)
    const rbo = byNumber(display_number)
    expect(rbo).toMatchObject({ status: 'CONFIRMADO', total: fv.total, rc: { retention: 1500 } })
    expect(entriesOf(id)).toEqual([
      [`1.1.01.03 ${round2(fv.total - 1500)} 0`, '1.1.04.03 1500 0', `1.1.03.01 0 ${fv.total}`],
    ])
    expect(db.audit.find((e) => e.document_id === id && e.action === 'CONFIRM')!.summary).toMatch(
      /, con una retención de ingresos brutos de \$\s1\.500,00$/,
    )
    expect(byNumber(fv.display_number).status).toBe('COBRADA')
    cmdCancelCustomerReceipt(ctx('tesoreria'), id, 'El cliente pidió rehacer el recibo')
    const entry = db.docLinks
      .filter((l) => l.from_document_id === id)
      .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
      .find((d) => d.doc_type === 'JOURNAL_ENTRY')!
    const reversal = db.documents.find((d) => d.je?.reverses_id === entry.id)!
    expect(
      db.jeLines
        .filter((l) => l.document_id === reversal.id)
        .map((l) => `${db.accounts.find((a) => a.id === l.account_id)!.code} ${l.debit} ${l.credit}`),
    ).toEqual([`1.1.01.03 0 ${round2(fv.total - 1500)}`, '1.1.04.03 0 1500', `1.1.03.01 ${fv.total} 0`])
  })

  it('la declaración: la alícuota sobre las ventas netas, menos percepciones y retenciones; asiento y pago', () => {
    invoiceWithPerception(2000)
    const fv = byNumber(invoiceDemoOrder().display_number)
    collect(fv.id, 1000)
    // El docente cambia la alícuota; la declaración la copia.
    expectBusinessError(
      () => cmdUpdateCompanySettings(ctx('contabilidad'), companyId(), { iibb_pct: 4 }),
      'SIN_PERMISO',
    )
    expect(
      expectBusinessError(
        () => cmdUpdateCompanySettings(ctx('docente'), companyId(), { iibb_pct: 3.555 }),
        'DATO_INVALIDO',
      ),
    ).toBe('La alícuota de ingresos brutos va de 0 a 100, con hasta 2 decimales.')
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { iibb_pct: 3.5 })
    expect(db.audit.at(-1)).toMatchObject({
      summary: 'Cambió la alícuota de ingresos brutos',
      changes: { iibb_pct: { from: null, to: 3.5 } },
    })
    at('2027-06-05')
    const { id } = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input({ tax: 'IIBB' }))
    const dj = byNumber('DJ-00001')
    const tax = Math.round((Math.round(fv.subtotal * 100) * 350) / 10000) / 100
    const due = round2(tax - 3000)
    expect(dj).toMatchObject({
      status: 'BORRADOR',
      subtotal: tax,
      total: due,
      tr: { tax: 'IIBB', base: fv.subtotal, rate: 3.5, tax_amount: tax, credits: 3000, due_date: '2027-06-15' },
    })
    const view = documentDetail(db, userId('contabilidad'), companyId(), 'TAX_RETURN', 'DJ-00001')!
    expect(view.tax_return!.withholdings.map((w) => [w.kind, w.source.display_number, w.amount])).toEqual([
      ['PERCEPCION', 'FP-00002', 2000],
      ['RETENCION', 'RBO-00001', 1000],
    ])
    expect(view.next_step.text).toMatch(/^Revisar las ventas netas del mes y las percepciones y retenciones/)
    // Que no se pueda declarar el mes de nuevo (el IVA es otro impuesto: sí).
    expect(
      expectBusinessError(
        () => cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input({ tax: 'IIBB' })),
        'DATO_INVALIDO',
      ),
    ).toBe('Ya hay una declaración de ingresos brutos de 05/2027: DJ-00001.')
    cmdPresentTaxReturn(ctx('contabilidad'), id)
    expect(entriesOf(id)).toEqual([[`5.2.03.01 ${tax} 0`, '1.1.04.03 0 3000', `2.1.04.03 0 ${due}`]])
    cmdPayTaxReturn(ctx('tesoreria'), id, account('1.1.01.03'))
    expect(byNumber('DJ-00001').status).toBe('PAGADA')
    expect(entriesOf(id)[1]).toEqual([`2.1.04.03 ${due} 0`, `1.1.01.03 0 ${due}`])
    expect(db.audit.find((e) => e.document_id === id && e.action === 'PAY')!.summary).toMatch(
      /^Pagó DJ-00001: ingresos brutos de 05\/2027, /,
    )
  })

  it('al actualizar una base guardada (v18), las reglas nuevas y los documentos sin percepción ni retención', () => {
    invoiceWithPerception(0)
    const stored = structuredClone(db)
    const company = stored.companies[0].id
    stored.postingRules = stored.postingRules.filter((r) => r.event !== 'IIBB' && r.event !== 'PAGO_IIBB')
    for (const d of stored.documents) {
      if (d.si) delete (d.si as { perception?: number }).perception
      if (d.rc) delete (d.rc as { retention?: number }).retention
    }
    const upgraded = upgradeDatabase({ ...stored, version: 18 })!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(
      upgraded.postingRules.filter((r) => r.company_id === company && (r.event === 'IIBB' || r.event === 'PAGO_IIBB')),
    ).toHaveLength(4)
    expect(upgraded.documents.filter((d) => d.si).every((d) => d.si!.perception === 0)).toBe(true)
  })
})

describe('calendario de vencimientos (Fase 7b.2)', () => {
  const calendar = (username = 'contabilidad') =>
    obligationsCalendar(db, userId(username), companyId(), '2027-04').rows.map((r) => [
      r.kind,
      r.due_date,
      r.status,
      r.overdue,
      r.detail,
    ])

  it('las cuatro obligaciones del mes por vencimiento, con su estado según los documentos', () => {
    // Hoy es el 14/05: los sueldos (día 4) y las cargas sociales (día 10) ya vencieron.
    expect(calendar()).toEqual([
      ['SUELDOS', '2027-05-04', 'PENDIENTE', true, 'Sin liquidar'],
      ['CARGAS_SOCIALES', '2027-05-10', 'PENDIENTE', true, 'Sin liquidar'],
      ['IIBB', '2027-05-15', 'PENDIENTE', false, 'Sin declarar'],
      ['IVA', '2027-05-20', 'PENDIENTE', false, 'Sin declarar'],
    ])
    const { id, display_number } = cmdCreatePayroll(ctx('rrhh'), companyId(), {
      period: '2027-04',
      payment_date: '2027-05-05',
      notes: '',
    })
    expect(calendar()[0]).toEqual(['SUELDOS', '2027-05-05', 'PENDIENTE', true, `${display_number} en borrador`])
    cmdSubmitPayroll(ctx('rrhh'), id)
    expect(calendar()[1]).toEqual([
      'CARGAS_SOCIALES',
      '2027-05-10',
      'PENDIENTE',
      true,
      `${display_number} espera la autorización de Gerencia`,
    ])
    cmdApprovePayroll(ctx('gerencia'), id, '')
    cmdPayPayrollSalaries(ctx('tesoreria'), id, account('1.1.01.03'))
    const rows = obligationsCalendar(db, userId('contabilidad'), companyId(), '2027-04').rows
    expect(rows[0]).toMatchObject({
      kind: 'SUELDOS',
      status: 'CUMPLIDA',
      overdue: false,
      detail: 'Pagados el 14/05/2027',
      amount: byNumber(display_number).total,
      document: { display_number },
    })
    expect(rows[1]).toMatchObject({
      kind: 'CARGAS_SOCIALES',
      status: 'A_PAGAR',
      overdue: true,
      detail: 'Falta pagarlas',
    })
    // El IVA de abril, sin ventas: presentado sin saldo, cumplido.
    const dj = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), input({ period: '2027-04' }))
    expect(calendar()[3]).toEqual(['IVA', '2027-05-20', 'PENDIENTE', false, 'DJ-00001 en borrador'])
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    expect(calendar()[3]).toEqual(['IVA', '2027-05-20', 'CUMPLIDA', false, 'Presentada sin saldo a pagar'])
  })

  it('quién lo ve: los sueldos, sólo quien ve las liquidaciones; el mes, bien escrito', () => {
    expect(() => obligationsCalendar(db, userId('ventas'), companyId(), '2027-04')).toThrow('Tu rol no tiene acceso')
    const imp = db.sectors.find((s) => s.company_id === companyId() && s.code === 'IMP')!.id
    cmdAssignRole(ctx('docente'), companyId(), userId('ventas'), 'IMPUESTOS', imp)
    expect(calendar('ventas').map((r) => r[0])).toEqual(['IIBB', 'IVA'])
    expect(
      expectBusinessError(
        () => obligationsCalendar(db, userId('contabilidad'), companyId(), '2027-4'),
        'DATO_INVALIDO',
      ),
    ).toBe('El período es un mes: aaaa-mm.')
    expect(
      expectBusinessError(
        () => obligationsCalendar(db, userId('contabilidad'), companyId(), '2015-02'),
        'DATO_INVALIDO',
      ),
    ).toBe('La empresa empezó sus actividades el 02/03/2015: no hay obligaciones antes.')
  })
})
