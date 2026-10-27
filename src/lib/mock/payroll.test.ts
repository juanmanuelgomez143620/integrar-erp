// Pruebas de la liquidación de sueldos y de sus pagos (docs/FASE_6_RRHH_Y_SUELDOS.md §3 y §4) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAYROLL_DEFAULT_RATES } from '../domain/catalog'
import { money } from '../format'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdAssignRole,
  cmdCancelPayroll,
  cmdConfirmPayroll,
  cmdCreatePayroll,
  cmdFinishProductionOrder,
  cmdIssueProductionOrder,
  cmdPayPayrollCharges,
  cmdPayPayrollSalaries,
  cmdSaveEmployee,
  cmdUpdateCompanySettings,
  cmdUpdatePayrollLines,
  payrollAmounts,
  payrollLines,
  productionOrderLines,
  productionOrderOperations,
  round2,
  type Ctx,
  type PayrollInput,
} from './engine'
import { cashFlow, cashProjection, documentDetail, laborVariance, listDocuments } from './queries'
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
const employee = (n: number) => db.employees.find((e) => e.company_id === companyId() && e.file_number === n)!
const lineOf = (docId: string, n: number) => payrollLines(db, docId).find((l) => l.employee_id === employee(n).id)!

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

const input = (over: Partial<PayrollInput> = {}): PayrollInput => ({
  period: '2027-05',
  payment_date: '2027-06-04',
  notes: '',
  ...over,
})

/** Los asientos automáticos de un documento, por cuenta. */
const entriesOf = (docId: string) =>
  db.docLinks
    .filter((l) => l.from_document_id === docId)
    .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
    .filter((d) => d.doc_type === 'JOURNAL_ENTRY')
    .map((d) =>
      db.jeLines
        .filter((l) => l.document_id === d.id)
        .map((l) => `${db.accounts.find((a) => a.id === l.account_id)!.code} ${l.debit} ${l.credit}`),
    )

describe('el cálculo de un recibo', () => {
  it('básico, antigüedad, presentismo, horas extra, aportes y contribuciones, cada uno a centavos', () => {
    const full = { days_worked: 30, absence_days: 0, overtime_50: 0, overtime_100: 0 }
    // Un oficial con 12 años: 1.250.000 de básico, 12 % de antigüedad y 8,33 % de presentismo.
    expect(payrollAmounts(PAYROLL_DEFAULT_RATES, 1250000, 12, full)).toEqual({
      basic: 1250000,
      seniority: 150000,
      attendance: 116620,
      overtime: 0,
      gross: 1516620,
      retirement: 166828.2,
      pami: 45498.6,
      health: 45498.6,
      deductions: 257825.4,
      net: 1258794.6,
      employer: 363988.8,
    })
    // Cuatro horas al 50 % y dos al 100 %: el valor hora es (1.250.000 + 150.000) / 200 = 7.000.
    expect(
      payrollAmounts(PAYROLL_DEFAULT_RATES, 1250000, 12, { ...full, overtime_50: 4, overtime_100: 2 }).overtime,
    ).toBe(70000)
    // Dos días sin aviso: cobra 28 días y pierde el presentismo.
    expect(
      payrollAmounts(PAYROLL_DEFAULT_RATES, 1250000, 12, { ...full, days_worked: 28, absence_days: 2 }),
    ).toMatchObject({ basic: 1166666.67, seniority: 140000, attendance: 0, gross: 1306666.67 })
  })
})

describe('liquidación de sueldos', () => {
  it('crear: el personal activo, los días desde el ingreso y los porcentajes de la empresa', () => {
    // Un ayudante que ingresó el 10 de mayo: cobra 21 días del mes.
    const sector = db.sectors.find((s) => s.company_id === companyId() && s.code === 'PRO')!
    const category = db.jobCategories.find((c) => c.company_id === companyId() && c.code === 'AYUDANTE')!
    const center = db.workCenters.find((w) => w.company_id === companyId() && w.code === 'ARMADO')!
    cmdSaveEmployee(ctx('rrhh'), companyId(), {
      id: '',
      first_name: 'Rubén',
      last_name: 'Acuña',
      hire_date: '2027-05-10',
      category_id: category.id,
      sector_id: sector.id,
      work_center_id: center.id,
    })
    const created = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    expect(created.display_number).toBe('LIQ-00001')
    const doc = byNumber('LIQ-00001')
    expect(doc).toMatchObject({ status: 'BORRADOR', py: { period: '2027-05', rates: PAYROLL_DEFAULT_RATES } })
    const lines = payrollLines(db, doc.id)
    expect(lines).toHaveLength(11)
    expect(lineOf(doc.id, 2)).toMatchObject({ seniority_years: 12, days_worked: 30, gross: 1516620, net: 1258794.6 })
    expect(lineOf(doc.id, 11)).toMatchObject({ days_worked: 21, seniority_years: 0, basic: 665000 })
    expect(doc.subtotal).toBe(Math.round(lines.reduce((s, l) => s + l.gross, 0) * 100) / 100)
    expect(doc.total).toBe(Math.round(lines.reduce((s, l) => s + l.net, 0) * 100) / 100)
    expect(db.audit.at(-1)!.summary).toBe('Creó LIQ-00001: sueldos de 05/2027 (11 empleados)')
    expect(db.tasks.filter((t) => t.document_id === doc.id).map((t) => t.title)).toEqual(['Confirmar LIQ-00001'])
    expect(listDocuments(db, userId('tesoreria'), companyId(), 'PAYROLL')[0]).toMatchObject({
      summary: 'Sueldos de 05/2027',
      line_count: 11,
    })
  })

  it('validaciones al crearla: el mes, la fecha de pago, que no esté repetida y quién la hace', () => {
    const create = (over: Partial<PayrollInput>, username = 'rrhh') =>
      expectBusinessError(() => cmdCreatePayroll(ctx(username), companyId(), input(over)), 'DATO_INVALIDO')
    expect(create({ period: '2027-5' })).toBe('El período es un mes: aaaa-mm.')
    create({ period: '2027-13' })
    expect(create({ period: '2027-06' })).toBe('Ese mes todavía no empezó: no se puede liquidar.')
    expect(create({ period: '2015-02' })).toBe('La empresa empezó sus actividades el 02/03/2015: no hay sueldos antes.')
    expect(create({ payment_date: '2027-02-30' })).toBe('La fecha de pago no es válida.')
    expect(create({ payment_date: '2027-04-30' })).toBe('La fecha de pago no puede ser anterior al mes liquidado.')
    for (const username of ['contabilidad', 'tesoreria', 'gerencia'])
      expectBusinessError(() => cmdCreatePayroll(ctx(username), companyId(), input()), 'SIN_PERMISO')
    cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    expect(create({})).toBe('Ya hay una liquidación de 05/2027: LIQ-00001.')
  })

  it('novedades: se recalculan los importes; validaciones', () => {
    const { id } = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    const ortiz = lineOf(id, 2)
    cmdUpdatePayrollLines(ctx('rrhh'), id, [
      { line_id: ortiz.id, days_worked: 28, absence_days: 2, overtime_50: 4, overtime_100: 0 },
    ])
    // 28 días sin presentismo y 4 horas al 50 % (7.000 × 1,5 × 4 = 42.000).
    expect(lineOf(id, 2)).toMatchObject({ basic: 1166666.67, attendance: 0, overtime: 42000, gross: 1348666.67 })
    expect(byNumber('LIQ-00001').subtotal).toBe(
      Math.round(payrollLines(db, id).reduce((s, l) => s + l.gross, 0) * 100) / 100,
    )
    const update = (lines: Parameters<typeof cmdUpdatePayrollLines>[2]) =>
      expectBusinessError(() => cmdUpdatePayrollLines(ctx('rrhh'), id, lines), 'DATO_INVALIDO')
    const base = { line_id: ortiz.id, days_worked: 30, absence_days: 0, overtime_50: 0, overtime_100: 0 }
    expect(update([{ ...base, days_worked: 29, absence_days: 2 }])).toBe(
      'Los días trabajados y las ausencias de Ortiz, Ramón son enteros que juntos no pasan de 30.',
    )
    update([{ ...base, days_worked: 31 }])
    update([{ ...base, days_worked: 29.5 }])
    expect(update([{ ...base, overtime_50: 250 }])).toBe(
      'Las horas extra de Ortiz, Ramón van de 0 a 200, con hasta 2 decimales.',
    )
    update([{ ...base, overtime_100: 1.555 }])
    expect(update([{ ...base, line_id: 'otra' }])).toBe('Uno de los empleados no es de la liquidación.')
    expect(update([base, base])).toBe('Un empleado está dos veces: indicá sus novedades una sola vez.')
    expectBusinessError(() => cmdUpdatePayrollLines(ctx('contabilidad'), id, [base]), 'SIN_PERMISO')
  })

  it('confirmar: el asiento de sueldos separa el taller (mano de obra directa) del resto', () => {
    const { id } = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    cmdConfirmPayroll(ctx('rrhh'), id)
    const doc = byNumber('LIQ-00001')
    expect(doc.status).toBe('CONFIRMADA')
    expect(doc.py!.confirmed_at).not.toBeNull()
    const lines = payrollLines(db, id)
    const sum = (rows: typeof lines, value: (l: (typeof lines)[number]) => number) =>
      Math.round(rows.reduce((s, l) => s + value(l), 0) * 100) / 100
    const direct = lines.filter((l) => l.is_direct_labor)
    const others = lines.filter((l) => !l.is_direct_labor)
    expect(direct).toHaveLength(6)
    expect(entriesOf(id)).toEqual([
      [
        `5.2.01.01 ${sum(others, (l) => l.gross)} 0`,
        `5.2.01.02 ${sum(others, (l) => l.employer)} 0`,
        `5.1.03.01 ${sum(direct, (l) => l.gross + l.employer)} 0`,
        `2.1.03.01 0 ${sum(lines, (l) => l.net)}`,
        `2.1.03.02 0 ${sum(lines, (l) => l.deductions + l.employer)}`,
      ],
    ])
    const view = documentDetail(db, userId('contabilidad'), companyId(), 'PAYROLL', 'LIQ-00001')!.payroll!
    expect(view).toMatchObject({
      period: '2027-05',
      net: doc.total,
      cost: sum(lines, (l) => l.gross + l.employer),
      direct_labor: sum(direct, (l) => l.gross + l.employer),
    })
    expect(view.lines[1]).toMatchObject({
      employee: { file_number: 2, last_name: 'Ortiz' },
      work_center: { code: 'CORTE' },
    })
    // Confirmada, ya no se cambian las novedades.
    expectBusinessError(
      () =>
        cmdUpdatePayrollLines(ctx('rrhh'), id, [
          { line_id: lines[0].id, days_worked: 30, absence_days: 0, overtime_50: 0, overtime_100: 0 },
        ]),
      'TRANSICION_INVALIDA',
    )
  })

  it('anular: el borrador sin más; la confirmada con su contraasiento; después se vuelve a liquidar el mes', () => {
    const draft = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    expectBusinessError(() => cmdCancelPayroll(ctx('rrhh'), draft.id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelPayroll(ctx('rrhh'), draft.id, 'Faltaban novedades')
    expect(byNumber('LIQ-00001').status).toBe('ANULADA')
    const second = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    cmdConfirmPayroll(ctx('rrhh'), second.id)
    expectBusinessError(() => cmdCancelPayroll(ctx('rrhh'), second.id, ' '), 'MOTIVO_REQUERIDO')
    expectBusinessError(() => cmdCancelPayroll(ctx('tesoreria'), second.id, 'Error'), 'SIN_PERMISO')
    cmdCancelPayroll(ctx('rrhh'), second.id, 'Se liquidó con el básico viejo')
    expect(byNumber('LIQ-00002').status).toBe('ANULADA')
    expect(db.audit.at(-1)!.summary).toMatch(
      /^Anuló LIQ-00002: el contraasiento AS-\d+ revirtió el de sueldos — Se liquidó con el básico viejo$/,
    )
    expect(cmdCreatePayroll(ctx('rrhh'), companyId(), input()).display_number).toBe('LIQ-00003')
  })

  it('los porcentajes los cambia el docente; la liquidación conserva los suyos', () => {
    const before = cmdCreatePayroll(ctx('rrhh'), companyId(), input({ period: '2027-04', payment_date: '2027-05-05' }))
    expectBusinessError(
      () => cmdUpdateCompanySettings(ctx('rrhh'), companyId(), { payroll: { employer_pct: 20 } }),
      'SIN_PERMISO',
    )
    expectBusinessError(
      () => cmdUpdateCompanySettings(ctx('docente'), companyId(), { payroll: { employer_pct: 120 } }),
      'DATO_INVALIDO',
    )
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { payroll: { employer_pct: 20 } })
    expect(db.audit.at(-1)!.summary).toBe('Cambió los porcentajes de la liquidación de sueldos')
    const after = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    expect(byNumber(after.display_number).py!.rates.employer_pct).toBe(20)
    expect(lineOf(after.id, 2).employer).toBe(303324)
    expect(byNumber(before.display_number).py!.rates.employer_pct).toBe(24)
    // El resto de la configuración no cambia.
    expect(db.companies[0].settings).toMatchObject({ payroll: { employer_pct: 20 } })
  })

  it('al actualizar una base guardada (v14), cada empresa recibe la cuenta y las reglas de sueldos', () => {
    const stored = structuredClone(db)
    const company = stored.companies[0].id
    stored.accounts = stored.accounts.filter((a) => !(a.company_id === company && a.code.startsWith('5.1.03')))
    stored.postingRules = stored.postingRules.filter((r) => r.event !== 'SUELDOS')
    const { pyLines: _lines, ...v14 } = stored
    const upgraded = upgradeDatabase({ ...v14, version: 14 } as DB)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.accounts.some((a) => a.company_id === company && a.code === '5.1.03.01')).toBe(true)
    expect(upgraded.postingRules.filter((r) => r.company_id === company && r.event === 'SUELDOS')).toHaveLength(5)
  })
})

describe('pago de sueldos y cargas sociales (Fase 6c)', () => {
  const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!.id
  const bank = () => account('1.1.01.03')
  const pending = (docId: string) =>
    db.tasks.filter((t) => t.document_id === docId && t.status === 'PENDIENTE').map((t) => t.title)
  const charges = (docId: string) => round2(payrollLines(db, docId).reduce((s, l) => s + l.deductions + l.employer, 0))

  /** Una liquidación de mayo confirmada con dos empleados (los demás, sin días): alcanza el banco de la demo. */
  function confirmed(username = 'rrhh') {
    const { id } = cmdCreatePayroll(ctx(username), companyId(), input())
    cmdUpdatePayrollLines(
      ctx(username),
      id,
      payrollLines(db, id)
        .slice(2)
        .map((l) => ({ line_id: l.id, days_worked: 0, absence_days: 0, overtime_50: 0, overtime_100: 0 })),
    )
    cmdConfirmPayroll(ctx(username), id)
    return id
  }

  it('Tesorería paga los sueldos y después las cargas sociales, cada pago con su asiento', () => {
    const id = confirmed()
    const doc = byNumber('LIQ-00001')
    expect(pending(id)).toEqual([`Pagar los sueldos de LIQ-00001 por ${money(doc.total)}`])
    const pay = (fn: typeof cmdPayPayrollSalaries, username: string, accountId: string, code: string) =>
      expectBusinessError(() => fn(ctx(username), id, accountId), code)
    expect(pay(cmdPayPayrollCharges, 'tesoreria', bank(), 'TRANSICION_INVALIDA')).toBe(
      'Primero se pagan los sueldos de LIQ-00001; después, sus cargas sociales.',
    )
    pay(cmdPayPayrollSalaries, 'rrhh', bank(), 'SIN_PERMISO')
    pay(cmdPayPayrollSalaries, 'tesoreria', account('2.1.03.01'), 'DATO_INVALIDO')
    expect(pay(cmdPayPayrollSalaries, 'tesoreria', account('1.1.01.01'), 'SALDO_INSUFICIENTE')).toMatch(
      /^No alcanza el saldo de 1\.1\.01\.01 Caja: hay \$\s[\d.,]+ y los sueldos netos de 05\/2027 son \$\s[\d.,]+\.$/,
    )

    cmdPayPayrollSalaries(ctx('tesoreria'), id, bank())
    expect(doc).toMatchObject({
      status: 'SUELDOS_PAGADOS',
      py: { salaries_paid_on: '2027-05-14', salaries_account_id: bank(), charges_paid_on: null },
    })
    expect(db.audit.find((a) => a.document_id === id && a.action === 'PAY')!.summary).toBe(
      `Pagó los sueldos de 05/2027 (LIQ-00001): ${money(doc.total)} netos desde 1.1.01.03 Banco cuenta corriente`,
    )
    expect(pay(cmdPayPayrollSalaries, 'tesoreria', bank(), 'TRANSICION_INVALIDA')).toBe(
      'Los sueldos de LIQ-00001 ya están pagados: faltan las cargas sociales.',
    )
    expect(pending(id)).toEqual(['Pagar las cargas sociales de LIQ-00001'])
    // Con algo pagado ya no se anula.
    expectBusinessError(() => cmdCancelPayroll(ctx('rrhh'), id, 'Error de cálculo'), 'TRANSICION_INVALIDA')

    cmdPayPayrollCharges(ctx('tesoreria'), id, bank())
    expect(doc).toMatchObject({ status: 'PAGADA', py: { charges_paid_on: '2027-05-14', charges_account_id: bank() } })
    expect(pending(id)).toEqual([])
    // El de sueldos y, después, los dos pagos: cada deuda contra el banco.
    expect(entriesOf(id).slice(1)).toEqual([
      [`2.1.03.01 ${doc.total} 0`, `1.1.01.03 0 ${doc.total}`],
      [`2.1.03.02 ${charges(id)} 0`, `1.1.01.03 0 ${charges(id)}`],
    ])
    expect(documentDetail(db, userId('tesoreria'), companyId(), 'PAYROLL', 'LIQ-00001')!.payroll).toMatchObject({
      charges: charges(id),
      charges_due: '2027-06-10',
      salaries_paid_on: '2027-05-14',
      salaries_account: { code: '1.1.01.03' },
      charges_account: { code: '1.1.01.03' },
    })
  })

  it('SoD-6: quien liquidó los sueldos no los paga (salvo que el docente apague la regla)', () => {
    cmdAssignRole(
      ctx('docente'),
      companyId(),
      userId('rrhh'),
      'TESORERIA',
      db.sectors.find((s) => s.code === 'TES')!.id,
    )
    const id = confirmed('rrhh')
    const payAction = (username: string) =>
      documentDetail(db, userId(username), companyId(), 'PAYROLL', 'LIQ-00001')!.actions.find((a) => a.action === 'PAY')
    expect(payAction('rrhh')).toMatchObject({
      label: 'Pagar los sueldos',
      enabled: false,
      reason: 'Separación de funciones: liquidaste estos sueldos; tiene que pagarlos otro integrante de Tesorería.',
    })
    expect(payAction('tesoreria')).toMatchObject({ label: 'Pagar los sueldos', enabled: true })
    expect(expectBusinessError(() => cmdPayPayrollSalaries(ctx('rrhh'), id, bank()), 'SEPARACION_FUNCIONES')).toBe(
      'No podés pagar LIQ-00001: la liquidaste vos.',
    )
    cmdPayPayrollSalaries(ctx('tesoreria'), id, bank())
    expect(payAction('tesoreria')).toMatchObject({ label: 'Pagar las cargas sociales', enabled: true })
    expectBusinessError(() => cmdPayPayrollCharges(ctx('rrhh'), id, bank()), 'SEPARACION_FUNCIONES')
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { sod_enabled: false })
    cmdPayPayrollCharges(ctx('rrhh'), id, bank())
    expect(byNumber('LIQ-00001').status).toBe('PAGADA')
  })

  it('el flujo de fondos: lo que falta pagar en el proyectado y lo pagado como concepto propio en el real', () => {
    const id = confirmed()
    const doc = byNumber('LIQ-00001')
    // Hoy es el 14/05: los sueldos se pagan el 04/06 (a 21 días) y las cargas vencen el 10/06 (a 27 días).
    const month = () => cashProjection(db, userId('tesoreria'), companyId()).buckets.find((b) => b.key === 'MES')!
    expect(month()).toMatchObject({ payroll: round2(doc.total + charges(id)), payroll_items: 2 })
    cmdPayPayrollSalaries(ctx('tesoreria'), id, bank())
    expect(month()).toMatchObject({ payroll: charges(id), payroll_items: 1 })
    cmdPayPayrollCharges(ctx('tesoreria'), id, bank())
    expect(month()).toMatchObject({ payroll: 0, payroll_items: 0 })
    const flow = cashFlow(db, userId('tesoreria'), companyId(), '2027-05-01', '2027-05-31')
    expect(flow.concepts.map((c) => c.key)).toEqual([
      'APERTURA',
      'COBROS',
      'PAGOS',
      'SUELDOS',
      'IMPUESTOS',
      'TRANSFERENCIAS',
      'OTROS',
    ])
    expect(flow.concepts.find((c) => c.key === 'SUELDOS')).toEqual({
      key: 'SUELDOS',
      label: 'Sueldos y cargas sociales',
      inflow: 0,
      outflow: round2(doc.total + charges(id)),
    })
  })

  it('la mano de obra del taller: la aplicada a las órdenes terminadas en el mes contra la real de la liquidación', () => {
    const chairs = byNumber('OPR-00001')
    cmdIssueProductionOrder(ctx('deposito'), chairs.id, {
      lines: productionOrderLines(db, chairs.id).map((l) => ({ line_id: l.id, quantity: l.quantity_planned })),
    })
    cmdFinishProductionOrder(ctx('produccion'), chairs.id, 10)
    const report = () => laborVariance(db, userId('contabilidad'), companyId(), '2027-05')
    const applied = round2(
      productionOrderOperations(db, chairs.id).reduce((s, o) => s + round2(o.hours_actual! * o.labor_rate), 0),
    )
    expect(applied).toBeGreaterThan(0)
    // Sin liquidación, todo lo aplicado queda sin su real.
    expect(report()).toMatchObject({ payroll: null, applied, real: 0, difference: applied })
    expect(report().orders.map((o) => o.display_number)).toEqual(['OPR-00001'])
    // En borrador todavía no cuenta como real.
    const { id } = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    expect(report()).toMatchObject({
      payroll: { display_number: 'LIQ-00001', status_info: { label: 'Borrador' } },
      real: 0,
    })
    cmdConfirmPayroll(ctx('rrhh'), id)
    const view = report()
    expect(view.rows.map((r) => `${r.work_center?.code} ${r.employees}`)).toEqual([
      'ARMADO 2',
      'CORTE 2',
      'TERMINACION 2',
    ])
    const direct = payrollLines(db, id).filter((l) => l.is_direct_labor)
    const corte = view.rows.find((r) => r.work_center?.code === 'CORTE')!
    expect(corte.real).toBe(
      round2(
        direct.filter((l) => l.work_center_id === corte.work_center!.id).reduce((s, l) => s + l.gross + l.employer, 0),
      ),
    )
    expect(view.real).toBe(
      documentDetail(db, userId('rrhh'), companyId(), 'PAYROLL', 'LIQ-00001')!.payroll!.direct_labor,
    )
    expect(view).toMatchObject({ applied, difference: round2(applied - view.real) })
    // Lo ven quienes ven las liquidaciones; el mes, bien escrito.
    expect(() => laborVariance(db, userId('produccion'), companyId(), '2027-05')).toThrow('Tu rol no tiene acceso')
    expectBusinessError(() => laborVariance(db, userId('contabilidad'), companyId(), '2027-5'), 'DATO_INVALIDO')
  })

  it('al actualizar una base guardada (v15), cada empresa recibe las reglas de los pagos', () => {
    cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    const stored = structuredClone(db)
    const company = stored.companies[0].id
    stored.postingRules = stored.postingRules.filter((r) => !r.event.startsWith('PAGO_'))
    for (const d of stored.documents)
      if (d.py) {
        const {
          salaries_paid_on: _a,
          salaries_account_id: _b,
          charges_paid_on: _c,
          charges_account_id: _d,
          ...v15
        } = d.py
        d.py = v15 as typeof d.py
      }
    const upgraded = upgradeDatabase({ ...stored, version: 15 })!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(
      upgraded.postingRules
        .filter((r) => r.company_id === company && (r.event === 'PAGO_SUELDOS' || r.event === 'PAGO_CARGAS_SOCIALES'))
        .map((r) => r.key)
        .sort(),
    ).toEqual(['CARGAS_SOCIALES_A_PAGAR', 'SUELDOS_A_PAGAR'])
    expect(upgraded.documents.find((d) => d.py)!.py).toMatchObject({ salaries_paid_on: null, charges_account_id: null })
  })
})
