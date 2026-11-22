// Pruebas del tablero de control (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §5, 7d) sobre
// buildSeed() y los cmd*: el mes elegido contra el anterior, desde el libro mayor y el Banco Aula (7d.1), y
// las alertas de lo que requiere atención hoy (7d.2).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from './db'
import {
  BusinessError,
  cmdCancelPaymentOrder,
  cmdConfirmDeliveryNote,
  cmdCreateJournalEntry,
  cmdCreateSalesInvoice,
  cmdCreateTaxReturn,
  cmdPresentTaxReturn,
  cmdProcessBankOrders,
  cmdReceiveTaxReturn,
  cmdSaveMaster,
  type Ctx,
} from './engine'
import { cashProjection, controlPanel, listPayables, listReceivables, type ControlPanel } from './queries'
import { money } from '../format'
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
const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!.id
const at = (iso: string) => vi.setSystemTime(new Date(`${iso}T10:00:00-03:00`))
const byNumber = (n: string) => db.documents.find((d) => d.company_id === companyId() && d.display_number === n)!
const round2 = (n: number) => Math.round(n * 100) / 100
const indicator = (panel: ControlPanel, key: string) =>
  panel.areas.flatMap((a) => a.indicators).find((i) => i.key === key)!
const panel = (period = '2027-05', username = 'gerencia') => controlPanel(db, userId(username), companyId(), period)
/** Un asiento manual de Contabilidad, registrado con su fecha. */
const entry = (date: string, description: string, lines: [string, number, number][]) =>
  cmdCreateJournalEntry(
    ctx('contabilidad'),
    companyId(),
    {
      document_date: date,
      description,
      lines: lines.map(([code, debit, credit]) => ({ account_id: account(code), debit, credit })),
    },
    true,
  )

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

describe('Tablero de control (7d.1)', () => {
  it('lo del mes sale del libro mayor y se compara con el anterior; los saldos son al cierre', () => {
    // Mayo: un servicio cobrado en efectivo suma a las ventas del mes.
    at('2027-05-20')
    const may = indicator(panel(), 'VENTAS').value
    entry('2027-05-20', 'Servicios de flete cobrados en efectivo.', [
      ['1.1.01.01', 100000, 0],
      ['4.1.01.03', 0, 100000],
    ])
    expect(indicator(panel(), 'VENTAS').value).toBe(round2(may + 100000))
    // Junio, contra mayo.
    at('2027-06-10')
    const before = panel('2027-06')
    expect(before).toMatchObject({
      period: '2027-06',
      previous: '2027-05',
      to: '2027-06-10',
      previous_to: '2027-05-31',
    })
    expect(indicator(before, 'VENTAS')).toMatchObject({ value: 0, previous: round2(may + 100000) })
    expect(indicator(before, 'MARGEN')).toMatchObject({
      previous: round2(indicator(before, 'VENTAS').previous - indicator(before, 'COSTO_VENTAS').previous),
    })
    // Un gasto de junio pagado por el banco: baja el resultado y lo disponible según los libros.
    entry('2027-06-10', 'Pago de la energía eléctrica del taller.', [
      ['5.2.02.02', 30000, 0],
      ['1.1.01.03', 0, 30000],
    ])
    const after = panel('2027-06')
    expect(indicator(after, 'RESULTADO').value).toBe(round2(indicator(before, 'RESULTADO').value - 30000))
    expect(indicator(after, 'DISPONIBLE').value).toBe(round2(indicator(before, 'DISPONIBLE').value - 30000))
    expect(indicator(after, 'RESULTADO').previous).toBe(indicator(before, 'RESULTADO').previous)
    // El banco lo debita recién cuando procesa la orden (la procesa otro integrante: no la envió Tesorería).
    expect(indicator(after, 'SALDO_BANCO').value).toBe(indicator(before, 'SALDO_BANCO').value)
    const order = db.bankMovements.find((m) => m.status === 'PENDIENTE' && m.amount === 30000)!
    cmdProcessBankOrders(ctx('tesoreria'), companyId(), [order.id])
    expect(indicator(panel('2027-06'), 'SALDO_BANCO').value).toBe(
      round2(indicator(before, 'SALDO_BANCO').value - 30000),
    )
    expect(indicator(panel('2027-06'), 'SALDO_BANCO')).toMatchObject({ better: 'UP', label: 'Saldo según el banco' })
  })

  it('lo ven Gerencia, Auditoría y el docente; un mes que no empezó no se elige', () => {
    for (const u of ['gerencia', 'auditor', 'docente'])
      expect(panel('2027-05', u).areas.map((a) => a.key)).toEqual([
        'RESULTADOS',
        'PERSONAL',
        'TERCEROS',
        'STOCK',
        'TESORERIA',
        'IMPUESTOS',
      ])
    expect(
      panel()
        .areas.find((a) => a.key === 'TESORERIA')!
        .indicators.map((i) => i.key),
    ).toEqual(['DISPONIBLE', 'SALDO_BANCO', 'PRESTAMOS'])
    expect(() => panel('2027-05', 'ventas')).toThrow()
    expectBusinessError(() => panel('2027-06'), 'DATO_INVALIDO')
    expectBusinessError(() => panel('2027-13'), 'DATO_INVALIDO')
    // Un mes terminado se mide hasta su último día.
    expect(panel('2027-02')).toMatchObject({ to: '2027-02-28', previous: '2027-01', previous_to: '2027-01-31' })
    // Sin movimientos, en cero (no en "menos cero").
    expect(Object.is(indicator(panel('2027-02'), 'VENTAS').value, 0)).toBe(true)
  })
})

/** La factura de venta del pedido de la demo, con su remito confirmado. */
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

/** Contabilidad prepara y presenta la declaración de IVA del mes; el fisco (otro de Impuestos) la acepta. */
function presentIva(period: string) {
  const { display_number } = cmdCreateTaxReturn(ctx('contabilidad'), companyId(), { tax: 'IVA', period, notes: '' })
  const dj = byNumber(display_number)
  cmdPresentTaxReturn(ctx('contabilidad'), dj.id)
  cmdReceiveTaxReturn(ctx('impuestos2'), dj.id, { accept: true })
  return dj
}

describe('Alertas del tablero (7d.2)', () => {
  const keys = (p: ControlPanel) => p.alerts.map((a) => a.key)
  const alert = (p: ControlPanel, key: string) => p.alerts.find((a) => a.key === key)!

  it('el stock bajo el mínimo: los tres primeros códigos y cuántos más, con el enlace a Stock', () => {
    expect(panel().alerts).toEqual([
      {
        key: 'STOCK_MINIMO',
        severity: 'warning',
        title: '3 productos bajo el stock mínimo',
        detail: 'IN-005, MP-004, MP-007',
        path: `/e/${db.companies[0].slug}/stock`,
      },
    ])
    // Compras sube el mínimo de dos productos más.
    for (const code of ['PT-001', 'MP-001']) {
      const product = db.products.find((p) => p.company_id === companyId() && p.code === code)!
      cmdSaveMaster(ctx('compras1'), 'product', companyId(), { ...product, min_stock: 1_000_000 })
    }
    expect(alert(panel(), 'STOCK_MINIMO')).toMatchObject({
      title: '5 productos bajo el stock mínimo',
      detail: 'IN-005, MP-001, MP-004 y 2 más',
    })
    // No dependen del mes elegido: son de hoy.
    expect(panel('2027-02').alerts).toEqual(panel().alerts)
  })

  it('lo vencido de clientes y proveedores sale de sus cuentas corrientes', () => {
    // La factura del pedido de la demo y la del proveedor sin su orden de pago: tres meses después, sin
    // cobrar ni pagar.
    invoiceDemoOrder()
    const payment = db.documents.find((d) => d.company_id === companyId() && d.doc_type === 'PAYMENT_ORDER')!
    cmdCancelPaymentOrder(ctx('contabilidad'), payment.id, 'Se paga más adelante')
    expect(keys(panel())).toEqual(['STOCK_MINIMO'])
    at('2027-08-20')
    const later = panel('2027-08')
    const receivables = listReceivables(db, userId('gerencia'), companyId()).filter((r) => r.overdue > 0)
    const payables = listPayables(db, userId('gerencia'), companyId()).filter((r) => r.overdue > 0)
    expect(receivables.length).toBeGreaterThan(0)
    expect(payables.length).toBeGreaterThan(0)
    const sum = (rows: { overdue: number }[]) => money(round2(rows.reduce((s, r) => s + r.overdue, 0)))
    expect(alert(later, 'CLIENTES_VENCIDOS')).toMatchObject({
      severity: 'warning',
      title: `${sum(receivables)} vencidos de los clientes`,
      path: `/e/${db.companies[0].slug}/ventas/clientes`,
    })
    expect(alert(later, 'PROVEEDORES_VENCIDOS')).toMatchObject({
      severity: 'danger',
      title: `${sum(payables)} vencidos con los proveedores`,
      path: `/e/${db.companies[0].slug}/pagos/proveedores`,
    })
    expect(keys(later).slice(0, 3)).toEqual(['STOCK_MINIMO', 'CLIENTES_VENCIDOS', 'PROVEEDORES_VENCIDOS'])
  })

  it('la falta de fondos del flujo proyectado y la orden que el banco rechaza', () => {
    entry('2027-05-14', 'Pago de la ampliación del galpón con transferencia bancaria.', [
      ['5.2.02.02', 100_000_000, 0],
      ['1.1.01.03', 0, 100_000_000],
    ])
    const projection = cashProjection(db, userId('gerencia'), companyId())
    const bucket = projection.buckets.find((b) => b.key === projection.shortfall)!
    expect(alert(panel(), 'FALTA_DE_FONDOS')).toMatchObject({
      severity: 'danger',
      detail: `El saldo proyectado queda en negativo en el tramo «${bucket.label}».`,
      path: `/e/${db.companies[0].slug}/pagos/flujo-de-fondos`,
    })
    expect(keys(panel())).not.toContain('BANCO_RECHAZADAS')
    // El banco no la debita: supera el saldo más el acuerdo de descubierto.
    const order = db.bankMovements.find((m) => m.status === 'PENDIENTE' && m.amount === 100_000_000)!
    cmdProcessBankOrders(ctx('tesoreria'), companyId(), [order.id])
    expect(alert(panel(), 'BANCO_RECHAZADAS')).toMatchObject({
      severity: 'danger',
      title: '1 orden rechazada por el banco',
      path: `/e/${db.companies[0].slug}/pagos/banco-aula`,
    })
    expect(keys(panel())).toEqual(['STOCK_MINIMO', 'FALTA_DE_FONDOS', 'BANCO_RECHAZADAS'])
  })

  it('la multa del fisco sin pagar y la declaración vencida sin pagar', () => {
    invoiceDemoOrder()
    at('2027-06-05')
    // La de abril, fuera de término: el fisco aplica la multa, a la mitad dentro de los 15 días.
    presentIva('2027-04')
    expect(alert(panel('2027-06'), 'MULTAS')).toMatchObject({
      severity: 'warning',
      title: '1 multa del fisco sin pagar',
      detail: `A pagar hoy: ${money(50_000)} (dentro de los 15 días de notificada, la multa se reduce a la mitad).`,
      path: `/e/${db.companies[0].slug}/impuestos/multas`,
    })
    // La de mayo, a tiempo: no está vencida hasta que pasa su vencimiento sin pagarla.
    const may = presentIva('2027-05')
    expect(may.status).toBe('PRESENTADA')
    expect(keys(panel('2027-06'))).not.toContain('DECLARACIONES_VENCIDAS')
    at('2027-06-25')
    const late = panel('2027-06')
    expect(alert(late, 'DECLARACIONES_VENCIDAS')).toMatchObject({
      severity: 'danger',
      title: '1 declaración vencida sin pagar',
      detail: `${money(may.total)}, más los intereses resarcitorios.`,
      path: `/e/${db.companies[0].slug}/impuestos/declaraciones`,
    })
    expect(alert(late, 'MULTAS').detail).toContain(`A pagar hoy: ${money(100_000)} `)
  })
})
