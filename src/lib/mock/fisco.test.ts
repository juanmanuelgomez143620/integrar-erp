// Pruebas del fisco simulado (docs/FASE_8_BANCO_Y_FISCO.md §4, 8d): el padrón de la empresa, su
// alta, modificación y baja por quien opera el fisco (Impuestos) y la letra de la factura de venta,
// que sale del padrón (8d.1); los puntos de venta que pide Ventas y habilita Impuestos, y la
// autorización de cada factura de venta (8d.2); la recepción de las declaraciones (8e.1), y la cuenta
// corriente tributaria y el pago de las declaraciones por el banco, con los intereses (8e.2); el
// domicilio fiscal electrónico y las intimaciones (8f.1); la multa por presentar fuera de término (8f.2).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cuitIsValid } from '../domain/cuit'
import type * as T from '../domain/types'
import { addDays, money } from '../format'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdAssignRole,
  cmdCancelTaxReturn,
  cmdCloseFiscalNotice,
  cmdConfirmDeliveryNote,
  cmdConfirmSalesInvoice,
  cmdCreateJournalEntry,
  cmdCreateSalesInvoice,
  cmdCreateTaxReturn,
  cmdDecidePointOfSale,
  cmdIssueFiscalNotice,
  cmdPayTaxFine,
  cmdPayTaxReturn,
  cmdPresentTaxReturn,
  cmdProcessBankOrders,
  cmdReceiveTaxReturn,
  cmdRequestPointOfSale,
  cmdResendBankOrder,
  cmdRespondFiscalNotice,
  cmdSaveTaxpayer,
  cmdSetModule,
  cmdSetTaxpayerActive,
  cmdUpdateCompanySettings,
  type Ctx,
  type TaxpayerInput,
} from './engine'
import {
  authorizedVouchers,
  documentDetail,
  fiscalNotices,
  fiscalNoticesToIssue,
  invoiceableSalesOrders,
  obligationsCalendar,
  padron,
  pointsOfSale,
  taxAccount,
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
const taxpayer = (cuit: string) => db.taxpayers.find((t) => t.company_id === companyId() && t.cuit === cuit)!

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

/** Un CUIT simulado con su dígito verificador, como los de la demo. */
function cuit(prefix: number, body: number) {
  for (let dv = 0; dv <= 9; dv++) {
    const candidate = `${prefix}-${String(body).padStart(8, '0')}-${dv}`
    if (cuitIsValid(candidate)) return candidate
  }
  throw new Error('sin dígito verificador')
}

const input = (over: Partial<TaxpayerInput> = {}): TaxpayerInput => ({
  id: '',
  cuit: cuit(30, 900),
  legal_name: 'Carpintería del Litoral SRL (ficticia)',
  vat_condition: 'RESPONSABLE_INSCRIPTO',
  activity: 'Carpintería de obra',
  province: 'Misiones',
  ...over,
})

describe('Fisco: el padrón de la demo', () => {
  it('trae la empresa y los proveedores y clientes con un CUIT válido', () => {
    const rows = padron(db, userId('contabilidad'), companyId())
    const company = db.companies[0]
    const partners = [...db.suppliers, ...db.customers].filter((p) => p.company_id === companyId() && p.tax_id)
    expect(partners.length).toBeGreaterThan(5)
    expect(partners.every((p) => cuitIsValid(p.tax_id))).toBe(true)
    expect(rows.map((r) => r.cuit)).toEqual([...new Set([company.tax_id, ...partners.map((p) => p.tax_id)])].sort())
    expect(rows.filter((r) => r.is_company).map((r) => [r.legal_name, r.vat_condition])).toEqual([
      [company.legal_name, company.vat_condition],
    ])
    expect(rows.every((r) => r.is_active)).toBe(true)
  })

  it('lo leen Impuestos, Contabilidad, Gerencia, Ventas, Compras y Auditoría; Tesorería no', () => {
    for (const u of ['contabilidad', 'gerencia', 'ventas', 'compras1', 'auditor'])
      expect(padron(db, userId(u), companyId()).length, u).toBeGreaterThan(0)
    expect(() => padron(db, userId('tesoreria'), companyId())).toThrow()
  })
})

describe('Fisco: Impuestos opera el padrón', () => {
  it('da de alta con un CUIT válido que no esté; Ventas lo consulta pero no lo opera', () => {
    expect(
      expectBusinessError(
        () => cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input({ cuit: '30-0000090-1' })),
        'DATO_INVALIDO',
      ),
    ).toBe('El CUIT no es válido: tiene el formato 30-12345678-9 y el último número es el dígito verificador.')
    const wrong = cuit(30, 900).replace(/\d$/, (d) => String((Number(d) + 1) % 10))
    expectBusinessError(
      () => cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input({ cuit: wrong })),
      'DATO_INVALIDO',
    )
    const existing = db.companies[0].tax_id
    expect(
      expectBusinessError(
        () => cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input({ cuit: existing })),
        'DATO_INVALIDO',
      ),
    ).toBe(`El CUIT ${existing} ya está en el padrón.`)
    expectBusinessError(
      () => cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input({ legal_name: 'X' })),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input({ vat_condition: 'OTRA' as never })),
      'DATO_INVALIDO',
    )
    expectBusinessError(() => cmdSaveTaxpayer(ctx('ventas'), companyId(), input()), 'SIN_PERMISO')
    const { id } = cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input())
    expect(taxpayer(cuit(30, 900))).toMatchObject({
      id,
      legal_name: 'Carpintería del Litoral SRL (ficticia)',
      is_active: true,
    })
    expect(db.audit.at(-1)).toMatchObject({
      action: 'CREATE',
      entity_type: 'taxpayer',
      summary: `Dio de alta en el padrón a Carpintería del Litoral SRL (ficticia) (CUIT ${cuit(30, 900)}): responsable inscripto`,
    })
  })

  it('modifica sin cambiar el CUIT y da de baja (no se borra)', () => {
    const { id } = cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input())
    const audits = db.audit.length
    cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input({ id, cuit: '30-99999999-9' }))
    expect(db.audit.length, 'sin cambios no hay auditoría').toBe(audits)
    cmdSaveTaxpayer(ctx('contabilidad'), companyId(), input({ id, vat_condition: 'MONOTRIBUTO' }))
    expect(taxpayer(cuit(30, 900))).toMatchObject({ vat_condition: 'MONOTRIBUTO' })
    expect(db.audit.at(-1)).toMatchObject({
      action: 'UPDATE',
      changes: { vat_condition: { from: 'RESPONSABLE_INSCRIPTO', to: 'MONOTRIBUTO' } },
    })
    cmdSetTaxpayerActive(ctx('contabilidad'), companyId(), id, false)
    expect(taxpayer(cuit(30, 900)).is_active).toBe(false)
    expect(db.audit.at(-1)!.summary).toBe(
      `Dio de baja del padrón a Carpintería del Litoral SRL (ficticia) (CUIT ${cuit(30, 900)})`,
    )
    expectBusinessError(() => cmdSetTaxpayerActive(ctx('ventas'), companyId(), id, true), 'SIN_PERMISO')
    cmdSetTaxpayerActive(ctx('contabilidad'), companyId(), id, true)
    expect(taxpayer(cuit(30, 900)).is_active).toBe(true)
  })
})

describe('Fisco: la letra de la factura sale del padrón', () => {
  const order = () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    return invoiceableSalesOrders(db, userId('ventas'), companyId()).find((o) => o.order.display_number === 'PV-00001')!
  }

  it('con la condición del cliente en el padrón; si el CUIT no está activo, con la de su ficha', () => {
    const pv = byNumber('PV-00001')
    const customer = db.customers.find((c) => c.id === pv.customer_id)!
    expect(customer.vat_condition).toBe('RESPONSABLE_INSCRIPTO')
    expect(order()).toMatchObject({ letter: 'A', letter_source: 'PADRON', customer_cuit: customer.tax_id })
    // El fisco lo pasa a exento: la factura sale B aunque la ficha diga responsable inscripto.
    const entry = taxpayer(customer.tax_id)
    cmdSaveTaxpayer(ctx('contabilidad'), companyId(), { ...entry, id: entry.id, vat_condition: 'EXENTO' })
    const sale = invoiceableSalesOrders(db, userId('ventas'), companyId())[0]
    expect(sale).toMatchObject({ letter: 'B', letter_source: 'PADRON' })
    // Dado de baja del padrón: vale la ficha, con el aviso.
    cmdSetTaxpayerActive(ctx('contabilidad'), companyId(), entry.id, false)
    expect(invoiceableSalesOrders(db, userId('ventas'), companyId())[0]).toMatchObject({
      letter: 'A',
      letter_source: 'FICHA',
    })
    // De vuelta en el padrón como exento, la factura registrada es B.
    cmdSetTaxpayerActive(ctx('contabilidad'), companyId(), entry.id, true)
    const lines = db.soLines.filter((l) => l.document_id === pv.id)
    const r = cmdCreateSalesInvoice(
      ctx('ventas'),
      companyId(),
      { sales_order_id: pv.id, notes: '', lines: lines.map((l) => ({ so_line_id: l.id, quantity: l.qty_delivered })) },
      true,
    )
    expect(byNumber(r.display_number).fv).toMatchObject({ letter: 'B', invoice_number: '00000001' })
  })

  it('un cliente con un CUIT que no está en el padrón usa su ficha', () => {
    const pv = byNumber('PV-00001')
    const customer = db.customers.find((c) => c.id === pv.customer_id)!
    customer.tax_id = cuit(30, 901)
    expect(order()).toMatchObject({ letter: 'A', letter_source: 'FICHA', customer_cuit: cuit(30, 901) })
  })
})

describe('Fisco: los puntos de venta (8d.2)', () => {
  const rows = (u = 'ventas') => pointsOfSale(db, userId(u), companyId())
  const pending = () =>
    db.tasks.filter(
      (t) => t.company_id === companyId() && t.task_type === 'HABILITAR_PUNTO_VENTA' && t.status === 'PENDIENTE',
    )
  const request = (description = 'Local de ventas', username = 'ventas') =>
    cmdRequestPointOfSale(ctx(username), companyId(), { description })
  /** Una factura registrada de una unidad de la primera línea del PV-00001 (ya entregado), en ese punto de venta. */
  const invoice = (point_of_sale?: string) => {
    const pv = byNumber('PV-00001')
    const line = db.soLines.find((l) => l.document_id === pv.id && l.line_no === 1)!
    return cmdCreateSalesInvoice(
      ctx('ventas'),
      companyId(),
      { sales_order_id: pv.id, notes: '', lines: [{ so_line_id: line.id, quantity: 1 }], point_of_sale },
      true,
    )
  }

  it('la demo trae el 00001 habilitado; lo ven quien lee el fisco y quien factura', () => {
    expect(rows().map((p) => [p.number, p.description, p.status, p.requested_by_name, p.decided_by_name])).toEqual([
      ['00001', 'Casa central', 'HABILITADO', null, null],
    ])
    expect(rows('contabilidad')).toHaveLength(1)
    expect(() => rows('tesoreria')).toThrow()
  })

  it('Ventas pide uno, Impuestos lo habilita y la factura de venta lo puede usar', () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    expectBusinessError(() => request('X'), 'DATO_INVALIDO')
    expectBusinessError(() => request('Local de ventas', 'contabilidad'), 'SIN_PERMISO')
    const { id, number, status } = request()
    expect([number, status]).toEqual(['00002', 'SOLICITADO'])
    expect(db.audit.at(-1)).toMatchObject({
      action: 'REQUEST',
      entity_type: 'point_of_sale',
      summary: 'Pidió al fisco habilitar el punto de venta 00002: Local de ventas',
    })
    expect(pending().map((t) => t.assigned_role)).toEqual(['IMPUESTOS'])
    expect(expectBusinessError(() => request('Otro local'), 'TRANSICION_INVALIDA')).toBe(
      'El punto de venta 00002 todavía espera la respuesta del fisco: se pide de a uno.',
    )
    // Mientras espera, la factura no lo puede usar.
    expect(expectBusinessError(() => invoice('00002'), 'DATO_INVALIDO')).toBe(
      'El punto de venta 00002 no está habilitado por el fisco: elegí uno habilitado.',
    )
    expectBusinessError(() => cmdDecidePointOfSale(ctx('ventas'), id, { approve: true }), 'SIN_PERMISO')
    expectBusinessError(
      () => cmdDecidePointOfSale(ctx('contabilidad'), id, { approve: false, reason: ' ' }),
      'MOTIVO_REQUERIDO',
    )
    expect(cmdDecidePointOfSale(ctx('contabilidad'), id, { approve: true })).toEqual({ status: 'HABILITADO' })
    expect(rows()[1]).toMatchObject({ number: '00002', status: 'HABILITADO', decided_by: userId('contabilidad') })
    expect(rows()[1].decided_by_name).toBeTruthy()
    expect(pending()).toEqual([])
    expect(db.audit.at(-1)).toMatchObject({
      action: 'APPROVE',
      summary: 'Habilitó el punto de venta 00002: Local de ventas',
    })
    expect(db.notifications.at(-1)).toMatchObject({
      type: 'PUNTO_VENTA',
      title: 'El fisco habilitó el punto de venta 00002',
    })
    expectBusinessError(() => cmdDecidePointOfSale(ctx('contabilidad'), id, { approve: true }), 'TRANSICION_INVALIDA')
    // La numeración sigue siendo por letra y punto de venta.
    expect(byNumber(invoice('00002').display_number).fv).toMatchObject({
      point_of_sale: '00002',
      invoice_number: '00000001',
    })
    expect(byNumber(invoice().display_number).fv).toMatchObject({ point_of_sale: '00001', invoice_number: '00000001' })
  })

  it('el rechazo lleva el motivo, y su número no se vuelve a usar', () => {
    const { id } = request('Feria de la madera')
    cmdDecidePointOfSale(ctx('contabilidad'), id, { approve: false, reason: 'Falta la habilitación municipal' })
    expect(rows()[1]).toMatchObject({
      number: '00002',
      status: 'RECHAZADO',
      rejection_reason: 'Falta la habilitación municipal',
    })
    expect(db.notifications.at(-1)).toMatchObject({
      type: 'PUNTO_VENTA',
      title: 'El fisco rechazó el punto de venta 00002',
      body: 'Motivo: Falta la habilitación municipal',
    })
    expect(db.audit.at(-1)!.summary).toBe('Rechazó el punto de venta 00002: Falta la habilitación municipal')
    expect(request('Feria de la madera').number).toBe('00003')
  })

  it('quien lo pidió no lo decide (SoD-14)', () => {
    const imp = db.sectors.find((s) => s.company_id === companyId() && s.code === 'IMP')!.id
    cmdAssignRole(ctx('docente'), companyId(), userId('ventas'), 'IMPUESTOS', imp)
    const { id } = request()
    expect(
      expectBusinessError(() => cmdDecidePointOfSale(ctx('ventas'), id, { approve: true }), 'SEPARACION_FUNCIONES'),
    ).toBe('No podés decidir el punto de venta 00002: lo pediste vos.')
    cmdDecidePointOfSale(ctx('contabilidad'), id, { approve: true })
    expect(rows()[1].status).toBe('HABILITADO')
  })

  it('si el fisco lo opera el sistema, habilita en el momento; al pasarlo al sistema, habilita lo que esperaba', () => {
    request()
    expect(pending()).toHaveLength(1)
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { fisco_mode: 'AUTOMATICO' })
    expect(rows()[1]).toMatchObject({ number: '00002', status: 'HABILITADO', decided_by: null })
    expect(pending()).toEqual([])
    expect(db.audit.at(-1)).toMatchObject({
      summary: 'Cambió quién opera el fisco simulado: lo opera el sistema',
      changes: { fisco_mode: { from: null, to: 'AUTOMATICO' } },
    })
    expect(request('Feria de la madera')).toMatchObject({ number: '00003', status: 'HABILITADO' })
    expect(pending()).toEqual([])
    expectBusinessError(
      () => cmdUpdateCompanySettings(ctx('docente'), companyId(), { fisco_mode: 'OTRO' as never }),
      'DATO_INVALIDO',
    )
    // De vuelta a Impuestos, el pedido espera con su tarea.
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { fisco_mode: 'ESTUDIANTES' })
    request('Depósito del puerto')
    expect(pending()).toHaveLength(1)
  })
})

describe('Fisco: la autorización de las facturas de venta (8d.2)', () => {
  it('al registrarla, el fisco le asigna SIM-, la fecha y el correlativo de la empresa, con 10 días de vigencia', () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const pv = byNumber('PV-00001')
    const [first, second] = db.soLines.filter((l) => l.document_id === pv.id).sort((a, b) => a.line_no - b.line_no)
    const draft = cmdCreateSalesInvoice(
      ctx('ventas'),
      companyId(),
      { sales_order_id: pv.id, notes: '', lines: [{ so_line_id: first.id, quantity: first.qty_delivered }] },
      false,
    )
    expect(byNumber(draft.display_number).fv).toMatchObject({
      point_of_sale: '00001',
      authorization_code: null,
      authorization_due: null,
    })
    cmdConfirmSalesInvoice(ctx('ventas'), draft.id)
    const fv = byNumber(draft.display_number)
    const day = fv.document_date.replaceAll('-', '')
    expect(fv.fv).toMatchObject({
      authorization_code: `SIM-${day}000001`,
      authorization_due: addDays(fv.document_date, 10),
    })
    expect(db.audit.find((a) => a.document_id === draft.id && a.action === 'CONFIRM')!.summary).toMatch(
      new RegExp(`, autorizada por el fisco con el código SIM-${day}000001$`),
    )
    const other = cmdCreateSalesInvoice(
      ctx('ventas'),
      companyId(),
      { sales_order_id: pv.id, notes: '', lines: [{ so_line_id: second.id, quantity: second.qty_delivered }] },
      true,
    )
    expect(byNumber(other.display_number).fv!.authorization_code).toBe(`SIM-${day}000002`)
    const month = fv.document_date.slice(0, 7)
    expect(
      authorizedVouchers(db, userId('contabilidad'), companyId(), month).map((v) => [
        v.display_number,
        v.authorization_code,
        v.invoice_label,
        v.status,
      ]),
    ).toEqual([
      [draft.display_number, `SIM-${day}000001`, 'A 00001-00000001', 'REGISTRADA'],
      [other.display_number, `SIM-${day}000002`, 'A 00001-00000002', 'REGISTRADA'],
    ])
    expect(authorizedVouchers(db, userId('contabilidad'), companyId(), '2020-01')).toEqual([])
    expectBusinessError(() => authorizedVouchers(db, userId('contabilidad'), companyId(), '2027-13'), 'DATO_INVALIDO')
    expect(() => authorizedVouchers(db, userId('tesoreria'), companyId(), month)).toThrow()
  })
})

describe('Fisco: la recepción de las declaraciones (8e.1)', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(`${iso}T10:00:00-03:00`))
  /** La declaración de IVA de un mes (aaaa-mm), preparada por Impuestos. */
  const taxReturn = (period: string) =>
    byNumber(cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period, notes: '' }).display_number)
  /** La venta del PV-00001, facturada en mayo, y la declaración de IVA de mayo, preparada en junio. */
  const mayReturn = () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const pv = byNumber('PV-00001')
    const lines = db.soLines.filter((l) => l.document_id === pv.id)
    cmdCreateSalesInvoice(
      ctx('ventas'),
      companyId(),
      { sales_order_id: pv.id, notes: '', lines: lines.map((l) => ({ so_line_id: l.id, quantity: l.qty_delivered })) },
      true,
    )
    at('2027-06-05')
    return taxReturn('2027-05')
  }
  /** Los asientos que dejó la declaración. */
  const entries = (id: string) =>
    db.docLinks.filter(
      (l) =>
        l.from_document_id === id && db.documents.find((d) => d.id === l.to_document_id)?.doc_type === 'JOURNAL_ENTRY',
    ).length
  const tasks = (id: string) =>
    db.tasks
      .filter((t) => t.document_id === id && t.status === 'PENDIENTE')
      .map((t) => [t.task_type, t.assigned_role ?? t.assigned_user_id])

  it('presentada, espera en el fisco; la acepta otro integrante de Impuestos con el acuse y el asiento (SoD-15)', () => {
    const dj = mayReturn()
    expect(dj.total).toBeGreaterThan(0)
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    expect(dj.status).toBe('ENVIADA')
    expect(dj.tr).toMatchObject({ control_amount: dj.tr!.tax_amount, transaction_code: null, received_on: null })
    expect(entries(dj.id)).toBe(0)
    expect(tasks(dj.id)).toEqual([['RECIBIR_DJ', 'IMPUESTOS']])
    expect(db.audit.at(-1)!.summary).toBe(
      `Presentó ${dj.display_number} al fisco: IVA de 05/2027, ${money(dj.total)} a pagar`,
    )
    // Mientras está en el fisco no se paga, no se anula y no se prepara la del mes siguiente.
    expectBusinessError(() => cmdPayTaxReturn(ctx('tesoreria'), dj.id), 'TRANSICION_INVALIDA')
    expectBusinessError(() => cmdCancelTaxReturn(ctx('contabilidad'), dj.id, 'Me equivoqué'), 'TRANSICION_INVALIDA')
    at('2027-07-05')
    expect(
      expectBusinessError(
        () => cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period: '2027-06', notes: '' }),
        'DATO_INVALIDO',
      ),
    ).toBe(`${dj.display_number} (IVA de 05/2027) está en el fisco: hay que esperar que la reciba.`)
    // Quien la presentó no la recibe (y ve por qué); Ventas no opera el fisco.
    expect(
      documentDetail(db, userId('contabilidad'), companyId(), 'TAX_RETURN', dj.display_number)!.actions.map((a) => [
        a.action,
        a.enabled,
      ]),
    ).toEqual([
      ['APPROVE', false],
      ['REJECT', false],
    ])
    expect(
      expectBusinessError(
        () => cmdReceiveTaxReturn(ctx('contabilidad'), dj.id, { accept: true }),
        'SEPARACION_FUNCIONES',
      ),
    ).toBe(`No podés recibir ${dj.display_number} en el fisco: la preparaste o la presentaste vos.`)
    expectBusinessError(() => cmdReceiveTaxReturn(ctx('ventas'), dj.id, { accept: true }), 'SIN_PERMISO')
    cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: true })
    expect(dj.status).toBe('PRESENTADA')
    expect(dj.tr).toMatchObject({
      transaction_code: 'SIM-DJ-20270705000001',
      received_on: '2027-07-05',
      received_by: userId('impuestos2'),
    })
    expect(entries(dj.id)).toBe(1)
    expect(tasks(dj.id)).toEqual([['PAGAR_DJ', 'TESORERIA']])
    expect(db.audit.find((a) => a.document_id === dj.id && a.action === 'APPROVE')!.summary).toBe(
      `Aceptó en el fisco ${dj.display_number} con el acuse SIM-DJ-20270705000001`,
    )
    cmdPayTaxReturn(ctx('tesoreria'), dj.id)
    expect(dj.status).toBe('PAGO_EN_BANCO')
  })

  it('observada: con el motivo y sin asiento; se anula y se presenta de nuevo', () => {
    const dj = mayReturn()
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    expectBusinessError(
      () => cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: false, reason: ' ' }),
      'MOTIVO_REQUERIDO',
    )
    cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: false, reason: 'Falta revisar el crédito fiscal' })
    expect(dj).toMatchObject({ status: 'OBSERVADA', status_reason: 'Falta revisar el crédito fiscal' })
    expect(dj.tr).toMatchObject({ transaction_code: null, received_on: '2027-06-05' })
    expect(entries(dj.id)).toBe(0)
    expect(tasks(dj.id)).toEqual([['CORREGIR_DJ', userId('contabilidad')]])
    at('2027-07-05')
    expect(
      expectBusinessError(
        () => cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period: '2027-06', notes: '' }),
        'DATO_INVALIDO',
      ),
    ).toBe(`El fisco observó ${dj.display_number} (IVA de 05/2027): primero hay que anularla y presentarla de nuevo.`)
    cmdCancelTaxReturn(ctx('contabilidad'), dj.id, 'La observó el fisco')
    expect(dj.status).toBe('ANULADA')
    const again = taxReturn('2027-05')
    cmdPresentTaxReturn(ctx('contabilidad'), again.id)
    cmdReceiveTaxReturn(ctx('impuestos2'), again.id, { accept: true })
    expect(again.status).toBe('PRESENTADA')
    expect(entries(again.id)).toBe(1)
  })

  it('con el fisco operado por el sistema, la recibe al presentarla; al pasarlo al sistema, recibe las enviadas', () => {
    const dj = mayReturn()
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    expect(dj.status).toBe('ENVIADA')
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { fisco_mode: 'AUTOMATICO' })
    expect(dj.status).toBe('PRESENTADA')
    expect(dj.tr).toMatchObject({ transaction_code: 'SIM-DJ-20270605000001', received_by: null })
    expect(db.audit.find((a) => a.document_id === dj.id && a.action === 'APPROVE')).toMatchObject({
      actor_user_id: null,
    })
    expect(tasks(dj.id)).toEqual([['PAGAR_DJ', 'TESORERIA']])
    // La de junio, sin ventas: sin saldo, aceptada en el momento.
    at('2027-07-05')
    const june = taxReturn('2027-06')
    cmdPresentTaxReturn(ctx('contabilidad'), june.id)
    expect(june.status).toBe('SIN_SALDO')
    expect(db.audit.find((a) => a.document_id === june.id && a.action === 'CONFIRM')!.summary).toBe(
      `Presentó ${june.display_number}: IVA de 06/2027, sin saldo a pagar; el fisco la aceptó con el acuse SIM-DJ-20270705000002`,
    )
  })

  it('con el módulo del fisco bloqueado, el fisco responde solo', () => {
    const dj = mayReturn()
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    const pos = cmdRequestPointOfSale(ctx('ventas'), companyId(), { description: 'Local de ventas' })
    expect(pos.status).toBe('SOLICITADO')
    cmdSetModule(ctx('docente'), companyId(), 'fisco', false)
    expect(dj.status).toBe('PRESENTADA')
    expect(db.pointsOfSale.find((p) => p.id === pos.id)!.status).toBe('HABILITADO')
    expect(db.audit.at(-1)!.summary).toBe('Bloqueó el módulo Fisco simulado')
    expect(cmdRequestPointOfSale(ctx('ventas'), companyId(), { description: 'Feria' }).status).toBe('HABILITADO')
  })
})

describe('Fisco: la cuenta corriente y el pago por el banco (8e.2)', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(`${iso}T10:00:00-03:00`))
  const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!.id
  const round2 = (n: number) => Math.round(n * 100) / 100
  /** La venta del PV-00001, facturada en mayo, y la declaración de IVA de mayo, presentada y aceptada en junio. */
  const acceptedMayReturn = () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const pv = byNumber('PV-00001')
    const lines = db.soLines.filter((l) => l.document_id === pv.id)
    cmdCreateSalesInvoice(
      ctx('ventas'),
      companyId(),
      { sales_order_id: pv.id, notes: '', lines: lines.map((l) => ({ so_line_id: l.id, quantity: l.qty_delivered })) },
      true,
    )
    at('2027-06-05')
    const dj = byNumber(
      cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period: '2027-05', notes: '' }).display_number,
    )
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: true })
    return dj
  }
  /** La orden de una operación en el Banco Aula. */
  const orderOf = (id: string) => db.bankMovements.find((m) => m.source_document_id === id && m.origin === 'ORDEN')!
  /** Las líneas del último asiento de la declaración. */
  const lastEntry = (id: string) => {
    const entry = db.docLinks
      .filter((l) => l.from_document_id === id)
      .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
      .filter((d) => d.doc_type === 'JOURNAL_ENTRY')
      .at(-1)!
    return db.jeLines
      .filter((l) => l.document_id === entry.id)
      .map((l) => `${db.accounts.find((a) => a.id === l.account_id)!.code} ${l.debit} ${l.credit}`)
  }
  /** La declaración en la cuenta corriente tributaria. */
  const row = () => taxAccount(db, userId('contabilidad'), companyId()).rows[0]
  const obligation = () =>
    obligationsCalendar(db, userId('contabilidad'), companyId(), '2027-05').rows.find((r) => r.kind === 'IVA')!
  /** Un asiento manual de Contabilidad, registrado con la fecha de hoy. */
  const manualEntry = (description: string, lines: [string, number, number][]) =>
    cmdCreateJournalEntry(
      ctx('contabilidad'),
      companyId(),
      {
        document_date: new Date().toISOString().slice(0, 10),
        description,
        lines: lines.map(([code, debit, credit]) => ({ account_id: account(code), debit, credit })),
      },
      true,
    )

  it('a término: sale del Banco Aula, queda en el banco y el fisco la imputa cuando el banco la procesa', () => {
    const dj = acceptedMayReturn()
    const total = dj.total
    expect(row()).toMatchObject({
      state: 'A_VENCER',
      declared: total,
      interest: 0,
      paid: 0,
      balance: total,
      transaction_code: 'SIM-DJ-20270605000001',
    })
    at('2027-06-10')
    cmdPayTaxReturn(ctx('tesoreria'), dj.id)
    expect(dj.status).toBe('PAGO_EN_BANCO')
    expect(dj.tr).toMatchObject({
      paid_on: '2027-06-10',
      paid_account_id: account('1.1.01.03'),
      interest: 0,
      imputed_on: null,
    })
    expect(lastEntry(dj.id)).toEqual([`2.1.04.02 ${total} 0`, `1.1.01.03 0 ${total}`])
    const order = orderOf(dj.id)
    expect(order).toMatchObject({
      status: 'PENDIENTE',
      direction: 'DEBITO',
      amount: total,
      ordered_by: userId('tesoreria'),
    })
    expect(db.audit.find((a) => a.document_id === dj.id && a.action === 'PAY')!.summary).toBe(
      `Pagó ${dj.display_number} por transferencia desde el Banco Aula: IVA de 05/2027, ${money(total)}`,
    )
    // Mientras tanto, para el fisco sigue sin pagar.
    expect(row()).toMatchObject({ state: 'EN_EL_BANCO', paid: 0, balance: total })
    expect(obligation()).toMatchObject({
      status: 'A_PAGAR',
      detail: 'Pago en el banco: el fisco lo imputa cuando el banco lo procesa',
    })
    const detail = documentDetail(db, userId('tesoreria'), companyId(), 'TAX_RETURN', dj.display_number)!
    expect(detail.next_step.who).toBe('Banco Aula (Tesorería)')
    expect(detail.tax_return!.bank_order).toMatchObject({ seq: order.seq, status: 'PENDIENTE' })
    // La procesa otro integrante de Tesorería (SoD-12), y el fisco imputa el pago.
    expectBusinessError(() => cmdProcessBankOrders(ctx('tesoreria'), companyId(), [order.id]), 'SEPARACION_FUNCIONES')
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [order.id])
    expect(dj.status).toBe('PAGADA')
    expect(dj.tr!.imputed_on).toBe('2027-06-10')
    expect(db.audit.filter((a) => a.document_id === dj.id).at(-1)).toMatchObject({
      action: 'SYSTEM',
      actor_user_id: null,
      summary: `El fisco imputó el pago de ${dj.display_number}: ${money(total)} (transacción ${order.transaction_number} del Banco Aula)`,
    })
    expect(row()).toMatchObject({
      state: 'PAGADA',
      paid: total,
      imputed_on: '2027-06-10',
      bank_transaction: order.transaction_number,
      balance: 0,
    })
    expect(taxAccount(db, userId('contabilidad'), companyId()).balance).toBe(0)
    expect(obligation()).toMatchObject({ status: 'CUMPLIDA', detail: 'Pagada el 10/06/2027' })
    // La cuenta corriente la lee quien lee el fisco; Tesorería no.
    expect(() => taxAccount(db, userId('tesoreria'), companyId())).toThrow()
  })

  it('fuera de término: con los intereses resarcitorios a la fecha, en la misma orden y a su cuenta', () => {
    const dj = acceptedMayReturn()
    const total = dj.total
    at('2027-07-05')
    // 15 días después del vencimiento (20/06): 4 % mensual simple, con mes de 30 días.
    const interest = Math.round((Math.round(total * 100) * 4 * 15) / 3000) / 100
    expect(interest).toBeGreaterThan(0)
    expect(row()).toMatchObject({ state: 'VENCIDA', interest, paid: 0, balance: round2(total + interest) })
    const view = documentDetail(db, userId('tesoreria'), companyId(), 'TAX_RETURN', dj.display_number)!
    expect(view.tax_return!.interest_to_date).toEqual({ days: 15, interest })
    expect(view.next_step.text).toBe(
      `Pagar ${money(total)} al fisco (simulado) por transferencia desde el Banco Aula: venció el 20/06/2027 y a hoy suma ${money(interest)} de intereses resarcitorios (15 días de atraso).`,
    )
    expect(obligation()).toMatchObject({ status: 'A_PAGAR', overdue: true })
    // Con el banco operado por el sistema, el fisco imputa el pago en el momento.
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { bank_mode: 'AUTOMATICO' })
    cmdPayTaxReturn(ctx('tesoreria'), dj.id)
    expect(dj.status).toBe('PAGADA')
    expect(dj.tr).toMatchObject({ paid_on: '2027-07-05', interest, imputed_on: '2027-07-05' })
    expect(lastEntry(dj.id)).toEqual([
      `2.1.04.02 ${total} 0`,
      `5.3.01.04 ${interest} 0`,
      `1.1.01.03 0 ${round2(total + interest)}`,
    ])
    expect(orderOf(dj.id)).toMatchObject({
      status: 'PROCESADO',
      amount: round2(total + interest),
      processed_on: '2027-07-05',
    })
    expect(db.audit.find((a) => a.document_id === dj.id && a.action === 'PAY')!.summary).toBe(
      `Pagó ${dj.display_number} por transferencia desde el Banco Aula: IVA de 05/2027, ${money(total)} y ${money(interest)} de intereses resarcitorios por 15 días de atraso`,
    )
    expect(row()).toMatchObject({ state: 'PAGADA', interest, paid: round2(total + interest), balance: 0 })
    expect(obligation()).toMatchObject({
      status: 'CUMPLIDA',
      overdue: false,
      detail: `Pagada el 05/07/2027, con ${money(interest)} de intereses resarcitorios`,
    })
  })

  it('sin fondos en el banco: la orden se rechaza, el fisco no imputa y Tesorería la reenvía', () => {
    const dj = acceptedMayReturn()
    const total = dj.total
    at('2027-06-10')
    // El banco queda en el límite del descubierto y un depósito registrado espera en el banco: los
    // libros tienen fondos y el banco no.
    manualEntry('Pago de la ampliación del galpón con transferencia bancaria.', [
      ['5.2.02.02', 13_800_000, 0],
      ['1.1.01.03', 0, 13_800_000],
    ])
    cmdProcessBankOrders(
      ctx('tesoreria2'),
      companyId(),
      db.bankMovements.filter((m) => m.company_id === companyId() && m.status === 'PENDIENTE').map((m) => m.id),
    )
    const deposit = manualEntry('Aporte de los socios depositado en el banco.', [
      ['1.1.01.03', 2_000_000, 0],
      ['3.1.01.01', 0, 2_000_000],
    ])
    cmdPayTaxReturn(ctx('tesoreria'), dj.id)
    const order = orderOf(dj.id)
    expect(cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [order.id])).toEqual({ processed: 0, rejected: 1 })
    expect(dj.status).toBe('PAGO_EN_BANCO')
    expect(row()).toMatchObject({ state: 'RECHAZADA', paid: 0, balance: total })
    expect(obligation().detail).toBe('El banco rechazó el pago por falta de fondos: hay que reenviarlo')
    expect(
      documentDetail(db, userId('tesoreria'), companyId(), 'TAX_RETURN', dj.display_number)!.next_step,
    ).toMatchObject({
      who: 'Tesorería',
      text: `El Banco Aula rechazó la orden N.º ${order.seq} por falta de fondos: hay que reenviarla desde la bandeja del banco cuando haya fondos. Hasta que el banco la procese, el fisco no imputa el pago.`,
    })
    // Una declaración pagada no se anula: se reenvía la orden cuando hay fondos.
    expectBusinessError(() => cmdCancelTaxReturn(ctx('contabilidad'), dj.id, 'Sin fondos'), 'TRANSICION_INVALIDA')
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [orderOf(deposit.id).id])
    at('2027-06-12')
    cmdResendBankOrder(ctx('tesoreria'), companyId(), order.id)
    expect(dj.status).toBe('PAGO_EN_BANCO')
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [order.id])
    expect(dj.status).toBe('PAGADA')
    // Los intereses se calcularon al pagar (a término): el fisco no los recalcula.
    expect(dj.tr).toMatchObject({ paid_on: '2027-06-10', imputed_on: '2027-06-12', interest: 0 })
  })

  it('con el módulo del banco bloqueado, el banco procesa solo: lo pendiente al bloquearlo y lo que llega', () => {
    const dj = acceptedMayReturn()
    cmdPayTaxReturn(ctx('tesoreria'), dj.id)
    expect(dj.status).toBe('PAGO_EN_BANCO')
    cmdSetModule(ctx('docente'), companyId(), 'bank', false)
    expect(dj.status).toBe('PAGADA')
    expect(db.bankMovements.filter((m) => m.company_id === companyId() && m.status === 'PENDIENTE')).toEqual([])
    expect(
      db.tasks.filter(
        (t) => t.company_id === companyId() && t.task_type === 'PROCESAR_BANCO' && t.status === 'PENDIENTE',
      ),
    ).toEqual([])
    expect(db.audit.at(-1)!.summary).toBe('Bloqueó el módulo Banco Aula')
    const deposit = manualEntry('Aporte de los socios depositado en el banco.', [
      ['1.1.01.03', 1_000, 0],
      ['3.1.01.01', 0, 1_000],
    ])
    expect(orderOf(deposit.id).status).toBe('PROCESADO')
  })
})

describe('Fisco: el domicilio fiscal electrónico y las intimaciones (8f.1)', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(`${iso}T10:00:00-03:00`))
  /** La venta del PV-00001, facturada en mayo (la empresa se dio de alta el 14/05/2027). */
  const sellInMay = () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const pv = byNumber('PV-00001')
    const lines = db.soLines.filter((l) => l.document_id === pv.id)
    cmdCreateSalesInvoice(
      ctx('ventas'),
      companyId(),
      { sales_order_id: pv.id, notes: '', lines: lines.map((l) => ({ so_line_id: l.id, quantity: l.qty_delivered })) },
      true,
    )
  }
  /** Una declaración presentada por Contabilidad y aceptada por el fisco (impuestos2). */
  const accepted = (tax: T.TaxCode, period: string) => {
    const dj = byNumber(cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax, period, notes: '' }).display_number)
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: true })
    return dj
  }
  const toIssue = () =>
    fiscalNoticesToIssue(db, userId('impuestos2'), companyId()).map((c) => [c.kind, c.tax, c.period, c.due_date])
  const issue = (kind: T.FiscalNoticeKind, tax: T.TaxCode, period: string, note = '', username = 'impuestos2') =>
    cmdIssueFiscalNotice(ctx(username), companyId(), { kind, tax, period, note })
  const notice = (number: number) => db.fiscalNotices.find((n) => n.company_id === companyId() && n.number === number)!
  const openTasks = () =>
    db.tasks
      .filter(
        (t) =>
          t.company_id === companyId() &&
          ['RESPONDER_INTIMACION', 'EVALUAR_DESCARGO'].includes(t.task_type) &&
          t.status === 'PENDIENTE',
      )
      .map((t) => [t.task_type, t.assigned_role])
  const view = (username = 'contabilidad') => fiscalNotices(db, userId(username), companyId())

  it('el fisco intima lo vencido desde el alta; se cumple solo al presentar y al pagar', () => {
    sellInMay()
    at('2027-06-05')
    const may = accepted('IVA', '2027-05')
    expect(may.total).toBeGreaterThan(0)
    at('2027-07-05')
    // Lo que venció desde el alta (14/05): las de abril y las de mayo; la de IVA de mayo, sin pagar.
    expect(toIssue()).toEqual([
      ['PRESENTACION', 'IIBB', '2027-04', '2027-05-15'],
      ['PRESENTACION', 'IVA', '2027-04', '2027-05-20'],
      ['PRESENTACION', 'IIBB', '2027-05', '2027-06-15'],
      ['PAGO', 'IVA', '2027-05', '2027-06-20'],
    ])
    expect(fiscalNoticesToIssue(db, userId('impuestos2'), companyId()).at(-1)).toMatchObject({
      amount: may.total,
      document: { display_number: may.display_number, status: 'PRESENTADA' },
    })
    // Lo intima quien opera el fisco: Ventas lee el domicilio, pero no intima.
    expect(() => fiscalNoticesToIssue(db, userId('ventas'), companyId())).toThrow()
    expectBusinessError(() => issue('PAGO', 'IVA', '2027-05', '', 'ventas'), 'SIN_PERMISO')
    expectBusinessError(() => issue('PAGO', 'IVA', '2027-06'), 'DATO_INVALIDO')
    expectBusinessError(() => issue('PAGO', 'IVA', '2027-05', 'x'.repeat(301)), 'DATO_INVALIDO')
    expect(issue('PAGO', 'IVA', '2027-05', 'Revisen el saldo del banco.')).toMatchObject({ number: 1 })
    const interest = Math.round((Math.round(may.total * 100) * 4 * 15) / 3000) / 100
    expect(notice(1)).toMatchObject({
      kind: 'PAGO',
      tax_return_id: may.id,
      subject: 'Intimación de pago',
      body: `Al 05/07/2027, el fisco no registra el pago de ${may.display_number} (IVA de 05/2027), que vencía el 20/06/2027: el saldo es ${money(may.total)} y los intereses resarcitorios a hoy, ${money(interest)}, que siguen corriendo hasta el pago. Se intima a Forestal del Norte SRL a pagarla dentro de los 15 días. Observaciones del fisco: Revisen el saldo del banco.`,
      issued_on: '2027-07-05',
      issued_by: userId('impuestos2'),
      response_due: '2027-07-20',
      status: 'PENDIENTE',
    })
    expectBusinessError(() => issue('PAGO', 'IVA', '2027-05'), 'DATO_INVALIDO')
    expect(issue('PRESENTACION', 'IIBB', '2027-05')).toMatchObject({ number: 2 })
    expect(notice(2).body).toBe(
      'Al 05/07/2027, el fisco no registra la presentación de la declaración de ingresos brutos de 05/2027, que vencía el 15/06/2027. Se intima a Forestal del Norte SRL a presentarla dentro de los 15 días.',
    )
    expect(db.audit.at(-1)!.summary).toBe(
      'Intimó a la empresa: falta de presentación de ingresos brutos de 05/2027 (intimación N.º 2)',
    )
    // El aviso, para Impuestos y Gerencia; la tarea de responder, para Impuestos.
    const notified = db.notifications.filter((n) => n.type === 'INTIMACION').map((n) => n.recipient_user_id)
    for (const u of ['contabilidad', 'gerencia']) expect(notified).toContain(userId(u))
    expect(openTasks()).toEqual([['RESPONDER_INTIMACION', 'IMPUESTOS']])
    // Quien la emitió no la responde (SoD-16): lo ve en el domicilio.
    expect(view('impuestos2').find((n) => n.number === 2)).toMatchObject({
      can_respond: false,
      sod_reason: 'Separación de funciones: la emitiste vos desde el fisco; la responde otro integrante de Impuestos.',
    })
    expect(view().find((n) => n.number === 2)).toMatchObject({ can_respond: true, sod_reason: null })
    expect(
      expectBusinessError(
        () => cmdRespondFiscalNotice(ctx('impuestos2'), companyId(), notice(2).id, 'La presentamos esta semana.'),
        'SEPARACION_FUNCIONES',
      ),
    ).toBe('No podés responder la intimación N.º 2: la emitiste vos.')
    // El pago en el banco todavía no la cumple; imputado, sí.
    cmdPayTaxReturn(ctx('tesoreria'), may.id)
    expect(notice(1).status).toBe('PENDIENTE')
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [
      db.bankMovements.find((m) => m.source_document_id === may.id && m.origin === 'ORDEN')!.id,
    ])
    expect(notice(1)).toMatchObject({ status: 'CUMPLIDA', closed_on: '2027-07-05', closed_by: null })
    expect(db.audit.filter((a) => a.entity_id === notice(1).id).at(-1)).toMatchObject({
      action: 'SYSTEM',
      actor_user_id: null,
      summary: `Dio por cumplida la intimación N.º 1: el fisco imputó el pago de ${may.display_number}`,
    })
    // La de ingresos brutos: se cumple al aceptar el fisco la declaración del mes.
    expect(view().find((n) => n.number === 2)!.overdue).toBe(false)
    at('2027-07-21')
    expect(view().find((n) => n.number === 2)!.overdue).toBe(true)
    const iibb = accepted('IIBB', '2027-05')
    expect(notice(2)).toMatchObject({ status: 'CUMPLIDA', closed_by: null })
    expect(db.audit.filter((a) => a.entity_id === notice(2).id).at(-1)!.summary).toBe(
      `Dio por cumplida la intimación N.º 2: el fisco aceptó ${iibb.display_number}`,
    )
    expect(openTasks()).toEqual([])
  })

  it('el descargo lo escribe Impuestos y lo evalúa otro integrante desde el fisco; con el fisco del sistema, en el momento', () => {
    at('2027-07-05')
    issue('PRESENTACION', 'IVA', '2027-05')
    issue('PRESENTACION', 'IVA', '2027-04')
    expectBusinessError(
      () => cmdRespondFiscalNotice(ctx('contabilidad'), companyId(), notice(1).id, 'Corto'),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdRespondFiscalNotice(ctx('ventas'), companyId(), notice(1).id, 'La presentamos esta semana.'),
      'SIN_PERMISO',
    )
    cmdRespondFiscalNotice(
      ctx('contabilidad'),
      companyId(),
      notice(1).id,
      'El contador estuvo de licencia: la presentamos esta semana.',
    )
    expect(notice(1)).toMatchObject({
      status: 'RESPONDIDA',
      responded_on: '2027-07-05',
      responded_by: userId('contabilidad'),
    })
    expect(openTasks()).toEqual([
      ['RESPONDER_INTIMACION', 'IMPUESTOS'],
      ['EVALUAR_DESCARGO', 'IMPUESTOS'],
    ])
    expectBusinessError(
      () => cmdRespondFiscalNotice(ctx('contabilidad'), companyId(), notice(1).id, 'Otra vez el descargo.'),
      'TRANSICION_INVALIDA',
    )
    // Quien escribió el descargo no lo evalúa (SoD-16); una pendiente no se da por cumplida.
    expect(view('contabilidad').find((n) => n.number === 1)).toMatchObject({
      can_close: false,
      sod_reason: 'Separación de funciones: escribiste el descargo; lo evalúa otro integrante de Impuestos.',
    })
    expectBusinessError(
      () => cmdCloseFiscalNotice(ctx('contabilidad'), companyId(), notice(1).id, ''),
      'SEPARACION_FUNCIONES',
    )
    expect(
      expectBusinessError(
        () => cmdCloseFiscalNotice(ctx('impuestos2'), companyId(), notice(2).id, ''),
        'TRANSICION_INVALIDA',
      ),
    ).toBe(
      'La intimación N.º 2 todavía no tiene descargo: se cumple presentando o pagando, o con la respuesta de la empresa.',
    )
    cmdCloseFiscalNotice(ctx('impuestos2'), companyId(), notice(1).id, 'Se acepta: presentar antes del 20/07.')
    expect(notice(1)).toMatchObject({
      status: 'CUMPLIDA',
      closed_by: userId('impuestos2'),
      close_note: 'Se acepta: presentar antes del 20/07.',
    })
    expect(openTasks()).toEqual([['RESPONDER_INTIMACION', 'IMPUESTOS']])
    // Con el fisco operado por el sistema, el descargo se acepta en el momento.
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { fisco_mode: 'AUTOMATICO' })
    cmdRespondFiscalNotice(ctx('contabilidad'), companyId(), notice(2).id, 'La de abril sale con la de mayo.')
    expect(notice(2)).toMatchObject({ status: 'CUMPLIDA', closed_by: null })
    expect(openTasks()).toEqual([])
  })

  it('la diferencia del control cruzado (fisco operado por Impuestos); al pasar el fisco al sistema, acepta los descargos', () => {
    sellInMay()
    at('2027-06-05')
    const dj = byNumber(
      cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period: '2027-05', notes: '' }).display_number,
    )
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    // Una diferencia entre lo declarado y lo que controló el fisco (por ejemplo, una factura sin autorizar).
    dj.tr!.control_amount = dj.tr!.tax_amount - 1000
    cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: true })
    expect(fiscalNoticesToIssue(db, userId('impuestos2'), companyId()).filter((c) => c.kind === 'DIFERENCIA')).toEqual([
      expect.objectContaining({ kind: 'DIFERENCIA', tax: 'IVA', period: '2027-05', amount: 1000 }),
    ])
    issue('DIFERENCIA', 'IVA', '2027-05')
    expect(notice(1)).toMatchObject({
      subject: 'Requerimiento por diferencia en el control cruzado',
      body: `En ${dj.display_number} (IVA de 05/2027) se declaró un débito fiscal de ${money(dj.tr!.tax_amount)} y los comprobantes autorizados del mes dan ${money(dj.tr!.tax_amount - 1000)}. Se intima a Forestal del Norte SRL a explicar la diferencia o a rectificar la declaración dentro de los 15 días.`,
    })
    cmdRespondFiscalNotice(
      ctx('contabilidad'),
      companyId(),
      notice(1).id,
      'Es la nota de crédito del día 31, que se autorizó en junio.',
    )
    expect(notice(1).status).toBe('RESPONDIDA')
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { fisco_mode: 'AUTOMATICO' })
    expect(notice(1)).toMatchObject({ status: 'CUMPLIDA', closed_by: null })
    expect(db.audit.filter((a) => a.entity_id === notice(1).id).at(-1)!.summary).toBe(
      'El fisco aceptó el descargo y dio por cumplida la intimación N.º 1',
    )
    expect(openTasks()).toEqual([])
  })
})

describe('Fisco: la multa por presentar fuera de término (8f.2)', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(`${iso}T10:00:00-03:00`))
  const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!.id
  /** La declaración de IVA de un mes, preparada y presentada por Contabilidad y aceptada por el fisco. */
  const accepted = (period: string) => {
    const dj = byNumber(
      cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period, notes: '' }).display_number,
    )
    cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
    cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: true })
    return dj
  }
  const fines = () => db.documents.filter((d) => d.company_id === companyId() && d.doc_type === 'TAX_FINE')
  /** Las líneas del último asiento de un documento. */
  const lastEntry = (id: string) => {
    const entry = db.docLinks
      .filter((l) => l.from_document_id === id)
      .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
      .filter((d) => d.doc_type === 'JOURNAL_ENTRY')
      .at(-1)!
    return db.jeLines
      .filter((l) => l.document_id === entry.id)
      .map((l) => `${db.accounts.find((a) => a.id === l.account_id)!.code} ${l.debit} ${l.credit}`)
  }

  it('presentada después del vencimiento, el fisco aplica la multa; dentro de los 15 días se paga la mitad', () => {
    at('2027-06-25')
    const dj = accepted('2027-05')
    const [fine] = fines()
    expect(fine).toMatchObject({
      display_number: 'MUL-00001',
      status: 'NOTIFICADA',
      total: 100000,
      tf: {
        tax: 'IVA',
        period: '2027-05',
        tax_return_id: dj.id,
        presented_on: '2027-06-25',
        due_date: '2027-06-20',
        amount: 100000,
        reduced_amount: 50000,
        reduction_until: '2027-07-10',
        paid_on: null,
      },
    })
    expect(db.docLinks.some((l) => l.from_document_id === dj.id && l.to_document_id === fine.id)).toBe(true)
    expect(db.audit.find((a) => a.document_id === fine.id && a.action === 'CREATE')).toMatchObject({
      actor_user_id: null,
      summary: `El fisco aplicó MUL-00001: multa por presentar ${dj.display_number} (IVA de 05/2027) fuera de término, ${money(100000)}; ${money(50000)} si se paga hasta el 10/07/2027`,
    })
    expect(
      db.tasks
        .filter((t) => t.document_id === fine.id && t.status === 'PENDIENTE')
        .map((t) => [t.task_type, t.assigned_role, t.title]),
    ).toEqual([['PAGAR_MULTA', 'TESORERIA', `Pagar MUL-00001 por ${money(100000)}`]])
    const notified = db.notifications.filter((n) => n.type === 'MULTA').map((n) => n.recipient_user_id)
    for (const u of ['tesoreria', 'gerencia', 'contabilidad']) expect(notified).toContain(userId(u))
    // En la cuenta corriente, la multa va después de su declaración: a pagar, la mitad.
    expect(taxAccount(db, userId('contabilidad'), companyId()).rows).toMatchObject([
      { kind: 'DECLARACION', document: { display_number: dj.display_number } },
      { kind: 'MULTA', document: { display_number: 'MUL-00001' }, state: 'A_PAGAR', declared: 50000, balance: 50000 },
    ])
    // La paga Tesorería, por el banco.
    expectBusinessError(() => cmdPayTaxFine(ctx('contabilidad'), fine.id), 'SIN_PERMISO')
    at('2027-07-05')
    cmdPayTaxFine(ctx('tesoreria'), fine.id)
    expect(fine).toMatchObject({
      status: 'PAGO_EN_BANCO',
      tf: { paid_on: '2027-07-05', paid_amount: 50000, paid_account_id: account('1.1.01.03') },
    })
    expect(lastEntry(fine.id)).toEqual(['5.3.02.03 50000 0', '1.1.01.03 0 50000'])
    expect(db.audit.find((a) => a.document_id === fine.id && a.action === 'PAY')!.summary).toBe(
      `Pagó MUL-00001 por transferencia desde el Banco Aula: ${money(50000)}, con la reducción a la mitad`,
    )
    const order = db.bankMovements.find((m) => m.source_document_id === fine.id && m.origin === 'ORDEN')!
    expect(order).toMatchObject({ status: 'PENDIENTE', amount: 50000 })
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [order.id])
    expect(fine).toMatchObject({ status: 'PAGADA', tf: { imputed_on: '2027-07-05' } })
    expect(taxAccount(db, userId('contabilidad'), companyId()).rows.find((r) => r.kind === 'MULTA')).toMatchObject({
      state: 'PAGADA',
      declared: 50000,
      paid: 50000,
      balance: 0,
      bank_transaction: order.transaction_number,
    })
    expect(documentDetail(db, userId('tesoreria'), companyId(), 'TAX_FINE', 'MUL-00001')!.tax_fine).toMatchObject({
      amount_due: 50000,
      imputed_on: '2027-07-05',
      tax_return: { display_number: dj.display_number },
    })
  })

  it('a término no hay multa; una sola por obligación; vencida la reducción, se paga entera', () => {
    at('2027-06-10')
    accepted('2027-05')
    expect(fines()).toEqual([])
    at('2027-07-25')
    const late = accepted('2027-06')
    expect(fines()).toHaveLength(1)
    // Anulada y presentada otra vez, fuera de término: la multa es la misma.
    cmdCancelTaxReturn(ctx('contabilidad'), late.id, 'Corregimos el crédito fiscal')
    accepted('2027-06')
    expect(fines()).toHaveLength(1)
    const [fine] = fines()
    expect(fine.tf!.reduction_until).toBe('2027-08-09')
    at('2027-08-10')
    expect(documentDetail(db, userId('tesoreria'), companyId(), 'TAX_FINE', fine.display_number)!.next_step.text).toBe(
      `Pagar ${money(100000)} por transferencia desde el Banco Aula: el plazo de la reducción venció el 09/08/2027.`,
    )
    cmdPayTaxFine(ctx('tesoreria'), fine.id)
    expect(fine.tf).toMatchObject({ paid_amount: 100000 })
    expect(lastEntry(fine.id)).toEqual(['5.3.02.03 100000 0', '1.1.01.03 0 100000'])
  })
})

describe('Fisco: las bases guardadas', () => {
  it('una base de la versión 27 recibe el padrón', () => {
    const old = structuredClone(db) as Partial<DB> & { version: number }
    delete old.taxpayers
    // Con el CUIT viejo de PRV-003, que tenía el dígito mal calculado.
    old.suppliers!.find((x) => x.code === 'PRV-003')!.tax_id = '30-00000102-9'
    old.version = 27
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    expect(db.taxpayers.length).toBe(padron(db, userId('contabilidad'), companyId()).length)
    expect(db.taxpayers.some((t) => t.cuit === db.companies[0].tax_id)).toBe(true)
    expect(db.suppliers.find((x) => x.code === 'PRV-003')!.tax_id).toBe('33-00000102-9')
    expect(db.taxpayers.some((t) => t.cuit === '33-00000102-9')).toBe(true)
  })

  it('una base de la versión 28 recibe el punto de venta 00001 y el código de sus facturas registradas', () => {
    cmdConfirmDeliveryNote(ctx('deposito'), byNumber('REM-00001').id)
    const pv = byNumber('PV-00001')
    const line = db.soLines.find((l) => l.document_id === pv.id && l.line_no === 1)!
    const sale = (register: boolean) =>
      cmdCreateSalesInvoice(
        ctx('ventas'),
        companyId(),
        { sales_order_id: pv.id, notes: '', lines: [{ so_line_id: line.id, quantity: 1 }] },
        register,
      )
    const registered = sale(true)
    const draft = sale(false)
    const old = structuredClone(db) as Partial<DB> & { version: number }
    delete old.pointsOfSale
    for (const d of old.documents!)
      if (d.fv) {
        const fv: Partial<T.SalesInvoiceHeader> = d.fv
        delete fv.authorization_code
        delete fv.authorization_due
      }
    old.version = 28
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    expect(pointsOfSale(db, userId('ventas'), companyId()).map((p) => [p.number, p.status])).toEqual([
      ['00001', 'HABILITADO'],
    ])
    const fv = byNumber(registered.display_number)
    expect(fv.fv).toMatchObject({
      authorization_code: `SIM-${fv.document_date.replaceAll('-', '')}000001`,
      authorization_due: addDays(fv.document_date, 10),
    })
    expect(byNumber(draft.display_number).fv).toMatchObject({ authorization_code: null, authorization_due: null })
  })

  it('una base de la versión 29 recibe los datos de la recepción y el segundo integrante de Impuestos', () => {
    const dj = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period: '2027-04', notes: '' })
    const old = structuredClone(db) as Partial<DB> & { version: number }
    for (const d of old.documents!)
      if (d.tr) {
        const tr: Partial<T.TaxReturnHeader> = d.tr
        delete tr.control_amount
        delete tr.transaction_code
        delete tr.received_on
        delete tr.received_by
      }
    const officer = old.profiles!.find((p) => p.username === 'impuestos2')!
    const member = old.members!.find((m) => m.user_id === officer.id)!
    old.profiles = old.profiles!.filter((p) => p.id !== officer.id)
    old.members = old.members!.filter((m) => m.id !== member.id)
    old.memberRoles = old.memberRoles!.filter((r) => r.member_id !== member.id)
    old.version = 29
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    expect(byNumber(dj.display_number).tr).toMatchObject({
      control_amount: null,
      transaction_code: null,
      received_on: null,
      received_by: null,
    })
    const again = db.profiles.find((p) => p.username === 'impuestos2')!
    const roles = db.memberRoles.filter((r) => db.members.find((m) => m.id === r.member_id)?.user_id === again.id)
    expect(roles.map((r) => r.role_code)).toEqual(['IMPUESTOS'])
  })

  it('una base de la versión 30 recibe la cuenta de los intereses resarcitorios, sus reglas y los datos del pago', () => {
    const dj = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period: '2027-04', notes: '' })
    const company = companyId()
    const old = structuredClone(db) as Partial<DB> & { version: number }
    old.accounts = old.accounts!.filter((a) => a.company_id !== company || a.code !== '5.3.01.04')
    old.postingRules = old.postingRules!.filter((r) => r.key !== 'INTERESES' || !r.event.startsWith('PAGO_'))
    for (const d of old.documents!)
      if (d.tr) {
        const tr: Partial<T.TaxReturnHeader> = d.tr
        delete tr.interest
        delete tr.imputed_on
        // Una declaración pagada antes de la 8e.2.
        if (d.id === dj.id) {
          d.status = 'PAGADA'
          tr.paid_on = '2027-05-10'
        }
      }
    old.version = 30
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    expect(byNumber(dj.display_number).tr).toMatchObject({ interest: 0, imputed_on: '2027-05-10' })
    const interest = db.accounts.find((a) => a.company_id === company && a.code === '5.3.01.04')!
    expect(interest).toMatchObject({ name: 'Intereses resarcitorios', is_imputable: true, is_active: true })
    expect(
      db.postingRules
        .filter((r) => r.company_id === company && r.key === 'INTERESES' && r.event.startsWith('PAGO_'))
        .map((r) => [r.event, r.account_id]),
    ).toEqual([
      ['PAGO_IVA', interest.id],
      ['PAGO_IIBB', interest.id],
    ])
  })

  it('una base de la versión 32 recibe la cuenta de las multas y la regla de su pago', () => {
    const company = companyId()
    const old = structuredClone(db) as Partial<DB> & { version: number }
    old.accounts = old.accounts!.filter((a) => a.company_id !== company || a.code !== '5.3.02.03')
    old.postingRules = old.postingRules!.filter((r) => r.event !== 'PAGO_MULTA')
    old.version = 32
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    const fines = db.accounts.find((a) => a.company_id === company && a.code === '5.3.02.03')!
    expect(fines).toMatchObject({ name: 'Multas fiscales', is_imputable: true })
    expect(
      db.postingRules
        .filter((r) => r.company_id === company && r.event === 'PAGO_MULTA')
        .map((r) => [r.key, r.account_id]),
    ).toEqual([['MULTA', fines.id]])
  })

  it('una base de la versión 31 recibe el domicilio fiscal electrónico, vacío', () => {
    const old = structuredClone(db) as Partial<DB> & { version: number }
    delete old.fiscalNotices
    old.version = 31
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    expect(db.fiscalNotices).toEqual([])
  })
})
