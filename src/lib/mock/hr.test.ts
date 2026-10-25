// Pruebas de las categorías y los legajos del personal (docs/FASE_6_RRHH_Y_SUELDOS.md §2)
// sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdCreateCompanyFromTemplate,
  cmdCreateCourse,
  cmdSaveEmployee,
  cmdSaveJobCategory,
  cmdSaveWorkCenter,
  cmdSetJobCategoryActive,
  cmdSetWorkCenterActive,
  cmdTerminateEmployee,
  type Ctx,
  type EmployeeInput,
  type JobCategoryInput,
} from './engine'
import { listEmployees, listJobCategories } from './queries'
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
const category = (code: string) => db.jobCategories.find((c) => c.company_id === companyId() && c.code === code)!
const sector = (code: string) => db.sectors.find((s) => s.company_id === companyId() && s.code === code)!
const center = (code: string) => db.workCenters.find((w) => w.company_id === companyId() && w.code === code)!
const byFile = (n: number) => db.employees.find((e) => e.company_id === companyId() && e.file_number === n)!

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

const categoryInput = (over: Partial<JobCategoryInput> = {}): JobCategoryInput => ({
  id: '',
  code: 'LUSTRADOR',
  name: 'Lustrador',
  basic_salary: 1150000,
  is_direct_labor: true,
  ...over,
})

const employeeInput = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  id: '',
  first_name: 'Rubén',
  last_name: 'Acuña',
  hire_date: '2027-05-03',
  category_id: category('AYUDANTE').id,
  sector_id: sector('PRO').id,
  work_center_id: center('ARMADO').id,
  ...over,
})

describe('la demo', () => {
  it('trae las categorías y el personal: seis en el taller, cada uno en su centro', () => {
    expect(
      listJobCategories(db, userId('rrhh'), companyId()).map((c) => [
        c.code,
        c.basic_salary,
        c.is_direct_labor,
        c.employees,
      ]),
    ).toEqual([
      ['ADMIN', 1050000, false, 1],
      ['AYUDANTE', 950000, true, 1],
      ['ENCARGADO', 1500000, false, 1],
      ['MEDIO-OF', 1100000, true, 3],
      ['OFICIAL', 1250000, true, 2],
      ['OPERARIO', 980000, false, 1],
      ['VENDEDOR', 1000000, false, 1],
    ])
    const staff = listEmployees(db, userId('rrhh'), companyId())
    expect(staff).toHaveLength(10)
    expect(staff.map((e) => e.file_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // La antigüedad son los años cumplidos al día de hoy (14/05/2027).
    expect(staff.find((e) => e.file_number === 2)).toMatchObject({
      last_name: 'Ortiz',
      seniority_years: 12,
      category: { code: 'OFICIAL' },
      sector: { code: 'PRO' },
      work_center: { code: 'CORTE' },
      status: 'ACTIVO',
    })
    expect(staff.find((e) => e.file_number === 10)).toMatchObject({ last_name: 'Romero', seniority_years: 4 })
    for (const e of staff) expect(e.work_center !== null).toBe(e.category.is_direct_labor)
  })

  it('la empresa nueva de un curso copia el personal de la plantilla, con sus sectores y centros', () => {
    const course = cmdCreateCourse(ctx('admin'), { academic_year: 2027, name: '6.º B', orientation: 'Gestión' })
    const { id } = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course })
    expect(db.jobCategories.filter((c) => c.company_id === id)).toHaveLength(7)
    const staff = db.employees.filter((e) => e.company_id === id)
    expect(staff).toHaveLength(10)
    for (const e of staff) {
      expect(db.jobCategories.find((c) => c.id === e.category_id)!.company_id).toBe(id)
      expect(db.sectors.find((s) => s.id === e.sector_id)!.company_id).toBe(id)
      if (e.work_center_id) expect(db.workCenters.find((w) => w.id === e.work_center_id)!.company_id).toBe(id)
    }
  })

  it('al actualizar una base guardada (v13), cada empresa recibe el personal de la demo', () => {
    const { jobCategories: _categories, employees: _employees, ...v13 } = structuredClone(db)
    const stored = { ...v13, version: 13 } as DB
    const upgraded = upgradeDatabase(stored)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.jobCategories).toHaveLength(7)
    expect(upgraded.employees).toHaveLength(10)
    // Una segunda vez no duplica nada.
    expect(upgradeDatabase({ ...upgraded, version: 13 })!.employees).toHaveLength(10)
  })
})

describe('categorías', () => {
  it('alta, cambios con auditoría, validaciones y desactivación', () => {
    const { id } = cmdSaveJobCategory(ctx('rrhh'), companyId(), categoryInput({ code: ' lustrador ' }))
    const created = db.jobCategories.find((c) => c.id === id)!
    expect(created).toMatchObject({ code: 'LUSTRADOR', basic_salary: 1150000, is_direct_labor: true, is_active: true })
    expect(db.audit.at(-1)!.summary).toMatch(
      /^Creó la categoría LUSTRADOR Lustrador: sueldo básico de \$\s1\.150\.000,00, del taller$/,
    )
    // Sin cambios no se registra nada; con cambios, la auditoría guarda el antes y el después.
    const audits = db.audit.length
    cmdSaveJobCategory(ctx('rrhh'), companyId(), categoryInput({ id }))
    expect(db.audit).toHaveLength(audits)
    cmdSaveJobCategory(ctx('rrhh'), companyId(), categoryInput({ id, basic_salary: 1200000 }))
    expect(db.audit.at(-1)).toMatchObject({
      action: 'UPDATE',
      changes: { basic_salary: { from: 1150000, to: 1200000 } },
    })
    const save = (input: JobCategoryInput, username = 'rrhh') =>
      expectBusinessError(() => cmdSaveJobCategory(ctx(username), companyId(), input), 'DATO_INVALIDO')
    expect(save(categoryInput({ code: 'OFICIAL' }))).toBe('Ya existe una categoría con el código OFICIAL.')
    save(categoryInput({ code: 'con espacios' }))
    save(categoryInput({ name: 'L' }))
    save(categoryInput({ basic_salary: 0 }))
    save(categoryInput({ basic_salary: 1000.555 }))
    save(categoryInput({ id: 'no-existe' }))
    save(categoryInput({ is_direct_labor: 'sí' as unknown as boolean }))
    // Con personal activo, una categoría no deja de ser del taller (ni pasa a serlo).
    expect(save(categoryInput({ id: category('OFICIAL').id, code: 'OFICIAL', is_direct_labor: false }))).toContain(
      'tiene personal activo',
    )
    for (const username of ['produccion', 'contabilidad'])
      expectBusinessError(() => cmdSaveJobCategory(ctx(username), companyId(), categoryInput()), 'SIN_PERMISO')
    // Desactivada, no se asigna a nadie más.
    cmdSetJobCategoryActive(ctx('rrhh'), companyId(), id, false)
    expect(db.jobCategories.find((c) => c.id === id)!.is_active).toBe(false)
    expect(
      expectBusinessError(
        () => cmdSaveEmployee(ctx('rrhh'), companyId(), employeeInput({ category_id: id })),
        'DATO_INVALIDO',
      ),
    ).toBe('La categoría LUSTRADOR Lustrador está inactiva.')
  })
})

describe('legajos', () => {
  it('alta con el número siguiente, cambios, validaciones y baja', () => {
    const { id } = cmdSaveEmployee(ctx('rrhh'), companyId(), employeeInput())
    const employee = db.employees.find((e) => e.id === id)!
    expect(employee).toMatchObject({ file_number: 11, last_name: 'Acuña', status: 'ACTIVO' })
    expect(db.audit.at(-1)!.summary).toBe('Dio de alta el legajo 11: Acuña, Rubén (Ayudante de taller)')
    // Pasa a Medio oficial en Terminación.
    cmdSaveEmployee(
      ctx('rrhh'),
      companyId(),
      employeeInput({ id, category_id: category('MEDIO-OF').id, work_center_id: center('TERMINACION').id }),
    )
    expect(db.audit.at(-1)).toMatchObject({ action: 'UPDATE', summary: 'Modificó el legajo 11 (Acuña, Rubén)' })
    expect(Object.keys(db.audit.at(-1)!.changes!)).toEqual(['category_id', 'work_center_id'])

    const save = (input: EmployeeInput) =>
      expectBusinessError(() => cmdSaveEmployee(ctx('rrhh'), companyId(), input), 'DATO_INVALIDO')
    save(employeeInput({ first_name: 'R' }))
    save(employeeInput({ last_name: ' ' }))
    expect(save(employeeInput({ hire_date: '2027-02-30' }))).toBe('La fecha de ingreso no es válida.')
    expect(save(employeeInput({ hire_date: '2027-05-15' }))).toBe('La fecha de ingreso no puede ser posterior a hoy.')
    expect(save(employeeInput({ hire_date: '2015-03-01' }))).toBe(
      'La fecha de ingreso no puede ser anterior al inicio de actividades de la empresa (02/03/2015).',
    )
    expect(save(employeeInput({ category_id: '' }))).toBe('Elegí la categoría.')
    expect(save(employeeInput({ sector_id: '' }))).toBe('Elegí el sector.')
    expect(save(employeeInput({ work_center_id: null }))).toBe(
      'El personal del taller trabaja en un centro de trabajo: elegilo.',
    )
    expect(save(employeeInput({ category_id: category('ADMIN').id, sector_id: sector('CON').id }))).toBe(
      'Sólo el personal del taller tiene centro de trabajo.',
    )
    save(employeeInput({ id: 'no-existe' }))
    // Un centro inactivo no se asigna; quien ya está en él lo conserva.
    cmdSaveWorkCenter(ctx('produccion'), companyId(), {
      id: '',
      code: 'PINTURA',
      name: 'Pintura',
      labor_rate: 8000,
      overhead_rate: 3000,
    })
    cmdSetWorkCenterActive(ctx('produccion'), companyId(), center('PINTURA').id, false)
    expect(save(employeeInput({ work_center_id: center('PINTURA').id }))).toBe(
      'El centro de trabajo PINTURA Pintura está inactivo.',
    )
    cmdSetWorkCenterActive(ctx('produccion'), companyId(), center('TERMINACION').id, false)
    cmdSaveEmployee(
      ctx('rrhh'),
      companyId(),
      employeeInput({
        id,
        first_name: 'Rubén Darío',
        category_id: category('MEDIO-OF').id,
        work_center_id: center('TERMINACION').id,
      }),
    )
    expect(employee.first_name).toBe('Rubén Darío')

    // La baja: fecha y motivo; después el legajo ya no se modifica.
    const terminate = (date: string, reason: string) => cmdTerminateEmployee(ctx('rrhh'), companyId(), id, date, reason)
    expect(expectBusinessError(() => terminate('2027-05-01', 'Renuncia'), 'DATO_INVALIDO')).toBe(
      'La baja no puede ser anterior al ingreso (03/05/2027).',
    )
    expectBusinessError(() => terminate('2027-05-20', 'Renuncia'), 'DATO_INVALIDO')
    expectBusinessError(() => terminate('2027-13-01', 'Renuncia'), 'DATO_INVALIDO')
    expectBusinessError(() => terminate('2027-05-10', ' '), 'MOTIVO_REQUERIDO')
    expectBusinessError(
      () => cmdTerminateEmployee(ctx('contabilidad'), companyId(), id, '2027-05-10', 'Renuncia'),
      'SIN_PERMISO',
    )
    terminate('2027-05-10', 'Renuncia')
    expect(employee).toMatchObject({ status: 'BAJA', termination_date: '2027-05-10', termination_reason: 'Renuncia' })
    expect(db.audit.at(-1)!.summary).toBe('Dio de baja el legajo 11 (Acuña, Rubén Darío) el 10/05/2027 — Renuncia')
    expectBusinessError(() => terminate('2027-05-12', 'Otra vez'), 'TRANSICION_INVALIDA')
    expectBusinessError(() => cmdSaveEmployee(ctx('rrhh'), companyId(), employeeInput({ id })), 'TRANSICION_INVALIDA')
    // Ya no cuenta como personal activo de su categoría.
    expect(listJobCategories(db, userId('rrhh'), companyId()).find((c) => c.code === 'MEDIO-OF')!.employees).toBe(3)
    // La antigüedad de un legajo dado de baja es la del día de la baja.
    expect(listEmployees(db, userId('gerencia'), companyId()).find((e) => e.file_number === 11)).toMatchObject({
      status: 'BAJA',
      seniority_years: 0,
      termination_date: '2027-05-10',
    })
  })

  it('permisos: RRHH da de alta; Gerencia, Contabilidad y Auditoría consultan; los demás no ven los legajos', () => {
    for (const username of ['gerencia', 'contabilidad', 'auditor'])
      expect(listEmployees(db, userId(username), companyId())).toHaveLength(10)
    for (const username of ['produccion', 'ventas', 'compras1'])
      expect(() => listEmployees(db, userId(username), companyId())).toThrow()
    for (const username of ['gerencia', 'produccion'])
      expectBusinessError(() => cmdSaveEmployee(ctx(username), companyId(), employeeInput()), 'SIN_PERMISO')
    // El número de legajo sigue al último aunque haya bajas.
    cmdTerminateEmployee(ctx('rrhh'), companyId(), byFile(10).id, '2027-05-14', 'Fin del contrato')
    expect(cmdSaveEmployee(ctx('rrhh'), companyId(), employeeInput()).id).toBe(byFile(11).id)
  })
})
