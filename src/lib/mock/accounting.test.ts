// Pruebas de la contabilidad (docs/FASE_2_CONTABILIDAD.md) sobre buildSeed()
// y los cmd* directos, con la fecha fija: el libro diario depende de "hoy".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_CHART } from '../domain/chart-of-accounts'
import type { DB } from './db'
import {
  BusinessError,
  accountBalance,
  cmdCancelJournalEntry,
  cmdConfirmJournalEntry,
  cmdCreateCompanyFromTemplate,
  cmdCreateCourse,
  cmdCreateJournalEntry,
  cmdOpenFiscalYear,
  cmdSaveAccount,
  cmdSetAccountActive,
  cmdSetModule,
  cmdSetPeriodStatus,
  cmdUpdateJournalEntry,
  type Ctx,
  type JournalEntryInput,
} from './engine'
import { documentDetail, journalBook, ledger, listAccounts, listFiscalYears, trialBalance } from './queries'
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
const account = (code: string, company = companyId()) =>
  db.accounts.find((a) => a.company_id === company && a.code === code)!.id
const doc = (id: string) => db.documents.find((d) => d.id === id)!
const lines = (docId: string) => db.jeLines.filter((l) => l.document_id === docId)

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

/** Pago de un gasto: debe al gasto, haber al banco. */
function entry(amount = 50000, date = '2027-05-14', credit = amount): JournalEntryInput {
  return {
    document_date: date,
    description: 'Pago de la publicidad del mes.',
    lines: [
      { account_id: account('5.2.02.07'), debit: amount, credit: 0 },
      { account_id: account('1.1.01.03'), debit: 0, credit },
    ],
  }
}

describe('empresa plantilla', () => {
  it('nace con el plan de cuentas básico, el ejercicio en curso y sus doce meses abiertos', () => {
    const accounts = db.accounts.filter((a) => a.company_id === companyId())
    expect(accounts).toHaveLength(BASE_CHART.length)
    expect(accounts.filter((a) => a.is_imputable).every((a) => a.level === 4)).toBe(true)
    const caja = accounts.find((a) => a.code === '1.1.01.01')!
    expect(caja).toMatchObject({ account_type: 'ACTIVO', normal_side: 'DEBE' })
    expect(accounts.find((a) => a.code === '1.2.01.06')).toMatchObject({ account_type: 'ACTIVO', normal_side: 'HABER' })
    const [year] = listFiscalYears(db, userId('contabilidad'), companyId())
    expect(year).toMatchObject({ name: 'Ejercicio 2027', start_date: '2027-01-01', end_date: '2027-12-31' })
    expect(year.periods.map((p) => p.status)).toEqual(Array(12).fill('ABIERTO'))
    expect(year.periods[1]).toMatchObject({ name: 'Febrero 2027', end_date: '2027-02-28' })
  })

  it('tiene el asiento N.º 1 de apertura con los bienes de cambio del inventario inicial', () => {
    const opening = db.documents.find((d) => d.je?.origin === 'APERTURA')!
    expect(opening).toMatchObject({ status: 'CONFIRMADO', document_date: '2027-01-01' })
    expect(opening.je!.entry_number).toBe(1)
    const amount = (code: string) => {
      const l = lines(opening.id).find((x) => x.account_id === account(code))!
      return l.debit - l.credit
    }
    expect(amount('1.1.05.01')).toBe(7310000)
    expect(amount('1.1.05.02')).toBe(1896500)
    expect(amount('1.1.05.04')).toBe(6110000)
    expect(amount('1.1.05.05')).toBe(1680000)
    expect(amount('3.2.02.01')).toBe(-30546500)
    // Primero las cuentas del debe, después las del haber.
    const sides = lines(opening.id)
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => (l.debit > 0 ? 'D' : 'H'))
    expect(sides.join('')).toMatch(/^D+H+$/)
  })

  it('el mayor de bienes de cambio coincide con el valor del inventario inicial', () => {
    const stockValue = db.stockMovements
      .filter((m) => m.movement_type === 'STOCK_INICIAL')
      .reduce((sum, m) => sum + m.total_cost, 0)
    const inventory = listAccounts(db, userId('contabilidad'), companyId()).find((a) => a.code === '1.1.05')!
    expect(inventory.balance).toBe(stockValue)
  })

  it('el balance de sumas y saldos balancea y Caja refleja el depósito del ejemplo', () => {
    const tb = trialBalance(db, userId('contabilidad'), companyId(), '2027-01-01', '2027-12-31')
    expect(tb.balanced).toBe(true)
    expect(tb.totals.debit).toBe(tb.totals.credit)
    const caja = tb.rows.find((r) => r.code === '1.1.01.01')!
    expect(caja).toMatchObject({ debit: 850000, credit: 300000, debit_balance: 550000, credit_balance: 0 })
  })
})

describe('asientos', () => {
  it('se registran con número correlativo y la tarea del borrador se resuelve', () => {
    const draft = db.documents.find((d) => d.je?.origin === 'MANUAL' && d.status === 'BORRADOR')!
    expect(db.tasks.some((t) => t.document_id === draft.id && t.status === 'PENDIENTE')).toBe(true)
    cmdConfirmJournalEntry(ctx('contabilidad'), draft.id)
    expect(doc(draft.id)).toMatchObject({ status: 'CONFIRMADO' })
    expect(doc(draft.id).je!.entry_number).toBe(3)
    expect(db.tasks.find((t) => t.document_id === draft.id)!.status).toBe('RESUELTA')
    const created = cmdCreateJournalEntry(ctx('contabilidad'), companyId(), entry(), true)
    expect(doc(created.id).je!.entry_number).toBe(4)
    expect(doc(created.id).total).toBe(50000)
  })

  it('controlan la partida doble', () => {
    const c = ctx('contabilidad')
    expectBusinessError(
      () => cmdCreateJournalEntry(c, companyId(), entry(50000, '2027-05-14', 40000), true),
      'ASIENTO_DESBALANCEADO',
    )
    expectBusinessError(
      () =>
        cmdCreateJournalEntry(
          c,
          companyId(),
          { ...entry(), lines: [{ account_id: account('1.1.01.01'), debit: 1000, credit: 0 }] },
          true,
        ),
      'ASIENTO_INCOMPLETO',
    )
    expectBusinessError(
      () =>
        cmdCreateJournalEntry(
          c,
          companyId(),
          { ...entry(), lines: [{ account_id: account('1.1.01.01'), debit: 1000, credit: 1000 }] },
          false,
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () =>
        cmdCreateJournalEntry(
          c,
          companyId(),
          { ...entry(), lines: [{ account_id: account('1.1.01'), debit: 1000, credit: 0 }] },
          false,
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(() => cmdCreateJournalEntry(c, companyId(), entry(10.005), false), 'DATO_INVALIDO')
    expectBusinessError(
      () => cmdCreateJournalEntry(c, companyId(), { ...entry(), description: 'x' }, false),
      'DATO_INVALIDO',
    )
    // El borrador desbalanceado se guarda: se controla al registrarlo.
    const draft = cmdCreateJournalEntry(c, companyId(), entry(50000, '2027-05-14', 40000), false)
    expect(doc(draft.id).status).toBe('BORRADOR')
    expectBusinessError(() => cmdConfirmJournalEntry(c, draft.id), 'ASIENTO_DESBALANCEADO')
  })

  it('controlan la fecha: no futura, correlativa con el diario y dentro de un período abierto', () => {
    const c = ctx('contabilidad')
    expectBusinessError(() => cmdCreateJournalEntry(c, companyId(), entry(1000, '2027-05-15'), true), 'FECHA_INVALIDA')
    // El último asiento registrado (el depósito del ejemplo) es de hoy.
    expectBusinessError(() => cmdCreateJournalEntry(c, companyId(), entry(1000, '2027-05-13'), true), 'FECHA_INVALIDA')
    expectBusinessError(() => cmdCreateJournalEntry(c, companyId(), entry(1000, '2026-12-31'), true), 'SIN_EJERCICIO')
    const may = db.fiscalPeriods.find((p) => p.company_id === companyId() && p.name === 'Mayo 2027')!
    cmdSetPeriodStatus(c, companyId(), may.id, 'CERRADO', '')
    expectBusinessError(() => cmdCreateJournalEntry(c, companyId(), entry(), true), 'PERIODO_CERRADO')
  })

  it('el borrador se corrige; el registrado ya no', () => {
    const c = ctx('contabilidad')
    const draft = cmdCreateJournalEntry(c, companyId(), entry(1000), false)
    cmdUpdateJournalEntry(c, draft.id, entry(2500))
    expect(doc(draft.id).total).toBe(2500)
    expect(lines(draft.id).map((l) => l.debit + l.credit)).toEqual([2500, 2500])
    cmdConfirmJournalEntry(c, draft.id)
    expectBusinessError(() => cmdUpdateJournalEntry(c, draft.id, entry(3000)), 'TRANSICION_INVALIDA')
    expectBusinessError(() => cmdConfirmJournalEntry(c, draft.id), 'TRANSICION_INVALIDA')
  })

  it('el registrado se anula con un contraasiento y los saldos vuelven a como estaban', () => {
    const c = ctx('contabilidad')
    const bank = account('1.1.01.03')
    const before = accountBalance(db, bank)
    const posted = cmdCreateJournalEntry(c, companyId(), entry(80000), true)
    expect(accountBalance(db, bank)).toBe(before - 80000)
    expectBusinessError(() => cmdCancelJournalEntry(c, posted.id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelJournalEntry(c, posted.id, 'La publicidad se pagó en efectivo, no por banco.')
    expect(doc(posted.id)).toMatchObject({
      status: 'ANULADO',
      status_reason: 'La publicidad se pagó en efectivo, no por banco.',
    })
    const reversal = db.documents.find((d) => d.je?.reverses_id === posted.id)!
    expect(reversal).toMatchObject({ status: 'CONFIRMADO', document_date: '2027-05-14' })
    expect(reversal.je).toMatchObject({ origin: 'CONTRAASIENTO', entry_number: doc(posted.id).je!.entry_number! + 1 })
    expect(lines(reversal.id).map((l) => [l.debit, l.credit])).toEqual(lines(posted.id).map((l) => [l.credit, l.debit]))
    expect(accountBalance(db, bank)).toBe(before)
    expect(db.docLinks.some((l) => l.from_document_id === posted.id && l.to_document_id === reversal.id)).toBe(true)
    // Los dos quedan en el libro diario.
    const book = journalBook(db, userId('contabilidad'), companyId(), '2027-05-14', '2027-05-14')
    expect(book.entries.map((e) => e.id)).toEqual(expect.arrayContaining([posted.id, reversal.id]))
    expect(book.total_debit).toBe(book.total_credit)
    expectBusinessError(
      () => cmdCancelJournalEntry(c, reversal.id, 'Prueba de anular el contraasiento'),
      'DATO_INVALIDO',
    )
    const detail = documentDetail(db, userId('contabilidad'), companyId(), 'JOURNAL_ENTRY', posted.display_number)!
    expect(detail.journal!.reversed_by!.display_number).toBe(reversal.display_number)
  })

  it('el borrador anulado nunca entra al libro diario', () => {
    const c = ctx('contabilidad')
    const draft = cmdCreateJournalEntry(c, companyId(), entry(), false)
    cmdCancelJournalEntry(c, draft.id, 'Era una prueba.')
    expect(doc(draft.id)).toMatchObject({ status: 'ANULADO' })
    expect(doc(draft.id).je!.entry_number).toBeNull()
    expect(db.documents.some((d) => d.je?.reverses_id === draft.id)).toBe(false)
  })

  it('respetan los permisos y el bloqueo del módulo', () => {
    expectBusinessError(() => cmdCreateJournalEntry(ctx('compras1'), companyId(), entry(), false), 'SIN_PERMISO')
    expectBusinessError(() => cmdCreateJournalEntry(ctx('tesoreria'), companyId(), entry(), false), 'SIN_PERMISO')
    expect(trialBalance(db, userId('tesoreria'), companyId(), '2027-01-01', '2027-12-31').balanced).toBe(true)
    expect(() => trialBalance(db, userId('compras1'), companyId(), '2027-01-01', '2027-12-31')).toThrow()
    cmdSetModule(ctx('docente'), companyId(), 'accounting', false)
    expectBusinessError(
      () => cmdCreateJournalEntry(ctx('contabilidad'), companyId(), entry(), false),
      'MODULO_BLOQUEADO',
    )
  })
})

describe('plan de cuentas', () => {
  it('Contabilidad agrega cuentas dentro de un rubro existente', () => {
    const c = ctx('contabilidad')
    const id = cmdSaveAccount(c, companyId(), {
      code: '1.1.01.05',
      name: 'Banco de la Selva cuenta corriente',
      description: 'Segunda cuenta bancaria (ficticia).',
      is_contra: false,
    })
    expect(db.accounts.find((a) => a.id === id)).toMatchObject({
      account_type: 'ACTIVO',
      normal_side: 'DEBE',
      level: 4,
    })
    const base = { name: 'Otra cuenta', description: '', is_contra: false }
    expectBusinessError(() => cmdSaveAccount(c, companyId(), { ...base, code: '1.1.01' }), 'DATO_INVALIDO')
    expectBusinessError(() => cmdSaveAccount(c, companyId(), { ...base, code: '1.1.09.01' }), 'DATO_INVALIDO')
    expectBusinessError(() => cmdSaveAccount(c, companyId(), { ...base, code: '1.1.01.05' }), 'DATO_INVALIDO')
    expectBusinessError(
      () => cmdSaveAccount(c, companyId(), { ...base, code: '1.1.01.06', name: 'CAJA' }),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdSaveAccount(ctx('compras1'), companyId(), { ...base, code: '1.1.01.06' }),
      'SIN_PERMISO',
    )
  })

  it('no se desactiva una cuenta con saldo ni se usa una desactivada', () => {
    const c = ctx('contabilidad')
    expectBusinessError(() => cmdSetAccountActive(c, companyId(), account('1.1.01.01'), false), 'DATO_INVALIDO')
    cmdSetAccountActive(c, companyId(), account('5.2.02.07'), false)
    expectBusinessError(() => cmdCreateJournalEntry(c, companyId(), entry(), false), 'DATO_INVALIDO')
    expectBusinessError(
      () =>
        cmdSaveAccount(c, companyId(), {
          id: account('1.1.01.01'),
          code: '1.1.01.01',
          name: 'Caja',
          description: '',
          is_contra: true,
        }),
      'DATO_INVALIDO',
    )
  })

  it('los rubros suman sus cuentas y se marca el saldo contrario a la naturaleza', () => {
    const c = ctx('contabilidad')
    cmdCreateJournalEntry(
      c,
      companyId(),
      {
        document_date: '2027-05-14',
        description: 'Pago en efectivo mayor que lo que hay en caja (error a propósito).',
        lines: [
          { account_id: account('5.2.02.08'), debit: 900000, credit: 0 },
          { account_id: account('1.1.01.01'), debit: 0, credit: 900000 },
        ],
      },
      true,
    )
    const rows = listAccounts(db, userId('contabilidad'), companyId())
    const caja = rows.find((r) => r.code === '1.1.01.01')!
    expect(caja).toMatchObject({ balance: -350000, contrary: true })
    const assets = rows.find((r) => r.code === '1')!
    const imputable = rows.filter((r) => r.is_imputable && r.code.startsWith('1.'))
    expect(assets.balance).toBe(Math.round(imputable.reduce((s, r) => s + r.balance, 0) * 100) / 100)
    const mayor = ledger(db, userId('contabilidad'), companyId(), account('1.1.01.01'), '2027-05-01', '2027-05-31')!
    expect(mayor.opening_balance).toBe(850000)
    expect(mayor.rows.map((r) => r.balance)).toEqual([550000, -350000])
    expect(mayor.closing_balance).toBe(-350000)
  })
})

describe('ejercicios y períodos', () => {
  it('Contabilidad cierra el mes y sólo el docente lo reabre, con motivo', () => {
    const april = db.fiscalPeriods.find((p) => p.company_id === companyId() && p.name === 'Abril 2027')!
    cmdSetPeriodStatus(ctx('contabilidad'), companyId(), april.id, 'CERRADO', '')
    expect(april).toMatchObject({ status: 'CERRADO', closed_by: userId('contabilidad') })
    expectBusinessError(
      () => cmdSetPeriodStatus(ctx('contabilidad'), companyId(), april.id, 'ABIERTO', 'Faltó un asiento'),
      'SIN_PERMISO',
    )
    expectBusinessError(
      () => cmdSetPeriodStatus(ctx('docente'), companyId(), april.id, 'ABIERTO', ''),
      'MOTIVO_REQUERIDO',
    )
    cmdSetPeriodStatus(ctx('docente'), companyId(), april.id, 'ABIERTO', 'Faltó registrar un gasto de abril.')
    expect(april).toMatchObject({ status: 'ABIERTO', closed_by: null })
    expect(db.audit.at(-1)).toMatchObject({ action: 'REOPEN_PERIOD', entity_label: 'Abril 2027' })
  })

  it('el docente abre el ejercicio siguiente', () => {
    expectBusinessError(() => cmdOpenFiscalYear(ctx('contabilidad'), companyId(), 2028), 'SIN_PERMISO')
    cmdOpenFiscalYear(ctx('docente'), companyId(), 2028)
    expect(listFiscalYears(db, userId('docente'), companyId()).map((y) => y.name)).toEqual([
      'Ejercicio 2028',
      'Ejercicio 2027',
    ])
    expectBusinessError(() => cmdOpenFiscalYear(ctx('docente'), companyId(), 2028), 'DATO_INVALIDO')
    expectBusinessError(() => cmdOpenFiscalYear(ctx('docente'), companyId(), 2030), 'DATO_INVALIDO')
  })
})

describe('empresa de un curso', () => {
  it('copia el plan de cuentas de la plantilla y nace con su propio asiento de apertura', () => {
    const docente = ctx('docente')
    const courseId = cmdCreateCourse(ctx('admin'), { academic_year: 2027, name: '5.º B', orientation: 'Gestión' })
    const created = cmdCreateCompanyFromTemplate(docente, { course_id: courseId })
    expect(db.accounts.filter((a) => a.company_id === created.id)).toHaveLength(BASE_CHART.length)
    const openings = db.documents.filter((d) => d.je?.origin === 'APERTURA')
    const [template, course] = [companyId(), created.id].map((id) => openings.find((d) => d.company_id === id)!)
    expect(course).toMatchObject({ display_number: 'AS-00001', document_date: '2027-01-01', total: template.total })
    const tb = trialBalance(db, userId('docente'), created.id, '2027-01-01', '2027-12-31')
    expect(tb.balanced).toBe(true)
  })
})
