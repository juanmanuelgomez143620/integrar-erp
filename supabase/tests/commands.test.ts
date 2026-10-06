// Paridad de comandos: la misma secuencia de operaciones en el motor simulado
// y, por el adaptador de la interfaz, en la base (RPC y Edge Function). Cada
// paso tiene que terminar igual en ambos lados —o fallar con el mismo código y
// el mismo mensaje— y, al final, todo lo que se lee (documentos, tareas,
// avisos, auditoría, stock y tablero) tiene que coincidir, textos incluidos.
//
// Los registros nuevos tienen ids y horas distintos en cada lado: los ids se
// comparan por orden de aparición y las horas por su orden relativo.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSupabaseBackend } from '../../src/lib/api/supabase'
import type { DocType } from '../../src/lib/domain/types'
import type { DB } from '../../src/lib/mock/db'
import * as E from '../../src/lib/mock/engine'
import * as Q from '../../src/lib/mock/queries'
import { DEMO_PASSWORD } from '../../src/lib/mock/seed'
import { project } from './support/compare'
import { createTestDb, type TestDb } from './support/db'
import { createFakeSupabase, PUBLIC_KEY, SUPABASE_URL, type FakeSupabase } from './support/fake-supabase'
import { loadMockDb, normalize, type LoadedMock } from './support/mock-loader'
import { buildScenario } from './support/scenario'

vi.setConfig({ testTimeout: 300_000 })

const DOMAIN = 'simulador.test'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

let db: TestDb
let fake: FakeSupabase
let mock: DB
let loaded: LoadedMock
let company: string
/** Todo lo que pasa después de esta hora es nuevo. */
let cutoff: string

type Backend = ReturnType<typeof createSupabaseBackend>
const sessions = new Map<string, Backend>()

async function pgAs(username: string): Promise<Backend> {
  let b = sessions.get(username)
  if (!b) {
    const items = new Map<string, string>()
    b = createSupabaseBackend({
      url: SUPABASE_URL,
      publishableKey: PUBLIC_KEY,
      emailDomain: DOMAIN,
      fetch: fake.fetch,
      storage: {
        getItem: (k) => items.get(k) ?? null,
        setItem: (k, v) => void items.set(k, v),
        removeItem: (k) => void items.delete(k),
      },
    })
    await b.auth.login(username, DEMO_PASSWORD)
    sessions.set(username, b)
  }
  return b
}

const mockId = (username: string) => mock.profiles.find((p) => p.username === username)!.id
const pg = (id: string) => loaded.pg(id)
const product = (code: string) => mock.products.find((p) => p.company_id === company && p.code === code)!
const supplier = (code: string) => mock.suppliers.find((s) => s.company_id === company && s.code === code)!.id
const warehouse = (code: string) => mock.warehouses.find((w) => w.company_id === company && w.code === code)!.id

type Outcome = { ok: true; value: unknown } | { ok: false; error: string }

const failure = (error: unknown): Outcome => ({
  ok: false,
  error: error instanceof E.BusinessError ? `${error.code}: ${error.message}` : `ERROR: ${(error as Error).message}`,
})

/**
 * Un paso: el mismo comando en ambos lados, como el mismo usuario. El
 * simulador corre sobre una copia (todo o nada, como en la aplicación).
 */
async function step<M, P>(
  label: string,
  username: string,
  onMock: (ctx: E.Ctx) => M,
  onPg: (b: Backend) => Promise<P>,
): Promise<{ mock: M; pg: P } | null> {
  const copy = structuredClone(mock)
  let m: Outcome
  try {
    m = { ok: true, value: onMock({ db: copy, userId: mockId(username), now: new Date().toISOString() }) }
    Object.assign(mock, copy)
  } catch (error) {
    m = failure(error)
  }
  let p: Outcome
  try {
    p = { ok: true, value: await onPg(await pgAs(username)) }
  } catch (error) {
    p = failure(error)
  }
  expect(p.ok ? 'ok' : p.error, label).toBe(m.ok ? 'ok' : m.error)
  return m.ok && p.ok ? { mock: m.value as M, pg: p.value as P } : null
}

/** Vincula un documento nuevo y sus líneas (por número de línea). */
async function linkDocument(mockDocId: string, pgDocId: string) {
  loaded.link(mockDocId, pgDocId)
  const tables: [string, { id: string; document_id: string; line_no: number }[]][] = [
    ['purchase_requisition_lines', mock.prLines],
    ['purchase_order_lines', mock.poLines],
    ['goods_receipt_lines', mock.grLines],
    ['stock_adjustment_lines', mock.saLines],
  ]
  for (const [table, lines] of tables) {
    const rows = await db.admin<{ id: string; line_no: number }>(
      `select id, line_no from public.${table} where document_id = $1`,
      [pgDocId],
    )
    for (const row of rows) {
      const line = lines.find((l) => l.document_id === mockDocId && l.line_no === row.line_no)
      if (line) loaded.link(line.id, row.id)
    }
  }
}

async function created(
  label: string,
  username: string,
  onMock: (ctx: E.Ctx) => { id: string; display_number: string },
  onPg: (b: Backend) => Promise<{ id: string; display_number: string }>,
) {
  const result = await step(label, username, onMock, onPg)
  expect(result, label).not.toBeNull()
  expect(result!.pg.display_number, label).toBe(result!.mock.display_number)
  await linkDocument(result!.mock.id, result!.pg.id)
  return result!.mock.id
}

/** Ids nuevos → "id#n" por orden de aparición; horas nuevas → "t#n" por orden cronológico. */
function canonical(value: unknown): unknown {
  const times = new Set<string>()
  const collect = (v: unknown): void => {
    if (typeof v === 'string' && TIMESTAMP.test(v) && v > cutoff) times.add(v)
    else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  collect(value)
  const rank = new Map([...times].sort().map((t, i) => [t, `t#${i + 1}`]))
  const ids = new Map<string, string>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (rank.has(v)) return rank.get(v)
      if (UUID.test(v)) {
        if (!ids.has(v)) ids.set(v, `id#${ids.size + 1}`)
        return ids.get(v)
      }
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}

/** Ordena los elementos creados en el mismo instante (su orden entre sí no está definido). */
function settle(list: unknown, key: (x: never) => string): unknown {
  if (!Array.isArray(list)) return list
  const mask = (x: unknown) => JSON.stringify(x).replace(/"[0-9a-f]{8}-[0-9a-f-]{27}"/gi, '"#"')
  return [...list].sort((a, b) => {
    const ka = key(a as never)
    const kb = key(b as never)
    if (ka !== kb) return 0
    return mask(a) < mask(b) ? -1 : mask(a) > mask(b) ? 1 : 0
  })
}

async function sameRead(
  label: string,
  username: string,
  real: (b: Backend) => Promise<unknown>,
  simulated: (userId: string) => unknown,
  ties?: (x: never) => string,
) {
  let want: unknown
  try {
    want = normalize(JSON.parse(JSON.stringify(simulated(mockId(username)) ?? null)))
  } catch {
    await expect(real(await pgAs(username)), label).rejects.toBeInstanceOf(E.BusinessError)
    return
  }
  let got = project(loaded.fromPg(await real(await pgAs(username))), want)
  if (ties) {
    want = settle(want, ties)
    got = settle(got, ties)
  }
  expect(canonical(got), label).toEqual(canonical(want))
}

beforeAll(async () => {
  mock = buildScenario()
  db = await createTestDb()
  loaded = await loadMockDb(db, mock)
  fake = createFakeSupabase(db, DOMAIN)
  for (const p of mock.profiles) fake.passwords.set(loaded.pg(p.id), DEMO_PASSWORD)
  company = mock.companies.find((c) => c.is_template)!.id
  // Las horas del escenario son anteriores a este momento.
  cutoff = new Date(Date.now() + 1000).toISOString()
  await new Promise((resolve) => setTimeout(resolve, 1100))
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('paridad de comandos', () => {
  it('compras: solicitudes, órdenes, aprobaciones, recepciones y ajustes', async () => {
    const companyPg = pg(company)
    const requisition = (lines: [string, number][], reason = 'Producción de la semana próxima') => ({
      needed_by: null,
      priority: 'NORMAL' as const,
      reason,
      notes: '',
      lines: lines.map(([code, quantity]) => ({ product_id: product(code).id, quantity })),
    })
    const pgRequisition = (input: ReturnType<typeof requisition>) => ({
      ...input,
      lines: input.lines.map((l) => ({ ...l, product_id: pg(l.product_id) })),
    })
    const order = (supplierCode: string, lines: [string, number, number, string | null][]): E.PurchaseOrderInput => ({
      supplier_id: supplier(supplierCode),
      expected_date: null,
      warehouse_id: warehouse('DEP-MP'),
      payment_terms_days: 30,
      delivery_terms: 'Puesto en planta',
      notes: '',
      lines: lines.map(([code, quantity, unit_price, requisition_line_id]) => ({
        product_id: product(code).id,
        requisition_line_id,
        quantity,
        unit_price,
        vat_rate: 21,
      })),
    })
    const pgOrder = (input: E.PurchaseOrderInput): E.PurchaseOrderInput => ({
      ...input,
      supplier_id: pg(input.supplier_id),
      warehouse_id: pg(input.warehouse_id),
      lines: input.lines.map((l) => ({
        ...l,
        product_id: pg(l.product_id),
        requisition_line_id: l.requisition_line_id && pg(l.requisition_line_id),
      })),
    })
    const both = <I>(make: () => I, toPg: (i: I) => I) => {
      const input = make()
      return { input, pgInput: toPg(input) }
    }

    // Solicitud enviada y otra en borrador que se modifica, se envía y se rechaza.
    const sc1 = await created(
      'SC enviada',
      'produccion',
      (c) =>
        E.cmdCreateRequisition(
          c,
          company,
          requisition([
            ['MP-002', 30],
            ['IN-001', 10],
          ]),
          true,
        ),
      (b) =>
        b.commands.createRequisition(
          companyPg,
          pgRequisition(
            requisition([
              ['MP-002', 30],
              ['IN-001', 10],
            ]),
          ),
          true,
        ),
    )
    const sc2 = await created(
      'SC en borrador',
      'produccion',
      (c) => E.cmdCreateRequisition(c, company, requisition([['IN-002', 4]]), false),
      (b) => b.commands.createRequisition(companyPg, pgRequisition(requisition([['IN-002', 4]])), false),
    )
    await step(
      'modificar SC',
      'produccion',
      (c) => E.cmdUpdateRequisition(c, sc2, requisition([['IN-002', 6]], 'Barniz para la línea nueva')),
      (b) =>
        b.commands.updateRequisition(
          pg(sc2),
          pgRequisition(requisition([['IN-002', 6]], 'Barniz para la línea nueva')),
        ),
    )
    await linkDocument(sc2, pg(sc2))
    await step(
      'enviar SC',
      'produccion',
      (c) => E.cmdSubmitRequisition(c, sc2),
      (b) => b.commands.submitRequisition(pg(sc2)),
    )
    expect(
      await step(
        'rechazar SC sin motivo',
        'compras1',
        (c) => E.cmdRejectRequisition(c, sc2, ''),
        (b) => b.commands.rejectRequisition(pg(sc2), ''),
      ),
    ).toBeNull()
    await step(
      'rechazar SC',
      'compras1',
      (c) => E.cmdRejectRequisition(c, sc2, 'Usen el barniz que sobró'),
      (b) => b.commands.rejectRequisition(pg(sc2), 'Usen el barniz que sobró'),
    )

    // OC parcial desde la SC: aprobación con separación de funciones, envío y recepciones.
    const line = mock.prLines.find((l) => l.document_id === sc1 && l.product_id === product('MP-002').id)!
    const oc1Input = both(() => order('PRV-001', [['MP-002', 20, 1600, line.id]]), pgOrder)
    const oc1 = await created(
      'OC desde la SC',
      'compras1',
      (c) => E.cmdCreatePurchaseOrder(c, company, oc1Input.input),
      (b) => b.commands.createPurchaseOrder(companyPg, oc1Input.pgInput),
    )
    await step(
      'enviar OC a aprobación',
      'compras1',
      (c) => E.cmdSubmitPurchaseOrder(c, oc1),
      (b) => b.commands.submitPurchaseOrder(pg(oc1)),
    )
    expect(
      await step(
        'aprobar la propia OC',
        'compras1',
        (c) => E.cmdApprovePurchaseOrder(c, oc1, 'ok'),
        (b) => b.commands.approvePurchaseOrder(pg(oc1), 'ok'),
      ),
    ).toBeNull()
    await step(
      'aprobar OC',
      'compras2',
      (c) => E.cmdApprovePurchaseOrder(c, oc1, 'Precio de lista'),
      (b) => b.commands.approvePurchaseOrder(pg(oc1), 'Precio de lista'),
    )
    await step(
      'enviar OC al proveedor',
      'compras1',
      (c) => E.cmdSendPurchaseOrder(c, oc1),
      (b) => b.commands.sendPurchaseOrder(pg(oc1)),
    )
    const ocLine = mock.poLines.find((l) => l.document_id === oc1)!
    const receipt = (quantity: number, note: string) => ({
      input: {
        purchase_order_id: oc1,
        warehouse_id: warehouse('DEP-MP'),
        supplier_delivery_note: note,
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: ocLine.id, quantity }],
      },
      pgInput: {
        purchase_order_id: pg(oc1),
        warehouse_id: pg(warehouse('DEP-MP')),
        supplier_delivery_note: note,
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: pg(ocLine.id), quantity }],
      },
    })
    expect(
      await step(
        'recibir más de lo pendiente',
        'deposito',
        (c) => E.cmdCreateGoodsReceipt(c, company, receipt(25, 'R-1').input, true),
        (b) => b.commands.createGoodsReceipt(companyPg, receipt(25, 'R-1').pgInput, true),
      ),
    ).toBeNull()
    const rec1 = await created(
      'recepción parcial',
      'deposito',
      (c) => E.cmdCreateGoodsReceipt(c, company, receipt(10, 'R-0001-00000100').input, true),
      (b) => b.commands.createGoodsReceipt(companyPg, receipt(10, 'R-0001-00000100').pgInput, true),
    )
    expect(
      await step(
        'remito duplicado',
        'deposito',
        (c) => E.cmdCreateGoodsReceipt(c, company, receipt(1, 'R-0001-00000100').input, true),
        (b) => b.commands.createGoodsReceipt(companyPg, receipt(1, 'R-0001-00000100').pgInput, true),
      ),
    ).toBeNull()
    const rec2 = await created(
      'recepción en borrador',
      'deposito',
      (c) => E.cmdCreateGoodsReceipt(c, company, receipt(5, 'R-0001-00000101').input, false),
      (b) => b.commands.createGoodsReceipt(companyPg, receipt(5, 'R-0001-00000101').pgInput, false),
    )
    await step(
      'confirmar recepción',
      'deposito',
      (c) => E.cmdConfirmGoodsReceipt(c, rec2),
      (b) => b.commands.confirmGoodsReceipt(pg(rec2)),
    )
    expect(
      await step(
        'anular la propia recepción',
        'deposito',
        (c) => E.cmdCancelGoodsReceipt(c, rec1, 'Se contó mal'),
        (b) => b.commands.cancelGoodsReceipt(pg(rec1), 'Se contó mal'),
      ),
    ).toBeNull()
    await step(
      'Gerencia anula la recepción',
      'gerencia',
      (c) => E.cmdCancelGoodsReceipt(c, rec1, 'Se contó mal'),
      (b) => b.commands.cancelGoodsReceipt(pg(rec1), 'Se contó mal'),
    )
    await step(
      'cerrar el saldo de la OC',
      'compras1',
      (c) => E.cmdClosePurchaseOrder(c, oc1, 'El proveedor no tiene más'),
      (b) => b.commands.closePurchaseOrder(pg(oc1), 'El proveedor no tiene más'),
    )
    await step(
      'cerrar el saldo de la SC',
      'compras1',
      (c) => E.cmdCloseRequisition(c, sc1, 'Se compra el mes que viene'),
      (b) => b.commands.closeRequisition(pg(sc1), 'Se compra el mes que viene'),
    )

    // OC grande: la aprueba Gerencia, no Compras.
    const bigInput = both(() => order('PRV-002', [['MP-006', 10, 115000, null]]), pgOrder)
    const big = await created(
      'OC grande',
      'compras2',
      (c) => E.cmdCreatePurchaseOrder(c, company, bigInput.input),
      (b) => b.commands.createPurchaseOrder(companyPg, bigInput.pgInput),
    )
    await step(
      'enviar OC grande',
      'compras2',
      (c) => E.cmdSubmitPurchaseOrder(c, big),
      (b) => b.commands.submitPurchaseOrder(pg(big)),
    )
    expect(
      await step(
        'Compras no puede aprobar la OC grande',
        'compras1',
        (c) => E.cmdApprovePurchaseOrder(c, big, ''),
        (b) => b.commands.approvePurchaseOrder(pg(big), ''),
      ),
    ).toBeNull()
    await step(
      'Gerencia aprueba la OC grande',
      'gerencia',
      (c) => E.cmdApprovePurchaseOrder(c, big, 'Inversión prevista'),
      (b) => b.commands.approvePurchaseOrder(pg(big), 'Inversión prevista'),
    )

    // OC que se retira, se rechaza, se reabre y se anula.
    const ocxInput = both(() => order('PRV-004', [['IN-002', 5, 18000, null]]), pgOrder)
    const ocx = await created(
      'OC a corregir',
      'compras1',
      (c) => E.cmdCreatePurchaseOrder(c, company, ocxInput.input),
      (b) => b.commands.createPurchaseOrder(companyPg, ocxInput.pgInput),
    )
    for (const [label, user, onMock, onPg] of [
      [
        'enviar',
        'compras1',
        (c: E.Ctx) => E.cmdSubmitPurchaseOrder(c, ocx),
        (b: Backend) => b.commands.submitPurchaseOrder(pg(ocx)),
      ],
      [
        'retirar',
        'compras1',
        (c: E.Ctx) => E.cmdWithdrawPurchaseOrder(c, ocx),
        (b: Backend) => b.commands.withdrawPurchaseOrder(pg(ocx)),
      ],
      [
        'reenviar',
        'compras1',
        (c: E.Ctx) => E.cmdSubmitPurchaseOrder(c, ocx),
        (b: Backend) => b.commands.submitPurchaseOrder(pg(ocx)),
      ],
      [
        'rechazar',
        'compras2',
        (c: E.Ctx) => E.cmdRejectPurchaseOrder(c, ocx, 'Pedí dos cotizaciones'),
        (b: Backend) => b.commands.rejectPurchaseOrder(pg(ocx), 'Pedí dos cotizaciones'),
      ],
      [
        'reabrir',
        'compras1',
        (c: E.Ctx) => E.cmdReopenPurchaseOrder(c, ocx),
        (b: Backend) => b.commands.reopenPurchaseOrder(pg(ocx)),
      ],
      [
        'anular',
        'compras1',
        (c: E.Ctx) => E.cmdCancelPurchaseOrder(c, ocx, 'Se compra a otro proveedor'),
        (b: Backend) => b.commands.cancelPurchaseOrder(pg(ocx), 'Se compra a otro proveedor'),
      ],
    ] as const)
      await step(`OC a corregir: ${label}`, user, onMock, onPg)

    // Ajustes de stock: una rotura confirmada y un borrador anulado.
    const adjustment = (reason: 'ROTURA' | 'CONTEO_FISICO', code: string, delta: number) => ({
      input: {
        warehouse_id: warehouse('DEP-MP'),
        reason_code: reason,
        notes: '',
        lines: [{ product_id: product(code).id, quantity_delta: delta }],
      },
      pgInput: {
        warehouse_id: pg(warehouse('DEP-MP')),
        reason_code: reason,
        notes: '',
        lines: [{ product_id: pg(product(code).id), quantity_delta: delta }],
      },
    })
    await created(
      'rotura',
      'deposito',
      (c) => E.cmdCreateStockAdjustment(c, company, adjustment('ROTURA', 'MP-002', -3).input, true),
      (b) => b.commands.createStockAdjustment(companyPg, adjustment('ROTURA', 'MP-002', -3).pgInput, true),
    )
    const draft = await created(
      'conteo en borrador',
      'deposito',
      (c) => E.cmdCreateStockAdjustment(c, company, adjustment('CONTEO_FISICO', 'IN-001', 2).input, false),
      (b) => b.commands.createStockAdjustment(companyPg, adjustment('CONTEO_FISICO', 'IN-001', 2).pgInput, false),
    )
    await step(
      'anular el conteo',
      'deposito',
      (c) => E.cmdCancelStockAdjustment(c, draft, 'Se repite el conteo'),
      (b) => b.commands.cancelStockAdjustment(pg(draft), 'Se repite el conteo'),
    )
    expect(
      await step(
        'sacar más stock del que hay',
        'deposito',
        (c) => E.cmdCreateStockAdjustment(c, company, adjustment('ROTURA', 'IN-003', -100000).input, true),
        (b) => b.commands.createStockAdjustment(companyPg, adjustment('ROTURA', 'IN-003', -100000).pgInput, true),
      ),
    ).toBeNull()
  })

  it('después de los comandos, cada usuario lee lo mismo en ambos lados', async () => {
    const companyPg = pg(company)
    const types: DocType[] = ['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT']
    const taskKey = (t: { status: string; created_at: string }) => `${t.status === 'EN_CURSO'}|${t.created_at}`
    expect(mock.documents.filter((x) => x.created_at > cutoff).length).toBeGreaterThanOrEqual(9)
    await sameRead(
      'integrantes y actividad',
      'docente',
      (b) => b.api.members(companyPg),
      (u) => Q.listMembers(mock, u, company),
    )
    for (const username of ['docente', 'compras1', 'compras2', 'deposito', 'produccion', 'gerencia', 'auditor']) {
      for (const type of types)
        await sameRead(
          `documentos ${type} (${username})`,
          username,
          (b) => b.api.documents(companyPg, type),
          (u) => Q.listDocuments(mock, u, company, type),
        )
      for (const d of mock.documents.filter((x) => x.company_id === company && x.created_at > cutoff))
        await sameRead(
          `${d.display_number} (${username})`,
          username,
          (b) => b.api.document(companyPg, d.doc_type, d.display_number),
          (u) => Q.documentDetail(mock, u, company, d.doc_type, d.display_number),
        )
      await sameRead(
        `tareas (${username})`,
        username,
        (b) => b.api.tasks(companyPg, 'all', true),
        (u) => Q.listTasks(mock, u, company, 'all', true),
        taskKey,
      )
      await sameRead(
        `avisos (${username})`,
        username,
        (b) => b.api.notifications(companyPg, null),
        (u) => Q.listNotifications(mock, u, company, null),
        (n: { created_at: string }) => n.created_at,
      )
      await sameRead(
        `auditoría (${username})`,
        username,
        (b) => b.api.audit(companyPg),
        (u) => Q.listAudit(mock, u, company),
      )
      await sameRead(
        `stock (${username})`,
        username,
        (b) => b.api.stock(companyPg),
        (u) => Q.listStock(mock, u, company),
      )
      for (const code of ['MP-002', 'IN-001', 'MP-006'])
        await sameRead(
          `kardex ${code} (${username})`,
          username,
          (b) => b.api.product(companyPg, code),
          (u) => Q.productDetail(mock, u, company, code),
        )
      await sameRead(
        `pendientes (${username})`,
        username,
        (b) => b.api.pendingRequisitionLines(companyPg),
        (u) => Q.pendingRequisitionLines(mock, u, company),
      )
    }
  })
})
