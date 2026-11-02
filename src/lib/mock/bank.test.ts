// Pruebas del Banco Aula (docs/FASE_8_BANCO_Y_FISCO.md §3): la cuenta de la empresa, las órdenes
// que le llegan de los asientos, Tesorería que opera el banco (SoD-12: quien envía una orden no la
// procesa), el modo del banco, el extracto y la conciliación (8a) y los cargos del mes (8b.1).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES } from '../domain/catalog'
import type * as T from '../domain/types'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  accountBalance,
  bankAlias,
  cmdCancelFundsTransfer,
  cmdCancelJournalEntry,
  cmdCloseBankMonth,
  cmdConfirmJournalEntry,
  cmdCreateCompanyFromTemplate,
  cmdCreateFundsTransfer,
  cmdCreateJournalEntry,
  cmdProcessBankOrders,
  cmdRegisterBankCharges,
  cmdUpdateCompanySettings,
  type Ctx,
} from './engine'
import { bankAccountView, bankStatement, listTasks, reconciliationCandidates } from './queries'
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
const view = (username = 'tesoreria') => bankAccountView(db, userId(username), companyId())!
const bankTasks = (username: string) =>
  listTasks(db, userId(username), companyId(), 'mine').filter((t) => t.task_type === 'PROCESAR_BANCO')

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

/** Tesorería deposita en el banco efectivo de la caja. */
const deposit = (amount: number, username = 'tesoreria') =>
  cmdCreateFundsTransfer(
    ctx(username),
    companyId(),
    {
      from_account_id: account('1.1.01.01'),
      to_account_id: account('1.1.01.03'),
      amount,
      reference: 'Boleta 0001-0002',
      notes: '',
    },
    true,
  )

const pendingOf = (source: string) => view().pending.find((m) => m.source?.id === source)!
const systemOperates = () => cmdUpdateCompanySettings(ctx('docente'), companyId(), { bank_mode: 'AUTOMATICO' })

describe('Banco Aula: la cuenta de la demo', () => {
  it('se abre con el saldo inicial; lo opera Tesorería y el depósito de la demo espera en el banco', () => {
    const v = view()
    expect(v.account).toMatchObject({
      number: 'CC 0001-000001',
      alias: 'FORESTAL.NORTE.BA',
      overdraft_limit: 1_000_000,
    })
    expect(v.account.ledger.code).toBe('1.1.01.03')
    expect(v.mode).toBe('ESTUDIANTES')
    expect(v.movements).toHaveLength(1)
    expect(v.movements[0]).toMatchObject({
      origin: 'APERTURA',
      transaction_number: null,
      concept: 'Saldo inicial de la cuenta',
    })
    // El depósito que registró Contabilidad llegó al banco y espera que Tesorería lo procese.
    expect(v.pending.map((m) => [m.concept, m.direction, m.amount, m.ordered_by_name, m.own])).toEqual([
      ['Depósito en el banco del efectivo de la caja', 'CREDITO', 300_000, 'Diego Fernández', false],
    ])
    expect(v.book_balance).toBe(v.balance + 300_000)
  })

  it('no hay un rol aparte para el banco: lo opera Tesorería, que en la demo tiene dos integrantes', () => {
    expect(Object.keys(ROLES)).not.toContain('BANCO')
    expect(db.islands.filter((i) => i.company_id === companyId()).map((i) => i.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
    const treasurers = db.memberRoles
      .filter((r) => r.company_id === companyId() && r.role_code === 'TESORERIA')
      .map((r) => db.profiles.find((p) => p.id === db.members.find((m) => m.id === r.member_id)!.user_id)!.username)
    expect(treasurers.sort()).toEqual(['tesoreria', 'tesoreria2'])
  })

  it('el alias sale de las dos primeras palabras del nombre de la empresa', () => {
    expect(bankAlias('forestal-del-norte-5-a-2027')).toBe('FORESTAL.NORTE.BA')
    expect(bankAlias('la-sa')).toBe('EMPRESA.BA')
    expect(bankAlias('maderera-misionera-sociedad')).toBe('MADERERA.MISIONER.BA')
  })
})

describe('Banco Aula: Tesorería opera el banco', () => {
  it('la orden espera en la bandeja con una tarea para Tesorería; quien la envió no la procesa (SoD-12)', () => {
    const before = view()
    const trf = deposit(100_000)
    expect(view().balance).toBe(before.balance)
    expect(view().book_balance).toBe(before.book_balance + 100_000)
    const mine = pendingOf(trf.id)
    expect(mine).toMatchObject({ direction: 'CREDITO', amount: 100_000, ordered_by_name: 'Valentina Ruiz', own: true })
    expect(bankTasks('tesoreria2').map((t) => t.path)).toEqual(['/e/forestal-del-norte/pagos/banco-aula/bandeja'])
    // Otra orden no abre otra tarea.
    deposit(50_000)
    expect(bankTasks('tesoreria2')).toHaveLength(1)

    const message = expectBusinessError(
      () => cmdProcessBankOrders(ctx('tesoreria'), companyId(), [mine.id]),
      'SEPARACION_FUNCIONES',
    )
    expect(message).toBe(`No podés procesar la orden N.º ${mine.seq}: la enviaste vos.`)
    // Lo que envió Contabilidad, sí lo procesa.
    const fromAccounting = view().pending.find((m) => m.ordered_by_name === 'Diego Fernández')!
    cmdProcessBankOrders(ctx('tesoreria'), companyId(), [fromAccounting.id])

    const result = cmdProcessBankOrders(
      ctx('tesoreria2'),
      companyId(),
      view('tesoreria2').pending.map((m) => m.id),
    )
    expect(result).toEqual({ processed: 2 })
    const after = view()
    expect(after.pending).toEqual([])
    expect(after.balance).toBe(after.book_balance)
    expect(after.movements[0].processed_by_name).toBe('Tomás Medina')
    expect(after.movements[0].transaction_number).toBe('SIM-000003')
    expect(bankTasks('tesoreria2')).toEqual([])
    expect(db.audit.at(-1)).toMatchObject({ action: 'PROCESS', entity_type: 'bank_account' })
  })

  it('sin separación de funciones, o como docente, quien la envió también puede procesarla', () => {
    const own = pendingOf(deposit(100_000).id)
    cmdProcessBankOrders(ctx('docente'), companyId(), [own.id])
    const again = pendingOf(deposit(20_000).id)
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { sod_enabled: false })
    cmdProcessBankOrders(ctx('tesoreria'), companyId(), [again.id])
    expect(view().pending.map((m) => m.ordered_by_name)).toEqual(['Diego Fernández'])
  })

  it('sólo Tesorería procesa, una orden pendiente y una sola vez', () => {
    const id = pendingOf(deposit(100_000).id).id
    expectBusinessError(() => cmdProcessBankOrders(ctx('contabilidad'), companyId(), [id]), 'SIN_PERMISO')
    expectBusinessError(() => cmdProcessBankOrders(ctx('tesoreria2'), companyId(), []), 'DATO_INVALIDO')
    expectBusinessError(() => cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [id, id]), 'DATO_INVALIDO')
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [id])
    expectBusinessError(() => cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [id]), 'TRANSICION_INVALIDA')
  })

  it('un asiento manual que mueve el banco también es una orden', () => {
    const draft = db.documents.find(
      (d) => d.doc_type === 'JOURNAL_ENTRY' && d.status === 'BORRADOR' && d.je?.description.includes('energía'),
    )!
    cmdConfirmJournalEntry(ctx('contabilidad'), draft.id)
    expect(pendingOf(draft.id)).toMatchObject({
      direction: 'DEBITO',
      amount: 185_000,
      ordered_by_name: 'Diego Fernández',
    })
  })

  it('al anular la operación, la orden pendiente se retira y la procesada se revierte', () => {
    // Pendiente: queda anulada, sin pasar por la cuenta.
    const pending = deposit(70_000)
    cmdCancelFundsTransfer(ctx('tesoreria'), pending.id, 'Error de importe')
    expect(view().pending.some((m) => m.source?.id === pending.id)).toBe(false)
    expect(db.bankMovements.find((m) => m.source_document_id === pending.id)!.status).toBe('ANULADO')

    // Procesada: el contraasiento manda la orden inversa, que también espera en la bandeja.
    const processed = deposit(100_000)
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [pendingOf(processed.id).id])
    const balance = view().balance
    cmdCancelFundsTransfer(ctx('tesoreria'), processed.id, 'Se cargó dos veces')
    const reversal = view().pending.find((m) => m.source?.id === processed.id)!
    expect(reversal.direction).toBe('DEBITO')
    expect(reversal.concept).toMatch(/^Reversión de SIM-\d{6}: /)
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [reversal.id])
    expect(view().balance).toBe(balance - 100_000)
  })

  it('si el docente pide que lo opere el sistema, lo pendiente se procesa y lo nuevo, en el momento', () => {
    systemOperates()
    expect(view().pending).toEqual([])
    expect(view().balance).toBe(view().book_balance)
    expect(db.audit.at(-1)!.summary).toBe('Cambió quién opera el Banco Aula: lo opera el sistema')
    const trf = deposit(100_000)
    const v = view()
    expect(v.pending).toEqual([])
    expect(v.movements[0]).toMatchObject({ amount: 100_000, processed_on: '2027-05-14', processed_by_name: null })
    expect(v.movements[0].source).toMatchObject({ id: trf.id, display_number: trf.display_number })
    // Al anular, la reversión también se procesa en el momento.
    cmdCancelFundsTransfer(ctx('tesoreria'), trf.id, 'Boleta equivocada')
    expect(view().balance).toBe(view().book_balance)
  })
})

describe('Banco Aula: el extracto y la conciliación (8a.2)', () => {
  it('el extracto de un período: el saldo al empezar, lo procesado día por día y el saldo final', () => {
    cmdProcessBankOrders(ctx('tesoreria'), companyId(), [view().pending[0].id])
    const trf = deposit(100_000)
    cmdProcessBankOrders(ctx('tesoreria2'), companyId(), [pendingOf(trf.id).id])
    const may = bankStatement(db, userId('tesoreria'), companyId(), '2027-05-01', '2027-05-31')!
    expect(may).toMatchObject({
      holder: { legal_name: 'Forestal del Norte SRL' },
      account: { number: 'CC 0001-000001', alias: 'FORESTAL.NORTE.BA' },
      opening_balance: 12_500_000,
      debits: 0,
      credits: 400_000,
      closing_balance: 12_900_000,
    })
    expect(may.lines.map((l) => [l.date, l.transaction_number, l.credit, l.balance])).toEqual([
      ['2027-05-14', 'SIM-000001', 300_000, 12_800_000],
      ['2027-05-14', 'SIM-000002', 100_000, 12_900_000],
    ])
    // Enero: el saldo inicial de la cuenta es su primera línea.
    const january = bankStatement(db, userId('contabilidad'), companyId(), '2027-01-01', '2027-01-31')!
    expect(january.opening_balance).toBe(0)
    expect(january.lines.map((l) => [l.concept, l.transaction_number, l.credit])).toEqual([
      ['Saldo inicial de la cuenta', null, 12_500_000],
    ])
    // Un mes sin movimientos termina con el mismo saldo con que empezó.
    expect(bankStatement(db, userId('tesoreria'), companyId(), '2027-03-01', '2027-03-31')).toMatchObject({
      opening_balance: 12_500_000,
      lines: [],
      closing_balance: 12_500_000,
    })
  })

  it('pide un período válido y sólo lo ve quien ve el banco', () => {
    expectBusinessError(
      () => bankStatement(db, userId('tesoreria'), companyId(), '2027-05-31', '2027-05-01'),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => bankStatement(db, userId('tesoreria'), companyId(), 'mayo', '2027-05-31'),
      'DATO_INVALIDO',
    )
    expect(() => bankStatement(db, userId('compras1'), companyId(), '2027-05-01', '2027-05-31')).toThrow()
  })

  it('la conciliación de una cuenta que no es del Banco Aula sigue con el extracto escrito', () => {
    expect(
      reconciliationCandidates(db, userId('contabilidad'), companyId(), account('1.1.01.01'), '2027-05-14')!.bank,
    ).toBeNull()
    const bank = reconciliationCandidates(
      db,
      userId('contabilidad'),
      companyId(),
      account('1.1.01.03'),
      '2027-05-14',
    )!.bank!
    // El depósito de la demo todavía no está en el banco: el extracto sólo tiene el saldo inicial.
    expect(bank.balance).toBe(12_500_000)
    expect(bank.lines.map((l) => l.concept)).toEqual(['Saldo inicial de la cuenta'])
  })
})

describe('Banco Aula: el cierre del mes y los cargos (8b.1)', () => {
  /** Mayo con descubierto: el depósito de la demo y un pago de 13 millones, los dos procesados el 14/05. */
  const mayInOverdraft = () => {
    cmdProcessBankOrders(ctx('tesoreria'), companyId(), [view().pending[0].id])
    const big = cmdCreateJournalEntry(
      ctx('contabilidad'),
      companyId(),
      {
        document_date: '2027-05-14',
        description: 'Pago de la ampliación del galpón con transferencia bancaria.',
        lines: [
          { account_id: account('5.2.02.02'), debit: 13_000_000, credit: 0 },
          { account_id: account('1.1.01.03'), debit: 0, credit: 13_000_000 },
        ],
      },
      true,
    )
    cmdProcessBankOrders(ctx('tesoreria'), companyId(), [pendingOf(big.id).id])
  }
  const travel = (day: string) => vi.setSystemTime(new Date(`${day}T12:00:00-03:00`))
  const closeMay = () => cmdCloseBankMonth(ctx('tesoreria'), companyId(), '2027-05')

  it('al cerrar el mes, el banco debita la comisión, el impuesto y los intereses por descubierto', () => {
    mayInOverdraft()
    expect(view().balance).toBe(-200_000)
    travel('2027-06-03')
    expect(view().to_close).toBe('2027-05')
    // Impuesto: 0,6 % de lo que movieron las órdenes (300.000 + 13.000.000). Intereses: 200.000 en
    // negativo del 14 al 31 de mayo (18 días) al 6 % mensual, con mes de 30 días.
    expect(closeMay()).toEqual({ period: '2027-05', fee: 15_000, tax: 79_800, interest: 7_200 })
    const v = view()
    expect(v.to_close).toBeNull()
    expect(v.movements.slice(0, 3).map((m) => [m.origin, m.charge, m.amount, m.processed_on])).toEqual([
      ['BANCO', 'INTERESES', 7_200, '2027-06-03'],
      ['BANCO', 'IMPUESTO_DC', 79_800, '2027-06-03'],
      ['BANCO', 'COMISION', 15_000, '2027-06-03'],
    ])
    expect(v.movements[2].concept).toBe('Comisión de mantenimiento de cuenta · 05/2027')
    expect(v.balance).toBe(-302_000)
    expect(db.audit.at(-1)).toMatchObject({ action: 'CLOSE_MONTH', entity_type: 'bank_account' })
    const tasks = listTasks(db, userId('contabilidad'), companyId(), 'mine').filter(
      (t) => t.task_type === 'REGISTRAR_CARGOS_BANCO',
    )
    expect(tasks.map((t) => t.path)).toEqual(['/e/forestal-del-norte/pagos/conciliaciones/nueva'])
  })

  it('se cierran en orden, una vez, sólo los meses terminados y desde que la cuenta opera', () => {
    expect(expectBusinessError(closeMay, 'DATO_INVALIDO')).toBe('05/2027 todavía no terminó.')
    expect(
      expectBusinessError(() => cmdCloseBankMonth(ctx('tesoreria'), companyId(), '2027-04'), 'DATO_INVALIDO'),
    ).toBe('La cuenta opera en el Banco Aula desde 05/2027: 04/2027 no se cierra.')
    travel('2027-07-02')
    expect(
      expectBusinessError(() => cmdCloseBankMonth(ctx('tesoreria'), companyId(), '2027-06'), 'DATO_INVALIDO'),
    ).toBe('Primero hay que cerrar 05/2027.')
    expectBusinessError(() => cmdCloseBankMonth(ctx('contabilidad'), companyId(), '2027-05'), 'SIN_PERMISO')
    expect(closeMay()).toMatchObject({ fee: 15_000, tax: 0, interest: 0 })
    expectBusinessError(closeMay, 'TRANSICION_INVALIDA')
    // Junio: sin órdenes ni descubierto, sólo la comisión.
    expect(cmdCloseBankMonth(ctx('tesoreria2'), companyId(), '2027-06')).toMatchObject({
      fee: 15_000,
      tax: 0,
      interest: 0,
    })
    expect(view().to_close).toBeNull()
  })

  it('Contabilidad registra los cargos desde la conciliación; si anula el asiento, vuelven a quedar sin registrar', () => {
    mayInOverdraft()
    travel('2027-06-03')
    closeMay()
    const candidates = () =>
      reconciliationCandidates(db, userId('contabilidad'), companyId(), account('1.1.01.03'), '2027-06-03')!.bank!
    const charges = candidates().charges
    expect(charges.map((c) => [c.charge, c.amount])).toEqual([
      ['COMISION', 15_000],
      ['IMPUESTO_DC', 79_800],
      ['INTERESES', 7_200],
    ])
    const ids = charges.map((c) => c.id)
    const movements = db.bankMovements.length
    expectBusinessError(() => cmdRegisterBankCharges(ctx('tesoreria'), companyId(), ids), 'SIN_PERMISO')
    expectBusinessError(() => cmdRegisterBankCharges(ctx('contabilidad'), companyId(), []), 'DATO_INVALIDO')
    const entry = cmdRegisterBankCharges(ctx('contabilidad'), companyId(), ids)
    const doc = db.documents.find((d) => d.id === entry.id)!
    expect(doc).toMatchObject({ status: 'CONFIRMADO', je: { origin: 'AUTOMATICO' } })
    const code = (id: string) => db.accounts.find((a) => a.id === id)!.code
    expect(
      db.jeLines
        .filter((l) => l.document_id === entry.id)
        .sort((a, b) => a.line_no - b.line_no)
        .map((l) => [code(l.account_id), l.debit, l.credit]),
    ).toEqual([
      ['5.3.01.03', 94_800, 0],
      ['5.3.01.01', 7_200, 0],
      ['1.1.01.03', 0, 102_000],
    ])
    // Registra lo que el banco ya debitó: no le manda una orden nueva.
    expect(db.bankMovements.length).toBe(movements)
    expect(candidates().charges).toEqual([])
    expect(view().book_balance).toBe(view().balance)
    expectBusinessError(() => cmdRegisterBankCharges(ctx('contabilidad'), companyId(), ids), 'TRANSICION_INVALIDA')
    const open = () =>
      listTasks(db, userId('contabilidad'), companyId(), 'mine').filter((t) => t.task_type === 'REGISTRAR_CARGOS_BANCO')
    expect(open()).toEqual([])

    cmdCancelJournalEntry(ctx('contabilidad'), entry.id, 'Se registró con la cuenta equivocada')
    expect(candidates().charges.map((c) => c.id)).toEqual(ids)
    expect(open()).toHaveLength(1)
    expect(db.bankMovements.length).toBe(movements)
  })

  it('una base de la versión 23 recibe la comisión, la tasa y las reglas de los cargos', () => {
    const old = structuredClone(db) as Partial<DB> & { version: number }
    delete old.bankClosings
    for (const account of old.bankAccounts!) {
      const a = account as Partial<T.BankAccount>
      delete a.monthly_fee
      delete a.overdraft_rate
      delete a.charges_from
    }
    for (const m of old.bankMovements!) delete (m as Partial<T.BankMovement>).charge
    old.postingRules = old.postingRules!.filter((r) => r.event !== 'CARGOS_BANCARIOS')
    old.version = 23
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    expect(db.bankAccounts[0]).toMatchObject({ monthly_fee: 15_000, overdraft_rate: 6, charges_from: '2027-05-01' })
    expect(db.bankMovements.every((m) => m.charge === null)).toBe(true)
    expect(
      db.postingRules
        .filter((r) => r.event === 'CARGOS_BANCARIOS')
        .map((r) => r.key)
        .sort(),
    ).toEqual(['COMISION', 'IMPUESTO_DC', 'INTERESES', 'RECHAZO'])
  })
})

describe('Banco Aula: quién ve la cuenta', () => {
  it('Tesorería, Contabilidad, Gerencia, Auditoría y el docente; Compras no', () => {
    for (const username of ['tesoreria', 'tesoreria2', 'contabilidad', 'gerencia', 'auditor', 'docente'])
      expect(bankAccountView(db, userId(username), companyId())).not.toBeNull()
    expect(() => bankAccountView(db, userId('compras1'), companyId())).toThrow()
  })
})

describe('Banco Aula: empresas nuevas y bases guardadas', () => {
  it('la empresa de un curso abre su cuenta con la apertura', () => {
    const course = db.courses[0]
    const created = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course.id })
    const bankAccount = db.bankAccounts.find((b) => b.company_id === created.id)!
    const movements = db.bankMovements.filter((m) => m.bank_account_id === bankAccount.id)
    expect(movements.map((m) => m.origin)).toEqual(['APERTURA'])
    const ledger = db.accounts.find((a) => a.id === bankAccount.ledger_account_id)!
    expect(movements[0].amount).toBe(accountBalance(db, ledger.id))
  })

  it('una base de la versión 21 recibe la cuenta con su historia procesada y el segundo integrante de Tesorería', () => {
    const old = structuredClone(db) as Partial<DB> & { version: number }
    delete old.bankAccounts
    delete old.bankMovements
    const second = old.profiles!.find((p) => p.username === 'tesoreria2')!
    const member = old.members!.find((m) => m.user_id === second.id)!
    old.memberRoles = old.memberRoles!.filter((r) => r.member_id !== member.id)
    old.members = old.members!.filter((m) => m.id !== member.id)
    old.profiles = old.profiles!.filter((p) => p.id !== second.id)
    old.version = 21
    db = upgradeDatabase(old as DB)!
    expect(db.version).toBe(DB_VERSION)
    const v = view()
    expect(v.balance).toBe(v.book_balance)
    expect(v.pending).toEqual([])
    expect(db.profiles.some((p) => p.username === 'tesoreria2')).toBe(true)
  })

  it('una base de la primera versión de la 8a.1 pierde la isla del entorno y el rol Banco', () => {
    const old = structuredClone(db)
    const company = companyId()
    const island = { id: 'isl-9', company_id: company, number: 9, name: 'Entorno: banco y fisco' }
    old.islands.push(island)
    old.sectors.push(
      { id: 'sec-ban', company_id: company, code: 'BAN', name: 'Banco Aula', island_id: island.id },
      { id: 'sec-fis', company_id: company, code: 'FIS', name: 'Fisco simulado', island_id: island.id },
    )
    old.profiles.push({ ...old.profiles.find((p) => p.username === 'tesoreria')!, id: 'usr-banco', username: 'banco' })
    old.members.push({ id: 'mbr-banco', company_id: company, user_id: 'usr-banco', job_title: '', is_active: true })
    old.memberRoles.push({
      id: 'mro-banco',
      company_id: company,
      member_id: 'mbr-banco',
      role_code: 'BANCO' as T.RoleCode,
      sector_id: 'sec-ban',
    })
    const task = old.tasks.find((t) => t.task_type === 'PROCESAR_BANCO')!
    task.assigned_role = 'BANCO' as T.RoleCode
    old.version = 22
    db = upgradeDatabase(old)!
    expect(db.memberRoles.some((r) => r.id === 'mro-banco')).toBe(false)
    expect(db.profiles.find((p) => p.id === 'usr-banco')!.is_active).toBe(false)
    expect(db.sectors.some((s) => ['BAN', 'FIS'].includes(s.code))).toBe(false)
    expect(db.islands.some((i) => i.number === 9)).toBe(false)
    expect(db.tasks.find((t) => t.id === task.id)!.assigned_role).toBe('TESORERIA')
  })
})
