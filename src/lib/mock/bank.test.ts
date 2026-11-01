// Pruebas del Banco Aula (docs/FASE_8_BANCO_Y_FISCO.md §3, 8a.1): la cuenta de la empresa, las
// órdenes que le llegan de los asientos, el modo del banco y la separación de funciones (SoD-12).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  accountBalance,
  bankAlias,
  cmdAssignRole,
  cmdCancelFundsTransfer,
  cmdConfirmJournalEntry,
  cmdCreateCompanyFromTemplate,
  cmdCreateFundsTransfer,
  cmdProcessBankOrders,
  cmdUpdateCompanySettings,
  type Ctx,
} from './engine'
import { bankAccountView, listTasks } from './queries'
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
const deposit = (amount: number) =>
  cmdCreateFundsTransfer(
    ctx('tesoreria'),
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

const studentsOperate = () => cmdUpdateCompanySettings(ctx('docente'), companyId(), { bank_mode: 'ESTUDIANTES' })

describe('Banco Aula: la cuenta de la demo', () => {
  it('se abre con el saldo inicial y lo que ya movió el banco, procesado: coincide con los libros', () => {
    const v = view()
    expect(v.account).toMatchObject({
      number: 'CC 0001-000001',
      alias: 'FORESTAL.NORTE.BA',
      overdraft_limit: 1_000_000,
    })
    expect(v.account.ledger.code).toBe('1.1.01.03')
    expect(v.mode).toBe('AUTOMATICO')
    expect(v.pending).toEqual([])
    expect(v.balance).toBe(v.book_balance)
    // El saldo inicial va primero (sin número de transacción) y el depósito manual de la demo, después.
    const oldest = v.movements.at(-1)!
    expect(oldest).toMatchObject({
      origin: 'APERTURA',
      transaction_number: null,
      concept: 'Saldo inicial de la cuenta',
    })
    expect(v.movements.some((m) => m.concept === 'Depósito en el banco del efectivo de la caja')).toBe(true)
  })

  it('la isla 9 del entorno tiene sus sectores y el usuario del banco no tiene roles de la empresa', () => {
    const island = db.islands.find((i) => i.company_id === companyId() && i.number === 9)!
    expect(island.name).toBe('Entorno: banco y fisco')
    expect(db.sectors.filter((s) => s.island_id === island.id).map((s) => s.code)).toEqual(['BAN', 'FIS'])
    const member = db.members.find((m) => m.user_id === userId('banco'))!
    expect(db.memberRoles.filter((r) => r.member_id === member.id).map((r) => r.role_code)).toEqual(['BANCO'])
  })

  it('el alias sale de las dos primeras palabras del nombre de la empresa', () => {
    expect(bankAlias('forestal-del-norte-5-a-2027')).toBe('FORESTAL.NORTE.BA')
    expect(bankAlias('la-sa')).toBe('EMPRESA.BA')
    expect(bankAlias('maderera-misionera-sociedad')).toBe('MADERERA.MISIONER.BA')
  })
})

describe('Banco Aula: las órdenes', () => {
  it('en modo automático, lo que mueve el banco se procesa en el momento, con su número de transacción', () => {
    const before = view()
    const trf = deposit(100_000)
    const v = view()
    expect(v.pending).toEqual([])
    expect(v.balance).toBe(before.balance + 100_000)
    expect(v.balance).toBe(v.book_balance)
    expect(v.movements[0]).toMatchObject({
      origin: 'ORDEN',
      direction: 'CREDITO',
      amount: 100_000,
      status: 'PROCESADO',
      processed_on: '2027-05-14',
      processed_by_name: null,
      source: { id: trf.id, display_number: trf.display_number },
    })
    expect(v.movements[0].transaction_number).toMatch(/^SIM-\d{6}$/)
  })

  it('operado por estudiantes, la orden espera en la bandeja con una tarea para el rol Banco', () => {
    studentsOperate()
    const before = view()
    deposit(100_000)
    const v = view()
    expect(v.balance).toBe(before.balance)
    expect(v.book_balance).toBe(before.book_balance + 100_000)
    expect(v.pending).toHaveLength(1)
    expect(v.pending[0]).toMatchObject({ direction: 'CREDITO', amount: 100_000, status: 'PENDIENTE' })
    const tasks = listTasks(db, userId('banco'), companyId(), 'mine')
    expect(tasks.map((t) => [t.task_type, t.path])).toEqual([['PROCESAR_BANCO', '/e/forestal-del-norte/banco/bandeja']])
    // Otra orden no abre otra tarea.
    deposit(50_000)
    expect(listTasks(db, userId('banco'), companyId(), 'mine')).toHaveLength(1)

    const result = cmdProcessBankOrders(
      ctx('banco'),
      companyId(),
      view('banco').pending.map((m) => m.id),
    )
    expect(result).toEqual({ processed: 2 })
    const after = view()
    expect(after.pending).toEqual([])
    expect(after.balance).toBe(after.book_balance)
    expect(after.movements[0].processed_by_name).toBe('Brenda Ibarra')
    expect(listTasks(db, userId('banco'), companyId(), 'mine')).toEqual([])
    expect(db.audit.at(-1)).toMatchObject({ action: 'PROCESS', entity_type: 'bank_account' })
  })

  it('sólo Banco procesa, una orden pendiente y una sola vez', () => {
    studentsOperate()
    deposit(100_000)
    const id = view().pending[0].id
    expectBusinessError(() => cmdProcessBankOrders(ctx('tesoreria'), companyId(), [id]), 'SIN_PERMISO')
    expectBusinessError(() => cmdProcessBankOrders(ctx('banco'), companyId(), []), 'DATO_INVALIDO')
    expectBusinessError(() => cmdProcessBankOrders(ctx('banco'), companyId(), [id, id]), 'DATO_INVALIDO')
    cmdProcessBankOrders(ctx('banco'), companyId(), [id])
    expectBusinessError(() => cmdProcessBankOrders(ctx('banco'), companyId(), [id]), 'TRANSICION_INVALIDA')
  })

  it('un asiento manual que mueve el banco también es una orden', () => {
    const draft = db.documents.find(
      (d) => d.doc_type === 'JOURNAL_ENTRY' && d.status === 'BORRADOR' && d.je?.description.includes('energía'),
    )!
    cmdConfirmJournalEntry(ctx('contabilidad'), draft.id)
    const v = view()
    expect(v.movements[0]).toMatchObject({ direction: 'DEBITO', amount: 185_000, source: { id: draft.id } })
    expect(v.balance).toBe(v.book_balance)
  })

  it('al anular la operación, la orden pendiente se retira y la procesada se revierte', () => {
    // Procesada: el contraasiento manda la orden inversa.
    const processed = deposit(100_000)
    const balance = view().balance
    cmdCancelFundsTransfer(ctx('tesoreria'), processed.id, 'Se cargó dos veces')
    const v = view()
    expect(v.movements[0]).toMatchObject({ direction: 'DEBITO', amount: 100_000, status: 'PROCESADO' })
    expect(v.movements[0].concept).toMatch(/^Reversión de SIM-\d{6}: /)
    expect(v.balance).toBe(balance - 100_000)
    expect(v.balance).toBe(v.book_balance)

    // Pendiente: queda anulada y la tarea del banco se cierra.
    studentsOperate()
    const pending = deposit(70_000)
    expect(view().pending).toHaveLength(1)
    cmdCancelFundsTransfer(ctx('tesoreria'), pending.id, 'Error de importe')
    expect(view().pending).toEqual([])
    expect(db.bankMovements.find((m) => m.source_document_id === pending.id)!.status).toBe('ANULADO')
    expect(listTasks(db, userId('banco'), companyId(), 'mine')).toEqual([])
    expect(view().balance).toBe(view().book_balance)
  })

  it('al volver al sistema, lo pendiente se procesa con la fecha del día', () => {
    studentsOperate()
    deposit(100_000)
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { bank_mode: 'AUTOMATICO' })
    const v = view()
    expect(v.pending).toEqual([])
    expect(v.balance).toBe(v.book_balance)
    expect(db.audit.at(-1)!.summary).toBe('Cambió quién opera el Banco Aula: lo opera el sistema')
  })
})

describe('Banco Aula: permisos y separación de funciones', () => {
  it('ven la cuenta Tesorería, Contabilidad, Gerencia, Auditoría y Banco; Compras no', () => {
    for (const username of ['tesoreria', 'contabilidad', 'gerencia', 'auditor', 'banco', 'docente'])
      expect(bankAccountView(db, userId(username), companyId())).not.toBeNull()
    expect(() => bankAccountView(db, userId('compras1'), companyId())).toThrow()
  })

  it('SoD-12: quien opera el banco no tiene roles de la empresa, ni al revés', () => {
    const sector = (code: string) => db.sectors.find((s) => s.company_id === companyId() && s.code === code)!.id
    expectBusinessError(
      () => cmdAssignRole(ctx('docente'), companyId(), userId('tesoreria'), 'BANCO', sector('BAN')),
      'SEPARACION_FUNCIONES',
    )
    const message = expectBusinessError(
      () => cmdAssignRole(ctx('docente'), companyId(), userId('banco'), 'TESORERIA', sector('TES')),
      'SEPARACION_FUNCIONES',
    )
    expect(message).toBe('Brenda Ibarra opera el Banco Aula: no puede tener un rol de la empresa.')
    // El docente queda afuera de la regla y, sin separación de funciones, se puede combinar.
    cmdAssignRole(ctx('docente'), companyId(), userId('banco'), 'DOCENTE', null)
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { sod_enabled: false })
    cmdAssignRole(ctx('docente'), companyId(), userId('tesoreria'), 'BANCO', sector('BAN'))
  })
})

describe('Banco Aula: empresas nuevas y bases guardadas', () => {
  it('la empresa de un curso abre su cuenta con la apertura y trae la isla del entorno', () => {
    const course = db.courses[0]
    const created = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course.id })
    const account = db.bankAccounts.find((b) => b.company_id === created.id)!
    const movements = db.bankMovements.filter((m) => m.bank_account_id === account.id)
    expect(movements.map((m) => m.origin)).toEqual(['APERTURA'])
    const ledger = db.accounts.find((a) => a.id === account.ledger_account_id)!
    expect(movements[0].amount).toBe(accountBalance(db, ledger.id))
    expect(db.sectors.filter((s) => s.company_id === created.id && ['BAN', 'FIS'].includes(s.code))).toHaveLength(2)
  })

  it('una base de la versión 21 recibe la cuenta con su historia, que coincide con los libros', () => {
    const old = structuredClone(db) as Partial<DB> & { version: number }
    delete old.bankAccounts
    delete old.bankMovements
    old.islands = old.islands!.filter((i) => i.number !== 9)
    old.sectors = old.sectors!.filter((s) => !['BAN', 'FIS'].includes(s.code))
    old.version = 21
    const upgraded = upgradeDatabase(old as DB)!
    expect(upgraded.version).toBe(DB_VERSION)
    db = upgraded
    const v = bankAccountView(db, userId('tesoreria'), companyId())!
    expect(v.balance).toBe(v.book_balance)
    expect(v.pending).toEqual([])
    expect(db.islands.some((i) => i.company_id === companyId() && i.number === 9)).toBe(true)
  })
})
