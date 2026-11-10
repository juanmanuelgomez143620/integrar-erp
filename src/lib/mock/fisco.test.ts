// Pruebas del fisco simulado (docs/FASE_8_BANCO_Y_FISCO.md §4, 8d.1): el padrón de la empresa, su
// alta, modificación y baja por quien opera el fisco (Impuestos) y la letra de la factura de venta,
// que sale del padrón.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cuitIsValid } from '../domain/cuit'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdConfirmDeliveryNote,
  cmdCreateSalesInvoice,
  cmdSaveTaxpayer,
  cmdSetTaxpayerActive,
  type Ctx,
  type TaxpayerInput,
} from './engine'
import { invoiceableSalesOrders, padron } from './queries'
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
})
