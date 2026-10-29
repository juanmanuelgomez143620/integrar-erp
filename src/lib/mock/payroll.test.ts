// Pruebas de la liquidación de sueldos y de sus pagos (docs/FASE_6_RRHH_Y_SUELDOS.md §3 y §4, con los
// convenios de docs/FASE_6D_CONVENIOS.md) sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAYROLL_DEFAULT_RATES } from '../domain/catalog'
import { money } from '../format'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdAssignRole,
  cmdApprovePayroll,
  cmdCancelPayroll,
  cmdCreatePayroll,
  cmdFinishProductionOrder,
  cmdIssueProductionOrder,
  cmdPayPayrollCharges,
  cmdPayPayrollSalaries,
  cmdRejectPayroll,
  cmdSaveEmployee,
  cmdSaveLaborAgreement,
  cmdSubmitPayroll,
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
/** RRHH la envía y Gerencia la autoriza (Fase 6d): queda confirmada, con su asiento. */
const authorize = (docId: string, username = 'rrhh') => {
  cmdSubmitPayroll(ctx(username), docId)
  cmdApprovePayroll(ctx('gerencia'), docId, '')
}
const agreement = (code: string) => db.laborAgreements.find((a) => a.company_id === companyId() && a.code === code)!

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
  const full = { days_worked: 30, hours_worked: 0, absence_days: 0, overtime_50: 0, overtime_100: 0 }

  it('por mes: básico, antigüedad, presentismo, horas extra, aportes (con el sindical) y contribuciones, a centavos', () => {
    // Un empleado de Comercio con 12 años: 1.250.000 de básico, 12 % de antigüedad, 8,33 % de
    // presentismo, 2,5 % de aporte sindical y 1 % de contribución del convenio.
    const rates = { ...PAYROLL_DEFAULT_RATES, union_pct: 2.5, union_employer_pct: 1 }
    expect(payrollAmounts(rates, 'MONTHLY', 1250000, 12, full)).toEqual({
      basic: 1250000,
      seniority: 150000,
      attendance: 116620,
      overtime: 0,
      gross: 1516620,
      retirement: 166828.2,
      pami: 45498.6,
      health: 45498.6,
      union_dues: 37915.5,
      deductions: 295740.9,
      net: 1220879.1,
      employer: 363988.8,
      union_contribution: 15166.2,
    })
    // Cuatro horas al 50 % y dos al 100 %: el valor hora es (1.250.000 + 150.000) / 200 = 7.000.
    expect(payrollAmounts(rates, 'MONTHLY', 1250000, 12, { ...full, overtime_50: 4, overtime_100: 2 }).overtime).toBe(
      70000,
    )
    // Medio centavo se redondea hacia arriba, como en la base (decimal exacto): el 11 % y el 1 % de 922.850,50.
    const flat = { ...rates, seniority_pct: 0, attendance_pct: 0, union_pct: 0 }
    expect(payrollAmounts(flat, 'MONTHLY', 922850.5, 0, full)).toMatchObject({
      gross: 922850.5,
      retirement: 101513.56,
      union_contribution: 9228.51,
    })
    // Dos días sin aviso: cobra 28 días y pierde el presentismo.
    expect(payrollAmounts(rates, 'MONTHLY', 1250000, 12, { ...full, days_worked: 28, absence_days: 2 })).toMatchObject({
      basic: 1166666.67,
      seniority: 140000,
      attendance: 0,
      gross: 1306666.67,
    })
  })

  it('por hora (jornalizado): el valor hora por las horas trabajadas; las extra, sobre el valor hora con la antigüedad', () => {
    // Un oficial de Madera con 12 años: 7.100 la hora, 176 horas en el mes, 10 % de asistencia,
    // 2 % de aporte sindical y 1 % de contribución del convenio.
    const rates = { ...PAYROLL_DEFAULT_RATES, attendance_pct: 10, union_pct: 2, union_employer_pct: 1 }
    const month = { ...full, days_worked: 0, hours_worked: 176 }
    expect(payrollAmounts(rates, 'HOURLY', 7100, 12, month)).toEqual({
      basic: 1249600,
      seniority: 149952,
      attendance: 139955.2,
      overtime: 0,
      gross: 1539507.2,
      retirement: 169345.79,
      pami: 46185.22,
      health: 46185.22,
      union_dues: 30790.14,
      deductions: 292506.37,
      net: 1247000.83,
      employer: 369481.73,
      union_contribution: 15395.07,
    })
    // El valor hora con la antigüedad es 7.100 + 852 = 7.952: 4 h al 50 % y 2 h al 100 %.
    expect(payrollAmounts(rates, 'HOURLY', 7100, 12, { ...month, overtime_50: 4, overtime_100: 2 }).overtime).toBe(
      79520,
    )
    // Los días no cuentan: cobra las horas que trabajó y, si faltó sin aviso, pierde la asistencia.
    expect(
      payrollAmounts(rates, 'HOURLY', 7100, 12, { ...month, days_worked: 30, hours_worked: 160, absence_days: 2 }),
    ).toMatchObject({ basic: 1136000, seniority: 136320, attendance: 0, gross: 1272320 })
  })
})

describe('liquidación de sueldos', () => {
  it('crear: el personal activo, los días (u horas) desde el ingreso y los porcentajes de la empresa y del convenio', () => {
    // Un ayudante del taller que ingresó el 10 de mayo: cobra las horas de 21 días del mes.
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
    expect(lines).toHaveLength(12)
    // El oficial, de Madera: por hora, con los porcentajes de su convenio.
    expect(lineOf(doc.id, 2)).toMatchObject({
      agreement_id: agreement('MADERA').id,
      pay_basis: 'HOURLY',
      seniority_years: 12,
      days_worked: 0,
      hours_worked: 176,
      attendance_pct: 10,
      union_pct: 2,
      gross: 1539507.2,
      net: 1247000.83,
    })
    // El chofer, de Camioneros: por mes, sin presentismo y con el 3 % para el sindicato.
    expect(lineOf(doc.id, 11)).toMatchObject({
      pay_basis: 'MONTHLY',
      days_worked: 30,
      seniority: 69000,
      attendance: 0,
      gross: 1219000,
      union_dues: 36570,
      union_contribution: 24380,
    })
    // La encargada, fuera de convenio: el sueldo pactado, sin adicionales ni sindicato.
    expect(lineOf(doc.id, 1)).toMatchObject({
      agreement_id: agreement('FUERA').id,
      gross: 1500000,
      union_dues: 0,
      union_contribution: 0,
    })
    expect(lineOf(doc.id, 12)).toMatchObject({ days_worked: 0, hours_worked: 123.2, seniority_years: 0, basic: 665280 })
    expect(doc.subtotal).toBe(Math.round(lines.reduce((s, l) => s + l.gross, 0) * 100) / 100)
    expect(doc.total).toBe(Math.round(lines.reduce((s, l) => s + l.net, 0) * 100) / 100)
    expect(db.audit.at(-1)!.summary).toBe('Creó LIQ-00001: sueldos de 05/2027 (12 empleados)')
    expect(db.tasks.filter((t) => t.document_id === doc.id).map((t) => t.title)).toEqual([
      'Enviar LIQ-00001 a autorizar',
    ])
    expect(listDocuments(db, userId('tesoreria'), companyId(), 'PAYROLL')[0]).toMatchObject({
      summary: 'Sueldos de 05/2027',
      line_count: 12,
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
    const nunez = lineOf(id, 4)
    const none = { days_worked: 0, hours_worked: 0, absence_days: 0, overtime_50: 0, overtime_100: 0 }
    cmdUpdatePayrollLines(ctx('rrhh'), id, [
      { ...none, line_id: ortiz.id, hours_worked: 160, absence_days: 2, overtime_50: 4 },
      { ...none, line_id: nunez.id, days_worked: 28, absence_days: 2, overtime_50: 4 },
    ])
    // Por hora: 160 horas sin asistencia y 4 horas al 50 % (7.952 × 1,5 × 4 = 47.712).
    expect(lineOf(id, 2)).toMatchObject({
      hours_worked: 160,
      basic: 1136000,
      attendance: 0,
      overtime: 47712,
      gross: 1320032,
    })
    // Por mes: 28 días sin presentismo y 4 horas al 50 % ((1.050.000 + 94.500) / 200 × 1,5 × 4 = 34.335).
    expect(lineOf(id, 4)).toMatchObject({
      days_worked: 28,
      basic: 980000,
      attendance: 0,
      overtime: 34335,
      gross: 1102535,
    })
    expect(byNumber('LIQ-00001').subtotal).toBe(
      Math.round(payrollLines(db, id).reduce((s, l) => s + l.gross, 0) * 100) / 100,
    )
    const update = (lines: Parameters<typeof cmdUpdatePayrollLines>[2]) =>
      expectBusinessError(() => cmdUpdatePayrollLines(ctx('rrhh'), id, lines), 'DATO_INVALIDO')
    const monthly = { ...none, line_id: nunez.id, days_worked: 30 }
    expect(update([{ ...monthly, days_worked: 29, absence_days: 2 }])).toBe(
      'Los días trabajados y las ausencias de Núñez, Patricia son enteros que juntos no pasan de 30.',
    )
    update([{ ...monthly, days_worked: 31 }])
    update([{ ...monthly, days_worked: 29.5 }])
    const base = { ...none, line_id: ortiz.id, hours_worked: 176 }
    expect(update([{ ...base, hours_worked: 301 }])).toBe(
      'Las horas trabajadas de Ortiz, Ramón van de 0 a 300, con hasta 2 decimales.',
    )
    update([{ ...base, hours_worked: 160.555 }])
    expect(update([{ ...base, absence_days: 31 }])).toBe(
      'Las ausencias sin aviso de Ortiz, Ramón son un entero de 0 a 30.',
    )
    update([{ ...base, absence_days: 1.5 }])
    expect(update([{ ...base, overtime_50: 250 }])).toBe(
      'Las horas extra de Ortiz, Ramón van de 0 a 200, con hasta 2 decimales.',
    )
    update([{ ...base, overtime_100: 1.555 }])
    expect(update([{ ...base, line_id: 'otra' }])).toBe('Uno de los empleados no es de la liquidación.')
    expect(update([base, base])).toBe('Un empleado está dos veces: indicá sus novedades una sola vez.')
    expectBusinessError(() => cmdUpdatePayrollLines(ctx('contabilidad'), id, [base]), 'SIN_PERMISO')
  })

  it('autorizada: el asiento de sueldos separa el taller (mano de obra directa) del resto', () => {
    const { id } = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    authorize(id)
    const doc = byNumber('LIQ-00001')
    expect(doc.status).toBe('CONFIRMADA')
    expect(doc.py!.confirmed_at).not.toBeNull()
    const lines = payrollLines(db, id)
    const sum = (rows: typeof lines, value: (l: (typeof lines)[number]) => number) =>
      Math.round(rows.reduce((s, l) => s + value(l), 0) * 100) / 100
    const direct = lines.filter((l) => l.is_direct_labor)
    const others = lines.filter((l) => !l.is_direct_labor)
    expect(direct).toHaveLength(6)
    // Las contribuciones incluyen la del convenio; lo retenido y lo contribuido al sindicato, en su cuenta.
    expect(entriesOf(id)).toEqual([
      [
        `5.2.01.01 ${sum(others, (l) => l.gross)} 0`,
        `5.2.01.02 ${sum(others, (l) => l.employer + l.union_contribution)} 0`,
        `5.1.03.01 ${sum(direct, (l) => l.gross + l.employer + l.union_contribution)} 0`,
        `2.1.03.01 0 ${sum(lines, (l) => l.net)}`,
        `2.1.03.02 0 ${sum(lines, (l) => l.deductions - l.union_dues + l.employer)}`,
        `2.1.03.03 0 ${sum(lines, (l) => l.union_dues + l.union_contribution)}`,
      ],
    ])
    const view = documentDetail(db, userId('contabilidad'), companyId(), 'PAYROLL', 'LIQ-00001')!.payroll!
    expect(view).toMatchObject({
      period: '2027-05',
      net: doc.total,
      cost: sum(lines, (l) => l.gross + l.employer + l.union_contribution),
      direct_labor: sum(direct, (l) => l.gross + l.employer + l.union_contribution),
      union_dues: sum(lines, (l) => l.union_dues),
      union_contribution: sum(lines, (l) => l.union_contribution),
    })
    expect(view.lines[1]).toMatchObject({
      employee: { file_number: 2, last_name: 'Ortiz' },
      work_center: { code: 'CORTE' },
      agreement: { code: 'MADERA', union_name: 'UOMA' },
      pay_basis: 'HOURLY',
      hours_worked: 176,
    })
    // Confirmada, ya no se cambian las novedades.
    expectBusinessError(
      () =>
        cmdUpdatePayrollLines(ctx('rrhh'), id, [
          { line_id: lines[0].id, days_worked: 30, hours_worked: 0, absence_days: 0, overtime_50: 0, overtime_100: 0 },
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
    authorize(second.id)
    expectBusinessError(() => cmdCancelPayroll(ctx('rrhh'), second.id, ' '), 'MOTIVO_REQUERIDO')
    expectBusinessError(() => cmdCancelPayroll(ctx('tesoreria'), second.id, 'Error'), 'SIN_PERMISO')
    cmdCancelPayroll(ctx('rrhh'), second.id, 'Se liquidó con el básico viejo')
    expect(byNumber('LIQ-00002').status).toBe('ANULADA')
    expect(db.audit.at(-1)!.summary).toMatch(
      /^Anuló LIQ-00002: el contraasiento AS-\d+ revirtió el de sueldos — Se liquidó con el básico viejo$/,
    )
    expect(cmdCreatePayroll(ctx('rrhh'), companyId(), input()).display_number).toBe('LIQ-00003')
  })

  it('enviar a autorizar, devolver con el motivo y autorizar: decide Gerencia, con sus tareas', () => {
    const { id } = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    const doc = byNumber('LIQ-00001')
    const tasks = () => db.tasks.filter((t) => t.document_id === id && t.status === 'PENDIENTE').map((t) => t.title)
    expectBusinessError(() => cmdApprovePayroll(ctx('gerencia'), id, ''), 'TRANSICION_INVALIDA')
    expectBusinessError(() => cmdSubmitPayroll(ctx('tesoreria'), id), 'SIN_PERMISO')
    cmdSubmitPayroll(ctx('rrhh'), id)
    expect(doc.status).toBe('PENDIENTE_APROBACION')
    expect(db.audit.at(-1)!.summary).toBe(`Envió LIQ-00001 a autorizar: sueldos de 05/2027, ${money(doc.total)} netos`)
    expect(tasks()).toEqual([`Autorizar la liquidación LIQ-00001 por ${money(doc.total)}`])
    // Pendiente: no se cambian las novedades ni se anula, y RRHH no la autoriza.
    expectBusinessError(() => cmdUpdatePayrollLines(ctx('rrhh'), id, []), 'TRANSICION_INVALIDA')
    expectBusinessError(() => cmdCancelPayroll(ctx('rrhh'), id, 'Error de cálculo'), 'TRANSICION_INVALIDA')
    expectBusinessError(() => cmdApprovePayroll(ctx('rrhh'), id, ''), 'SIN_PERMISO')
    expect(documentDetail(db, userId('gerencia'), companyId(), 'PAYROLL', 'LIQ-00001')!.actions).toMatchObject([
      { action: 'APPROVE', label: 'Autorizar', enabled: true },
      { action: 'REJECT', label: 'Devolver a RRHH', enabled: true, requires_comment: true },
    ])
    // Gerencia la devuelve con el motivo: vuelve a borrador, con la tarea de RRHH.
    expectBusinessError(() => cmdRejectPayroll(ctx('gerencia'), id, ' '), 'MOTIVO_REQUERIDO')
    cmdRejectPayroll(ctx('gerencia'), id, 'Faltan las horas extra del taller')
    expect(doc).toMatchObject({ status: 'BORRADOR', status_reason: 'Faltan las horas extra del taller' })
    expect(db.audit.at(-1)!.summary).toBe('Devolvió LIQ-00001 a RRHH — Faltan las horas extra del taller')
    expect(tasks()).toEqual(['Enviar LIQ-00001 a autorizar'])
    expect(documentDetail(db, userId('rrhh'), companyId(), 'PAYROLL', 'LIQ-00001')!.next_step).toEqual({
      who: 'RRHH',
      text: 'Gerencia la devolvió: "Faltan las horas extra del taller". Corregir las novedades y volver a enviarla a autorizar.',
    })
    expect(entriesOf(id)).toEqual([])
    // Se envía de nuevo y Gerencia la autoriza: se registra el asiento y Tesorería recibe la tarea.
    cmdSubmitPayroll(ctx('rrhh'), id)
    cmdApprovePayroll(ctx('gerencia'), id, 'Revisada con los partes del taller')
    expect(doc.status).toBe('CONFIRMADA')
    expect(doc.py!.confirmed_at).not.toBeNull()
    expect(db.audit.find((e) => e.document_id === id && e.action === 'APPROVE')!.summary).toBe(
      `Autorizó LIQ-00001: sueldos de 05/2027, ${money(doc.total)} netos a pagar — Revisada con los partes del taller`,
    )
    expect(entriesOf(id)).toHaveLength(1)
    expect(tasks()).toEqual([`Pagar los sueldos de LIQ-00001 por ${money(doc.total)}`])
  })

  it('SoD-11: quien preparó la liquidación no la autoriza ni la devuelve (salvo que el docente apague la regla)', () => {
    const ger = db.sectors.find((s) => s.company_id === companyId() && s.code === 'GER')!.id
    cmdAssignRole(ctx('docente'), companyId(), userId('rrhh'), 'GERENCIA', ger)
    const { id } = cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    cmdSubmitPayroll(ctx('rrhh'), id)
    const action = (name: string) =>
      documentDetail(db, userId('rrhh'), companyId(), 'PAYROLL', 'LIQ-00001')!.actions.find((a) => a.action === name)
    expect(action('APPROVE')).toMatchObject({
      enabled: false,
      reason: 'Separación de funciones: no podés autorizar ni devolver una liquidación que preparaste vos.',
    })
    expect(action('REJECT')).toMatchObject({ enabled: false })
    expect(expectBusinessError(() => cmdApprovePayroll(ctx('rrhh'), id, ''), 'SEPARACION_FUNCIONES')).toBe(
      'No podés autorizar ni devolver una liquidación que preparaste vos.',
    )
    expectBusinessError(() => cmdRejectPayroll(ctx('rrhh'), id, 'Revisar las horas'), 'SEPARACION_FUNCIONES')
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { sod_enabled: false })
    cmdApprovePayroll(ctx('rrhh'), id, '')
    expect(byNumber('LIQ-00001').status).toBe('CONFIRMADA')
  })

  it('los porcentajes legales los cambia el docente y los del convenio, RRHH; la liquidación conserva los suyos', () => {
    const before = cmdCreatePayroll(ctx('rrhh'), companyId(), input({ period: '2027-04', payment_date: '2027-05-05' }))
    cmdSaveLaborAgreement(ctx('rrhh'), companyId(), { ...agreement('MADERA'), union_pct: 3 })
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
    expect(lineOf(after.id, 2)).toMatchObject({ employer: 307901.44, union_pct: 3, union_dues: 46185.22 })
    expect(byNumber(before.display_number).py!.rates.employer_pct).toBe(24)
    expect(lineOf(before.id, 2).union_pct).toBe(2)
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
    expect(upgraded.postingRules.filter((r) => r.company_id === company && r.event === 'SUELDOS')).toHaveLength(6)
  })

  it('al actualizar una base guardada (v17), las liquidaciones de antes quedan por mes, con sus porcentajes y sin sindicato', () => {
    cmdCreatePayroll(ctx('rrhh'), companyId(), input())
    const stored = structuredClone(db)
    stored.pyLines = stored.pyLines.map(
      ({
        agreement_id: _a,
        pay_basis: _b,
        seniority_pct: _c,
        attendance_pct: _d,
        union_pct: _e,
        union_employer_pct: _f,
        hours_worked: _g,
        union_dues: _h,
        union_contribution: _i,
        ...line
      }) => line as DB['pyLines'][number],
    )
    const upgraded = upgradeDatabase({ ...stored, version: 17 })!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.pyLines[0]).toMatchObject({
      agreement_id: null,
      pay_basis: 'MONTHLY',
      seniority_pct: 1,
      attendance_pct: 8.33,
      union_pct: 0,
      union_employer_pct: 0,
      hours_worked: 0,
      union_dues: 0,
      union_contribution: 0,
    })
  })
})

describe('pago de sueldos y cargas sociales (Fase 6c)', () => {
  const account = (code: string) => db.accounts.find((a) => a.company_id === companyId() && a.code === code)!.id
  const bank = () => account('1.1.01.03')
  const pending = (docId: string) =>
    db.tasks.filter((t) => t.document_id === docId && t.status === 'PENDIENTE').map((t) => t.title)
  const total = (docId: string, value: (l: ReturnType<typeof payrollLines>[number]) => number) =>
    round2(payrollLines(db, docId).reduce((s, l) => s + value(l), 0))
  /** Las cargas sociales: lo de la seguridad social y lo de los sindicatos. */
  const charges = (docId: string) => total(docId, (l) => l.deductions + l.employer + l.union_contribution)

  /** Una liquidación de mayo confirmada con dos empleados (los demás, sin días): alcanza el banco de la demo. */
  function confirmed(username = 'rrhh') {
    const { id } = cmdCreatePayroll(ctx(username), companyId(), input())
    cmdUpdatePayrollLines(
      ctx(username),
      id,
      payrollLines(db, id)
        .slice(2)
        .map((l) => ({
          line_id: l.id,
          days_worked: 0,
          hours_worked: 0,
          absence_days: 0,
          overtime_50: 0,
          overtime_100: 0,
        })),
    )
    authorize(id, username)
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
    // El de sueldos y, después, los dos pagos: cada deuda contra el banco (las cargas, con lo de los sindicatos).
    expect(entriesOf(id).slice(1)).toEqual([
      [`2.1.03.01 ${doc.total} 0`, `1.1.01.03 0 ${doc.total}`],
      [
        `2.1.03.02 ${total(id, (l) => l.deductions - l.union_dues + l.employer)} 0`,
        `2.1.03.03 ${total(id, (l) => l.union_dues + l.union_contribution)} 0`,
        `1.1.01.03 0 ${charges(id)}`,
      ],
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
    authorize(id)
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
        direct
          .filter((l) => l.work_center_id === corte.work_center!.id)
          .reduce((s, l) => s + l.gross + l.employer + l.union_contribution, 0),
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
    ).toEqual(['CARGAS_SOCIALES_A_PAGAR', 'SINDICATOS_A_PAGAR', 'SUELDOS_A_PAGAR'])
    expect(upgraded.documents.find((d) => d.py)!.py).toMatchObject({ salaries_paid_on: null, charges_account_id: null })
  })
})
