// Pruebas de los préstamos del Banco Aula (docs/FASE_8_BANCO_Y_FISCO.md §3, 8c.1): el cronograma por
// sistema francés, el pedido de Gerencia con los indicadores del libro mayor, la evaluación de
// Tesorería (SoD-13) o del sistema, la acreditación, el débito de las cuotas y su registro.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as T from '../domain/types'
import { money } from '../format'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdAssignRole,
  cmdCreateJournalEntry,
  cmdDebitLoanInstallments,
  cmdEvaluateLoan,
  cmdRegisterBankCharges,
  cmdRequestLoan,
  cmdUpdateCompanySettings,
  loanIndicators,
  loanSchedule,
  type Ctx,
} from './engine'
import { bankAccountView, bankLoans, listTasks, loanPreview, reconciliationCandidates } from './queries'
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
const travel = (day: string) => vi.setSystemTime(new Date(`${day}T12:00:00-03:00`))
const loans = (username = 'gerencia') => bankLoans(db, userId(username), companyId()).loans
const tasks = (username: string, type: string) =>
  listTasks(db, userId(username), companyId(), 'mine').filter((t) => t.task_type === type)

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

const request = (amount = 1_000_000, months = 12, username = 'gerencia') =>
  cmdRequestLoan(ctx(username), companyId(), { amount, months, purpose: 'Capital de trabajo para la temporada alta' })
const approve = (id: string, rate = 48, months = 12, username = 'tesoreria') =>
  cmdEvaluateLoan(ctx(username), id, { approve: true, rate, months })
const systemOperates = () => cmdUpdateCompanySettings(ctx('docente'), companyId(), { bank_mode: 'AUTOMATICO' })

describe('Préstamos: el cronograma por sistema francés', () => {
  it('cuota fija, el interés de cada cuota al centavo y la última ajusta el capital', () => {
    const rows = loanSchedule(1_000_000, 48, 12, '2027-01-31')
    expect(rows).toHaveLength(12)
    // 4 % mensual: el primer interés es 40.000 y la cuota, 106.552,17.
    expect(rows[0]).toEqual({ n: 1, due_on: '2027-02-28', principal: 66_552.17, interest: 40_000 })
    expect(rows.slice(0, 11).every((r) => Math.round((r.principal + r.interest) * 100) === 10_655_217)).toBe(true)
    expect(rows[11]).toEqual({ n: 12, due_on: '2028-01-31', principal: 102_454.03, interest: 4_098.16 })
    expect(Math.round(rows.reduce((s, r) => s + r.principal, 0) * 100)).toBe(100_000_000)
    // Vence el mismo día de cada mes o el último, si el mes no lo tiene.
    expect(rows.slice(0, 4).map((r) => r.due_on)).toEqual(['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31'])
  })

  it('sin interés, la cuota es el capital dividido el plazo', () => {
    const rows = loanSchedule(100_000, 0, 6, '2027-05-14')
    expect(rows.map((r) => [r.principal, r.interest])).toEqual([
      [16_666.67, 0],
      [16_666.67, 0],
      [16_666.67, 0],
      [16_666.67, 0],
      [16_666.67, 0],
      [16_666.65, 0],
    ])
  })
})

describe('Préstamos: el pedido de Gerencia', () => {
  it('guarda los indicadores del libro mayor del día y le deja a Tesorería la tarea de evaluarlo', () => {
    const preview = loanPreview(db, userId('gerencia'), companyId(), 1_000_000, 12)!
    expect(preview).toEqual(loanIndicators(db, companyId(), 1_000_000, 12))
    // La demo: buena liquidez, poca deuda y sin ventas en mayo (la cuota sobre ventas no se calcula).
    expect(preview).toMatchObject({
      liquidity: 2.98,
      debt_ratio: 0.07,
      installment: 106_552.17,
      sales: 0,
      sales_share: null,
    })
    const created = request()
    expect(created).toMatchObject({ number: 1, status: 'SOLICITADO' })
    expect(loans()[0]).toMatchObject({
      number: 1,
      amount: 1_000_000,
      months: 12,
      status: 'SOLICITADO',
      liquidity: 2.98,
      debt_ratio: 0.07,
      sales_share: null,
      requested_on: '2027-05-14',
      own: true,
      installments: [],
    })
    expect(tasks('tesoreria2', 'EVALUAR_PRESTAMO').map((t) => t.path)).toEqual([
      '/e/forestal-del-norte/pagos/banco-aula/bandeja',
    ])
    expect(db.audit.at(-1)!.summary).toBe(
      `Pidió al Banco Aula el préstamo N.º 1: ${money(1_000_000)} en 12 cuotas, para Capital de trabajo para la temporada alta`,
    )
  })

  it('valida el importe, el plazo y el destino; sólo lo pide Gerencia y de a uno', () => {
    expectBusinessError(() => request(0), 'DATO_INVALIDO')
    expectBusinessError(() => request(50_000_000.01), 'DATO_INVALIDO')
    expectBusinessError(() => request(1_000.005), 'DATO_INVALIDO')
    expect(expectBusinessError(() => request(1_000_000, 10), 'DATO_INVALIDO')).toBe(
      'El plazo es de 6, 12, 18 o 24 cuotas mensuales.',
    )
    expectBusinessError(
      () => cmdRequestLoan(ctx('gerencia'), companyId(), { amount: 1_000, months: 6, purpose: ' x ' }),
      'DATO_INVALIDO',
    )
    expectBusinessError(() => request(1_000_000, 12, 'tesoreria'), 'SIN_PERMISO')
    expect(loanPreview(db, userId('gerencia'), companyId(), 1_000_000, 10)).toBeNull()
    request()
    expect(expectBusinessError(() => request(), 'TRANSICION_INVALIDA')).toBe(
      'El préstamo N.º 1 todavía espera la evaluación del banco: se pide de a uno.',
    )
  })
})

describe('Préstamos: la evaluación y la acreditación', () => {
  it('Tesorería lo aprueba: el banco acredita el importe y arma el cronograma; Gerencia recibe el aviso', () => {
    const { id } = request()
    expect(approve(id, 48, 12)).toEqual({ status: 'VIGENTE' })
    const loan = loans()[0]
    expect(loan).toMatchObject({ status: 'VIGENTE', rate: 48, granted_on: '2027-05-14', outstanding: 1_000_000 })
    expect(loan.installments.map((i) => [i.n, i.due_on, i.total, i.status, i.due])[0]).toEqual([
      1,
      '2027-06-14',
      106_552.17,
      'PENDIENTE',
      false,
    ])
    const v = bankAccountView(db, userId('tesoreria'), companyId())!
    expect(v.movements[0]).toMatchObject({
      origin: 'BANCO',
      charge: 'PRESTAMO',
      direction: 'CREDITO',
      amount: 1_000_000,
      concept: 'Acreditación del préstamo N.º 1',
      processed_on: '2027-05-14',
    })
    expect(v.balance).toBe(12_500_000 + 1_000_000)
    const notice = db.notifications.find((n) => n.type === 'PRESTAMO' && n.recipient_user_id === userId('gerencia'))!
    expect(notice).toMatchObject({
      title: 'El Banco Aula aprobó el préstamo N.º 1',
      body: `Acreditó ${money(1_000_000)} en la cuenta: 12 cuotas de ${money(106_552.17)} al 48 % anual. Contabilidad lo registra desde la conciliación.`,
    })
    expect(tasks('tesoreria2', 'EVALUAR_PRESTAMO')).toEqual([])
    expect(tasks('contabilidad', 'REGISTRAR_CARGOS_BANCO')).toHaveLength(1)
    expect(db.audit.at(-1)!.summary).toBe(
      `Aprobó el préstamo N.º 1: acreditó ${money(1_000_000)} en 12 cuotas al 48 % anual`,
    )
  })

  it('el banco puede cambiar el plazo y la tasa, o rechazarlo con el motivo', () => {
    const first = request()
    expect(
      expectBusinessError(
        () => cmdEvaluateLoan(ctx('tesoreria'), first.id, { approve: false, reason: ' ' }),
        'MOTIVO_REQUERIDO',
      ),
    ).toBe('Indicá el motivo del rechazo: lo recibe Gerencia.')
    cmdEvaluateLoan(ctx('tesoreria'), first.id, { approve: false, reason: 'Falta el plan de negocios' })
    expect(loans()[0]).toMatchObject({ status: 'RECHAZADO', rejection_reason: 'Falta el plan de negocios' })
    expect(db.notifications.find((n) => n.title === 'El Banco Aula rechazó el préstamo N.º 1')!.body).toBe(
      'Motivo: Falta el plan de negocios',
    )
    expect(expectBusinessError(() => approve(first.id), 'TRANSICION_INVALIDA')).toBe(
      'El préstamo N.º 1 ya está rechazado.',
    )
    // Rechazado el anterior, Gerencia puede pedir otro; el banco lo aprueba a 6 meses y al 36,5 %.
    const second = request(600_000, 12)
    expectBusinessError(() => approve(second.id, 200.01), 'DATO_INVALIDO')
    expectBusinessError(() => approve(second.id, 48, 9), 'DATO_INVALIDO')
    expectBusinessError(() => approve(second.id, 48, 12, 'contabilidad'), 'SIN_PERMISO')
    approve(second.id, 36.5, 6)
    expect(loans()[0]).toMatchObject({ number: 2, months: 6, rate: 36.5 })
    expect(loans()[0].installments).toHaveLength(6)
  })

  it('quien pidió el préstamo no lo evalúa (SoD-13)', () => {
    const tes = db.sectors.find((s) => s.company_id === companyId() && s.code === 'TES')!.id
    cmdAssignRole(ctx('docente'), companyId(), userId('gerencia'), 'TESORERIA', tes)
    const { id } = request()
    expect(expectBusinessError(() => approve(id, 48, 12, 'gerencia'), 'SEPARACION_FUNCIONES')).toBe(
      'No podés evaluar el préstamo N.º 1: lo pediste vos.',
    )
    expect(approve(id, 48, 12, 'tesoreria')).toEqual({ status: 'VIGENTE' })
  })

  it('si lo opera el sistema, decide en el momento: aprueba con la tasa de referencia o rechaza diciendo por qué', () => {
    systemOperates()
    expect(request()).toMatchObject({ status: 'VIGENTE' })
    expect(loans()[0]).toMatchObject({ rate: 48, months: 12, evaluated_by_name: null })
    expect(tasks('tesoreria2', 'EVALUAR_PRESTAMO')).toEqual([])
    // Una deuda nueva de 25.000.000 deja la liquidez corriente por debajo de 1.
    cmdCreateJournalEntry(
      ctx('contabilidad'),
      companyId(),
      {
        document_date: '2027-05-14',
        description: 'Compra de una máquina a pagar.',
        lines: [
          { account_id: account('1.2.01.01'), debit: 25_000_000, credit: 0 },
          { account_id: account('2.1.05.01'), debit: 0, credit: 25_000_000 },
        ],
      },
      true,
    )
    expect(request(500_000, 6)).toMatchObject({ status: 'RECHAZADO' })
    const rejected = loans()[0]
    expect(rejected.liquidity).toBeLessThan(1)
    expect(rejected.rejection_reason).toBe(
      `La liquidez corriente es ${String(rejected.liquidity).replace('.', ',')}: el banco pide al menos 1.`,
    )
  })
})

describe('Préstamos: las cuotas y su registro', () => {
  it('al vencer, quien opera el banco debita la cuota en dos movimientos; con la última, queda cancelado', () => {
    const { id } = request(600_000, 6)
    approve(id, 48, 6)
    expect(expectBusinessError(() => cmdDebitLoanInstallments(ctx('tesoreria'), companyId()), 'DATO_INVALIDO')).toBe(
      'No hay cuotas vencidas para debitar.',
    )
    travel('2027-07-20')
    expect(
      loans()[0]
        .installments.filter((i) => i.due)
        .map((i) => i.n),
    ).toEqual([1, 2])
    expectBusinessError(() => cmdDebitLoanInstallments(ctx('contabilidad'), companyId()), 'SIN_PERMISO')
    expect(cmdDebitLoanInstallments(ctx('tesoreria'), companyId())).toEqual({ debited: 2 })
    const v = bankAccountView(db, userId('tesoreria'), companyId())!
    const first = loans()[0].installments[0]
    expect(
      v.movements
        .slice(0, 4)
        .map((m) => [m.charge, m.amount, m.concept])
        .reverse(),
    ).toEqual([
      ['CUOTA_CAPITAL', first.principal, 'Préstamo N.º 1 · cuota 1 de 6: capital'],
      ['CUOTA_INTERES', first.interest, 'Préstamo N.º 1 · cuota 1 de 6: intereses'],
      ['CUOTA_CAPITAL', loans()[0].installments[1].principal, 'Préstamo N.º 1 · cuota 2 de 6: capital'],
      ['CUOTA_INTERES', loans()[0].installments[1].interest, 'Préstamo N.º 1 · cuota 2 de 6: intereses'],
    ])
    expect(
      loans()[0]
        .installments.slice(0, 2)
        .map((i) => [i.status, i.debited_on]),
    ).toEqual([
      ['DEBITADA', '2027-07-20'],
      ['DEBITADA', '2027-07-20'],
    ])
    travel('2027-11-14')
    cmdDebitLoanInstallments(ctx('tesoreria2'), companyId())
    expect(loans()[0]).toMatchObject({ status: 'CANCELADO', outstanding: 0 })
  })

  it('si lo opera el sistema, debita las cuotas vencidas la próxima vez que mueve la cuenta', () => {
    systemOperates()
    request(600_000, 6)
    travel('2027-06-14')
    expect(loans()[0].installments[0]).toMatchObject({ status: 'PENDIENTE', due: true })
    // Un pedido nuevo de la empresa mueve el banco: primero debita la cuota.
    request(100_000, 6)
    expect(loans().find((l) => l.number === 1)!.installments[0]).toMatchObject({
      status: 'DEBITADA',
      debited_on: '2027-06-14',
    })
  })

  it('Contabilidad registra la acreditación y las cuotas desde la conciliación, con una línea del banco por lado', () => {
    const { id } = request(600_000, 6)
    approve(id, 48, 6)
    travel('2027-06-14')
    cmdDebitLoanInstallments(ctx('tesoreria'), companyId())
    const candidates = () =>
      reconciliationCandidates(db, userId('contabilidad'), companyId(), account('1.1.01.03'), '2027-06-14')!.bank!
    const pending = candidates().charges
    expect(pending.map((c) => [c.charge, c.direction])).toEqual([
      ['PRESTAMO', 'CREDITO'],
      ['CUOTA_CAPITAL', 'DEBITO'],
      ['CUOTA_INTERES', 'DEBITO'],
    ])
    const entry = cmdRegisterBankCharges(
      ctx('contabilidad'),
      companyId(),
      pending.map((c) => c.id),
    )
    const code = (accountId: string) => db.accounts.find((a) => a.id === accountId)!.code
    const installment = loans()[0].installments[0]
    expect(
      db.jeLines
        .filter((l) => l.document_id === entry.id)
        .sort((a, b) => a.line_no - b.line_no)
        .map((l) => [code(l.account_id), l.debit, l.credit]),
    ).toEqual([
      ['2.1.02.01', installment.principal, 0],
      ['5.3.01.01', installment.interest, 0],
      ['1.1.01.03', 600_000, 0],
      ['1.1.01.03', 0, installment.total],
      ['2.1.02.01', 0, 600_000],
    ])
    expect(db.documents.find((d) => d.id === entry.id)!.je!.description).toBe(
      `Movimientos del Banco Aula registrados desde la conciliación: 3 movimientos (débitos por ${money(installment.total)} y créditos por ${money(600_000)}).`,
    )
    expect(candidates().charges).toEqual([])
    const view = bankAccountView(db, userId('contabilidad'), companyId())!
    expect(view.book_balance).toBe(view.balance + 300_000)
  })

  it('una base de la versión 25 recibe los préstamos vacíos y las reglas de la acreditación y las cuotas', () => {
    const old = structuredClone(db) as Partial<DB> & { version: number }
    delete old.bankLoans
    delete old.bankLoanInstallments
    old.postingRules = old.postingRules!.filter(
      (r) => !['PRESTAMO', 'CUOTA_CAPITAL', 'CUOTA_INTERES'].includes(r.key) || r.event !== 'CARGOS_BANCARIOS',
    )
    old.version = 25
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    expect(db.bankLoans).toEqual([])
    expect(db.bankLoanInstallments).toEqual([] as T.BankLoanInstallment[])
    expect(
      db.postingRules
        .filter((r) => r.company_id === companyId() && r.event === 'CARGOS_BANCARIOS')
        .map((r) => r.key)
        .sort(),
    ).toEqual(['COMISION', 'CUOTA_CAPITAL', 'CUOTA_INTERES', 'IMPUESTO_DC', 'INTERESES', 'PRESTAMO', 'RECHAZO'])
  })
})
