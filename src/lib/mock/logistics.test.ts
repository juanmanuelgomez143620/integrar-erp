// Pruebas de la logística (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §4): los transportistas
// y los vehículos propios, sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdCreateCompanyFromTemplate,
  cmdSaveCarrier,
  cmdSaveVehicle,
  cmdSetCarrierActive,
  cmdSetVehicleActive,
  type CarrierInput,
  type Ctx,
  type VehicleInput,
} from './engine'
import { listCarriers, listVehicles } from './queries'
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

const carrierInput = (over: Partial<CarrierInput> = {}): CarrierInput => ({
  id: '',
  code: 'TR-003',
  legal_name: 'Fletes del Alto Paraná SRL',
  tax_id: '30-00000112-7',
  phone: '3757 400000',
  ...over,
})

const vehicleInput = (over: Partial<VehicleInput> = {}): VehicleInput => ({
  id: '',
  code: 'UTIL-01',
  plate: 'af 300 ms',
  description: 'Utilitario para entregas chicas',
  ...over,
})

describe('transporte (Fase 7c.1)', () => {
  it('la demo trae los dos fletes y el camión; los ven Logística, Depósito, Gerencia y Auditoría', () => {
    expect(listCarriers(db, userId('deposito'), companyId()).map((c) => [c.code, c.tax_id, c.is_active])).toEqual([
      ['TR-001', '30-00000107-0', true],
      ['TR-002', '30-00000111-9', true],
    ])
    expect(listVehicles(db, userId('gerencia'), companyId()).map((v) => [v.code, v.plate])).toEqual([
      ['CAM-01', 'AF 512 MS'],
    ])
    expect(listCarriers(db, userId('auditor'), companyId())).toHaveLength(2)
    expect(() => listCarriers(db, userId('ventas'), companyId())).toThrow('Tu rol no tiene acceso')
  })

  it('transportistas: alta, cambios con auditoría, validaciones y desactivación', () => {
    const { id } = cmdSaveCarrier(ctx('deposito'), companyId(), carrierInput({ code: ' tr-003 ' }))
    expect(db.carriers.find((c) => c.id === id)).toMatchObject({ code: 'TR-003', is_active: true })
    expect(db.audit.at(-1)!.summary).toBe('Dio de alta el transportista TR-003 Fletes del Alto Paraná SRL')
    cmdSaveCarrier(ctx('deposito'), companyId(), carrierInput({ id, phone: '3757 411111' }))
    expect(db.audit.at(-1)).toMatchObject({
      action: 'UPDATE',
      changes: { phone: { from: '3757 400000', to: '3757 411111' } },
    })
    const save = (input: CarrierInput) =>
      expectBusinessError(() => cmdSaveCarrier(ctx('deposito'), companyId(), input), 'DATO_INVALIDO')
    expect(save(carrierInput({ code: 'TR-001' }))).toBe('Ya existe un transportista con el código TR-001.')
    expect(save(carrierInput({ code: 'TR 4' }))).toBe(
      'El código del transportista tiene de 1 a 12 letras, números o guiones.',
    )
    expect(save(carrierInput({ code: 'TR-004', legal_name: 'F' }))).toBe('La razón social tiene de 2 a 80 caracteres.')
    expect(save(carrierInput({ code: 'TR-004', tax_id: '30000001127' }))).toBe(
      'El CUIT debe tener el formato 30-12345678-9.',
    )
    expect(save(carrierInput({ code: 'TR-004', phone: '1'.repeat(41) }))).toBe('El teléfono tiene hasta 40 caracteres.')
    expect(save(carrierInput({ id: 'no-existe' }))).toBe('El transportista no existe.')
    for (const username of ['gerencia', 'ventas'])
      expectBusinessError(
        () => cmdSaveCarrier(ctx(username), companyId(), carrierInput({ code: 'TR-009' })),
        'SIN_PERMISO',
      )
    cmdSetCarrierActive(ctx('deposito'), companyId(), id, false)
    expect(db.audit.at(-1)!.summary).toBe('Desactivó el transportista TR-003 Fletes del Alto Paraná SRL')
    expect(listCarriers(db, userId('deposito'), companyId()).find((c) => c.id === id)!.is_active).toBe(false)
  })

  it('vehículos: el dominio en mayúsculas, sin repetirse; validaciones y desactivación', () => {
    const { id } = cmdSaveVehicle(ctx('deposito'), companyId(), vehicleInput({ plate: ' af  300   ms ' }))
    expect(db.vehicles.find((v) => v.id === id)).toMatchObject({ code: 'UTIL-01', plate: 'AF 300 MS' })
    expect(db.audit.at(-1)!.summary).toBe(
      'Dio de alta el vehículo UTIL-01 (AF 300 MS): Utilitario para entregas chicas',
    )
    const save = (input: VehicleInput) =>
      expectBusinessError(() => cmdSaveVehicle(ctx('deposito'), companyId(), input), 'DATO_INVALIDO')
    expect(save(vehicleInput({ code: 'CAM-01' }))).toBe('Ya existe un vehículo con el código CAM-01.')
    expect(save(vehicleInput({ code: 'UTIL-02', plate: 'AF 512 MS' }))).toBe(
      'Ya existe un vehículo con el dominio AF 512 MS.',
    )
    expect(save(vehicleInput({ code: 'UTIL-02', plate: 'AF-1' }))).toBe(
      'El dominio tiene de 6 a 9 letras, números o espacios (por ejemplo, AB 123 CD).',
    )
    expect(save(vehicleInput({ code: 'UTIL-02', plate: 'AB 999 ZZ', description: 'U' }))).toBe(
      'La descripción del vehículo tiene de 2 a 80 caracteres.',
    )
    cmdSaveVehicle(ctx('deposito'), companyId(), vehicleInput({ id, description: 'Utilitario (en el taller)' }))
    expect(db.audit.at(-1)).toMatchObject({ action: 'UPDATE', summary: 'Modificó el vehículo UTIL-01 (AF 300 MS)' })
    cmdSetVehicleActive(ctx('deposito'), companyId(), id, false)
    expect(db.vehicles.find((v) => v.id === id)!.is_active).toBe(false)
    expectBusinessError(() => cmdSetVehicleActive(ctx('gerencia'), companyId(), id, true), 'SIN_PERMISO')
  })

  it('la empresa de un curso copia el transporte de la plantilla', () => {
    const template = db.companies.find((c) => c.is_template)!
    const course = db.courses[0]
    const { id } = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course.id })
    expect(db.carriers.filter((c) => c.company_id === id).map((c) => c.code)).toEqual(
      db.carriers.filter((c) => c.company_id === template.id).map((c) => c.code),
    )
    expect(db.vehicles.filter((v) => v.company_id === id)).toHaveLength(1)
  })

  it('al actualizar una base guardada (v19), cada empresa recibe los fletes y el camión de la demo', () => {
    const { carriers: _carriers, vehicles: _vehicles, ...v19 } = structuredClone(db)
    const upgraded = upgradeDatabase({ ...v19, version: 19 } as DB)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.carriers.filter((c) => c.company_id === companyId())).toHaveLength(2)
    expect(upgraded.vehicles.filter((v) => v.company_id === companyId())).toHaveLength(1)
    // Una segunda vez no duplica nada.
    expect(upgradeDatabase({ ...upgraded, version: 19 })!.carriers).toHaveLength(upgraded.carriers.length)
  })
})
