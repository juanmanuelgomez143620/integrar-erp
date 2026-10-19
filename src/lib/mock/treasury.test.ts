// Pruebas de las transferencias entre cuentas, el flujo de fondos, los cheques y la
// conciliación bancaria (docs/FASE_3_COMPRAS_Y_TESORERIA.md §7) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { todayAR } from '../format'
import type { DB } from './db'
import {
  BusinessError,
  accountBalance,
  cmdApprovePaymentOrder,
  cmdCancelBankReconciliation,
  cmdCancelFundsTransfer,
  cmdConfirmFundsTransfer,
  cmdCreateBankReconciliation,
  cmdCreateFundsTransfer,
  cmdCreateJournalEntry,
  cmdPayPaymentOrder,
  type BankReconciliationInput,
  type Ctx,
  type FundsTransferInput,
} from './engine'
import { cashFlow, cashProjection, documentDetail, issuedCheques, reconciliationCandidates } from './queries'
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
const balance = (code: string) => accountBalance(db, account(code))
const treasuryTotal = () => ['1.1.01.01', '1.1.01.02', '1.1.01.03', '1.1.01.04'].reduce((s, c) => s + balance(c), 0)

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

const transfer = (from: string, to: string, amount: number, over: Partial<FundsTransferInput> = {}) => ({
  from_account_id: account(from),
  to_account_id: account(to),
  amount,
  reference: 'Boleta 0001-0001',
  notes: '',
  ...over,
})

/** Líneas del asiento automático de un documento: [código, debe, haber]. */
function entryLines(docId: string) {
  const entry = db.docLinks
    .filter((l) => l.from_document_id === docId)
    .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
    .find((d) => d.je?.origin === 'AUTOMATICO')!
  return db.jeLines
    .filter((l) => l.document_id === entry.id)
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => [db.accounts.find((a) => a.id === l.account_id)!.code, l.debit, l.credit])
}

describe('transferencia entre cuentas', () => {
  it('la demo trae un depósito en borrador para que Tesorería lo confirme', () => {
    const draft = byNumber('TF-00001')
    expect(draft).toMatchObject({ doc_type: 'FUNDS_TRANSFER', status: 'BORRADOR', total: 200000 })
    expect(db.tasks.find((t) => t.document_id === draft.id)).toMatchObject({
      task_type: 'CONFIRMAR_TRANSFERENCIA',
      assigned_user_id: userId('tesoreria'),
      status: 'PENDIENTE',
    })
  })

  it('al confirmarse genera el asiento y no cambia el total de los fondos', () => {
    const total = treasuryTotal()
    const caja = balance('1.1.01.01')
    const tf = cmdCreateFundsTransfer(ctx('tesoreria'), companyId(), transfer('1.1.01.01', '1.1.01.02', 50000), true)
    const doc = byNumber(tf.display_number)
    expect(doc.status).toBe('CONFIRMADA')
    expect(doc.ft!.transferred_on).toBe(todayAR())
    expect(entryLines(doc.id)).toEqual([
      ['1.1.01.02', 50000, 0],
      ['1.1.01.01', 0, 50000],
    ])
    expect(balance('1.1.01.01')).toBe(caja - 50000)
    expect(balance('1.1.01.02')).toBe(50000)
    expect(treasuryTotal()).toBe(total)
    const detail = documentDetail(db, userId('tesoreria'), companyId(), 'FUNDS_TRANSFER', tf.display_number)!
    expect(detail.transfer).toMatchObject({
      from_account: { code: '1.1.01.01' },
      to_account: { code: '1.1.01.02' },
      reference: 'Boleta 0001-0001',
    })
    expect(detail.doc.summary).toBe('Caja → Fondo fijo')
    expect(detail.signatures.map((s) => s.label)).toEqual(['Preparó', 'Confirmó'])
  })

  it('controla las cuentas, el importe, la referencia, el saldo y los permisos', () => {
    const create = (input: FundsTransferInput, username = 'tesoreria') =>
      cmdCreateFundsTransfer(ctx(username), companyId(), input, true)
    expectBusinessError(() => create(transfer('1.1.01.01', '1.1.01.01', 1000)), 'DATO_INVALIDO')
    expectBusinessError(() => create(transfer('1.1.01.01', '2.1.01.01', 1000)), 'DATO_INVALIDO')
    expectBusinessError(() => create(transfer('1.1.01.01', '1.1.01.03', 0)), 'DATO_INVALIDO')
    expectBusinessError(() => create(transfer('1.1.01.01', '1.1.01.03', 10.005)), 'DATO_INVALIDO')
    expectBusinessError(
      () => create(transfer('1.1.01.01', '1.1.01.03', 1000, { reference: 'x'.repeat(61) })),
      'DATO_INVALIDO',
    )
    expectBusinessError(() => create(transfer('1.1.01.01', '1.1.01.03', 1000), 'contabilidad'), 'SIN_PERMISO')
    // El fondo fijo no tiene saldo: queda en borrador y no se puede confirmar.
    expectBusinessError(() => create(transfer('1.1.01.02', '1.1.01.01', 1000)), 'SALDO_INSUFICIENTE')
    const draft = cmdCreateFundsTransfer(ctx('tesoreria'), companyId(), transfer('1.1.01.02', '1.1.01.01', 1000), false)
    const detail = documentDetail(db, userId('tesoreria'), companyId(), 'FUNDS_TRANSFER', draft.display_number)!
    expect(detail.actions.find((a) => a.action === 'CONFIRM')).toMatchObject({ enabled: false })
    expectBusinessError(() => cmdConfirmFundsTransfer(ctx('tesoreria'), draft.id), 'SALDO_INSUFICIENTE')
  })

  it('se anula con contraasiento, salvo que los fondos ya se hayan usado', () => {
    const total = treasuryTotal()
    const first = cmdCreateFundsTransfer(ctx('tesoreria'), companyId(), transfer('1.1.01.01', '1.1.01.02', 30000), true)
    expectBusinessError(() => cmdCancelFundsTransfer(ctx('tesoreria'), first.id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelFundsTransfer(ctx('tesoreria'), first.id, 'Se cargó en la cuenta equivocada')
    expect(byNumber(first.display_number).status).toBe('ANULADA')
    expect(balance('1.1.01.02')).toBe(0)
    expect(treasuryTotal()).toBe(total)
    // Si el destino ya usó el dinero, no se anula: se prepara otra transferencia.
    const second = cmdCreateFundsTransfer(
      ctx('tesoreria'),
      companyId(),
      transfer('1.1.01.01', '1.1.01.02', 20000),
      true,
    )
    cmdCreateFundsTransfer(ctx('tesoreria'), companyId(), transfer('1.1.01.02', '1.1.01.03', 15000), true)
    const detail = documentDetail(db, userId('tesoreria'), companyId(), 'FUNDS_TRANSFER', second.display_number)!
    expect(detail.actions.find((a) => a.action === 'CANCEL')).toMatchObject({ enabled: false })
    expectBusinessError(() => cmdCancelFundsTransfer(ctx('tesoreria'), second.id, 'Error'), 'SALDO_INSUFICIENTE')
    // Un borrador se anula sin asiento.
    cmdCancelFundsTransfer(ctx('tesoreria'), byNumber('TF-00001').id, 'Se deposita mañana')
    expect(byNumber('TF-00001').status).toBe('ANULADA')
  })
})

describe('flujo de fondos', () => {
  it('real: entradas y salidas por concepto, por cuenta, y saldos que cierran', () => {
    cmdCreateFundsTransfer(ctx('tesoreria'), companyId(), transfer('1.1.01.01', '1.1.01.02', 40000), true)
    const op = byNumber('OP-00001')
    cmdApprovePaymentOrder(ctx('gerencia'), op.id, 'ok')
    cmdPayPaymentOrder(ctx('tesoreria'), op.id, 'Transferencia 1234')
    const today = todayAR()
    const flow = cashFlow(db, userId('tesoreria'), companyId(), today, today)
    const concept = (key: string) => flow.concepts.find((c) => c.key === key)!
    expect(concept('PAGOS')).toMatchObject({ inflow: 0, outflow: op.total })
    expect(concept('TRANSFERENCIAS')).toMatchObject({ inflow: 40000, outflow: 40000 })
    // El depósito del seed es un asiento manual de Contabilidad.
    expect(concept('OTROS')).toMatchObject({ inflow: 300000, outflow: 300000 })
    expect(flow.inflow).toBe(flow.concepts.reduce((s, c) => s + c.inflow, 0))
    expect(flow.closing).toBe(flow.opening + flow.inflow - flow.outflow)
    expect(flow.closing).toBe(treasuryTotal())
    expect(flow.accounts.map((a) => a.account.code)).toEqual(['1.1.01.01', '1.1.01.02', '1.1.01.03', '1.1.01.04'])
    expect(flow.accounts.reduce((s, a) => s + a.closing, 0)).toBe(flow.closing)
    expect(() => cashFlow(db, userId('compras1'), companyId(), today, today)).toThrow()
  })

  it('proyectado: lo que vence por tramo y el aviso si no alcanzan los fondos', () => {
    const before = cashProjection(db, userId('tesoreria'), companyId())
    expect(before.balance).toBe(treasuryTotal())
    // La factura de la demo vence a 30 días.
    expect(before.buckets.map((b) => [b.key, b.payments, b.invoices])).toEqual([
      ['VENCIDAS', 0, 0],
      ['SEMANA', 0, 0],
      ['QUINCENA', 0, 0],
      ['MES', 266200, 1],
      ['DESPUES', 0, 0],
    ])
    expect(before.shortfall).toBeNull()
    // Contabilidad registra un gasto grande pagado por banco: ya no alcanza para lo que vence.
    cmdCreateJournalEntry(
      ctx('contabilidad'),
      companyId(),
      {
        document_date: todayAR(),
        description: 'Pago de la ampliación del galpón con transferencia bancaria.',
        lines: [
          { account_id: account('5.2.02.02'), debit: 13200000, credit: 0 },
          { account_id: account('1.1.01.03'), debit: 0, credit: 13200000 },
        ],
      },
      true,
    )
    const after = cashProjection(db, userId('tesoreria'), companyId())
    expect(after.balance).toBe(150000)
    expect(after.buckets.find((b) => b.key === 'MES')!.balance).toBe(150000 - 266200)
    expect(after.shortfall).toBe('MES')
  })
})

describe('cheques y conciliación bancaria', () => {
  /** La OP de la demo, aprobada por Gerencia: lista para pagar. */
  const approved = () => {
    const op = byNumber('OP-00001')
    cmdApprovePaymentOrder(ctx('gerencia'), op.id, 'ok')
    return op
  }
  const reconcile = (over: Partial<BankReconciliationInput>, username = 'contabilidad') =>
    cmdCreateBankReconciliation(ctx(username), companyId(), {
      account_id: account('1.1.01.03'),
      statement_date: todayAR(),
      statement_balance: 0,
      journal_line_ids: [],
      notes: '',
      ...over,
    })
  const candidates = (date = todayAR()) =>
    reconciliationCandidates(db, userId('contabilidad'), companyId(), account('1.1.01.03'), date)!

  it('con cheque hace falta su número, y queda en los cheques emitidos pendiente de débito', () => {
    const op = approved()
    expectBusinessError(() => cmdPayPaymentOrder(ctx('tesoreria'), op.id, '', 'CHEQUE'), 'DATO_INVALIDO')
    expectBusinessError(() => cmdPayPaymentOrder(ctx('tesoreria'), op.id, 'Cheque 1', 'CHEQUE'), 'DATO_INVALIDO')
    cmdPayPaymentOrder(ctx('tesoreria'), op.id, '00012345', 'CHEQUE')
    expect(op.op).toMatchObject({ payment_method: 'CHEQUE', payment_reference: '00012345' })
    const detail = documentDetail(db, userId('tesoreria'), companyId(), 'PAYMENT_ORDER', 'OP-00001')!
    expect(detail.payment?.payment_method).toBe('CHEQUE')
    expect(detail.history.at(-1)?.summary).toContain('con cheque N.º 00012345')
    expect(issuedCheques(db, userId('tesoreria'), companyId())).toMatchObject([
      { number: '00012345', amount: op.total, status: 'PENDIENTE', reconciliation: null },
    ])
  })

  it('cierra con lo pendiente; la siguiente encuentra el cheque y queda debitado', () => {
    const op = approved()
    cmdPayPaymentOrder(ctx('tesoreria'), op.id, '00012345', 'CHEQUE')
    // Al 31/1 el banco sólo tenía la apertura.
    const january = candidates('2027-01-31')
    expect(january.lines.map((l) => [l.debit, l.credit])).toEqual([[12500000, 0]])
    const first = reconcile({
      statement_date: '2027-01-31',
      statement_balance: 12500000,
      journal_line_ids: january.lines.map((l) => l.line_id),
    })
    expect(byNumber(first.display_number)).toMatchObject({ status: 'CONFIRMADA' })
    // Hoy: el depósito del seed ya está en el extracto, el cheque todavía no.
    const today = candidates()
    expect(today.last?.display_number).toBe(first.display_number)
    expect(today.lines.map((l) => [l.debit, l.credit])).toEqual([
      [300000, 0],
      [0, op.total],
    ])
    const deposit = today.lines[0].line_id
    expectBusinessError(
      () => reconcile({ statement_balance: 12800000 - 1, journal_line_ids: [deposit] }),
      'CONCILIACION_NO_CIERRA',
    )
    expectBusinessError(() => reconcile({ statement_date: '2027-01-31', statement_balance: 12500000 }), 'DATO_INVALIDO')
    expectBusinessError(
      () => reconcile({ statement_balance: 12800000, journal_line_ids: [deposit] }, 'tesoreria'),
      'SIN_PERMISO',
    )
    const second = reconcile({ statement_balance: 12800000, journal_line_ids: [deposit] })
    const view = documentDetail(
      db,
      userId('contabilidad'),
      companyId(),
      'BANK_RECONCILIATION',
      second.display_number,
    )!.reconciliation!
    expect(view).toMatchObject({ book_balance: 12800000 - op.total, pending_debits: 0, pending_credits: op.total })
    expect(view.pending.map((l) => l.credit)).toEqual([op.total])
    expect(issuedCheques(db, userId('tesoreria'), companyId())[0].status).toBe('PENDIENTE')
    // Sólo se anula la última; al anularla, el depósito vuelve a estar pendiente.
    const detail = documentDetail(db, userId('contabilidad'), companyId(), 'BANK_RECONCILIATION', first.display_number)!
    expect(detail.actions.find((a) => a.action === 'CANCEL')).toMatchObject({ enabled: false })
    expectBusinessError(
      () => cmdCancelBankReconciliation(ctx('contabilidad'), first.id, 'Error'),
      'TRANSICION_INVALIDA',
    )
    cmdCancelBankReconciliation(ctx('contabilidad'), second.id, 'Se cargó el saldo de otro extracto')
    // Con el cheque debitado, cierra sin pendientes.
    const all = candidates().lines.map((l) => l.line_id)
    const third = reconcile({ statement_balance: 12800000 - op.total, journal_line_ids: all })
    expect(issuedCheques(db, userId('tesoreria'), companyId())[0]).toMatchObject({
      status: 'DEBITADO',
      reconciliation: { display_number: third.display_number },
    })
  })
})
