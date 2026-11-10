// Pruebas del fisco simulado (docs/FASE_8_BANCO_Y_FISCO.md §4, 8d): el padrón de la empresa, su
// alta, modificación y baja por quien opera el fisco (Impuestos) y la letra de la factura de venta,
// que sale del padrón (8d.1); los puntos de venta que pide Ventas y habilita Impuestos, y la
// autorización de cada factura de venta (8d.2).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cuitIsValid } from '../domain/cuit'
import type * as T from '../domain/types'
import { addDays } from '../format'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdAssignRole,
  cmdConfirmDeliveryNote,
  cmdConfirmSalesInvoice,
  cmdCreateSalesInvoice,
  cmdDecidePointOfSale,
  cmdRequestPointOfSale,
  cmdSaveTaxpayer,
  cmdSetTaxpayerActive,
  cmdUpdateCompanySettings,
  type Ctx,
  type TaxpayerInput,
} from './engine'
import { authorizedVouchers, invoiceableSalesOrders, padron, pointsOfSale } from './queries'
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
})
