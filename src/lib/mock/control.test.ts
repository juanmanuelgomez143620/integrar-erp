// Pruebas del tablero de control (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §5, 7d.1) sobre
// buildSeed() y los cmd*: el mes elegido contra el anterior, desde el libro mayor y el Banco Aula.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from './db'
import { BusinessError, cmdCreateJournalEntry, cmdProcessBankOrders, type Ctx } from './engine'
import { controlPanel, type ControlPanel } from './queries'
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
