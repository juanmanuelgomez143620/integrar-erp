// Pruebas de la logística (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §4): los transportistas,
// los vehículos propios y las hojas de ruta, sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  cmdCancelDeliveryNote,
  cmdCancelRouteSheet,
  cmdCloseRouteSheet,
  cmdConfirmDeliveryNote,
  cmdCreateCompanyFromTemplate,
  cmdCreateDeliveryNote,
  cmdCreateRouteSheet,
  cmdCreateSalesOrder,
  cmdDepartRouteSheet,
  cmdSaveCarrier,
  cmdSaveVehicle,
  cmdSetCarrierActive,
  cmdSetVehicleActive,
  deliveryStatus,
  routeSheetLines,
  type CarrierInput,
  type Ctx,
  type RouteSheetInput,
  type VehicleInput,
} from './engine'
import {
  documentDetail,
  listCarriers,
  listDocuments,
  listDrivers,
  listNotifications,
  listVehicles,
  routeSheetCandidates,
} from './queries'
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

describe('hojas de ruta (Fase 7c.2)', () => {
  const byNumber = (n: string) => db.documents.find((d) => d.company_id === companyId() && d.display_number === n)!
  const customer = (code: string) => db.customers.find((c) => c.company_id === companyId() && c.code === code)!
  const product = (code: string) => db.products.find((p) => p.company_id === companyId() && p.code === code)!
  const warehouse = (code: string) => db.warehouses.find((w) => w.company_id === companyId() && w.code === code)!
  const carrier = (code: string) => db.carriers.find((c) => c.company_id === companyId() && c.code === code)!
  const vehicle = (code: string) => db.vehicles.find((v) => v.company_id === companyId() && v.code === code)!
  const driver = () =>
    db.employees.find(
      (e) => e.company_id === companyId() && db.jobCategories.find((c) => c.id === e.category_id)?.code === 'CHOFER',
    )!

  /** Una silla vendida y despachada a un cliente: el remito queda pendiente de entrega. */
  const dispatched = (customerCode: string) => {
    const order = cmdCreateSalesOrder(
      ctx('ventas'),
      companyId(),
      {
        customer_id: customer(customerCode).id,
        warehouse_id: warehouse('DEP-PT').id,
        delivery_date: null,
        payment_terms_days: 30,
        customer_reference: '',
        notes: '',
        lines: [{ product_id: product('PT-002').id, quantity: 1, unit_price: 125000 }],
      },
      true,
    )
    return cmdCreateDeliveryNote(
      ctx('deposito'),
      companyId(),
      {
        sales_order_id: order.id,
        carrier_name: '',
        notes: '',
        lines: db.soLines.filter((l) => l.document_id === order.id).map((l) => ({ so_line_id: l.id, quantity: 1 })),
      },
      true,
    ).id
  }

  const sheet = (over: Partial<RouteSheetInput> = {}): RouteSheetInput => ({
    document_date: '2027-05-14',
    carrier_id: null,
    vehicle_id: vehicle('CAM-01').id,
    driver_id: driver().id,
    notes: '',
    delivery_note_ids: [],
    ...over,
  })

  let rem1: string
  let rem2: string
  let rem3: string
  beforeEach(() => {
    rem1 = byNumber('REM-00001').id
    cmdConfirmDeliveryNote(ctx('deposito'), rem1)
    rem2 = dispatched('CLI-002')
    rem3 = dispatched('CLI-003')
  })

  it('con el camión propio y su chofer: armar, salir y rendir; cada remito muestra su estado de entrega', () => {
    const candidates = routeSheetCandidates(db, userId('deposito'), companyId())
    expect(candidates.map((c) => [c.display_number, c.customer.code, c.last_attempt])).toEqual([
      ['REM-00001', 'CLI-001', null],
      ['REM-00002', 'CLI-002', null],
      ['REM-00003', 'CLI-003', null],
    ])
    expect(listDrivers(db, userId('deposito'), companyId()).map((d) => d.file_number)).toContain(driver().file_number)

    const { id, display_number } = cmdCreateRouteSheet(
      ctx('deposito'),
      companyId(),
      sheet({ delivery_note_ids: [rem2, rem1], notes: 'Salir temprano.' }),
    )
    expect(display_number).toBe('HR-00001')
    expect(routeSheetLines(db, id).map((l) => l.delivery_note_id)).toEqual([rem2, rem1])
    expect(deliveryStatus(db, rem1).status).toBe('PROGRAMADO')
    expect(routeSheetCandidates(db, userId('deposito'), companyId()).map((c) => c.display_number)).toEqual([
      'REM-00003',
    ])
    expect(db.audit.at(-1)!.summary).toBe(
      `Armó HR-00001 para el 14/05/2027: 2 remitos con CAM-01 (AF 512 MS) con ${driver().first_name} ${driver().last_name}`,
    )
    expect(db.tasks.find((t) => t.document_id === id && t.status === 'PENDIENTE')!.title).toBe('Salir con HR-00001')
    expect(documentDetail(db, userId('deposito'), companyId(), 'DELIVERY_NOTE', 'REM-00001')!.next_step.text).toBe(
      'Está en la hoja de ruta HR-00001, que todavía no salió.',
    )

    cmdDepartRouteSheet(ctx('deposito'), id)
    expect(db.documents.find((d) => d.id === id)!.status).toBe('EN_CAMINO')
    expect(deliveryStatus(db, rem2).status).toBe('EN_CAMINO')
    expect(db.tasks.find((t) => t.document_id === id && t.status === 'PENDIENTE')!.title).toBe('Rendir HR-00001')

    const [first, second] = routeSheetLines(db, id)
    const notified = listNotifications(db, userId('ventas'), companyId()).length
    cmdCloseRouteSheet(ctx('deposito'), id, [
      { line_id: first.id, delivered: false, received_by: '', reason: 'El local estaba cerrado' },
      { line_id: second.id, delivered: true, received_by: '  Juan Pérez ', reason: '' },
    ])
    expect(db.documents.find((d) => d.id === id)!.status).toBe('CERRADA')
    expect(db.audit.at(-1)!.summary).toBe('Rindió HR-00001: 1 de 2 remitos entregados')
    expect(deliveryStatus(db, rem1).status).toBe('ENTREGADO')
    expect(deliveryStatus(db, rem2).status).toBe('PENDIENTE')
    expect(listNotifications(db, userId('ventas'), companyId()).length).toBe(notified + 2)
    const delivered = documentDetail(db, userId('ventas'), companyId(), 'DELIVERY_NOTE', 'REM-00001')!
    expect(delivered.delivery).toMatchObject({
      delivery_status: 'ENTREGADO',
      route_sheet: { display_number: 'HR-00001' },
      outcome: 'ENTREGADO',
      received_by: 'Juan Pérez',
    })
    expect(delivered.next_step.text).toBe('Entregado con la hoja de ruta HR-00001: lo recibió Juan Pérez.')
    // El que no se entregó vuelve a estar pendiente, con el intento anterior.
    expect(
      routeSheetCandidates(db, userId('deposito'), companyId()).map((c) => [c.display_number, c.last_attempt]),
    ).toEqual([
      ['REM-00002', { display_number: 'HR-00001', reason: 'El local estaba cerrado' }],
      ['REM-00003', null],
    ])
    const view = documentDetail(db, userId('auditor'), companyId(), 'ROUTE_SHEET', 'HR-00001')!.route_sheet!
    expect(view.stops.map((s) => [s.delivery_note.display_number, s.outcome])).toEqual([
      ['REM-00002', 'NO_ENTREGADO'],
      ['REM-00001', 'ENTREGADO'],
    ])
    expect(view.driver!.file_number).toBe(driver().file_number)
    // Un remito entregado ya no se anula.
    expect(
      expectBusinessError(() => cmdCancelDeliveryNote(ctx('gerencia'), rem1, 'Error de carga'), 'TRANSICION_INVALIDA'),
    ).toBe('REM-00001 ya se entregó al cliente con HR-00001: no se anula.')
  })

  it('valida el transporte, la fecha y los remitos al armarla, y otra vez al salir', () => {
    const create = (over: Partial<RouteSheetInput>) =>
      expectBusinessError(
        () => cmdCreateRouteSheet(ctx('deposito'), companyId(), sheet({ delivery_note_ids: [rem1], ...over })),
        'DATO_INVALIDO',
      )
    expectBusinessError(
      () => cmdCreateRouteSheet(ctx('ventas'), companyId(), sheet({ delivery_note_ids: [rem1] })),
      'SIN_PERMISO',
    )
    expect(create({ document_date: '2027-05-13' })).toBe('La fecha de salida es hoy o un día posterior.')
    expect(create({ document_date: '2027-02-30' })).toBe('La fecha de salida no es válida.')
    expect(create({ vehicle_id: null, driver_id: null })).toBe(
      'Elegí con qué sale el reparto: un transportista o un vehículo propio con su chofer.',
    )
    expect(create({ carrier_id: carrier('TR-001').id })).toBe(
      'Elegí un transportista o un vehículo propio con su chofer, no los dos.',
    )
    expect(create({ driver_id: null })).toBe('Elegí el chofer: un empleado activo del legajo.')
    expect(create({ delivery_note_ids: [] })).toBe('Elegí los remitos despachados que lleva, en el orden de visita.')
    expect(create({ delivery_note_ids: [rem1, rem1] })).toBe('Un remito figura dos veces en la hoja.')
    expect(create({ delivery_note_ids: [byNumber('PV-00001').id] })).toBe('Uno de los remitos no existe.')
    cmdSetVehicleActive(ctx('deposito'), companyId(), vehicle('CAM-01').id, false)
    expect(create({})).toBe('El vehículo no existe o está desactivado.')

    // Con un transportista: el remito ya programado no entra en otra hoja.
    const viaCarrier = { carrier_id: carrier('TR-001').id, vehicle_id: null, driver_id: null }
    const { id } = cmdCreateRouteSheet(
      ctx('deposito'),
      companyId(),
      sheet({ ...viaCarrier, delivery_note_ids: [rem1, rem3] }),
    )
    expect(create({ ...viaCarrier, delivery_note_ids: [rem3] })).toBe('REM-00003 ya está en la hoja de ruta HR-00001.')
    // Al salir se controla otra vez el transporte.
    cmdSetCarrierActive(ctx('deposito'), companyId(), carrier('TR-001').id, false)
    expect(expectBusinessError(() => cmdDepartRouteSheet(ctx('deposito'), id), 'DATO_INVALIDO')).toBe(
      'El transportista no existe o está desactivado.',
    )
    cmdSetCarrierActive(ctx('deposito'), companyId(), carrier('TR-001').id, true)
    cmdDepartRouteSheet(ctx('deposito'), id)

    // Al rendir hace falta el resultado de cada remito, con quién lo recibió o por qué no.
    const [a, b] = routeSheetLines(db, id)
    const close = (outcomes: Parameters<typeof cmdCloseRouteSheet>[2]) =>
      expectBusinessError(() => cmdCloseRouteSheet(ctx('deposito'), id, outcomes), 'DATO_INVALIDO')
    expect(close([{ line_id: a.id, delivered: true, received_by: 'Ana López', reason: '' }])).toBe(
      'Indicá si REM-00003 se entregó o no.',
    )
    expect(
      close([
        { line_id: a.id, delivered: true, received_by: 'Al', reason: '' },
        { line_id: b.id, delivered: false, received_by: '', reason: 'Dirección equivocada' },
      ]),
    ).toBe('Indicá quién recibió REM-00001: nombre y apellido, de 3 a 80 caracteres.')
    expect(
      close([
        { line_id: a.id, delivered: true, received_by: 'Ana López', reason: '' },
        { line_id: b.id, delivered: false, received_by: '', reason: '' },
      ]),
    ).toBe('Indicá por qué no se entregó REM-00003: de 3 a 200 caracteres.')
    expect(
      close([
        { line_id: a.id, delivered: true, received_by: 'Ana López', reason: '' },
        { line_id: a.id, delivered: true, received_by: 'Ana López', reason: '' },
      ]),
    ).toBe('Indicá el resultado de cada remito de la hoja, una sola vez.')
  })

  it('anular: la hoja en preparación sí (sus remitos vuelven a estar pendientes); la que salió, no', () => {
    const { id } = cmdCreateRouteSheet(ctx('deposito'), companyId(), sheet({ delivery_note_ids: [rem1, rem2] }))
    // El remito programado no se anula: primero la hoja.
    expect(
      expectBusinessError(() => cmdCancelDeliveryNote(ctx('gerencia'), rem2, 'Error de carga'), 'TRANSICION_INVALIDA'),
    ).toBe('REM-00002 está en la hoja de ruta HR-00001: primero hay que rendirla o anularla.')
    expectBusinessError(() => cmdCancelRouteSheet(ctx('deposito'), id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelRouteSheet(ctx('deposito'), id, 'Se rompió el camión')
    expect(db.documents.find((d) => d.id === id)!.status).toBe('ANULADA')
    expect(deliveryStatus(db, rem1).status).toBe('PENDIENTE')
    const second = cmdCreateRouteSheet(ctx('deposito'), companyId(), sheet({ delivery_note_ids: [rem1] }))
    cmdDepartRouteSheet(ctx('deposito'), second.id)
    expectBusinessError(() => cmdCancelRouteSheet(ctx('deposito'), second.id, 'No sale'), 'TRANSICION_INVALIDA')
  })

  it('las ven Logística, Depósito, Ventas, Gerencia y Auditoría; los remitos a repartir y los choferes, sólo Logística', () => {
    cmdCreateRouteSheet(ctx('deposito'), companyId(), sheet({ delivery_note_ids: [rem1] }))
    for (const username of ['deposito', 'ventas', 'gerencia', 'auditor'])
      expect(listDocuments(db, userId(username), companyId(), 'ROUTE_SHEET').map((d) => d.summary)).toEqual([
        `CAM-01 (AF 512 MS) con ${driver().first_name} ${driver().last_name}`,
      ])
    expect(() => listDocuments(db, userId('contabilidad'), companyId(), 'ROUTE_SHEET')).toThrow(
      'Tu rol no tiene acceso',
    )
    expect(() => routeSheetCandidates(db, userId('ventas'), companyId())).toThrow('Tu rol no tiene acceso')
    expect(() => listDrivers(db, userId('gerencia'), companyId())).toThrow('Tu rol no tiene acceso')
  })
})
