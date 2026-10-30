import { describe, expect, it } from 'vitest'
import type { DocumentListItem, EmployeeRow, StockRow, TreasuryAccountRow } from '@/lib/api'
import type { AuditEvent, Vehicle } from '@/lib/domain/types'
import {
  bankBalance,
  fiscoInfo,
  packages,
  parkedVehicles,
  PLACES,
  PLACE_IDS,
  productShape,
  replaySteps,
  routeTrucks,
  ROUTES,
  staffFigures,
  stockPiles,
  trucks,
  workInProgress,
} from './twin-model'

function doc(
  partial: Partial<DocumentListItem> & Pick<DocumentListItem, 'id' | 'doc_type' | 'status'>,
): DocumentListItem {
  return {
    sector_name: 'Compras',
    display_number: partial.id,
    summary: '',
    line_count: 0,
    total: 0,
    ...partial,
  } as DocumentListItem
}

function event(partial: Partial<AuditEvent> & Pick<AuditEvent, 'id' | 'occurred_at'>): AuditEvent {
  return { document_id: 'oc', actor_sector_name: 'Compras', ...partial } as AuditEvent
}

function stock(
  code: string,
  type: string,
  qty: number,
  opts: { reserved?: number; name?: string; category?: string; uom?: string; min?: number } = {},
): StockRow {
  return {
    product: {
      id: code,
      code,
      name: opts.name ?? code,
      category: opts.category ?? '',
      product_type: type,
      uom_code: opts.uom ?? 'UN',
      min_stock: opts.min ?? 0,
    },
    warehouse: { id: 'w' },
    qty,
    reserved: opts.reserved ?? 0,
    total_qty: qty,
    below_min: false,
  } as unknown as StockRow
}

function employee(id: string, sector: string, opts: { status?: string; center?: string } = {}): EmployeeRow {
  return {
    id,
    first_name: 'Ana',
    last_name: id,
    status: opts.status ?? 'ACTIVO',
    category: { name: 'Oficial' },
    sector: { code: sector },
    work_center: opts.center ? { code: opts.center, name: opts.center } : null,
  } as unknown as EmployeeRow
}

describe('gemelo digital: planta', () => {
  it('no superpone sectores en el piso', () => {
    for (const [i, a] of PLACE_IDS.entries()) {
      for (const b of PLACE_IDS.slice(i + 1)) {
        const pa = PLACES[a]
        const pb = PLACES[b]
        const apart = Math.abs(pa.x - pb.x) >= (pa.w + pb.w) / 2 || Math.abs(pa.z - pb.z) >= (pa.d + pb.d) / 2
        expect(apart, `${a} y ${b}`).toBe(true)
      }
    }
  })

  it('sólo traza caminos entre lugares que existen, también hacia el banco y el fisco', () => {
    for (const route of ROUTES) {
      expect(PLACES[route.from]).toBeDefined()
      expect(PLACES[route.to]).toBeDefined()
    }
    expect(ROUTES.filter((r) => r.to === 'FIS').map((r) => [r.from, r.kind])).toEqual([
      ['IMP', 'paper'],
      ['TES', 'money'],
    ])
  })
})

describe('gemelo digital: el personal', () => {
  it('una figura por empleado activo en su sector; el chofer en camino va en el camión', () => {
    const route = doc({ id: 'hr', doc_type: 'ROUTE_SHEET', status: 'EN_CAMINO', rs: { driver_id: 'chofer' } as never })
    const figures = staffFigures(
      [
        employee('ger', 'GER'),
        employee('corte', 'PRO', { center: 'CORTE' }),
        employee('dep', 'DEP'),
        employee('baja', 'VEN', { status: 'BAJA' }),
        employee('chofer', 'LOG'),
        employee('otro', 'XXX'),
      ],
      [route],
    )
    expect(figures.map((f) => [f.id, f.place, f.station])).toEqual([
      ['ger', 'GER', null],
      ['corte', 'PRO', 'CORTE'],
      ['dep', 'DEP_PT', null],
    ])
    expect(figures[1].tip).toBe('corte, Ana · Oficial · CORTE')
    expect(staffFigures([employee('chofer', 'LOG')], []).map((f) => f.place)).toEqual(['LOG'])
  })
})

describe('gemelo digital: el transporte', () => {
  const sheets = [
    doc({
      id: 'hr1',
      doc_type: 'ROUTE_SHEET',
      status: 'EN_CAMINO',
      summary: 'CAM-01 (AF 512 MS) con Walter Aguirre',
      line_count: 2,
      rs: { vehicle_id: 'cam', driver_id: 'w' } as never,
    }),
    doc({
      id: 'hr2',
      doc_type: 'ROUTE_SHEET',
      status: 'BORRADOR',
      summary: 'TR-001 Transportes Ruta 12 SRL',
      line_count: 1,
      rs: { carrier_id: 'tr' } as never,
    }),
    doc({ id: 'hr3', doc_type: 'ROUTE_SHEET', status: 'CERRADA', rs: {} as never }),
  ]

  it('las órdenes de compra enviadas llegan en camión; los remitos en preparación son bultos', () => {
    const docs = [
      doc({ id: 'oc1', doc_type: 'PURCHASE_ORDER', status: 'ENVIADO' }),
      doc({ id: 'oc2', doc_type: 'PURCHASE_ORDER', status: 'APROBADO' }),
      doc({ id: 'rem', doc_type: 'DELIVERY_NOTE', status: 'BORRADOR' }),
      doc({ id: 'rem2', doc_type: 'DELIVERY_NOTE', status: 'CONFIRMADO' }),
    ]
    expect(trucks(docs).map((t) => [t.docId, t.direction])).toEqual([['oc1', 'in']])
    expect(packages(docs).map((p) => p.docId)).toEqual(['rem'])
  })

  it('las hojas de ruta abiertas son camiones: cargando o en camino, propios o de un transportista', () => {
    expect(routeTrucks(sheets).map((t) => [t.docId, t.moving, t.own, t.stops, t.transport])).toEqual([
      ['hr1', true, true, 2, 'CAM-01 (AF 512 MS) con Walter Aguirre'],
      ['hr2', false, false, 1, 'TR-001 Transportes Ruta 12 SRL'],
    ])
  })

  it('el vehículo propio que no sale espera estacionado', () => {
    const vehicles = [
      { id: 'cam', code: 'CAM-01', plate: 'AF 512 MS', is_active: true },
      { id: 'util', code: 'UTIL-01', plate: 'AG 300 MS', is_active: true },
      { id: 'viejo', code: 'CAM-00', plate: 'AA 000 AA', is_active: false },
    ] as Vehicle[]
    expect(parkedVehicles(vehicles, sheets)).toEqual([{ id: 'util', label: 'UTIL-01 (AG 300 MS)' }])
  })
})

describe('gemelo digital: el banco y el fisco', () => {
  it('el banco muestra el saldo de las cuentas bancarias', () => {
    const account = (name: string, balance: number, is_active = true) =>
      ({ account: { name, is_active }, balance }) as TreasuryAccountRow
    expect(
      bankBalance([account('Caja', 500), account('Banco cuenta corriente', 12000), account('Banco viejo', 9, false)]),
    ).toBe(12000)
  })

  it('el fisco muestra las declaraciones presentadas que falta pagar y el vencimiento más próximo', () => {
    const tax = (id: string, status: string, total: number, due: string) =>
      doc({ id, doc_type: 'TAX_RETURN', status, total, tr: { due_date: due } as never })
    expect(
      fiscoInfo([
        tax('iva', 'PRESENTADA', 1000, '2027-06-20'),
        tax('iibb', 'PRESENTADA', 300, '2027-06-15'),
        tax('vieja', 'PAGADA', 50, '2027-05-20'),
      ]),
    ).toEqual({ pending: 2, amount: 1300, nextDue: '2027-06-15' })
    expect(fiscoInfo([])).toEqual({ pending: 0, amount: 0, nextDue: null })
  })
})

describe('gemelo digital: los productos', () => {
  it('cada producto tiene su forma, por el nombre y la categoría', () => {
    const shape = (name: string, category = '') => productShape({ name, category })
    expect([
      shape('Mesa de comedor de pino 1,60 m'),
      shape('Silla de eucalipto'),
      shape('Placard de MDF 2 puertas'),
      shape('Cama 2 plazas de eucalipto'),
      shape('Colchón 2 plazas (reventa)'),
      shape('Tabla de pino elliottis 1" × 6"'),
      shape('Tirante de pino 2" × 3"'),
      shape('Tablero de pino finger joint 18 mm', 'Placas y tableros'),
      shape('Barniz poliuretánico'),
      shape('Cola vinílica para madera'),
      shape('Bisagra cazoleta 35 mm'),
      shape('Film stretch para embalaje'),
      shape('Lija grano 120', 'Adhesivos y terminación'),
    ]).toEqual([
      'table',
      'chair',
      'wardrobe',
      'bed',
      'mattress',
      'planks',
      'planks',
      'boards',
      'cans',
      'cans',
      'hardware',
      'rolls',
      'box',
    ])
  })

  it('los muebles y las placas se ven uno por unidad hasta el tope; lo demás, según el doble del mínimo', () => {
    const piles = stockPiles([
      stock('PT-002', 'PRODUCTO_TERMINADO', 22, { name: 'Silla de eucalipto' }),
      stock('PT-001', 'PRODUCTO_TERMINADO', 3, { name: 'Mesa de comedor', reserved: 1 }),
      stock('MP-001', 'MATERIA_PRIMA', 1200, { name: 'Tabla de pino', uom: 'PIE', min: 800 }),
      stock('MP-004', 'MATERIA_PRIMA', 15, { name: 'Placa MDF 18 mm', min: 20 }),
      stock('IN-002', 'INSUMO', 18, { name: 'Barniz poliuretánico', uom: 'L', min: 15 }),
      stock('IN-004', 'INSUMO', 240, { name: 'Bisagra cazoleta 35 mm', min: 100 }),
      stock('IN-007', 'INSUMO', 4, { name: 'Film stretch', uom: 'ROL' }),
      stock('IN-008', 'INSUMO', 8, { name: 'Cinta de embalar', uom: 'ROL' }),
      stock('PT-003', 'PRODUCTO_TERMINADO', 0, { name: 'Placard de MDF' }),
    ])
    expect(piles.map((p) => [p.code, p.place, p.shape, p.units, p.more, p.reserved])).toEqual([
      ['PT-002', 'DEP_PT', 'chair', 8, 14, false],
      ['PT-001', 'DEP_PT', 'table', 3, 0, true],
      // 1.200 pies contra 1.600 (el doble del mínimo): 3/4 de la altura.
      ['MP-001', 'DEP_MP', 'planks', 5, 0, false],
      ['MP-004', 'DEP_MP', 'boards', 12, 3, false],
      ['IN-002', 'DEP_MP', 'cans', 4, 0, false],
      // Más del doble del mínimo: la altura llega al tope.
      ['IN-004', 'DEP_MP', 'hardware', 6, 0, false],
      // Sin mínimo: contra el que más tiene de su forma.
      ['IN-007', 'DEP_MP', 'rolls', 3, 0, false],
      ['IN-008', 'DEP_MP', 'rolls', 6, 0, false],
      ['PT-003', 'DEP_PT', 'wardrobe', 0, 0, false],
    ])
  })

  it('en Producción se ve lo que se está fabricando, con su forma y su cantidad', () => {
    const order = (id: string, status: string, summary: string, quantity: number) =>
      doc({ id, doc_type: 'PRODUCTION_ORDER', status, summary, pd: { quantity } as never })
    expect(
      workInProgress([
        order('o1', 'EN_PROCESO', 'PT-002 Silla de eucalipto', 10),
        order('o2', 'LIBERADA', 'PT-001 Mesa de comedor', 2),
      ]).map((w) => [w.docId, w.shape, w.quantity, w.units, w.more]),
    ).toEqual([['o1', 'chair', 10, 8, 2]])
  })
})

describe('gemelo digital: recorridos', () => {
  it('arma el recorrido del documento en orden y en el sector de quien actuó', () => {
    const oc = doc({ id: 'oc', doc_type: 'PURCHASE_ORDER', status: 'APROBADO' })
    const steps = replaySteps(oc, [
      event({ id: 2, occurred_at: '2026-10-02T10:00:00Z', actor_sector_name: 'Gerencia' }),
      event({ id: 1, occurred_at: '2026-10-01T10:00:00Z' }),
      event({ id: 3, occurred_at: '2026-10-03T10:00:00Z', document_id: 'otro' }),
      event({ id: 4, occurred_at: '2026-10-04T10:00:00Z', actor_sector_name: '—' }),
    ])
    expect(steps.map((s) => [s.event?.id, s.place])).toEqual([
      [1, 'COM'],
      [2, 'GER'],
      [4, 'COM'],
    ])
  })

  it('termina en el sector donde el documento espera hoy', () => {
    const op = doc({ id: 'oc', doc_type: 'PAYMENT_ORDER', status: 'PENDIENTE_APROBACION' })
    const steps = replaySteps(op, [
      event({ id: 1, occurred_at: '2026-10-01T10:00:00Z', actor_sector_name: 'Contabilidad' }),
    ])
    expect(steps.map((s) => [s.event?.id ?? null, s.place])).toEqual([
      [1, 'CON'],
      [null, 'GER'],
    ])
  })
})
