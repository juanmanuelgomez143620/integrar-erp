// Pruebas de los libros IVA y de la declaración mensual de IVA
// (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §2) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { money } from '../format'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdAssignRole,
  cmdCancelSalesInvoice,
  cmdCancelTaxReturn,
  cmdConfirmDeliveryNote,
  cmdCreateSalesInvoice,
  cmdCreateTaxReturn,
  cmdPayTaxReturn,
  cmdPresentTaxReturn,
  cmdUpdateCompanySettings,
  type Ctx,
  type TaxReturnInput,
} from './engine'
import { cashFlow, cashProjection, documentDetail, ivaBook } from './queries'
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
    expect(create({ tax: 'IIBB' })).toBe('Elegí el impuesto: por ahora, el IVA.')
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
