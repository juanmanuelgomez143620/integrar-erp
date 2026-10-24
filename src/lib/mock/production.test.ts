// Pruebas de las listas de materiales, los centros de trabajo y las órdenes de producción (docs/FASE_5_PRODUCCION_Y_COSTOS.md §2 a §4)
// sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  bomLinesOf,
  bomOperationsOf,
  cmdCancelProductionOrder,
  cmdCreateCompanyFromTemplate,
  cmdCreateCourse,
  cmdCreateProductionOrder,
  cmdFinishProductionOrder,
  cmdIssueProductionOrder,
  cmdReleaseProductionOrder,
  cmdSaveBom,
  cmdSaveWorkCenter,
  cmdSetBomActive,
  cmdSetWorkCenterActive,
  cmdUpdateCompanySettings,
  onHandQuantity,
  productionOrderLines,
  productionOrderOperations,
  reservedQuantity,
  type Ctx,
  type ProductionOrderInput,
} from './engine'
import { bomDetail, documentDetail, listBoms, listWorkCenters, productionCatalog, productionCosts } from './queries'
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
const product = (code: string) => db.products.find((p) => p.company_id === companyId() && p.code === code)!
const warehouse = (code: string) => db.warehouses.find((w) => w.company_id === companyId() && w.code === code)!
const codeOf = (productId: string) => db.products.find((p) => p.id === productId)!.code

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

const order = (code: string, quantity: number, over: Partial<ProductionOrderInput> = {}): ProductionOrderInput => ({
  product_id: product(code).id,
  quantity,
  materials_warehouse_id: warehouse('DEP-MP').id,
  output_warehouse_id: warehouse('DEP-PT').id,
  due_date: '2027-05-20',
  notes: '',
  ...over,
})

const center = (code: string) => db.workCenters.find((w) => w.company_id === companyId() && w.code === code)!

const bom = (code: string, lines: [string, number][], notes = '', operations: [string, number][] = []) => ({
  product_id: product(code).id,
  notes,
  lines: lines.map(([c, quantity]) => ({ component_id: product(c).id, quantity })),
  operations: operations.map(([c, hours]) => ({ work_center_id: center(c).id, hours })),
})

/** Las horas que tiene hoy la lista de un producto, como [centro, horas]. */
const operationsOf = (code: string) =>
  bomOperationsOf(db, db.boms.find((b) => b.product_id === product(code).id)!.id).map(
    (o) => [db.workCenters.find((w) => w.id === o.work_center_id)!.code, o.hours] as [string, number],
  )

/** Los asientos automáticos de un documento, con sus importes por cuenta. */
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

describe('listas de materiales', () => {
  it('la demo trae las de los cuatro muebles, con el costo estimado de sus materiales', () => {
    const rows = listBoms(db, userId('produccion'), companyId())
    expect(rows.map((r) => [r.product.code, r.components, r.material_cost, r.conversion_cost])).toEqual([
      ['PT-001', 8, 188950, 70000],
      ['PT-002', 6, 39490, 22800],
      ['PT-003', 6, 255800, 54000],
      ['PT-004', 8, 234350, 55200],
    ])
    const detail = bomDetail(db, userId('deposito'), companyId(), 'PT-002')!
    expect(detail.lines.map((l) => `${l.component.code} ${l.quantity} ${l.line_cost}`)).toEqual([
      'MP-002 18 28800',
      'IN-001 0.1 650',
      'IN-002 0.4 7200',
      'IN-003 0.04 560',
      'IN-006 2 1800',
      'IN-007 0.03 480',
    ])
    // Las horas por centro, a las tarifas de cada uno: 39.490 de materiales y 22.800 de conversión.
    expect(detail.operations.map((o) => `${o.work_center.code} ${o.hours} ${o.cost}`)).toEqual([
      'CORTE 0.6 9600',
      'ARMADO 0.6 7200',
      'TERMINACION 0.5 6000',
    ])
    expect(detail.conversion_cost).toBe(22800)
    // La orden de la demo (diez sillas, liberada).
    expect(detail.open_orders).toBe(1)
    expect(bomDetail(db, userId('produccion'), companyId(), 'MP-001')).toBeNull()
    expect(() => listBoms(db, userId('ventas'), companyId())).toThrow()
  })

  it('Producción la modifica o la desactiva; las órdenes ya cargadas no cambian', () => {
    const silla = db.boms.find((b) => b.product_id === product('PT-002').id)!
    const audits = db.audit.length
    // Igual a la que hay: no cambia nada ni queda en la auditoría.
    cmdSaveBom(
      ctx('produccion'),
      companyId(),
      bom(
        'PT-002',
        bomLinesOf(db, silla.id).map((l) => [codeOf(l.component_id), l.quantity]),
        '',
        operationsOf('PT-002'),
      ),
    )
    expect(db.audit).toHaveLength(audits)
    cmdSaveBom(
      ctx('produccion'),
      companyId(),
      bom(
        'PT-002',
        [
          ['MP-002', 18],
          ['IN-002', 0.5],
        ],
        'Con más barniz',
        [['ARMADO', 1]],
      ),
    )
    expect(bomLinesOf(db, silla.id).map((l) => `${codeOf(l.component_id)} ${l.quantity}`)).toEqual([
      'MP-002 18',
      'IN-002 0.5',
    ])
    expect(operationsOf('PT-002')).toEqual([['ARMADO', 1]])
    expect(db.audit.at(-1)!.summary).toBe(
      'Modificó la lista de materiales de PT-002 Silla de eucalipto (2 componentes y 1 centro de trabajo)',
    )
    expect(productionOrderLines(db, byNumber('OPR-00001').id)).toHaveLength(6)
    // Desactivada, no se planifican órdenes de ese producto.
    cmdSetBomActive(ctx('produccion'), companyId(), silla.id, false)
    expect(productionCatalog(db, userId('produccion'), companyId()).map((p) => p.code)).toEqual([
      'PT-001',
      'PT-003',
      'PT-004',
    ])
    expectBusinessError(
      () => cmdCreateProductionOrder(ctx('produccion'), companyId(), order('PT-002', 1), false),
      'DATO_INVALIDO',
    )
  })

  it('validaciones: el producto, los componentes, las cantidades y quién la arma', () => {
    const save = (username: string, input: ReturnType<typeof bom>) =>
      expectBusinessError(
        () => cmdSaveBom(ctx(username), companyId(), input),
        username === 'ventas' ? 'SIN_PERMISO' : 'DATO_INVALIDO',
      )
    // Sólo los productos terminados tienen lista; los componentes son materias primas e insumos.
    save('produccion', bom('MR-001', [['MP-001', 1]]))
    save('produccion', bom('PT-002', [['PT-001', 1]]))
    save('produccion', bom('PT-002', [['SV-001', 1]]))
    save(
      'produccion',
      bom('PT-002', [
        ['MP-002', 1],
        ['MP-002', 2],
      ]),
    )
    save('produccion', bom('PT-002', [['MP-002', 0]]))
    save('produccion', bom('PT-002', [['MP-002', 0.0005]]))
    save('produccion', bom('PT-002', []))
    save('ventas', bom('PT-002', [['MP-002', 1]]))
    // Las horas: centros repetidos, en cero o con cuatro decimales.
    save(
      'produccion',
      bom('PT-002', [['MP-002', 1]], '', [
        ['CORTE', 1],
        ['CORTE', 2],
      ]),
    )
    save('produccion', bom('PT-002', [['MP-002', 1]], '', [['CORTE', 0]]))
    save('produccion', bom('PT-002', [['MP-002', 1]], '', [['CORTE', 0.0005]]))
  })

  it('una empresa creada desde la plantilla copia sus listas, con sus propios productos', () => {
    const course = cmdCreateCourse(ctx('admin'), { academic_year: 2027, name: '6.º B', orientation: 'Gestión' })
    const { id } = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course })
    const boms = db.boms.filter((b) => b.company_id === id)
    expect(boms).toHaveLength(4)
    const lines = db.bomLines.filter((l) => boms.some((b) => b.id === l.bom_id))
    expect(lines).toHaveLength(28)
    for (const l of lines) expect(db.products.find((p) => p.id === l.component_id)!.company_id).toBe(id)
    // Y sus centros de trabajo, con las horas de cada lista.
    expect(db.workCenters.filter((w) => w.company_id === id).map((w) => w.code)).toEqual([
      'CORTE',
      'ARMADO',
      'TERMINACION',
    ])
    const operations = db.bomOperations.filter((o) => boms.some((b) => b.id === o.bom_id))
    expect(operations).toHaveLength(12)
    for (const o of operations) expect(db.workCenters.find((w) => w.id === o.work_center_id)!.company_id).toBe(id)
  })

  it('al actualizar una base guardada (v11), cada empresa recibe las listas y las reglas de producción', () => {
    // Una base guardada antes de la Fase 5: sin las colecciones de producción ni las cuentas de la conversión.
    const {
      boms: _boms,
      bomLines: _bomLines,
      prdLines: _prdLines,
      workCenters: _workCenters,
      bomOperations: _bomOperations,
      prdOperations: _prdOperations,
      ...v11
    } = structuredClone(db)
    const stored = { ...v11, version: 11 } as DB
    const events = ['CONSUMO_PRODUCCION', 'CONVERSION_PRODUCCION', 'PRODUCCION_TERMINADA']
    stored.documents = stored.documents.filter((d) => d.doc_type !== 'PRODUCTION_ORDER')
    stored.postingRules = stored.postingRules.filter((r) => !events.includes(r.event))
    stored.accounts = stored.accounts.filter((a) => !a.code.startsWith('5.1.02'))
    const upgraded = upgradeDatabase(stored)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.boms).toHaveLength(4)
    expect(upgraded.prdLines).toEqual([])
    expect(upgraded.postingRules.filter((r) => events.includes(r.event))).toHaveLength(8)
    expect(upgraded.accounts.filter((a) => a.code.startsWith('5.1.02')).map((a) => a.code)).toEqual([
      '5.1.02',
      '5.1.02.01',
      '5.1.02.02',
    ])
    expect(upgraded.workCenters).toHaveLength(3)
    expect(upgraded.bomOperations).toHaveLength(12)
  })
})

describe('orden de producción', () => {
  it('planificar, liberar (reserva), entregar (consume al promedio) y terminar (ingresa al costo real)', () => {
    const created = cmdCreateProductionOrder(ctx('produccion'), companyId(), order('PT-001', 5), false)
    const doc = byNumber(created.display_number)
    expect(created.display_number).toBe('OPR-00002')
    expect(doc.status).toBe('BORRADOR')
    const lines = productionOrderLines(db, doc.id)
    expect(lines.map((l) => `${codeOf(l.product_id)} ${l.quantity_planned} ${l.planned_unit_cost}`)).toEqual([
      'MP-007 5 105000',
      'MP-003 120 1400',
      'MP-001 50 1300',
      'IN-001 1.5 6500',
      'IN-002 7.5 18000',
      'IN-003 0.5 14000',
      'IN-006 30 900',
      'IN-007 0.5 16000',
    ])
    // Lo previsto: 944.750 de materiales y 350.000 de conversión (70.000 por mesa).
    expect(doc.total).toBe(1294750)
    expect(
      productionOrderOperations(db, doc.id).map(
        (o) => `${db.workCenters.find((w) => w.id === o.work_center_id)!.code} ${o.hours_planned}`,
      ),
    ).toEqual(['CORTE 12.5', 'ARMADO 7.5', 'TERMINACION 5'])

    // Liberar: alcanza y reserva los materiales; Depósito recibe la tarea.
    cmdReleaseProductionOrder(ctx('produccion'), doc.id)
    expect(doc.status).toBe('LIBERADA')
    expect(reservedQuantity(db, product('MP-007').id, warehouse('DEP-MP').id)).toBe(5)
    expect(db.tasks.filter((t) => t.document_id === doc.id && t.status === 'PENDIENTE').map((t) => t.title)).toEqual([
      'Entregar los materiales de OPR-00002',
    ])

    // Depósito entrega: cinco pies más de tirante (desperdicio) y dos lijas menos.
    const issued = (code: string, planned: number) => (code === 'MP-003' ? 125 : code === 'IN-006' ? 28 : planned)
    cmdIssueProductionOrder(ctx('deposito'), doc.id, {
      lines: lines.map((l) => ({ line_id: l.id, quantity: issued(codeOf(l.product_id), l.quantity_planned) })),
    })
    expect(doc.status).toBe('EN_PROCESO')
    expect(reservedQuantity(db, product('MP-007').id, warehouse('DEP-MP').id)).toBe(0)
    expect(onHandQuantity(db, product('MP-007').id, warehouse('DEP-MP').id)).toBe(1)
    expect(
      db.stockMovements.filter((m) => m.document_id === doc.id).map((m) => `${m.movement_type} ${m.quantity}`),
    ).toContain('CONSUMO_PRODUCCION -125')
    // Productos en proceso al debe; materias primas e insumos al haber, al costo promedio.
    expect(entriesOf(doc.id)).toEqual([['1.1.05.03 949950 0', '1.1.05.01 0 765000', '1.1.05.02 0 184950']])

    // Terminar: salieron bien 4 de 5, con las horas previstas; cada una cuesta lo
    // consumido más la conversión (216.250 de mano de obra y 133.750 de carga fabril), dividido 4.
    cmdFinishProductionOrder(ctx('produccion'), doc.id, 4)
    expect(doc.status).toBe('TERMINADA')
    expect(doc.pd).toMatchObject({ quantity_produced: 4, unit_cost: 324987.5 })
    expect(onHandQuantity(db, product('PT-001').id, warehouse('DEP-PT').id)).toBe(10)
    const balance = db.stockBalances.find(
      (b) => b.product_id === product('PT-001').id && b.warehouse_id === warehouse('DEP-PT').id,
    )!
    expect(balance.avg_unit_cost).toBe(285995)
    // La conversión aplicada a productos en proceso; después, el pase a productos terminados.
    expect(entriesOf(doc.id).slice(1)).toEqual([
      ['1.1.05.03 350000 0', '5.1.02.01 0 216250', '5.1.02.02 0 133750'],
      ['1.1.05.04 1299950 0', '1.1.05.03 0 1299950'],
    ])
    expect(
      db.notifications.filter((n) => n.document_id === doc.id && n.type === 'PRODUCCION_TERMINADA').map((n) => n.title),
    ).toContain('Ingresaron 4 UN de PT-001')
    const view = documentDetail(db, userId('contabilidad'), companyId(), 'PRODUCTION_ORDER', 'OPR-00002')!
    expect(view.production_order).toMatchObject({
      planned_cost: 1294750,
      planned_material_cost: 944750,
      planned_conversion_cost: 350000,
      material_cost: 949950,
      labor_cost: 216250,
      overhead_cost: 133750,
      unit_cost: 324987.5,
      standard_cost: 260000,
    })
    expect(view.next_step.text).toMatch(/a \$\s324\.987,50 por unidad/)
    // Una orden terminada no se anula.
    expectBusinessError(
      () => cmdCancelProductionOrder(ctx('produccion'), doc.id, 'Me equivoqué'),
      'TRANSICION_INVALIDA',
    )
  })

  it('falta de materiales: no se libera y dice qué falta; con stock negativo permitido, sí', () => {
    // Diez placards: llevan 20 placas de MDF y hay 8.
    const { id } = cmdCreateProductionOrder(ctx('produccion'), companyId(), order('PT-003', 10), false)
    const message = expectBusinessError(() => cmdReleaseProductionOrder(ctx('produccion'), id), 'STOCK_INSUFICIENTE')
    expect(message).toContain('MP-004 necesita 20 UN y hay 8 UN disponibles')
    const detail = documentDetail(db, userId('produccion'), companyId(), 'PRODUCTION_ORDER', 'OPR-00002')!
    expect(detail.actions.find((a) => a.action === 'RELEASE')).toMatchObject({ enabled: false })
    expect(detail.next_step.text).toMatch(/^Faltan materiales: MP-004 necesita 20 UN/)
    // Lo reservado por otra orden también cuenta: la demo reservó 180 pies de eucalipto para las sillas.
    const camas = cmdCreateProductionOrder(ctx('produccion'), companyId(), order('PT-004', 13), false)
    expect(
      expectBusinessError(() => cmdReleaseProductionOrder(ctx('produccion'), camas.id), 'STOCK_INSUFICIENTE'),
    ).toContain(
      'MP-002 necesita 780 PIE y hay 720 PIE disponibles (900 PIE en el depósito y 180 PIE reservados para otras órdenes)',
    )
    cmdUpdateCompanySettings(ctx('docente'), companyId(), { allow_negative_stock: true })
    cmdReleaseProductionOrder(ctx('produccion'), id)
    expect(byNumber('OPR-00002').status).toBe('LIBERADA')
  })

  it('anular: la planificada sin más; la que está en proceso devuelve los materiales con contraasiento', () => {
    const draft = cmdCreateProductionOrder(ctx('produccion'), companyId(), order('PT-002', 2), false)
    expectBusinessError(() => cmdCancelProductionOrder(ctx('produccion'), draft.id, ''), 'MOTIVO_REQUERIDO')
    cmdCancelProductionOrder(ctx('produccion'), draft.id, 'Se planificó de más')
    expect(byNumber(draft.display_number).status).toBe('ANULADA')

    // La orden de la demo: Depósito entrega y después se anula.
    const demo = byNumber('OPR-00001')
    const before = onHandQuantity(db, product('MP-002').id, warehouse('DEP-MP').id)
    cmdIssueProductionOrder(ctx('deposito'), demo.id, {
      lines: productionOrderLines(db, demo.id).map((l) => ({ line_id: l.id, quantity: l.quantity_planned })),
    })
    expect(onHandQuantity(db, product('MP-002').id, warehouse('DEP-MP').id)).toBe(before - 180)
    cmdCancelProductionOrder(ctx('produccion'), demo.id, 'Se rompió la máquina')
    expect(demo.status).toBe('ANULADA')
    expect(onHandQuantity(db, product('MP-002').id, warehouse('DEP-MP').id)).toBe(before)
    // El consumo y su contraasiento.
    const entries = db.docLinks
      .filter((l) => l.from_document_id === demo.id)
      .map((l) => db.documents.find((d) => d.id === l.to_document_id)!)
      .filter((d) => d.doc_type === 'JOURNAL_ENTRY')
    expect(entries.map((e) => `${e.je!.origin} ${e.status}`)).toEqual(['AUTOMATICO ANULADO'])
    const reversal = db.docLinks.find((l) => l.from_document_id === entries[0].id)!
    expect(db.documents.find((d) => d.id === reversal.to_document_id)!.je!.origin).toBe('CONTRAASIENTO')
    expect(db.audit.at(-1)!.summary).toMatch(
      /^Anuló OPR-00001: los materiales volvieron a Depósito de materias primas e insumos y el contraasiento AS-\d+ revirtió el consumo — Se rompió la máquina$/,
    )
  })

  it('cada sector hace lo suyo, y las cantidades se controlan', () => {
    const demo = byNumber('OPR-00001')
    const all = (quantity: (planned: number) => number) => ({
      lines: productionOrderLines(db, demo.id).map((l) => ({ line_id: l.id, quantity: quantity(l.quantity_planned) })),
    })
    expectBusinessError(
      () => cmdCreateProductionOrder(ctx('ventas'), companyId(), order('PT-002', 1), false),
      'SIN_PERMISO',
    )
    expectBusinessError(
      () =>
        cmdIssueProductionOrder(
          ctx('produccion'),
          demo.id,
          all((q) => q),
        ),
      'SIN_PERMISO',
    )
    expectBusinessError(
      () =>
        cmdIssueProductionOrder(
          ctx('deposito'),
          demo.id,
          all(() => 0),
        ),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () =>
        cmdIssueProductionOrder(
          ctx('deposito'),
          demo.id,
          all(() => -1),
        ),
      'DATO_INVALIDO',
    )
    // Más de lo que hay disponible.
    expectBusinessError(
      () =>
        cmdIssueProductionOrder(
          ctx('deposito'),
          demo.id,
          all((q) => q * 1000),
        ),
      'STOCK_INSUFICIENTE',
    )
    cmdIssueProductionOrder(
      ctx('deposito'),
      demo.id,
      all((q) => q),
    )
    expectBusinessError(() => cmdFinishProductionOrder(ctx('deposito'), demo.id, 10), 'SIN_PERMISO')
    expectBusinessError(() => cmdFinishProductionOrder(ctx('produccion'), demo.id, 11), 'DATO_INVALIDO')
    expectBusinessError(() => cmdFinishProductionOrder(ctx('produccion'), demo.id, 0), 'DATO_INVALIDO')
    // La planificación: cantidad, fecha y depósitos.
    for (const input of [
      order('PT-002', 0),
      order('PT-002', 1.0005),
      order('PT-002', 1, { due_date: '2027-05-13' }),
      order('PT-002', 1, { due_date: '2027-06-31' }),
      order('PT-002', 1, { materials_warehouse_id: crypto.randomUUID() }),
      order('MP-001', 1),
    ])
      expectBusinessError(() => cmdCreateProductionOrder(ctx('produccion'), companyId(), input, false), 'DATO_INVALIDO')
  })
})

describe('centros de trabajo y costos de conversión', () => {
  it('la demo trae tres centros; Producción los crea, modifica y desactiva', () => {
    expect(listWorkCenters(db, userId('contabilidad'), companyId()).map((w) => `${w.code} ${w.boms}`)).toEqual([
      'ARMADO 4',
      'CORTE 4',
      'TERMINACION 4',
    ])
    const { id } = cmdSaveWorkCenter(ctx('produccion'), companyId(), {
      id: '',
      code: 'pintura',
      name: 'Pintura',
      labor_rate: 7500,
      overhead_rate: 2500.5,
    })
    expect(db.audit.at(-1)!.summary).toMatch(
      /^Creó el centro de trabajo PINTURA Pintura: \$\s7\.500,00 de mano de obra/,
    )
    const audits = db.audit.length
    // Sin cambios no queda en la auditoría.
    cmdSaveWorkCenter(ctx('produccion'), companyId(), {
      id,
      code: 'PINTURA',
      name: 'Pintura',
      labor_rate: 7500,
      overhead_rate: 2500.5,
    })
    expect(db.audit).toHaveLength(audits)
    cmdSaveWorkCenter(ctx('produccion'), companyId(), {
      id,
      code: 'PINTURA',
      name: 'Pintura y laqueado',
      labor_rate: 8000,
      overhead_rate: 2500.5,
    })
    expect(db.audit.at(-1)!.changes).toEqual({
      name: { from: 'Pintura', to: 'Pintura y laqueado' },
      labor_rate: { from: 7500, to: 8000 },
    })
    // Desactivado, no va en las listas nuevas.
    cmdSetWorkCenterActive(ctx('produccion'), companyId(), id, false)
    expectBusinessError(
      () => cmdSaveBom(ctx('produccion'), companyId(), bom('PT-002', [['MP-002', 18]], '', [['PINTURA', 0.2]])),
      'DATO_INVALIDO',
    )
    // Controles: quién, código, nombre y tarifas.
    const save = (username: string, over: Record<string, unknown>) =>
      expectBusinessError(
        () =>
          cmdSaveWorkCenter(ctx(username), companyId(), {
            id: '',
            code: 'NUEVO',
            name: 'Nuevo centro',
            labor_rate: 1000,
            overhead_rate: 500,
            ...over,
          }),
        username === 'produccion' ? 'DATO_INVALIDO' : 'SIN_PERMISO',
      )
    save('contabilidad', {})
    save('produccion', { code: 'CON ESPACIOS' })
    save('produccion', { code: 'CORTE' })
    save('produccion', { name: 'X' })
    save('produccion', { labor_rate: -1 })
    save('produccion', { overhead_rate: 10.005 })
  })

  it('terminar con las horas reales: la conversión se aplica con las tarifas de la orden', () => {
    const demo = byNumber('OPR-00001')
    cmdIssueProductionOrder(ctx('deposito'), demo.id, {
      lines: productionOrderLines(db, demo.id).map((l) => ({ line_id: l.id, quantity: l.quantity_planned })),
    })
    // Las tarifas cambian después de planificarla: la orden usa las suyas.
    const corte = center('CORTE')
    cmdSaveWorkCenter(ctx('produccion'), companyId(), { ...corte, labor_rate: 20000 })
    const operations = productionOrderOperations(db, demo.id)
    expect(operations.map((o) => `${o.hours_planned} ${o.labor_rate} ${o.overhead_rate}`)).toEqual([
      '6 9000 7000',
      '6 8500 3500',
      '5 8000 4000',
    ])
    const finish = (hours: { operation_id: string; hours: number }[]) =>
      cmdFinishProductionOrder(ctx('produccion'), demo.id, 10, hours)
    expectBusinessError(() => finish([{ operation_id: 'otra', hours: 1 }]), 'DATO_INVALIDO')
    expectBusinessError(() => finish([{ operation_id: operations[0].id, hours: -1 }]), 'DATO_INVALIDO')
    expectBusinessError(
      () =>
        finish([
          { operation_id: operations[0].id, hours: 7 },
          { operation_id: operations[0].id, hours: 8 },
        ]),
      'DATO_INVALIDO',
    )
    // En corte se trabajaron 7 horas; en los demás, las previstas.
    finish([{ operation_id: operations[0].id, hours: 7 }])
    const view = documentDetail(
      db,
      userId('produccion'),
      companyId(),
      'PRODUCTION_ORDER',
      'OPR-00001',
    )!.production_order!
    expect(view.operations.map((o) => `${o.work_center.code} ${o.hours_planned} ${o.hours_actual}`)).toEqual([
      'CORTE 6 7',
      'ARMADO 6 6',
      'TERMINACION 5 5',
    ])
    // Mano de obra: 7 × 9.000 + 6 × 8.500 + 5 × 8.000; carga fabril: 7 × 7.000 + 6 × 3.500 + 5 × 4.000.
    expect(view).toMatchObject({ labor_cost: 154000, overhead_cost: 90000 })
    expect(view.unit_cost).toBe((view.material_cost + 154000 + 90000) / 10)
    // El informe de costos de producción del día.
    const rows = productionCosts(db, userId('contabilidad'), companyId(), '2027-05-14', '2027-05-14')
    expect(rows.map((r) => [r.order.display_number, r.product.code, r.quantity_produced, r.labor_cost])).toEqual([
      ['OPR-00001', 'PT-002', 10, 154000],
    ])
    expect(productionCosts(db, userId('contabilidad'), companyId(), '2027-05-15', '2027-05-31')).toEqual([])
    expect(() => productionCosts(db, userId('rrhh'), companyId(), '2027-05-01', '2027-05-31')).toThrow()
  })
})
