// Pruebas de las listas de materiales y las órdenes de producción (docs/FASE_5_PRODUCCION_Y_COSTOS.md §2 y §3)
// sobre buildSeed() y los cmd*.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import {
  BusinessError,
  bomLinesOf,
  cmdCancelProductionOrder,
  cmdCreateCompanyFromTemplate,
  cmdCreateCourse,
  cmdCreateProductionOrder,
  cmdFinishProductionOrder,
  cmdIssueProductionOrder,
  cmdReleaseProductionOrder,
  cmdSaveBom,
  cmdSetBomActive,
  cmdUpdateCompanySettings,
  onHandQuantity,
  productionOrderLines,
  reservedQuantity,
  type Ctx,
  type ProductionOrderInput,
} from './engine'
import { bomDetail, documentDetail, listBoms, productionCatalog } from './queries'
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

const bom = (code: string, lines: [string, number][], notes = '') => ({
  product_id: product(code).id,
  notes,
  lines: lines.map(([c, quantity]) => ({ component_id: product(c).id, quantity })),
})

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
    expect(rows.map((r) => [r.product.code, r.components, r.material_cost])).toEqual([
      ['PT-001', 8, 188950],
      ['PT-002', 6, 39490],
      ['PT-003', 6, 255800],
      ['PT-004', 8, 234350],
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
      ),
    )
    expect(bomLinesOf(db, silla.id).map((l) => `${codeOf(l.component_id)} ${l.quantity}`)).toEqual([
      'MP-002 18',
      'IN-002 0.5',
    ])
    expect(db.audit.at(-1)!.summary).toBe(
      'Modificó la lista de materiales de PT-002 Silla de eucalipto (2 componentes)',
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
  })

  it('una empresa creada desde la plantilla copia sus listas, con sus propios productos', () => {
    const course = cmdCreateCourse(ctx('admin'), { academic_year: 2027, name: '6.º B', orientation: 'Gestión' })
    const { id } = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course })
    const boms = db.boms.filter((b) => b.company_id === id)
    expect(boms).toHaveLength(4)
    const lines = db.bomLines.filter((l) => boms.some((b) => b.id === l.bom_id))
    expect(lines).toHaveLength(28)
    for (const l of lines) expect(db.products.find((p) => p.id === l.component_id)!.company_id).toBe(id)
  })

  it('al actualizar una base guardada (v11), cada empresa recibe las listas y las reglas de producción', () => {
    // Una base guardada antes de la Fase 5a: sin las colecciones de producción.
    const { boms: _boms, bomLines: _bomLines, prdLines: _prdLines, ...v11 } = structuredClone(db)
    const stored = { ...v11, version: 11 } as DB
    stored.documents = stored.documents.filter((d) => d.doc_type !== 'PRODUCTION_ORDER')
    stored.postingRules = stored.postingRules.filter(
      (r) => r.event !== 'CONSUMO_PRODUCCION' && r.event !== 'PRODUCCION_TERMINADA',
    )
    const upgraded = upgradeDatabase(stored)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.boms).toHaveLength(4)
    expect(upgraded.prdLines).toEqual([])
    expect(
      upgraded.postingRules.filter((r) => r.event === 'CONSUMO_PRODUCCION' || r.event === 'PRODUCCION_TERMINADA'),
    ).toHaveLength(5)
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
    expect(doc.total).toBe(944750)

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

    // Terminar: salieron bien 4 de 5; cada una cuesta lo consumido dividido 4.
    cmdFinishProductionOrder(ctx('produccion'), doc.id, 4)
    expect(doc.status).toBe('TERMINADA')
    expect(doc.pd).toMatchObject({ quantity_produced: 4, unit_cost: 237487.5 })
    expect(onHandQuantity(db, product('PT-001').id, warehouse('DEP-PT').id)).toBe(10)
    const balance = db.stockBalances.find(
      (b) => b.product_id === product('PT-001').id && b.warehouse_id === warehouse('DEP-PT').id,
    )!
    expect(balance.avg_unit_cost).toBe(250995)
    expect(entriesOf(doc.id)[1]).toEqual(['1.1.05.04 949950 0', '1.1.05.03 0 949950'])
    expect(
      db.notifications.filter((n) => n.document_id === doc.id && n.type === 'PRODUCCION_TERMINADA').map((n) => n.title),
    ).toContain('Ingresaron 4 UN de PT-001')
    const view = documentDetail(db, userId('contabilidad'), companyId(), 'PRODUCTION_ORDER', 'OPR-00002')!
    expect(view.production_order).toMatchObject({ planned_cost: 944750, material_cost: 949950, unit_cost: 237487.5 })
    expect(view.next_step.text).toMatch(/a \$\s237\.487,50 por unidad/)
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
