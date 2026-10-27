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
import { addDays, todayAR } from '../../src/lib/format'
import type { CompanySettings, DocType } from '../../src/lib/domain/types'
import type { DB } from '../../src/lib/mock/db'
import * as E from '../../src/lib/mock/engine'
import * as Q from '../../src/lib/mock/queries'
import { DEMO_PASSWORD } from '../../src/lib/mock/seed'
import { project } from './support/compare'
import { createTestDb, type TestDb } from './support/db'
import { createFakeSupabase, PUBLIC_KEY, SUPABASE_URL, type FakeSupabase } from './support/fake-supabase'
import { loadMockDb, normalize, type LoadedMock } from './support/mock-loader'
import { buildScenario } from './support/scenario'

// En una PC con poca memoria, la última comparación (todas las lecturas de cada usuario) pasa los 5 minutos.
vi.setConfig({ testTimeout: 600_000 })

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
  lastFailure = m.ok ? '' : m.error
  return m.ok && p.ok ? { mock: m.value as M, pg: p.value as P } : null
}

/** El error del último paso que falló en los dos lados (para explicar un paso que tenía que salir bien). */
let lastFailure = ''

/** Un paso que tiene que salir bien: si fallara igual en los dos lados, step() no lo notaría. */
async function ok<M, P>(label: string, username: string, onMock: (ctx: E.Ctx) => M, onPg: (b: Backend) => Promise<P>) {
  const result = await step(label, username, onMock, onPg)
  expect(result, `${label}: tenía que salir bien (${lastFailure})`).not.toBeNull()
  return result!
}

/** Vincula un documento nuevo y sus líneas (por número de línea). */
async function linkDocument(mockDocId: string, pgDocId: string) {
  loaded.link(mockDocId, pgDocId)
  const tables: [string, { id: string; document_id: string; line_no: number }[]][] = [
    ['purchase_requisition_lines', mock.prLines],
    ['purchase_order_lines', mock.poLines],
    ['goods_receipt_lines', mock.grLines],
    ['stock_adjustment_lines', mock.saLines],
    ['journal_entry_lines', mock.jeLines],
    ['supplier_invoice_lines', mock.siLines],
    ['payment_order_lines', mock.opLines],
    ['rfq_lines', mock.rfqLines],
    ['supplier_quote_lines', mock.sqLines],
    ['bank_reconciliation_lines', mock.brLines],
    ['sales_order_lines', mock.soLines],
    ['delivery_note_lines', mock.dnLines],
    ['sales_invoice_lines', mock.fvLines],
    ['customer_receipt_lines', mock.rcLines],
    ['sales_quote_lines', mock.qtLines],
    ['production_order_lines', mock.prdLines],
    ['production_order_operations', mock.prdOperations],
    ['payroll_lines', mock.pyLines],
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
  expect(result, `${label}: tenía que salir bien (${lastFailure})`).not.toBeNull()
  expect(result!.pg.display_number, label).toBe(result!.mock.display_number)
  await linkDocument(result!.mock.id, result!.pg.id)
  return result!.mock.id
}

/**
 * Los id numéricos (auditoría, kardex) salen de secuencias, y en la base una
 * operación que falla consume números aunque se deshaga: dentro de cada lista
 * se comparan por su orden, no por su valor.
 */
function renumber(value: unknown): unknown {
  const numericId = (x: unknown) =>
    x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'number' ? (x as { id: number }).id : null
  if (Array.isArray(value)) {
    const ids = value.map(numericId).filter((id): id is number => id !== null)
    const rank = new Map([...ids].sort((a, b) => a - b).map((id, i) => [id, `n#${i + 1}`]))
    return value.map((x) => {
      const y = renumber(x)
      const id = numericId(x)
      return id === null ? y : { ...(y as object), id: rank.get(id) }
    })
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, renumber(x)]))
  return value
}

/** Ids nuevos → "id#n" por orden de aparición; horas nuevas → "t#n" por orden cronológico. */
function canonical(input: unknown): unknown {
  const value = renumber(input)
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
    // Las claves en orden fijo: jsonb las ordena a su manera ("to" antes que "from") y los ids
    // nuevos se numeran por orden de aparición.
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, walk(x)]),
      )
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
    await ok(
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
    await ok(
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
    await ok(
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
    await ok(
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
    await ok(
      'aprobar OC',
      'compras2',
      (c) => E.cmdApprovePurchaseOrder(c, oc1, 'Precio de lista'),
      (b) => b.commands.approvePurchaseOrder(pg(oc1), 'Precio de lista'),
    )
    await ok(
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
    await ok(
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
    await ok(
      'Gerencia anula la recepción',
      'gerencia',
      (c) => E.cmdCancelGoodsReceipt(c, rec1, 'Se contó mal'),
      (b) => b.commands.cancelGoodsReceipt(pg(rec1), 'Se contó mal'),
    )
    await ok(
      'cerrar el saldo de la OC',
      'compras1',
      (c) => E.cmdClosePurchaseOrder(c, oc1, 'El proveedor no tiene más'),
      (b) => b.commands.closePurchaseOrder(pg(oc1), 'El proveedor no tiene más'),
    )
    await ok(
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
    await ok(
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
    await ok(
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
      await ok(`OC a corregir: ${label}`, user, onMock, onPg)

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
    await ok(
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

  it('contabilidad: asientos, contraasientos, plan de cuentas, períodos y ejercicios', async () => {
    const companyPg = pg(company)
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const today = todayAR()
    const entry = (lines: [string, number, number][], description = 'Pago de gastos del mes.', date = today) => {
      const input: E.JournalEntryInput = {
        document_date: date,
        description,
        lines: lines.map(([code, debit, credit]) => ({ account_id: account(code), debit, credit })),
      }
      return { input, pgInput: { ...input, lines: input.lines.map((l) => ({ ...l, account_id: pg(l.account_id) })) } }
    }
    const create = (label: string, username: string, e: ReturnType<typeof entry>, confirm: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateJournalEntry(c, company, e.input, confirm),
        (b) => b.commands.createJournalEntry(companyPg, e.pgInput, confirm),
      )

    // Controles de la partida doble, de las cuentas, de la fecha y de los permisos.
    for (const [label, username, e] of [
      [
        'asiento desbalanceado',
        'contabilidad',
        entry([
          ['5.2.02.02', 1000, 0],
          ['1.1.01.01', 0, 900],
        ]),
      ],
      [
        'asiento de un solo lado',
        'contabilidad',
        entry([
          ['5.2.02.02', 1000, 0],
          ['5.2.02.03', 500, 0],
        ]),
      ],
      [
        'cuenta que es un rubro',
        'contabilidad',
        entry([
          ['1.1.01', 1000, 0],
          ['1.1.01.01', 0, 1000],
        ]),
      ],
      [
        'importe con tres decimales',
        'contabilidad',
        entry([
          ['5.2.02.02', 10.005, 0],
          ['1.1.01.01', 0, 10.005],
        ]),
      ],
      [
        'fecha futura',
        'contabilidad',
        entry(
          [
            ['5.2.02.02', 10, 0],
            ['1.1.01.01', 0, 10],
          ],
          'Gasto.',
          addDays(today, 1),
        ),
      ],
      [
        'fecha anterior al último asiento',
        'contabilidad',
        entry(
          [
            ['5.2.02.02', 10, 0],
            ['1.1.01.01', 0, 10],
          ],
          'Gasto.',
          addDays(today, -1),
        ),
      ],
      [
        'Compras no registra asientos',
        'compras1',
        entry([
          ['5.2.02.02', 10, 0],
          ['1.1.01.01', 0, 10],
        ]),
      ],
    ] as const)
      expect(await create(label, username, e, true), label).toBeNull()

    // Un borrador desbalanceado que se corrige y se registra.
    const draftInput = entry(
      [
        ['5.2.02.03', 25000, 0],
        ['1.1.01.03', 0, 20000],
      ],
      'Pago del servicio de internet.',
    )
    const draft = await created(
      'asiento en borrador',
      'contabilidad',
      (c) => E.cmdCreateJournalEntry(c, company, draftInput.input, false),
      (b) => b.commands.createJournalEntry(companyPg, draftInput.pgInput, false),
    )
    expect(
      await step(
        'registrar el borrador desbalanceado',
        'contabilidad',
        (c) => E.cmdConfirmJournalEntry(c, draft),
        (b) => b.commands.confirmJournalEntry(pg(draft)),
      ),
    ).toBeNull()
    const fixed = entry(
      [
        ['5.2.02.03', 25000, 0],
        ['1.1.01.03', 0, 25000],
      ],
      'Pago del servicio de internet del mes.',
    )
    await ok(
      'corregir el borrador',
      'contabilidad',
      (c) => E.cmdUpdateJournalEntry(c, draft, fixed.input),
      (b) => b.commands.updateJournalEntry(pg(draft), fixed.pgInput),
    )
    await linkDocument(draft, pg(draft))
    await ok(
      'registrar el borrador',
      'contabilidad',
      (c) => E.cmdConfirmJournalEntry(c, draft),
      (b) => b.commands.confirmJournalEntry(pg(draft)),
    )
    expect(
      await step(
        'modificar un asiento registrado',
        'contabilidad',
        (c) => E.cmdUpdateJournalEntry(c, draft, fixed.input),
        (b) => b.commands.updateJournalEntry(pg(draft), fixed.pgInput),
      ),
    ).toBeNull()

    // Un asiento registrado que se anula con contraasiento.
    const adInput = entry(
      [
        ['5.2.02.07', 80000, 0],
        ['1.1.01.03', 0, 80000],
      ],
      'Pago de publicidad en la radio.',
    )
    const ad = await created(
      'asiento registrado',
      'contabilidad',
      (c) => E.cmdCreateJournalEntry(c, company, adInput.input, true),
      (b) => b.commands.createJournalEntry(companyPg, adInput.pgInput, true),
    )
    expect(
      await step(
        'anular sin motivo',
        'contabilidad',
        (c) => E.cmdCancelJournalEntry(c, ad, ''),
        (b) => b.commands.cancelJournalEntry(pg(ad), ''),
      ),
    ).toBeNull()
    await ok(
      'anular con contraasiento',
      'contabilidad',
      (c) => E.cmdCancelJournalEntry(c, ad, 'Era un gasto de otro mes'),
      (b) => b.commands.cancelJournalEntry(pg(ad), 'Era un gasto de otro mes'),
    )
    const reversal = mock.documents.find((d) => d.je?.reverses_id === ad)!
    const [{ document_id: reversalPg }] = await db.admin<{ document_id: string }>(
      'select document_id from public.journal_entries where reverses_id = $1',
      [pg(ad)],
    )
    await linkDocument(reversal.id, reversalPg)
    expect(
      await step(
        'anular el contraasiento',
        'contabilidad',
        (c) => E.cmdCancelJournalEntry(c, reversal.id, 'Prueba'),
        (b) => b.commands.cancelJournalEntry(reversalPg, 'Prueba'),
      ),
    ).toBeNull()

    // Plan de cuentas.
    const newAccount = {
      code: '1.1.01.06',
      name: 'Banco del Litoral caja de ahorro',
      description: 'Cuenta bancaria ficticia.',
      is_contra: false,
    }
    const added = await step(
      'cuenta nueva',
      'contabilidad',
      (c) => E.cmdSaveAccount(c, company, newAccount),
      (b) => b.commands.saveAccount(companyPg, newAccount),
    )
    expect(added).not.toBeNull()
    loaded.link(added!.mock, added!.pg as string)
    for (const [label, input] of [
      ['cuenta con nombre repetido', { ...newAccount, code: '1.1.01.07', name: 'CAJA' }],
      ['cuenta de tres niveles', { ...newAccount, code: '1.1.09', name: 'Otra cuenta' }],
      ['cuenta en un rubro que no existe', { ...newAccount, code: '1.1.09.01', name: 'Otra cuenta' }],
      ['código repetido', { ...newAccount, name: 'Otra cuenta' }],
    ] as const)
      expect(
        await step(
          label,
          'contabilidad',
          (c) => E.cmdSaveAccount(c, company, input),
          (b) => b.commands.saveAccount(companyPg, input),
        ),
        label,
      ).toBeNull()
    await ok(
      'renombrar la cuenta',
      'contabilidad',
      (c) =>
        E.cmdSaveAccount(c, company, { ...newAccount, id: added!.mock, name: 'Banco del Litoral cuenta corriente' }),
      (b) =>
        b.commands.saveAccount(companyPg, {
          ...newAccount,
          id: added!.pg as string,
          name: 'Banco del Litoral cuenta corriente',
        }),
    )
    expect(
      await step(
        'desactivar una cuenta con saldo',
        'contabilidad',
        (c) => E.cmdSetAccountActive(c, company, account('1.1.01.01'), false),
        (b) => b.commands.setAccountActive(companyPg, pg(account('1.1.01.01')), false),
      ),
    ).toBeNull()
    await ok(
      'desactivar una cuenta sin saldo',
      'contabilidad',
      (c) => E.cmdSetAccountActive(c, company, account('1.1.01.02'), false),
      (b) => b.commands.setAccountActive(companyPg, pg(account('1.1.01.02')), false),
    )

    // Períodos y ejercicios.
    const month = mock.fiscalPeriods.find(
      (p) => p.company_id === company && p.start_date <= today && today <= p.end_date,
    )!
    const period = (label: string, username: string, status: 'ABIERTO' | 'CERRADO', reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdSetPeriodStatus(c, company, month.id, status, reason),
        (b) => b.commands.setPeriodStatus(companyPg, pg(month.id), status, reason),
      )
    expect(await period('cerrar el mes', 'contabilidad', 'CERRADO', '')).not.toBeNull()
    expect(
      await create(
        'asiento en un mes cerrado',
        'contabilidad',
        entry([
          ['5.2.02.02', 10, 0],
          ['1.1.01.01', 0, 10],
        ]),
        true,
      ),
    ).toBeNull()
    expect(await period('Contabilidad no reabre', 'contabilidad', 'ABIERTO', 'Falta un gasto')).toBeNull()
    expect(await period('reabrir sin motivo', 'docente', 'ABIERTO', '')).toBeNull()
    expect(await period('el docente reabre', 'docente', 'ABIERTO', 'Falta registrar un gasto')).not.toBeNull()
    const nextYear = Number(today.slice(0, 4)) + 1
    const opened = await step(
      'abrir el ejercicio siguiente',
      'docente',
      (c) => E.cmdOpenFiscalYear(c, company, nextYear),
      (b) => b.commands.openFiscalYear(companyPg, nextYear),
    )
    expect(opened).not.toBeNull()
    for (const [label, username, year] of [
      ['abrir el mismo ejercicio otra vez', 'docente', nextYear],
      ['abrir un ejercicio lejano', 'docente', nextYear + 5],
      ['Contabilidad no abre ejercicios', 'contabilidad', nextYear + 1],
    ] as const)
      expect(
        await step(
          label,
          username,
          (c) => E.cmdOpenFiscalYear(c, company, year),
          (b) => b.commands.openFiscalYear(companyPg, year),
        ),
        label,
      ).toBeNull()
  })

  it('facturas de proveedor: control por oposición, asiento automático, anulación e imputación', async () => {
    const companyPg = pg(company)
    const today = todayAR()
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const rule = (key: string) =>
      mock.postingRules.find((r) => r.company_id === company && r.event === 'COMPRA' && r.key === key)!.id
    // La OC cerrada de la primera prueba, con parte de lo pedido recibido.
    const oc = mock.documents.find(
      (d) => d.doc_type === 'PURCHASE_ORDER' && d.created_at > cutoff && d.status === 'CERRADO',
    )!.id
    const { id: ocLine, qty_received: received } = mock.poLines.find((l) => l.document_id === oc)!
    expect(received).toBeGreaterThan(3)
    const invoice = (
      orderId: string,
      lineId: string,
      number: string,
      quantity: number,
      price: number,
      { pos = '4', date = today } = {},
    ) => {
      const input: E.SupplierInvoiceInput = {
        purchase_order_id: orderId,
        point_of_sale: pos,
        invoice_number: number,
        document_date: date,
        notes: '',
        lines: [{ po_line_id: lineId, quantity, unit_price: price }],
      }
      const pgInput = {
        ...input,
        purchase_order_id: pg(orderId),
        lines: input.lines.map((l) => ({ ...l, po_line_id: pg(l.po_line_id) })),
      }
      return { input, pgInput }
    }
    const create = (label: string, username: string, i: ReturnType<typeof invoice>, register: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateSupplierInvoice(c, company, i.input, register),
        (b) => b.commands.createSupplierInvoice(companyPg, i.pgInput, register),
      )
    const createdInvoice = (label: string, username: string, i: ReturnType<typeof invoice>, register: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreateSupplierInvoice(c, company, i.input, register),
        (b) => b.commands.createSupplierInvoice(companyPg, i.pgInput, register),
      )
    const confirm = (label: string, username: string, id: string) =>
      step(
        label,
        username,
        (c) => E.cmdConfirmSupplierInvoice(c, id),
        (b) => b.commands.confirmSupplierInvoice(pg(id)),
      )
    const cancel = (label: string, username: string, id: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelSupplierInvoice(c, id, reason),
        (b) => b.commands.cancelSupplierInvoice(pg(id), reason),
      )

    // Controles: lo recibido, el comprobante, la fecha y los permisos.
    for (const [label, username, i] of [
      ['facturar más de lo recibido', 'compras1', invoice(oc, ocLine, '1001', received + 1, 1600)],
      ['factura sin cantidades', 'compras1', invoice(oc, ocLine, '1001', 0, 1600)],
      ['cantidad con cuatro decimales', 'compras1', invoice(oc, ocLine, '1001', 1.0005, 1600)],
      ['precio negativo', 'compras1', invoice(oc, ocLine, '1001', 1, -5)],
      ['punto de venta con letras', 'compras1', invoice(oc, ocLine, '1001', 1, 1600, { pos: 'A1' })],
      ['número de nueve cifras', 'compras1', invoice(oc, ocLine, '123456789', 1, 1600)],
      ['fecha futura', 'compras1', invoice(oc, ocLine, '1001', 1, 1600, { date: addDays(today, 1) })],
      ['Depósito no registra facturas', 'deposito', invoice(oc, ocLine, '1001', 1, 1600)],
    ] as const)
      expect(await create(label, username, i, true), label).toBeNull()

    // Un borrador que se registra (con su asiento automático) una sola vez.
    const draftInput = invoice(oc, ocLine, '1001', 3, 1600)
    const draft = await createdInvoice('factura en borrador', 'compras1', draftInput, false)
    expect(await create('el mismo comprobante otra vez', 'compras2', draftInput, false)).toBeNull()
    expect(await confirm('Depósito no registra la factura', 'deposito', draft)).toBeNull()
    expect(await confirm('registrar la factura', 'compras2', draft)).not.toBeNull()
    expect(await confirm('registrarla otra vez', 'compras1', draft)).toBeNull()

    // Otra factura completa lo recibido; después no queda nada por facturar.
    const second = await createdInvoice(
      'factura con otro precio',
      'compras1',
      invoice(oc, ocLine, '1002', received - 3, 1650),
      true,
    )
    expect(await create('facturar lo ya facturado', 'compras1', invoice(oc, ocLine, '1003', 1, 1600), true)).toBeNull()

    // La anulación libera lo facturado y deja el contraasiento del asiento de compra.
    expect(await cancel('anular sin motivo', 'compras1', second, '')).toBeNull()
    expect(await cancel('Contabilidad no anula facturas', 'contabilidad', second, 'Precio mal')).toBeNull()
    expect(
      await cancel('anular la factura y su asiento', 'compras1', second, 'El precio no es el pactado'),
    ).not.toBeNull()
    expect(await cancel('anular una factura anulada', 'compras1', second, 'Otra vez')).toBeNull()

    // Contabilidad cambia la imputación de las materias primas y la factura siguiente la usa.
    for (const [label, username, code] of [
      ['imputar a un rubro', 'contabilidad', '1.1.05'],
      ['Compras no cambia la imputación', 'compras1', '1.1.05.02'],
    ] as const)
      expect(
        await step(
          label,
          username,
          (c) => E.cmdSavePostingRule(c, company, rule('MATERIA_PRIMA'), account(code)),
          (b) => b.commands.savePostingRule(companyPg, pg(rule('MATERIA_PRIMA')), pg(account(code))),
        ),
        label,
      ).toBeNull()
    await ok(
      'cambiar la imputación',
      'contabilidad',
      (c) => E.cmdSavePostingRule(c, company, rule('MATERIA_PRIMA'), account('1.1.05.02')),
      (b) => b.commands.savePostingRule(companyPg, pg(rule('MATERIA_PRIMA')), pg(account('1.1.05.02'))),
    )
    await createdInvoice(
      'factura con la imputación nueva',
      'compras1',
      invoice(oc, ocLine, '1003', received - 3, 1600),
      true,
    )

    // Un servicio de un monotributista: factura C, sin IVA discriminado (todo es costo).
    const serviceOrder: E.PurchaseOrderInput = {
      supplier_id: supplier('PRV-010'),
      expected_date: null,
      warehouse_id: warehouse('DEP-MP'),
      payment_terms_days: 0,
      delivery_terms: 'Puesto en planta',
      notes: '',
      lines: [
        { product_id: product('SV-001').id, requisition_line_id: null, quantity: 2, unit_price: 21000, vat_rate: 21 },
      ],
    }
    const service = await created(
      'OC de un servicio',
      'compras2',
      (c) => E.cmdCreatePurchaseOrder(c, company, serviceOrder),
      (b) =>
        b.commands.createPurchaseOrder(companyPg, {
          ...serviceOrder,
          supplier_id: pg(serviceOrder.supplier_id),
          warehouse_id: pg(serviceOrder.warehouse_id),
          lines: serviceOrder.lines.map((l) => ({ ...l, product_id: pg(l.product_id) })),
        }),
    )
    await ok(
      'enviar la OC del servicio',
      'compras2',
      (c) => E.cmdSubmitPurchaseOrder(c, service),
      (b) => b.commands.submitPurchaseOrder(pg(service)),
    )
    await ok(
      'aprobar la OC del servicio',
      'compras1',
      (c) => E.cmdApprovePurchaseOrder(c, service, 'Servicio necesario'),
      (b) => b.commands.approvePurchaseOrder(pg(service), 'Servicio necesario'),
    )
    await ok(
      'mandar la OC al proveedor',
      'compras2',
      (c) => E.cmdSendPurchaseOrder(c, service),
      (b) => b.commands.sendPurchaseOrder(pg(service)),
    )
    const serviceLine = mock.poLines.find((l) => l.document_id === service)!.id
    expect(
      await create('facturar un servicio no prestado', 'compras2', invoice(service, serviceLine, '77', 2, 21000), true),
    ).toBeNull()
    const delivered = {
      purchase_order_id: service,
      warehouse_id: warehouse('DEP-MP'),
      supplier_delivery_note: 'R-0002-00000077',
      carrier_name: '',
      notes: 'Servicio prestado.',
      lines: [{ po_line_id: serviceLine, quantity: 2 }],
    }
    const serviceReceipt = await created(
      'servicio prestado',
      'deposito',
      (c) => E.cmdCreateGoodsReceipt(c, company, delivered, true),
      (b) =>
        b.commands.createGoodsReceipt(
          companyPg,
          {
            ...delivered,
            purchase_order_id: pg(service),
            warehouse_id: pg(delivered.warehouse_id),
            lines: [{ po_line_id: pg(serviceLine), quantity: 2 }],
          },
          true,
        ),
    )
    await createdInvoice('factura C', 'compras2', invoice(service, serviceLine, '77', 2, 21000, { pos: '2' }), true)
    expect(
      await step(
        'anular una recepción ya facturada',
        'gerencia',
        (c) => E.cmdCancelGoodsReceipt(c, serviceReceipt, 'Se cargó dos veces'),
        (b) => b.commands.cancelGoodsReceipt(pg(serviceReceipt), 'Se cargó dos veces'),
      ),
    ).toBeNull()
  })

  it('órdenes de pago: reserva del saldo, aprobación, pago con su asiento, separación de funciones y anulación', async () => {
    const companyPg = pg(company)
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const registered = (supplierCode: string, number: string) =>
      mock.documents.find(
        (d) =>
          d.doc_type === 'SUPPLIER_INVOICE' &&
          d.status === 'REGISTRADA' &&
          d.supplier_id === supplier(supplierCode) &&
          d.si!.invoice_number === number,
      )!
    // La factura C del servicio (la registró compras2) y una factura de PRV-001, de la prueba anterior.
    const service = registered('PRV-010', '00000077')
    const other = registered('PRV-001', '00001001')
    const payment = (
      invoiceId: string | null,
      amount: number,
      { from = '1.1.01.03', supplierCode }: { from?: string; supplierCode?: string } = {},
    ) => {
      const input: E.PaymentOrderInput = {
        supplier_id: supplierCode
          ? supplier(supplierCode)
          : mock.documents.find((d) => d.id === invoiceId)!.supplier_id!,
        treasury_account_id: account(from),
        notes: '',
        lines: invoiceId ? [{ invoice_id: invoiceId, amount }] : [],
      }
      const pgInput = {
        ...input,
        supplier_id: pg(input.supplier_id),
        treasury_account_id: pg(input.treasury_account_id),
        lines: input.lines.map((l) => ({ ...l, invoice_id: pg(l.invoice_id) })),
      }
      return { input, pgInput }
    }
    const create = (label: string, username: string, p: ReturnType<typeof payment>, submit: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreatePaymentOrder(c, company, p.input, submit),
        (b) => b.commands.createPaymentOrder(companyPg, p.pgInput, submit),
      )
    const createdOrder = (label: string, username: string, p: ReturnType<typeof payment>, submit: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreatePaymentOrder(c, company, p.input, submit),
        (b) => b.commands.createPaymentOrder(companyPg, p.pgInput, submit),
      )
    const approve = (label: string, username: string, id: string) =>
      step(
        label,
        username,
        (c) => E.cmdApprovePaymentOrder(c, id, 'Autorizado'),
        (b) => b.commands.approvePaymentOrder(pg(id), 'Autorizado'),
      )
    const pay = (
      label: string,
      username: string,
      id: string,
      reference = '',
      method: 'TRANSFERENCIA' | 'CHEQUE' | 'EFECTIVO' = 'TRANSFERENCIA',
    ) =>
      step(
        label,
        username,
        (c) => E.cmdPayPaymentOrder(c, id, reference, method),
        (b) => b.commands.payPaymentOrder(pg(id), reference, method),
      )
    const cancel = (label: string, username: string, id: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelPaymentOrder(c, id, reason),
        (b) => b.commands.cancelPaymentOrder(pg(id), reason),
      )

    // Controles: el saldo de la factura, los importes, la caja o el banco, el proveedor y los permisos.
    for (const [label, username, p] of [
      ['pagar más que el saldo', 'contabilidad', payment(service.id, service.total + 1)],
      ['importe con tres decimales', 'contabilidad', payment(service.id, 1.005)],
      [
        'pagar desde una cuenta que no es caja ni banco',
        'contabilidad',
        payment(service.id, 1000, { from: '2.1.01.01' }),
      ],
      ['factura de otro proveedor', 'contabilidad', payment(service.id, 1000, { supplierCode: 'PRV-001' })],
      ['orden sin facturas', 'contabilidad', payment(null, 0, { supplierCode: 'PRV-010' })],
      ['Compras no prepara pagos', 'compras1', payment(service.id, 1000)],
    ] as const)
      expect(await create(label, username, p, true), label).toBeNull()

    // Un pago parcial reserva su parte: el resto se puede incluir en otra orden, no más.
    const partial = await createdOrder('pago parcial', 'contabilidad', payment(service.id, 20000), true)
    const rest = E.round2(service.total - 20000)
    expect(await create('reservar de más', 'tesoreria', payment(service.id, rest + 0.01), false)).toBeNull()
    const draft = await createdOrder(
      'el resto, en borrador',
      'tesoreria',
      payment(service.id, rest, { from: '1.1.01.01' }),
      false,
    )
    await ok(
      'enviar el borrador a aprobación',
      'tesoreria',
      (c) => E.cmdSubmitPaymentOrder(c, draft),
      (b) => b.commands.submitPaymentOrder(pg(draft)),
    )

    // Gerencia aprueba una y rechaza la otra; Contabilidad no aprueba.
    expect(await approve('Contabilidad no aprueba pagos', 'contabilidad', partial)).toBeNull()
    expect(await approve('aprobar', 'gerencia', partial)).not.toBeNull()
    expect(
      await step(
        'rechazar sin motivo',
        'gerencia',
        (c) => E.cmdRejectPaymentOrder(c, draft, ''),
        (b) => b.commands.rejectPaymentOrder(pg(draft), ''),
      ),
    ).toBeNull()
    await ok(
      'rechazar',
      'gerencia',
      (c) => E.cmdRejectPaymentOrder(c, draft, 'Se paga todo junto el mes que viene'),
      (b) => b.commands.rejectPaymentOrder(pg(draft), 'Se paga todo junto el mes que viene'),
    )

    // Tesorería paga (asiento automático) y la factura queda pagada en parte.
    expect(await pay('Gerencia no paga', 'gerencia', partial)).toBeNull()
    expect(await pay('un medio de pago que no existe', 'tesoreria', partial, '1', 'GIRO' as never)).toBeNull()
    expect(await pay('pagar', 'tesoreria', partial, '000777')).not.toBeNull()
    expect(await pay('pagar otra vez', 'tesoreria', partial)).toBeNull()

    // Separación de funciones: compras2 registró la factura; con el rol de Tesorería tampoco la puede pagar.
    const tes = mock.sectors.find((s) => s.company_id === company && s.code === 'TES')!.id
    await ok(
      'el docente le suma Tesorería a compras2',
      'docente',
      (c) => E.cmdAssignRole(c, company, mockId('compras2'), 'TESORERIA', tes),
      (b) => b.commands.assignRole(companyPg, pg(mockId('compras2')), 'TESORERIA', pg(tes)),
    )
    const balance = await createdOrder('el resto, otra vez', 'contabilidad', payment(service.id, rest), true)
    expect(await approve('aprobar el resto', 'gerencia', balance)).not.toBeNull()
    expect(await pay('pagar una factura que registró', 'compras2', balance)).toBeNull()
    expect(await pay('cheque sin número', 'tesoreria', balance, '', 'CHEQUE')).toBeNull()
    expect(await pay('cheque con letras', 'tesoreria', balance, 'Cheque 1', 'CHEQUE')).toBeNull()
    expect(await pay('pagar el resto con cheque', 'tesoreria', balance, '000321', 'CHEQUE')).not.toBeNull()
    expect(
      await step(
        'anular una factura pagada',
        'compras2',
        (c) => E.cmdCancelSupplierInvoice(c, service.id, 'Error'),
        (b) => b.commands.cancelSupplierInvoice(pg(service.id), 'Error'),
      ),
    ).toBeNull()

    // Anular un pago: con motivo, revierte el asiento y la factura vuelve a tener saldo.
    expect(await cancel('anular el pago sin motivo', 'tesoreria', balance, '')).toBeNull()
    expect(await cancel('anular el pago', 'tesoreria', balance, 'El cheque fue rechazado')).not.toBeNull()

    // Una factura en una orden en curso no se anula; y no se paga sin fondos.
    // (El fondo fijo lo desactivó la prueba de Contabilidad; Valores a depositar tampoco tiene saldo.)
    const pending = await createdOrder(
      'pago desde una cuenta sin saldo',
      'contabilidad',
      payment(other.id, 1000, { from: '1.1.01.04' }),
      true,
    )
    expect(
      await step(
        'anular una factura en una orden en curso',
        'compras1',
        (c) => E.cmdCancelSupplierInvoice(c, other.id, 'Error de carga'),
        (b) => b.commands.cancelSupplierInvoice(pg(other.id), 'Error de carga'),
      ),
    ).toBeNull()
    expect(await approve('aprobar el pago sin fondos', 'gerencia', pending)).not.toBeNull()
    expect(await pay('pagar sin fondos', 'tesoreria', pending)).toBeNull()
    expect(
      await cancel('anular la orden aprobada', 'contabilidad', pending, 'No hay fondos en esa cuenta'),
    ).not.toBeNull()
  })

  it('cotizaciones: solicitud, cotizaciones, cuadro comparativo, adjudicación y anulación', async () => {
    const companyPg = pg(company)
    const byLineNo = (a: { line_no: number }, b: { line_no: number }) => a.line_no - b.line_no
    // Una SC propia de esta prueba: la solicitud de cotización atiende sus líneas.
    const scInput: E.RequisitionInput = {
      needed_by: null,
      priority: 'NORMAL',
      reason: 'Bisagras y correderas para los placares del mes',
      notes: '',
      lines: [
        { product_id: product('IN-004').id, quantity: 200 },
        { product_id: product('IN-005').id, quantity: 40 },
      ],
    }
    const scId = await created(
      'SC para cotizar',
      'produccion',
      (c) => E.cmdCreateRequisition(c, company, scInput, true),
      (b) =>
        b.commands.createRequisition(
          companyPg,
          { ...scInput, lines: scInput.lines.map((l) => ({ ...l, product_id: pg(l.product_id) })) },
          true,
        ),
    )
    const scLines = mock.prLines.filter((l) => l.document_id === scId).sort(byLineNo)
    const rfq = (suppliers: string[], over: Partial<E.RfqInput> = {}) => {
      const input: E.RfqInput = {
        response_due: addDays(todayAR(), 3),
        warehouse_id: warehouse('DEP-MP'),
        notes: 'Entregar en el depósito de materias primas',
        supplier_ids: suppliers.map(supplier),
        lines: scLines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, requisition_line_id: l.id })),
        ...over,
      }
      const pgInput = {
        ...input,
        warehouse_id: pg(input.warehouse_id),
        supplier_ids: input.supplier_ids.map(pg),
        lines: input.lines.map((l) => ({
          ...l,
          product_id: pg(l.product_id),
          requisition_line_id: l.requisition_line_id ? pg(l.requisition_line_id) : null,
        })),
      }
      return { input, pgInput }
    }
    const createRfq = (label: string, username: string, r: ReturnType<typeof rfq>, send: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateRfq(c, company, r.input, send),
        (b) => b.commands.createRfq(companyPg, r.pgInput, send),
      )
    const createdRfq = (label: string, username: string, r: ReturnType<typeof rfq>, send: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreateRfq(c, company, r.input, send),
        (b) => b.commands.createRfq(companyPg, r.pgInput, send),
      )

    // Controles de la solicitud: proveedores, fecha, cantidades y permisos.
    for (const [label, username, r] of [
      ['invitar a un solo proveedor', 'compras1', rfq(['PRV-003'])],
      ['el mismo proveedor dos veces', 'compras1', rfq(['PRV-003', 'PRV-003'])],
      ['responder en el pasado', 'compras1', rfq(['PRV-003', 'PRV-009'], { response_due: addDays(todayAR(), -1) })],
      [
        'cotizar más de lo pendiente de la SC',
        'compras1',
        rfq(['PRV-003', 'PRV-009'], {
          lines: [
            {
              product_id: scLines[0].product_id,
              quantity: scLines[0].quantity + 1,
              requisition_line_id: scLines[0].id,
            },
          ],
        }),
      ],
      ['sin ítems', 'compras1', rfq(['PRV-003', 'PRV-009'], { lines: [] })],
      ['Depósito no pide cotizaciones', 'deposito', rfq(['PRV-003', 'PRV-009'])],
    ] as const)
      expect(await createRfq(label, username, r, true), label).toBeNull()

    const rfqId = await createdRfq('solicitud en borrador', 'compras1', rfq(['PRV-003', 'PRV-009', 'PRV-010']), false)
    await ok(
      'enviarla a los proveedores',
      'compras1',
      (c) => E.cmdSendRfq(c, rfqId),
      (b) => b.commands.sendRfq(pg(rfqId)),
    )
    expect(
      await step(
        'enviarla otra vez',
        'compras1',
        (c) => E.cmdSendRfq(c, rfqId),
        (b) => b.commands.sendRfq(pg(rfqId)),
      ),
    ).toBeNull()

    // Cotizaciones: proveedor invitado, una por proveedor, validez, plazos y precios.
    const quote = (
      rfqDoc: string,
      supplierCode: string,
      prices: (number | null)[],
      over: Partial<E.SupplierQuoteInput> = {},
    ) => {
      const items = mock.rfqLines.filter((l) => l.document_id === rfqDoc).sort(byLineNo)
      const input: E.SupplierQuoteInput = {
        rfq_id: rfqDoc,
        supplier_id: supplier(supplierCode),
        supplier_reference: 'P-778',
        valid_until: addDays(todayAR(), 10),
        delivery_days: 5,
        payment_terms_days: 30,
        notes: '',
        lines: items.flatMap((l, i) =>
          prices[i] == null ? [] : [{ rfq_line_id: l.id, unit_price: prices[i]!, vat_rate: 21 }],
        ),
        ...over,
      }
      const pgInput = {
        ...input,
        rfq_id: pg(input.rfq_id),
        supplier_id: pg(input.supplier_id),
        lines: input.lines.map((l) => ({ ...l, rfq_line_id: pg(l.rfq_line_id) })),
      }
      return { input, pgInput }
    }
    const createQuote = (label: string, username: string, q: ReturnType<typeof quote>) =>
      step(
        label,
        username,
        (c) => E.cmdCreateSupplierQuote(c, company, q.input),
        (b) => b.commands.createSupplierQuote(companyPg, q.pgInput),
      )
    const createdQuote = (label: string, username: string, q: ReturnType<typeof quote>) =>
      created(
        label,
        username,
        (c) => E.cmdCreateSupplierQuote(c, company, q.input),
        (b) => b.commands.createSupplierQuote(companyPg, q.pgInput),
      )
    for (const [label, username, q] of [
      ['proveedor no invitado', 'compras1', quote(rfqId, 'PRV-005', [2100, 9000])],
      ['oferta vencida', 'compras1', quote(rfqId, 'PRV-003', [2100, 9000], { valid_until: addDays(todayAR(), -1) })],
      ['precio cero', 'compras1', quote(rfqId, 'PRV-003', [0, 9000])],
      ['precio con cinco decimales', 'compras1', quote(rfqId, 'PRV-003', [2100.12345, 9000])],
      ['plazo de entrega con decimales', 'compras1', quote(rfqId, 'PRV-003', [2100, 9000], { delivery_days: 1.5 })],
      ['condición de pago negativa', 'compras1', quote(rfqId, 'PRV-003', [2100, 9000], { payment_terms_days: -1 })],
      [
        'referencia muy larga',
        'compras1',
        quote(rfqId, 'PRV-003', [2100, 9000], { supplier_reference: 'x'.repeat(41) }),
      ],
      ['sin precios', 'compras1', quote(rfqId, 'PRV-003', [null, null])],
      ['Contabilidad no carga cotizaciones', 'contabilidad', quote(rfqId, 'PRV-003', [2100, 9000])],
    ] as const)
      expect(await createQuote(label, username, q), label).toBeNull()
    const usual = await createdQuote('cotización completa', 'compras1', quote(rfqId, 'PRV-003', [2150, 9300]))
    expect(await createQuote('una por proveedor', 'compras2', quote(rfqId, 'PRV-003', [2000, 9000]))).toBeNull()
    const partial = await createdQuote(
      'cotización que no cotiza todo',
      'compras2',
      quote(rfqId, 'PRV-009', [2050, null], { delivery_days: 2, payment_terms_days: 0 }),
    )
    // El monotributista cotiza el precio final: el IVA se ignora.
    const service = await createdQuote(
      'cotización sin IVA discriminado',
      'compras1',
      quote(rfqId, 'PRV-010', [2300, 9900], { supplier_reference: '' }),
    )
    expect(
      await step(
        'anular una cotización sin motivo',
        'compras1',
        (c) => E.cmdCancelSupplierQuote(c, service, ''),
        (b) => b.commands.cancelSupplierQuote(pg(service), ''),
      ),
    ).toBeNull()
    await ok(
      'anular una cotización',
      'compras1',
      (c) => E.cmdCancelSupplierQuote(c, service, 'El proveedor mandó otra con descuento'),
      (b) => b.commands.cancelSupplierQuote(pg(service), 'El proveedor mandó otra con descuento'),
    )

    // Adjudicar: una que no es la más conveniente exige justificarlo; sólo Compras adjudica.
    const award = (label: string, username: string, quoteId: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdAwardRfq(c, rfqId, quoteId, reason),
        (b) => b.commands.awardRfq(pg(rfqId), pg(quoteId), reason),
      )
    expect(await award('adjudicar la incompleta sin justificar', 'compras1', partial, 'Barata')).toBeNull()
    expect(await award('adjudicar una anulada', 'compras1', service, 'La necesitamos ya mismo')).toBeNull()
    expect(await award('Contabilidad no adjudica', 'contabilidad', usual, '')).toBeNull()
    const order = await created(
      'adjudicar la más conveniente',
      'compras1',
      (c) => E.cmdAwardRfq(c, rfqId, usual, ''),
      (b) => b.commands.awardRfq(pg(rfqId), pg(usual), ''),
    )
    expect(await award('adjudicar otra vez', 'compras1', usual, '')).toBeNull()
    await ok(
      'la OC de la adjudicación sigue su circuito',
      'compras1',
      (c) => E.cmdSubmitPurchaseOrder(c, order),
      (b) => b.commands.submitPurchaseOrder(pg(order)),
    )

    // Otra solicitud que se anula: su cotización queda descartada.
    const dropped = await createdRfq(
      'otra solicitud',
      'compras2',
      rfq(['PRV-003', 'PRV-005'], {
        lines: [{ product_id: product('IN-003').id, quantity: 5, requisition_line_id: null, notes: 'Caja cerrada' }],
      }),
      true,
    )
    await createdQuote('su cotización', 'compras2', quote(dropped, 'PRV-005', [13500]))
    expect(
      await step(
        'anular la solicitud sin motivo',
        'compras1',
        (c) => E.cmdCancelRfq(c, dropped, ''),
        (b) => b.commands.cancelRfq(pg(dropped), ''),
      ),
    ).toBeNull()
    await ok(
      'anular la solicitud',
      'compras1',
      (c) => E.cmdCancelRfq(c, dropped, 'Se compra con la próxima licitación'),
      (b) => b.commands.cancelRfq(pg(dropped), 'Se compra con la próxima licitación'),
    )
    expect(
      await createQuote('cotizar una solicitud anulada', 'compras2', quote(dropped, 'PRV-003', [13000])),
    ).toBeNull()
  })

  it('transferencias entre cuentas: saldo, asiento, borrador y anulación con contraasiento', async () => {
    const companyPg = pg(company)
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const transfer = (from: string, to: string, amount: number, over: Partial<E.FundsTransferInput> = {}) => {
      const input: E.FundsTransferInput = {
        from_account_id: account(from),
        to_account_id: account(to),
        amount,
        reference: 'Boleta 0002-0001',
        notes: '',
        ...over,
      }
      return {
        input,
        pgInput: { ...input, from_account_id: pg(input.from_account_id), to_account_id: pg(input.to_account_id) },
      }
    }
    const create = (label: string, username: string, t: ReturnType<typeof transfer>, confirm: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateFundsTransfer(c, company, t.input, confirm),
        (b) => b.commands.createFundsTransfer(companyPg, t.pgInput, confirm),
      )
    const createdTransfer = (label: string, username: string, t: ReturnType<typeof transfer>, confirm: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreateFundsTransfer(c, company, t.input, confirm),
        (b) => b.commands.createFundsTransfer(companyPg, t.pgInput, confirm),
      )
    const cancel = (label: string, username: string, id: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelFundsTransfer(c, id, reason),
        (b) => b.commands.cancelFundsTransfer(pg(id), reason),
      )

    // Controles: cuentas, importe, referencia, saldo y permisos.
    for (const [label, username, t] of [
      ['la misma cuenta', 'tesoreria', transfer('1.1.01.01', '1.1.01.01', 1000)],
      ['a una cuenta que no es caja ni banco', 'tesoreria', transfer('1.1.01.01', '2.1.01.01', 1000)],
      ['importe cero', 'tesoreria', transfer('1.1.01.01', '1.1.01.03', 0)],
      ['importe con tres decimales', 'tesoreria', transfer('1.1.01.01', '1.1.01.03', 10.005)],
      ['referencia muy larga', 'tesoreria', transfer('1.1.01.01', '1.1.01.03', 1000, { reference: 'x'.repeat(61) })],
      ['más que el saldo de la caja', 'tesoreria', transfer('1.1.01.01', '1.1.01.03', 999999999)],
      ['Contabilidad no transfiere', 'contabilidad', transfer('1.1.01.01', '1.1.01.03', 1000)],
    ] as const)
      expect(await create(label, username, t, true), label).toBeNull()

    // Un borrador sin saldo se guarda pero no se confirma; uno con saldo, sí.
    const short = await createdTransfer(
      'borrador sin saldo',
      'tesoreria',
      transfer('1.1.01.01', '1.1.01.03', 999999999),
      false,
    )
    expect(
      await step(
        'confirmar sin saldo',
        'tesoreria',
        (c) => E.cmdConfirmFundsTransfer(c, short),
        (b) => b.commands.confirmFundsTransfer(pg(short)),
      ),
    ).toBeNull()
    expect(await cancel('anular el borrador', 'tesoreria', short, 'Importe mal cargado')).not.toBeNull()
    const draft = await createdTransfer('borrador', 'tesoreria', transfer('1.1.01.03', '1.1.01.01', 120000), false)
    await ok(
      'confirmarlo',
      'tesoreria',
      (c) => E.cmdConfirmFundsTransfer(c, draft),
      (b) => b.commands.confirmFundsTransfer(pg(draft)),
    )

    // Anular una confirmada: con motivo y si los fondos siguen en el destino.
    expect(await cancel('anular sin motivo', 'tesoreria', draft, '')).toBeNull()
    expect(await cancel('Contabilidad no anula transferencias', 'contabilidad', draft, 'Error')).toBeNull()
    expect(await cancel('anular con contraasiento', 'tesoreria', draft, 'Se extrajo de más')).not.toBeNull()
    const spent = await createdTransfer('a la caja', 'tesoreria', transfer('1.1.01.03', '1.1.01.01', 10000), true)
    const caja = E.accountBalance(mock, account('1.1.01.01'))
    await createdTransfer('vaciar la caja', 'tesoreria', transfer('1.1.01.01', '1.1.01.03', caja), true)
    expect(await cancel('anular cuando los fondos ya se usaron', 'tesoreria', spent, 'Era para otra caja')).toBeNull()
    await createdTransfer('devolver a la caja', 'tesoreria', transfer('1.1.01.03', '1.1.01.01', 10000), true)
    expect(await cancel('anular cuando volvió el saldo', 'tesoreria', spent, 'Era para otra caja')).not.toBeNull()
  })

  it('conciliación bancaria: cierra con lo pendiente, controles y anulación de la última', async () => {
    const companyPg = pg(company)
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const bank = account('1.1.01.03')
    const today = todayAR()
    const open = () => {
      const reconciled = E.reconciledLineIds(mock, bank)
      return E.accountLinesUpTo(mock, bank, today).filter(({ line }) => !reconciled.has(line.id))
    }
    // Las líneas de asientos creados en otras pruebas no están vinculadas: se buscan por asiento y número de línea.
    const pgLine = async (lineId: string) => {
      const line = mock.jeLines.find((l) => l.id === lineId)!
      const entry = mock.documents.find((d) => d.id === line.document_id)!
      const [row] = await db.admin<{ id: string }>(
        `select l.id from public.journal_entry_lines l join public.documents d on d.id = l.document_id
          where d.company_id = $1 and d.display_number = $2 and l.line_no = $3`,
        [companyPg, entry.display_number, line.line_no],
      )
      return row.id
    }
    const input = async (over: Partial<E.BankReconciliationInput>) => {
      const value: E.BankReconciliationInput = {
        account_id: bank,
        statement_date: today,
        statement_balance: 0,
        journal_line_ids: [],
        notes: '',
        ...over,
      }
      const ids: string[] = []
      for (const id of value.journal_line_ids) ids.push(await pgLine(id))
      return { value, pgValue: { ...value, account_id: pg(value.account_id), journal_line_ids: ids } }
    }
    const reconcile = async (label: string, username: string, over: Partial<E.BankReconciliationInput>) => {
      const r = await input(over)
      return step(
        label,
        username,
        (c) => E.cmdCreateBankReconciliation(c, company, r.value),
        (b) => b.commands.createBankReconciliation(companyPg, r.pgValue),
      )
    }
    // El cheque de la demo sigue sin debitar: todo lo demás figura en el extracto.
    const cheque = mock.documents.find((d) => d.doc_type === 'PAYMENT_ORDER' && d.op?.payment_reference === '00000451')!
    const lines = open()
    const pendingCheque = lines.find(
      ({ doc, line }) => line.credit === cheque.total && doc.je!.description.includes('00000451'),
    )!
    const marked = lines.filter((l) => l !== pendingCheque).map(({ line }) => line.id)
    const book = E.round2(
      E.accountLinesUpTo(mock, bank, today).reduce((s, { line }) => s + line.debit - line.credit, 0),
    )
    const statement = E.round2(book + cheque.total)

    for (const [label, username, over] of [
      ['Tesorería no concilia', 'tesoreria', { statement_balance: statement, journal_line_ids: marked }],
      ['un extracto a futuro', 'contabilidad', { statement_date: '2999-12-31' }],
      ['antes de la última conciliación', 'contabilidad', { statement_date: `${today.slice(0, 4)}-01-01` }],
      ['saldo con tres decimales', 'contabilidad', { statement_balance: 10.005 }],
      [
        'una línea de otra cuenta',
        'contabilidad',
        { journal_line_ids: [E.accountLinesUpTo(mock, account('1.1.01.01'), today)[0].line.id] },
      ],
      ['la misma línea dos veces', 'contabilidad', { journal_line_ids: [marked[0], marked[0]] }],
      ['no cierra', 'contabilidad', { statement_balance: statement + 100, journal_line_ids: marked }],
      ['una cuenta que no es caja ni banco', 'contabilidad', { account_id: account('2.1.01.01') }],
    ] as const)
      expect(await reconcile(label, username, over as Partial<E.BankReconciliationInput>), label).toBeNull()

    const r = await input({ statement_balance: statement, journal_line_ids: marked, notes: 'Extracto de octubre' })
    const reconciliation = await created(
      'conciliar con el cheque pendiente',
      'contabilidad',
      (c) => E.cmdCreateBankReconciliation(c, company, r.value),
      (b) => b.commands.createBankReconciliation(companyPg, r.pgValue),
    )
    const first = mock.documents.find(
      (d) => d.doc_type === 'BANK_RECONCILIATION' && d.br?.account_id === bank && d.id !== reconciliation,
    )!
    const cancel = (label: string, id: string, reason: string) =>
      step(
        label,
        'contabilidad',
        (c) => E.cmdCancelBankReconciliation(c, id, reason),
        (b) => b.commands.cancelBankReconciliation(pg(id), reason),
      )
    expect(await cancel('anular una que no es la última', first.id, 'Error')).toBeNull()
    expect(await cancel('anular sin motivo', reconciliation, '')).toBeNull()
    expect(
      await step(
        'Tesorería no anula conciliaciones',
        'tesoreria',
        (c) => E.cmdCancelBankReconciliation(c, reconciliation, 'Error'),
        (b) => b.commands.cancelBankReconciliation(pg(reconciliation), 'Error'),
      ),
    ).toBeNull()
    // Se lee antes de anularla: el cheque figura como pendiente en esta conciliación.
    await sameRead(
      'cheques emitidos con la conciliación confirmada',
      'tesoreria',
      (b) => b.api.issuedCheques(companyPg),
      (u) => Q.issuedCheques(mock, u, company),
    )
    expect(await cancel('anular la última', reconciliation, 'Se tomó el extracto de otra cuenta')).not.toBeNull()
  })

  it('ventas: pedidos con crédito y reserva de stock, remitos con costo de lo vendido y anulaciones', async () => {
    const companyPg = pg(company)
    const customer = (code: string) => mock.customers.find((c) => c.company_id === company && c.code === code)!.id
    const salesOrder = (
      customerCode: string,
      lines: [string, number, number?][],
      over: Partial<E.SalesOrderInput> = {},
    ) => {
      const input: E.SalesOrderInput = {
        customer_id: customer(customerCode),
        warehouse_id: warehouse('DEP-PT'),
        delivery_date: null,
        payment_terms_days: 30,
        customer_reference: '',
        notes: '',
        lines: lines.map(([code, quantity, price]) => ({
          product_id: product(code).id,
          quantity,
          unit_price: price ?? product(code).sale_price!,
        })),
        ...over,
      }
      return {
        input,
        pgInput: {
          ...input,
          customer_id: pg(input.customer_id),
          warehouse_id: pg(input.warehouse_id),
          lines: input.lines.map((l) => ({ ...l, product_id: pg(l.product_id) })),
        },
      }
    }
    const create = (label: string, username: string, o: ReturnType<typeof salesOrder>, confirm: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateSalesOrder(c, company, o.input, confirm),
        (b) => b.commands.createSalesOrder(companyPg, o.pgInput, confirm),
      )
    const createdOrder = (label: string, username: string, o: ReturnType<typeof salesOrder>, confirm: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreateSalesOrder(c, company, o.input, confirm),
        (b) => b.commands.createSalesOrder(companyPg, o.pgInput, confirm),
      )
    const status = (id: string) => mock.documents.find((d) => d.id === id)!.status
    const orderLines = (orderId: string) =>
      mock.soLines.filter((l) => l.document_id === orderId).sort((a, b) => a.line_no - b.line_no)
    const delivery = (orderId: string, quantities: number[]) => {
      const input: E.DeliveryNoteInput = {
        sales_order_id: orderId,
        carrier_name: 'Transporte propio',
        notes: '',
        lines: orderLines(orderId).map((l, i) => ({ so_line_id: l.id, quantity: quantities[i] ?? 0 })),
      }
      return {
        input,
        pgInput: {
          ...input,
          sales_order_id: pg(orderId),
          lines: input.lines.map((l) => ({ ...l, so_line_id: pg(l.so_line_id) })),
        },
      }
    }
    const deliver = (label: string, username: string, d: ReturnType<typeof delivery>, confirm: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateDeliveryNote(c, company, d.input, confirm),
        (b) => b.commands.createDeliveryNote(companyPg, d.pgInput, confirm),
      )
    const createdDelivery = (label: string, username: string, d: ReturnType<typeof delivery>, confirm: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreateDeliveryNote(c, company, d.input, confirm),
        (b) => b.commands.createDeliveryNote(companyPg, d.pgInput, confirm),
      )
    const cancelDelivery = (label: string, username: string, id: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelDeliveryNote(c, id, reason),
        (b) => b.commands.cancelDeliveryNote(pg(id), reason),
      )
    const orderAction = (
      label: string,
      username: string,
      id: string,
      action: 'confirm' | 'approve' | 'reject' | 'cancel' | 'close',
      text = '',
    ) =>
      step(
        label,
        username,
        (c) =>
          action === 'confirm'
            ? E.cmdConfirmSalesOrder(c, id)
            : action === 'approve'
              ? E.cmdApproveSalesOrder(c, id, text)
              : action === 'reject'
                ? E.cmdRejectSalesOrder(c, id, text)
                : action === 'cancel'
                  ? E.cmdCancelSalesOrder(c, id, text)
                  : E.cmdCloseSalesOrder(c, id, text),
        (b) =>
          action === 'confirm'
            ? b.commands.confirmSalesOrder(pg(id))
            : action === 'approve'
              ? b.commands.approveSalesOrder(pg(id), text)
              : action === 'reject'
                ? b.commands.rejectSalesOrder(pg(id), text)
                : action === 'cancel'
                  ? b.commands.cancelSalesOrder(pg(id), text)
                  : b.commands.closeSalesOrder(pg(id), text),
      )
    const reads = async (label: string) => {
      for (const username of ['ventas', 'deposito', 'gerencia']) {
        await sameRead(
          `clientes para vender ${label} (${username})`,
          username,
          (b) => b.api.salesCustomers(companyPg),
          (u) => Q.salesCustomers(mock, u, company),
        )
        await sameRead(
          `catálogo de venta ${label} (${username})`,
          username,
          (b) => b.api.salesCatalog(companyPg),
          (u) => Q.salesCatalog(mock, u, company),
        )
        await sameRead(
          `pedidos para despachar ${label} (${username})`,
          username,
          (b) => b.api.dispatchableOrders(companyPg),
          (u) => Q.dispatchableOrders(mock, u, company),
        )
      }
    }

    // Controles del pedido: qué se vende, cantidades, precios, fechas, condición y permisos.
    const yesterday = addDays(todayAR(), -1)
    for (const [label, username, o] of [
      ['una materia prima no se vende', 'ventas', salesOrder('CLI-004', [['MP-001', 10, 2000]])],
      [
        'el mismo producto dos veces',
        'ventas',
        salesOrder('CLI-004', [
          ['PT-002', 1],
          ['PT-002', 2],
        ]),
      ],
      ['precio cero', 'ventas', salesOrder('CLI-004', [['PT-002', 1, 0]])],
      ['precio con cinco decimales', 'ventas', salesOrder('CLI-004', [['PT-002', 1, 10.00001]])],
      ['cantidad con cuatro decimales', 'ventas', salesOrder('CLI-004', [['PT-002', 1.0001]])],
      ['entrega en el pasado', 'ventas', salesOrder('CLI-004', [['PT-002', 1]], { delivery_date: yesterday })],
      ['fecha de entrega inválida', 'ventas', salesOrder('CLI-004', [['PT-002', 1]], { delivery_date: '2027-13-40' })],
      ['condición de pago de 400 días', 'ventas', salesOrder('CLI-004', [['PT-002', 1]], { payment_terms_days: 400 })],
      [
        'referencia muy larga',
        'ventas',
        salesOrder('CLI-004', [['PT-002', 1]], { customer_reference: 'x'.repeat(61) }),
      ],
      ['sin ítems', 'ventas', salesOrder('CLI-004', [])],
      ['Compras no vende', 'compras1', salesOrder('CLI-004', [['PT-002', 1]])],
    ] as const)
      expect(await create(label, username, o, false), label).toBeNull()

    // Falta de stock: el borrador se guarda, pero no se confirma más de lo disponible.
    const available = (code: string) =>
      Q.salesCatalog(mock, mockId('ventas'), company)
        .find((p) => p.code === code)!
        .stock.find((s) => s.warehouse_id === warehouse('DEP-PT'))!.available
    const short = await createdOrder(
      'pedido de más mesas que las disponibles',
      'ventas',
      salesOrder('CLI-004', [['PT-001', available('PT-001') + 1]]),
      false,
    )
    expect(await orderAction('confirmar sin stock', 'ventas', short, 'confirm')).toBeNull()
    expect(await orderAction('anular el borrador', 'ventas', short, 'cancel', 'Falta stock')).not.toBeNull()

    // Dentro del crédito queda confirmado; si lo supera, lo autoriza Gerencia.
    const big = await createdOrder(
      'pedido con flete, dentro del crédito',
      'ventas',
      salesOrder(
        'CLI-004',
        [
          ['PT-002', 5],
          ['SV-001', 1, 40000],
        ],
        { delivery_date: addDays(todayAR(), 7), customer_reference: 'OC 7781', notes: 'Entregar en obra' },
      ),
      true,
    )
    expect(status(big)).toBe('CONFIRMADO')
    const credit = await createdOrder(
      'pedido que supera el crédito',
      'ventas',
      salesOrder('CLI-007', [['MR-001', 5]]),
      true,
    )
    expect(status(credit)).toBe('PENDIENTE_APROBACION')
    await reads('con los pedidos confirmados')
    expect(await orderAction('Ventas no autoriza créditos', 'ventas', credit, 'approve')).toBeNull()
    expect(await orderAction('rechazar sin motivo', 'gerencia', credit, 'reject', '')).toBeNull()
    expect(await deliver('no se despacha un pedido sin autorizar', 'deposito', delivery(credit, [1]), false)).toBeNull()
    await ok(
      'Gerencia autoriza el crédito',
      'gerencia',
      (c) => E.cmdApproveSalesOrder(c, credit, 'Paga siempre'),
      (b) => b.commands.approveSalesOrder(pg(credit), 'Paga siempre'),
    )

    // Controles del remito.
    for (const [label, username, d] of [
      ['más de lo que falta entregar', 'deposito', delivery(big, [6, 0])],
      ['todo en cero', 'deposito', delivery(big, [0, 0])],
      ['una cantidad negativa', 'deposito', delivery(big, [-1, 1])],
      ['Ventas no despacha', 'ventas', delivery(big, [1, 0])],
    ] as const)
      expect(await deliver(label, username, d, false), label).toBeNull()

    // En preparación, el pedido no se anula; despachado, baja el stock y registra el costo.
    const partial = await createdDelivery('remito en preparación', 'deposito', delivery(big, [2, 1]), false)
    expect(await orderAction('anular con un remito en preparación', 'ventas', big, 'cancel', 'Error')).toBeNull()
    await ok(
      'despacharlo',
      'deposito',
      (c) => E.cmdConfirmDeliveryNote(c, partial),
      (b) => b.commands.confirmDeliveryNote(pg(partial)),
    )
    expect(status(big)).toBe('ENTREGADO_PARCIAL')
    expect(await cancelDelivery('quien despachó no anula', 'deposito', partial, 'Error de carga')).toBeNull()
    expect(await cancelDelivery('anular sin motivo', 'gerencia', partial, '')).toBeNull()
    expect(
      await cancelDelivery('Gerencia lo anula con contramovimiento', 'gerencia', partial, 'Volvió todo'),
    ).not.toBeNull()
    expect(status(big)).toBe('CONFIRMADO')
    const full = await createdDelivery('entregar todo', 'deposito', delivery(big, [5, 1]), true)
    expect(status(big)).toBe('ENTREGADO')
    expect(await orderAction('anular un pedido entregado', 'ventas', big, 'cancel', 'Error')).toBeNull()

    // Entregado en parte y cerrado: su remito ya no se anula.
    const closing = await createdDelivery('entregar dos colchones', 'deposito', delivery(credit, [2]), true)
    expect(await orderAction('cerrar sin motivo', 'ventas', credit, 'close', '')).toBeNull()
    expect(
      await orderAction('cerrar el saldo', 'ventas', credit, 'close', 'El cliente no recibe el resto'),
    ).not.toBeNull()
    expect(status(credit)).toBe('CERRADO')
    expect(await cancelDelivery('anular el remito de un pedido cerrado', 'gerencia', closing, 'Error')).toBeNull()
    await reads('después de las entregas')

    // Facturas de venta: controles, numeración por letra (A al responsable inscripto, B al exento) y anulación.
    const invoiceInput = (orderId: string, quantities: number[]) => {
      const input: E.SalesInvoiceInput = {
        sales_order_id: orderId,
        notes: '',
        lines: orderLines(orderId).map((l, i) => ({ so_line_id: l.id, quantity: quantities[i] ?? 0 })),
      }
      return {
        input,
        pgInput: {
          ...input,
          sales_order_id: pg(orderId),
          lines: input.lines.map((l) => ({ ...l, so_line_id: pg(l.so_line_id) })),
        },
      }
    }
    const createInvoice = (label: string, username: string, inv: ReturnType<typeof invoiceInput>, register: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateSalesInvoice(c, company, inv.input, register),
        (b) => b.commands.createSalesInvoice(companyPg, inv.pgInput, register),
      )
    const createdInvoice = (label: string, username: string, inv: ReturnType<typeof invoiceInput>, register: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreateSalesInvoice(c, company, inv.input, register),
        (b) => b.commands.createSalesInvoice(companyPg, inv.pgInput, register),
      )
    const cancelInvoice = (label: string, username: string, id: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelSalesInvoice(c, id, reason),
        (b) => b.commands.cancelSalesInvoice(pg(id), reason),
      )
    const waiting = await createdOrder(
      'pedido todavía sin entregar',
      'ventas',
      salesOrder('CLI-010', [['PT-002', 1]]),
      true,
    )
    for (const [label, username, inv] of [
      ['más de lo entregado', 'ventas', invoiceInput(big, [6, 1])],
      ['todo en cero', 'ventas', invoiceInput(big, [0, 0])],
      ['una cantidad negativa', 'ventas', invoiceInput(big, [-1, 1])],
      ['Tesorería no factura', 'tesoreria', invoiceInput(big, [5, 1])],
      ['un pedido sin entregas', 'ventas', invoiceInput(waiting, [1])],
    ] as const)
      expect(await createInvoice(label, username, inv, true), label).toBeNull()
    const first = await createdInvoice('factura A de una parte', 'ventas', invoiceInput(big, [3, 1]), true)
    const rest = await createdInvoice('borrador del resto', 'ventas', invoiceInput(big, [2, 0]), false)
    expect(
      await createInvoice('facturar de más con un borrador pendiente', 'ventas', invoiceInput(big, [3, 0]), false),
    ).toBeNull()
    await ok(
      'registrar el borrador',
      'ventas',
      (c) => E.cmdConfirmSalesInvoice(c, rest),
      (b) => b.commands.confirmSalesInvoice(pg(rest)),
    )
    const exempt = await createdInvoice('factura B al exento', 'ventas', invoiceInput(credit, [2]), true)
    expect(mock.documents.find((d) => d.id === exempt)!.fv!.letter).toBe('B')
    expect(await cancelDelivery('anular un remito ya facturado', 'gerencia', full, 'Error de carga')).toBeNull()
    expect(await cancelInvoice('anular sin motivo', 'ventas', first, '')).toBeNull()
    expect(await cancelInvoice('Tesorería no anula facturas', 'tesoreria', first, 'Error de carga')).toBeNull()
    expect(
      await cancelInvoice('anular con contraasiento', 'ventas', first, 'Se facturó con el precio viejo'),
    ).not.toBeNull()
    for (const username of ['ventas', 'tesoreria', 'gerencia']) {
      await sameRead(
        `pedidos para facturar (${username})`,
        username,
        (b) => b.api.invoiceableSalesOrders(companyPg),
        (u) => Q.invoiceableSalesOrders(mock, u, company),
      )
      await sameRead(
        `cuentas corrientes de clientes (${username})`,
        username,
        (b) => b.api.receivables(companyPg),
        (u) => Q.listReceivables(mock, u, company),
      )
      for (const code of ['CLI-004', 'CLI-007'])
        await sameRead(
          `cuenta corriente de ${code} (${username})`,
          username,
          (b) => b.api.customerAccount(companyPg, pg(customer(code))),
          (u) => Q.customerAccount(mock, u, company, customer(code)),
        )
    }
    await reads('con las facturas')
  })

  it('cobros: recibo con su asiento, estados de la factura, separación de funciones, fondos y anulación', async () => {
    const companyPg = pg(company)
    const customer = (code: string) => mock.customers.find((c) => c.company_id === company && c.code === code)!.id
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const status = (id: string) => mock.documents.find((d) => d.id === id)!.status
    const invoiceOf = (code: string, statuses: string[]) =>
      mock.documents
        .filter(
          (d) => d.doc_type === 'SALES_INVOICE' && d.customer_id === customer(code) && statuses.includes(d.status),
        )
        .sort((a, b) => a.number - b.number)[0]
    // De la prueba de ventas: la factura A del resto a CLI-004, la anulada y la B al exento CLI-007.
    const a = invoiceOf('CLI-004', ['REGISTRADA'])
    const cancelled = invoiceOf('CLI-004', ['ANULADA'])
    const exempt = invoiceOf('CLI-007', ['REGISTRADA'])
    // La de la demo (CLI-001), cobrada en parte y con otra parte reservada en un borrador del escenario.
    const demo = invoiceOf('CLI-001', ['COBRADA_PARCIAL'])
    const receipt = (
      invoiceId: string | null,
      amount: number,
      over: Partial<E.CustomerReceiptInput> = {},
      extra: { invoice_id: string; amount: number }[] = [],
    ) => {
      const input: E.CustomerReceiptInput = {
        customer_id: invoiceId ? mock.documents.find((d) => d.id === invoiceId)!.customer_id! : customer('CLI-004'),
        treasury_account_id: account('1.1.01.03'),
        payment_method: 'TRANSFERENCIA',
        reference: '',
        notes: '',
        lines: [...(invoiceId ? [{ invoice_id: invoiceId, amount }] : []), ...extra],
        ...over,
      }
      const pgInput = {
        ...input,
        customer_id: pg(input.customer_id),
        treasury_account_id: pg(input.treasury_account_id),
        lines: input.lines.map((l) => ({ ...l, invoice_id: pg(l.invoice_id) })),
      }
      return { input, pgInput }
    }
    const create = (label: string, username: string, r: ReturnType<typeof receipt>, confirm: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateCustomerReceipt(c, company, r.input, confirm),
        (b) => b.commands.createCustomerReceipt(companyPg, r.pgInput, confirm),
      )
    const createdReceipt = (label: string, username: string, r: ReturnType<typeof receipt>, confirm: boolean) =>
      created(
        label,
        username,
        (c) => E.cmdCreateCustomerReceipt(c, company, r.input, confirm),
        (b) => b.commands.createCustomerReceipt(companyPg, r.pgInput, confirm),
      )
    const confirm = (label: string, username: string, id: string) =>
      step(
        label,
        username,
        (c) => E.cmdConfirmCustomerReceipt(c, id),
        (b) => b.commands.confirmCustomerReceipt(pg(id)),
      )
    const cancel = (label: string, username: string, id: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelCustomerReceipt(c, id, reason),
        (b) => b.commands.cancelCustomerReceipt(pg(id), reason),
      )
    const reads = async (label: string) => {
      for (const username of ['tesoreria', 'ventas', 'gerencia']) {
        await sameRead(
          `cuentas corrientes de clientes ${label} (${username})`,
          username,
          (b) => b.api.receivables(companyPg),
          (u) => Q.listReceivables(mock, u, company),
        )
        for (const code of ['CLI-001', 'CLI-004', 'CLI-007'])
          await sameRead(
            `cuenta corriente de ${code} ${label} (${username})`,
            username,
            (b) => b.api.customerAccount(companyPg, pg(customer(code))),
            (u) => Q.customerAccount(mock, u, company, customer(code)),
          )
      }
      for (const code of ['CLI-001', 'CLI-004', 'CLI-007'])
        await sameRead(
          `facturas para cobrar de ${code} ${label}`,
          'tesoreria',
          (b) => b.api.receiptCandidates(companyPg, pg(customer(code))),
          (u) => Q.receiptCandidates(mock, u, company, customer(code)),
        )
      await sameRead(
        `flujo de fondos proyectado ${label}`,
        'tesoreria',
        (b) => b.api.cashProjection(companyPg),
        (u) => Q.cashProjection(mock, u, company),
      )
      const month = todayAR().slice(0, 8)
      await sameRead(
        `flujo de fondos del mes ${label}`,
        'tesoreria',
        (b) => b.api.cashFlow(companyPg, `${month}01`, todayAR()),
        (u) => Q.cashFlow(mock, u, company, `${month}01`, todayAR()),
      )
    }

    // Controles: quién cobra, el medio, la cuenta, las facturas del cliente y los importes.
    const remaining = E.round2(E.salesInvoicePending(mock, demo) - E.salesInvoiceCommitted(mock, demo.id))
    for (const [label, username, r] of [
      ['Ventas no cobra', 'ventas', receipt(a.id, 1000)],
      ['cheque sin número', 'tesoreria', receipt(a.id, 1000, { payment_method: 'CHEQUE' })],
      ['cheque con letras', 'tesoreria', receipt(a.id, 1000, { payment_method: 'CHEQUE', reference: 'Cheque 1' })],
      ['un medio que no existe', 'tesoreria', receipt(a.id, 1000, { payment_method: 'GIRO' as never })],
      ['referencia muy larga', 'tesoreria', receipt(a.id, 1000, { reference: 'x'.repeat(61) })],
      [
        'una cuenta que no es caja ni banco',
        'tesoreria',
        receipt(a.id, 1000, { treasury_account_id: account('1.1.03.01') }),
      ],
      ['factura de otro cliente', 'tesoreria', receipt(a.id, 1000, { customer_id: customer('CLI-002') })],
      ['importe con tres decimales', 'tesoreria', receipt(a.id, 10.005)],
      ['más que el saldo', 'tesoreria', receipt(a.id, a.total + 1)],
      ['más que lo que no está reservado', 'tesoreria', receipt(demo.id, remaining + 0.01)],
      ['sin facturas', 'tesoreria', receipt(null, 0)],
      ['la misma factura dos veces', 'tesoreria', receipt(a.id, 1000, {}, [{ invoice_id: a.id, amount: 1000 }])],
      ['una factura anulada', 'tesoreria', receipt(cancelled.id, 1000)],
    ] as const)
      expect(await create(label, username, r, true), label).toBeNull()

    // Un cobro parcial por transferencia, y el resto en borrador: la factura no se anula mientras lo reserva.
    const partial = await createdReceipt(
      'cobro parcial',
      'tesoreria',
      receipt(a.id, 100000, { reference: 'TRF 1201' }),
      true,
    )
    expect(status(partial)).toBe('CONFIRMADO')
    expect(status(a.id)).toBe('COBRADA_PARCIAL')
    const rest = await createdReceipt(
      'el resto, en borrador',
      'tesoreria',
      receipt(a.id, E.round2(a.total - 100000), {
        payment_method: 'EFECTIVO',
        treasury_account_id: account('1.1.01.01'),
      }),
      false,
    )
    expect(
      await step(
        'anular una factura cobrada en parte',
        'ventas',
        (c) => E.cmdCancelSalesInvoice(c, a.id, 'Error de carga'),
        (b) => b.commands.cancelSalesInvoice(pg(a.id), 'Error de carga'),
      ),
    ).toBeNull()
    await reads('con un cobro parcial y un borrador')

    // Separación de funciones: ventas emitió la factura; con el rol de Tesorería tampoco la puede cobrar.
    const tes = mock.sectors.find((s) => s.company_id === company && s.code === 'TES')!.id
    await ok(
      'el docente le suma Tesorería a ventas',
      'docente',
      (c) => E.cmdAssignRole(c, company, mockId('ventas'), 'TESORERIA', tes),
      (b) => b.commands.assignRole(companyPg, pg(mockId('ventas')), 'TESORERIA', pg(tes)),
    )
    expect(await confirm('cobrar una factura que emitió', 'ventas', rest)).toBeNull()
    await sameRead(
      'el recibo, como quien emitió la factura',
      'ventas',
      (b) => b.api.document(companyPg, 'CUSTOMER_RECEIPT', mock.documents.find((d) => d.id === rest)!.display_number),
      (u) =>
        Q.documentDetail(
          mock,
          u,
          company,
          'CUSTOMER_RECEIPT',
          mock.documents.find((d) => d.id === rest)!.display_number,
        ),
    )
    expect(await confirm('confirmar el resto', 'tesoreria', rest)).not.toBeNull()
    expect(await confirm('confirmarlo otra vez', 'tesoreria', rest)).toBeNull()
    expect(status(a.id)).toBe('COBRADA')

    // Un cheque del cliente a Valores a depositar: si ya se depositó, el cobro no se anula.
    const cheque = await createdReceipt(
      'cobro con cheque',
      'tesoreria',
      receipt(exempt.id, exempt.total, {
        payment_method: 'CHEQUE',
        reference: '00009876',
        treasury_account_id: account('1.1.01.04'),
      }),
      true,
    )
    expect(status(exempt.id)).toBe('COBRADA')
    const depositInput: E.FundsTransferInput = {
      from_account_id: account('1.1.01.04'),
      to_account_id: account('1.1.01.03'),
      amount: exempt.total,
      reference: 'Depósito del cheque 00009876',
      notes: '',
    }
    const deposit = await created(
      'depositar el cheque',
      'tesoreria',
      (c) => E.cmdCreateFundsTransfer(c, company, depositInput, true),
      (b) =>
        b.commands.createFundsTransfer(
          companyPg,
          {
            ...depositInput,
            from_account_id: pg(depositInput.from_account_id),
            to_account_id: pg(depositInput.to_account_id),
          },
          true,
        ),
    )
    expect(await cancel('anular sin motivo', 'tesoreria', cheque, '')).toBeNull()
    expect(await cancel('anular un cobro ya depositado', 'tesoreria', cheque, 'El cheque fue rechazado')).toBeNull()
    expect(await cancel('Gerencia no anula cobros', 'gerencia', cheque, 'El cheque fue rechazado')).toBeNull()
    await ok(
      'anular el depósito',
      'tesoreria',
      (c) => E.cmdCancelFundsTransfer(c, deposit, 'El banco rechazó el cheque'),
      (b) => b.commands.cancelFundsTransfer(pg(deposit), 'El banco rechazó el cheque'),
    )
    expect(await cancel('anular el cobro', 'tesoreria', cheque, 'El cheque fue rechazado')).not.toBeNull()
    expect(status(exempt.id)).toBe('REGISTRADA')
    expect(await cancel('anularlo otra vez', 'tesoreria', cheque, 'Error')).toBeNull()

    // Un borrador se anula sin más y libera lo que reservaba.
    const draft = await createdReceipt('un borrador', 'tesoreria', receipt(exempt.id, 1000), false)
    expect(
      await step(
        'anular una factura en un recibo en borrador',
        'ventas',
        (c) => E.cmdCancelSalesInvoice(c, exempt.id, 'Error de carga'),
        (b) => b.commands.cancelSalesInvoice(pg(exempt.id), 'Error de carga'),
      ),
    ).toBeNull()
    expect(await cancel('anular el borrador', 'tesoreria', draft, 'El cliente pagó otro importe')).not.toBeNull()
    await reads('después de los cobros')
  })

  it('listas de precios y presupuestos: precios, ajustes, la lista del cliente y el pedido que nace de la aceptación', async () => {
    const companyPg = pg(company)
    const customer = (code: string) => mock.customers.find((c) => c.company_id === company && c.code === code)!
    const status = (id: string) => mock.documents.find((d) => d.id === id)!.status
    const listInput = (over: Partial<E.PriceListInput> = {}): E.PriceListInput => ({
      code: 'MIN',
      name: 'Minorista',
      description: 'Para el mostrador',
      copy_from: 'SALE_PRICE',
      percent: 10,
      ...over,
    })
    const createList = (label: string, username: string, input: E.PriceListInput) =>
      step(
        label,
        username,
        (c) => E.cmdCreatePriceList(c, company, input),
        (b) =>
          b.commands.createPriceList(companyPg, {
            ...input,
            copy_from: mock.priceLists.some((l) => l.id === input.copy_from) ? pg(input.copy_from) : input.copy_from,
          }),
      )
    const setPrice = (label: string, username: string, listId: string, code: string, price: number | null) =>
      step(
        label,
        username,
        (c) => E.cmdSetPriceListPrice(c, company, listId, product(code).id, price),
        (b) => b.commands.setPriceListPrice(companyPg, pg(listId), pg(product(code).id), price),
      )
    const adjust = (label: string, username: string, listId: string, percent: number) =>
      step(
        label,
        username,
        (c) => E.cmdAdjustPriceList(c, company, listId, percent),
        (b) => b.commands.adjustPriceList(companyPg, pg(listId), percent),
      )
    const setActive = (label: string, listId: string, active: boolean) =>
      step(
        label,
        'ventas',
        (c) => E.cmdSetPriceListActive(c, company, listId, active),
        (b) => b.commands.setPriceListActive(companyPg, pg(listId), active),
      )
    const assign = (label: string, code: string, listId: string) =>
      step(
        label,
        'ventas',
        (c) =>
          E.cmdSaveMaster(c, 'customer', company, {
            id: customer(code).id,
            code,
            legal_name: customer(code).legal_name,
            price_list_id: listId,
          }),
        (b) =>
          b.commands.saveMaster('customer', companyPg, {
            id: pg(customer(code).id),
            code,
            legal_name: customer(code).legal_name,
            price_list_id: listId ? pg(listId) : '',
          }),
      )
    const reads = async (label: string) => {
      for (const username of ['ventas', 'gerencia', 'contabilidad']) {
        await sameRead(
          `listas de precios ${label} (${username})`,
          username,
          (b) => b.api.priceLists(companyPg),
          (u) => Q.listPriceLists(mock, u, company),
        )
        for (const code of ['MAY', 'MIN'])
          await sameRead(
            `lista ${code} ${label} (${username})`,
            username,
            (b) => b.api.priceList(companyPg, code),
            (u) => Q.priceListDetail(mock, u, company, code),
          )
      }
      await sameRead(
        `clientes para vender ${label}`,
        'ventas',
        (b) => b.api.salesCustomers(companyPg),
        (u) => Q.salesCustomers(mock, u, company),
      )
      await sameRead(
        `catálogo de venta ${label}`,
        'ventas',
        (b) => b.api.salesCatalog(companyPg),
        (u) => Q.salesCatalog(mock, u, company),
      )
    }

    // Listas: controles, una nueva copiada de los precios de venta y sus cambios.
    for (const [label, username, input] of [
      ['Tesorería no arma listas', 'tesoreria', listInput()],
      ['código con espacios', 'ventas', listInput({ code: 'MIN 2' })],
      ['código repetido', 'ventas', listInput({ code: 'MAY' })],
      ['nombre de una letra', 'ventas', listInput({ name: 'M' })],
      ['porcentaje de -90', 'ventas', listInput({ percent: -90 })],
      ['porcentaje con tres decimales', 'ventas', listInput({ percent: 1.005 })],
      ['copiar de una lista que no existe', 'ventas', listInput({ copy_from: crypto.randomUUID() })],
    ] as const)
      expect(await createList(label, username, input), label).toBeNull()
    const newList = await ok(
      'lista minorista: los precios de venta con un 10 % más',
      'ventas',
      (c) => E.cmdCreatePriceList(c, company, listInput()),
      (b) => b.commands.createPriceList(companyPg, listInput()),
    )
    loaded.link(newList.mock.id, (newList.pg as { id: string }).id)
    const min = newList.mock.id
    expect(await setPrice('una materia prima no va en la lista', 'ventas', min, 'MP-001', 1000)).toBeNull()
    expect(await setPrice('precio con tres decimales', 'ventas', min, 'PT-001', 1000.005)).toBeNull()
    expect(await setPrice('Depósito no cambia precios', 'deposito', min, 'PT-001', 1000)).toBeNull()
    expect(await setPrice('cambiar un precio', 'ventas', min, 'PT-002', 140000)).not.toBeNull()
    expect(await setPrice('el mismo precio otra vez', 'ventas', min, 'PT-002', 140000)).not.toBeNull()
    expect(await setPrice('sacar el flete', 'ventas', min, 'SV-001', null)).not.toBeNull()
    expect(await setPrice('sacarlo otra vez', 'ventas', min, 'SV-001', null)).toBeNull()
    expect(await setPrice('volver a agregarlo', 'ventas', min, 'SV-001', 50000)).not.toBeNull()
    expect(await adjust('ajuste de cero', 'ventas', min, 0)).toBeNull()
    expect(await adjust('ajuste de -95 %', 'ventas', min, -95)).toBeNull()
    expect(await adjust('subir la lista un 3,5 %', 'ventas', min, 3.5)).not.toBeNull()
    await ok(
      'cambiarle el nombre',
      'ventas',
      (c) => E.cmdUpdatePriceList(c, company, min, { name: 'Minorista 2027', description: '' }),
      (b) => b.commands.updatePriceList(companyPg, pg(min), { name: 'Minorista 2027', description: '' }),
    )
    await reads('con la lista minorista')

    // La lista del cliente: una desactivada no se asigna; sin lista, vuelve al precio de venta.
    expect(await setActive('desactivar la minorista', min, false)).not.toBeNull()
    expect(await assign('asignar una lista inactiva', 'CLI-005', min)).toBeNull()
    expect(await setActive('activarla de nuevo', min, true)).not.toBeNull()
    expect(await assign('asignarla a CLI-005', 'CLI-005', min)).not.toBeNull()
    expect(await assign('sacarle la lista a CLI-008', 'CLI-008', '')).not.toBeNull()
    expect(customer('CLI-005').price_list_id).toBe(min)
    await reads('con la lista asignada')

    // Presupuestos: controles, enviado, rechazado sin motivo, aceptado (genera el pedido) y vencido.
    const quoteInput = (code: string, lines: [string, number][], over: Partial<E.SalesQuoteInput> = {}) => {
      const input: E.SalesQuoteInput = {
        customer_id: customer(code).id,
        warehouse_id: warehouse('DEP-PT'),
        valid_until: addDays(todayAR(), 10),
        payment_terms_days: 15,
        customer_reference: 'Pedido de precios 77',
        notes: '',
        lines: lines.map(([p, quantity]) => ({
          product_id: product(p).id,
          quantity,
          unit_price: E.listPriceFor(mock, customer(code), product(p)),
        })),
        ...over,
      }
      return {
        input,
        pgInput: {
          ...input,
          customer_id: pg(input.customer_id),
          warehouse_id: pg(input.warehouse_id),
          lines: input.lines.map((l) => ({ ...l, product_id: pg(l.product_id) })),
        },
      }
    }
    const createQuote = (label: string, username: string, q: ReturnType<typeof quoteInput>, send: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateSalesQuote(c, company, q.input, send),
        (b) => b.commands.createSalesQuote(companyPg, q.pgInput, send),
      )
    const createdQuote = (label: string, q: ReturnType<typeof quoteInput>, send: boolean) =>
      created(
        label,
        'ventas',
        (c) => E.cmdCreateSalesQuote(c, company, q.input, send),
        (b) => b.commands.createSalesQuote(companyPg, q.pgInput, send),
      )
    const quoteAction = (
      label: string,
      username: string,
      id: string,
      action: 'send' | 'reject' | 'expire' | 'cancel',
      text = '',
    ) =>
      step(
        label,
        username,
        (c) =>
          action === 'send'
            ? E.cmdSendSalesQuote(c, id)
            : action === 'reject'
              ? E.cmdRejectSalesQuote(c, id, text)
              : action === 'expire'
                ? E.cmdExpireSalesQuote(c, id)
                : E.cmdCancelSalesQuote(c, id, text),
        (b) =>
          action === 'send'
            ? b.commands.sendSalesQuote(pg(id))
            : action === 'reject'
              ? b.commands.rejectSalesQuote(pg(id), text)
              : action === 'expire'
                ? b.commands.expireSalesQuote(pg(id))
                : b.commands.cancelSalesQuote(pg(id), text),
      )
    for (const [label, username, q] of [
      ['Depósito no presupuesta', 'deposito', quoteInput('CLI-005', [['PT-001', 1]])],
      ['validez vencida', 'ventas', quoteInput('CLI-005', [['PT-001', 1]], { valid_until: addDays(todayAR(), -1) })],
      ['validez inválida', 'ventas', quoteInput('CLI-005', [['PT-001', 1]], { valid_until: '2027-02-30' })],
      ['una materia prima no se vende', 'ventas', quoteInput('CLI-005', [['MP-001', 1]])],
      ['sin ítems', 'ventas', quoteInput('CLI-005', [])],
    ] as const)
      expect(await createQuote(label, username, q, false), label).toBeNull()
    const first = await createdQuote(
      'presupuesto a CLI-005 con los precios de su lista',
      quoteInput('CLI-005', [
        ['PT-002', 6],
        ['SV-001', 1],
      ]),
      false,
    )
    expect(await quoteAction('dar por vencido un borrador', 'ventas', first, 'expire')).toBeNull()
    expect(await quoteAction('enviarlo', 'ventas', first, 'send')).not.toBeNull()
    expect(await quoteAction('enviarlo otra vez', 'ventas', first, 'send')).toBeNull()
    expect(await quoteAction('rechazar sin motivo', 'ventas', first, 'reject', '')).toBeNull()
    expect(await quoteAction('darlo por vencido estando vigente', 'ventas', first, 'expire')).toBeNull()
    // La lista cambia después: el pedido toma los precios del presupuesto.
    expect(await adjust('subir la minorista otra vez', 'ventas', min, 2)).not.toBeNull()
    const order = await created(
      'el cliente lo acepta: se genera el pedido',
      'ventas',
      (c) => E.cmdAcceptSalesQuote(c, first),
      (b) => b.commands.acceptSalesQuote(pg(first)),
    )
    expect(status(first)).toBe('ACEPTADO')
    expect(status(order)).toBe('BORRADOR')
    expect(mock.soLines.filter((l) => l.document_id === order).map((l) => l.list_price)).toEqual(
      mock.qtLines.filter((l) => l.document_id === first).map((l) => l.list_price),
    )

    const declined = await createdQuote('otro, enviado', quoteInput('CLI-003', [['PT-004', 1]]), true)
    expect(
      await quoteAction('el cliente no acepta', 'ventas', declined, 'reject', 'Lo compra el año que viene'),
    ).not.toBeNull()
    const late = await createdQuote('uno que vence', quoteInput('CLI-009', [['PT-002', 2]]), true)
    const past = addDays(todayAR(), -3)
    mock.documents.find((d) => d.id === late)!.qt!.valid_until = past
    await db.admin('update public.sales_quotes set valid_until = $1 where document_id = $2', [past, pg(late)])
    expect(
      await step(
        'aceptar un presupuesto vencido',
        'ventas',
        (c) => E.cmdAcceptSalesQuote(c, late),
        (b) => b.commands.acceptSalesQuote(pg(late)),
      ),
    ).toBeNull()
    expect(await quoteAction('Contabilidad no lo da por vencido', 'contabilidad', late, 'expire')).toBeNull()
    expect(await quoteAction('darlo por vencido', 'ventas', late, 'expire')).not.toBeNull()
    const draft = await createdQuote('un borrador', quoteInput('CLI-004', [['MR-001', 1]]), false)
    expect(await quoteAction('anularlo sin motivo', 'ventas', draft, 'cancel', '')).toBeNull()
    expect(await quoteAction('anularlo', 'ventas', draft, 'cancel', 'Se cargó al cliente equivocado')).not.toBeNull()
    await reads('después de los presupuestos')
  })

  it('producción: centros de trabajo, listas de materiales y órdenes (liberar, entregar, terminar y anular) con sus asientos', async () => {
    const companyPg = pg(company)
    const status = (id: string) => mock.documents.find((d) => d.id === id)!.status
    const bomOf = (code: string) => mock.boms.find((b) => b.product_id === product(code).id)!
    const center = (code: string) => mock.workCenters.find((w) => w.company_id === company && w.code === code)!
    const bomInput = (code: string, lines: [string, number][], notes = '', operations: [string, number][] = []) => ({
      product_id: product(code).id,
      notes,
      lines: lines.map(([c, quantity]) => ({ component_id: product(c).id, quantity })),
      operations: operations.map(([c, hours]) => ({ work_center_id: center(c).id, hours })),
    })
    const saveBom = (label: string, username: string, input: ReturnType<typeof bomInput>) =>
      step(
        label,
        username,
        (c) => E.cmdSaveBom(c, company, input),
        (b) =>
          b.commands.saveBom(companyPg, {
            ...input,
            product_id: pg(input.product_id),
            lines: input.lines.map((l) => ({ ...l, component_id: pg(l.component_id) })),
            operations: input.operations.map((o) => ({ ...o, work_center_id: pg(o.work_center_id) })),
          }),
      )
    const saveCenter = (label: string, username: string, input: E.WorkCenterInput) =>
      step(
        label,
        username,
        (c) => E.cmdSaveWorkCenter(c, company, input),
        (b) => b.commands.saveWorkCenter(companyPg, { ...input, id: input.id ? pg(input.id) : '' }),
      )
    const centerInput = (over: Partial<E.WorkCenterInput> = {}): E.WorkCenterInput => ({
      id: '',
      code: 'LUSTRE',
      name: 'Lustre a muñeca',
      labor_rate: 9500,
      overhead_rate: 1500,
      ...over,
    })
    const setBomActive = (label: string, code: string, active: boolean) =>
      step(
        label,
        'produccion',
        (c) => E.cmdSetBomActive(c, company, bomOf(code).id, active),
        (b) => b.commands.setBomActive(companyPg, pg(bomOf(code).id), active),
      )
    const orderInput = (code: string, quantity: number, over: Partial<E.ProductionOrderInput> = {}) => {
      const input: E.ProductionOrderInput = {
        product_id: product(code).id,
        quantity,
        materials_warehouse_id: warehouse('DEP-MP'),
        output_warehouse_id: warehouse('DEP-PT'),
        due_date: addDays(todayAR(), 5),
        notes: 'Para reponer el showroom',
        ...over,
      }
      const known = (id: string) => (mock.warehouses.some((w) => w.id === id) ? pg(id) : id)
      return {
        input,
        pgInput: {
          ...input,
          product_id: pg(input.product_id),
          materials_warehouse_id: known(input.materials_warehouse_id),
          output_warehouse_id: known(input.output_warehouse_id),
        },
      }
    }
    const createOrder = (label: string, username: string, o: ReturnType<typeof orderInput>, release: boolean) =>
      step(
        label,
        username,
        (c) => E.cmdCreateProductionOrder(c, company, o.input, release),
        (b) => b.commands.createProductionOrder(companyPg, o.pgInput, release),
      )
    const createdOrder = (label: string, o: ReturnType<typeof orderInput>, release: boolean) =>
      created(
        label,
        'produccion',
        (c) => E.cmdCreateProductionOrder(c, company, o.input, release),
        (b) => b.commands.createProductionOrder(companyPg, o.pgInput, release),
      )
    const issue = (
      label: string,
      username: string,
      id: string,
      quantity: (code: string, planned: number) => number,
    ) => {
      const lines = mock.prdLines
        .filter((l) => l.document_id === id)
        .sort((a, b) => a.line_no - b.line_no)
        .map((l) => ({ line_id: l.id, quantity: quantity(codeOf(l.product_id), l.quantity_planned) }))
      return step(
        label,
        username,
        (c) => E.cmdIssueProductionOrder(c, id, { lines }),
        (b) => b.commands.issueProductionOrder(pg(id), { lines: lines.map((l) => ({ ...l, line_id: pg(l.line_id) })) }),
      )
    }
    const codeOf = (productId: string) => mock.products.find((p) => p.id === productId)!.code
    const reads = async (label: string) => {
      await sameRead(
        `centros de trabajo ${label}`,
        'contabilidad',
        (b) => b.api.workCenters(companyPg),
        (u) => Q.listWorkCenters(mock, u, company),
      )
      for (const username of ['produccion', 'deposito', 'contabilidad'])
        await sameRead(
          `listas de materiales ${label} (${username})`,
          username,
          (b) => b.api.boms(companyPg),
          (u) => Q.listBoms(mock, u, company),
        )
      for (const code of ['PT-002', 'PT-004'])
        await sameRead(
          `lista de ${code} ${label}`,
          'compras1',
          (b) => b.api.bom(companyPg, code),
          (u) => Q.bomDetail(mock, u, company, code),
        )
      await sameRead(
        `lo que se puede fabricar ${label}`,
        'produccion',
        (b) => b.api.productionCatalog(companyPg),
        (u) => Q.productionCatalog(mock, u, company),
      )
      await sameRead(
        `stock ${label}`,
        'deposito',
        (b) => b.api.stock(companyPg),
        (u) => Q.listStock(mock, u, company),
      )
    }

    // Centros de trabajo: controles, uno nuevo, su modificación (y una sin cambios) y uno desactivado.
    for (const [label, username, input] of [
      ['Contabilidad no los arma', 'contabilidad', centerInput()],
      ['código con espacios', 'produccion', centerInput({ code: 'CON ESPACIOS' })],
      ['código repetido', 'produccion', centerInput({ code: 'CORTE' })],
      ['nombre de una letra', 'produccion', centerInput({ name: 'X' })],
      ['tarifa negativa', 'produccion', centerInput({ labor_rate: -1 })],
      ['tasa con tres decimales', 'produccion', centerInput({ overhead_rate: 10.005 })],
    ] as const)
      expect(await saveCenter(label, username, input), label).toBeNull()
    const lustre = await saveCenter('el centro de lustre', 'produccion', centerInput())
    expect(lustre).not.toBeNull()
    loaded.link(lustre!.mock.id, (lustre!.pg as { id: string }).id)
    const lustreId = lustre!.mock.id
    expect(await saveCenter('sin cambios', 'produccion', centerInput({ id: lustreId }))).not.toBeNull()
    expect(
      await saveCenter('subirle la tarifa', 'produccion', centerInput({ id: lustreId, labor_rate: 10000 })),
    ).not.toBeNull()
    const setCenterActive = (label: string, active: boolean) =>
      step(
        label,
        'produccion',
        (c) => E.cmdSetWorkCenterActive(c, company, lustreId, active),
        (b) => b.commands.setWorkCenterActive(companyPg, pg(lustreId), active),
      )
    expect(await setCenterActive('desactivarlo', false)).not.toBeNull()
    expect(
      await saveBom(
        'una lista con un centro inactivo',
        'produccion',
        bomInput('PT-002', [['MP-002', 18]], '', [['LUSTRE', 1]]),
      ),
    ).toBeNull()
    expect(await setCenterActive('activarlo de nuevo', true)).not.toBeNull()

    // Listas de materiales: controles, una modificación, una igual (no cambia nada) y una desactivada.
    for (const [label, username, input] of [
      ['Ventas no arma listas', 'ventas', bomInput('PT-004', [['MP-002', 60]])],
      ['un producto que no es terminado', 'produccion', bomInput('MR-001', [['MP-001', 1]])],
      ['un componente que no es materia prima ni insumo', 'produccion', bomInput('PT-004', [['PT-001', 1]])],
      [
        'un componente repetido',
        'produccion',
        bomInput('PT-004', [
          ['MP-002', 1],
          ['MP-002', 2],
        ]),
      ],
      ['una cantidad en cero', 'produccion', bomInput('PT-004', [['MP-002', 0]])],
      ['una cantidad con cuatro decimales', 'produccion', bomInput('PT-004', [['MP-002', 0.0005]])],
      ['sin componentes', 'produccion', bomInput('PT-004', [])],
      [
        'un centro repetido',
        'produccion',
        bomInput('PT-004', [['MP-002', 60]], '', [
          ['CORTE', 1],
          ['CORTE', 2],
        ]),
      ],
      ['horas en cero', 'produccion', bomInput('PT-004', [['MP-002', 60]], '', [['CORTE', 0]])],
      ['horas con cuatro decimales', 'produccion', bomInput('PT-004', [['MP-002', 60]], '', [['CORTE', 0.0005]])],
    ] as const)
      expect(await saveBom(label, username, input), label).toBeNull()
    expect(
      await saveBom(
        'la cama con una placa entera',
        'produccion',
        bomInput(
          'PT-004',
          [
            ['MP-002', 60],
            ['MP-003', 30],
            ['MP-006', 1],
            ['IN-002', 1.5],
          ],
          'Base de fenólico entera',
          [
            ['CORTE', 1.5],
            ['ARMADO', 2],
            ['LUSTRE', 0.75],
          ],
        ),
      ),
    ).not.toBeNull()
    const bed = mock.bomLines
      .filter((l) => l.bom_id === bomOf('PT-004').id)
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => [codeOf(l.component_id), l.quantity] as [string, number])
    expect(
      await saveBom(
        'la misma lista otra vez',
        'produccion',
        bomInput('PT-004', bed, 'Base de fenólico entera', [
          ['CORTE', 1.5],
          ['ARMADO', 2],
          ['LUSTRE', 0.75],
        ]),
      ),
    ).not.toBeNull()
    expect(await setBomActive('desactivar la lista de la cama', 'PT-004', false)).not.toBeNull()
    expect(await createOrder('una cama sin lista activa', 'produccion', orderInput('PT-004', 1), false)).toBeNull()
    expect(await setBomActive('activarla de nuevo', 'PT-004', true)).not.toBeNull()
    await reads('con la lista de la cama modificada')

    // Órdenes: controles de la planificación.
    for (const [label, username, o] of [
      ['Ventas no planifica', 'ventas', orderInput('PT-002', 1)],
      ['cantidad en cero', 'produccion', orderInput('PT-002', 0)],
      ['cantidad con cuatro decimales', 'produccion', orderInput('PT-002', 1.0005)],
      ['fecha prevista pasada', 'produccion', orderInput('PT-002', 1, { due_date: addDays(todayAR(), -1) })],
      ['fecha que no existe', 'produccion', orderInput('PT-002', 1, { due_date: '2027-02-30' })],
      [
        'depósito de otra empresa',
        'produccion',
        orderInput('PT-002', 1, { materials_warehouse_id: crypto.randomUUID() }),
      ],
      ['una materia prima no se fabrica', 'produccion', orderInput('MP-001', 1)],
    ] as const)
      expect(await createOrder(label, username, o, false), label).toBeNull()

    // Faltan placas: se planifica pero no se libera.
    const placards = await createdOrder('diez placards', orderInput('PT-003', 10), false)
    expect(
      await step(
        'liberarla sin placas',
        'produccion',
        (c) => E.cmdReleaseProductionOrder(c, placards),
        (b) => b.commands.releaseProductionOrder(pg(placards)),
      ),
    ).toBeNull()
    expect(status(placards)).toBe('BORRADOR')

    // Una mesa: liberar, entregar (con dos pies de tabla de más) y terminar.
    const table = await createdOrder('una mesa, liberada al crearla', orderInput('PT-001', 1), true)
    expect(status(table)).toBe('LIBERADA')
    expect(await issue('Producción no entrega materiales', 'produccion', table, (_c, q) => q)).toBeNull()
    expect(await issue('sin cantidades', 'deposito', table, () => 0)).toBeNull()
    expect(await issue('una cantidad negativa', 'deposito', table, () => -1)).toBeNull()
    expect(await issue('más de lo que hay', 'deposito', table, (_c, q) => q * 1000)).toBeNull()
    expect(
      await step(
        'un material que no es de la orden',
        'deposito',
        (c) => E.cmdIssueProductionOrder(c, table, { lines: [{ line_id: crypto.randomUUID(), quantity: 1 }] }),
        (b) => b.commands.issueProductionOrder(pg(table), { lines: [{ line_id: crypto.randomUUID(), quantity: 1 }] }),
      ),
    ).toBeNull()
    expect(
      await issue('Depósito entrega con dos pies de tabla de más', 'deposito', table, (c, q) =>
        c === 'MP-001' ? q + 2 : q,
      ),
    ).not.toBeNull()
    expect(status(table)).toBe('EN_PROCESO')
    const finish = (
      label: string,
      username: string,
      id: string,
      quantity: number,
      hours: { operation_id: string; hours: number }[] = [],
    ) =>
      step(
        label,
        username,
        (c) => E.cmdFinishProductionOrder(c, id, quantity, hours),
        (b) =>
          b.commands.finishProductionOrder(
            pg(id),
            quantity,
            hours.map((h) => ({
              ...h,
              operation_id: mock.prdOperations.some((o) => o.id === h.operation_id)
                ? pg(h.operation_id)
                : h.operation_id,
            })),
          ),
      )
    const tableOperations = mock.prdOperations
      .filter((o) => o.document_id === table)
      .sort((a, b) => a.line_no - b.line_no)
    expect(await finish('Depósito no la termina', 'deposito', table, 1)).toBeNull()
    expect(await finish('más de lo planificado', 'produccion', table, 2)).toBeNull()
    expect(await finish('cero unidades', 'produccion', table, 0)).toBeNull()
    expect(
      await finish('horas de otra orden', 'produccion', table, 1, [{ operation_id: crypto.randomUUID(), hours: 1 }]),
    ).toBeNull()
    expect(
      await finish('horas negativas', 'produccion', table, 1, [{ operation_id: tableOperations[0].id, hours: -1 }]),
    ).toBeNull()
    expect(
      await finish('un centro dos veces', 'produccion', table, 1, [
        { operation_id: tableOperations[0].id, hours: 2 },
        { operation_id: tableOperations[0].id, hours: 3 },
      ]),
    ).toBeNull()
    // En corte se trabajaron 3 horas (estaban previstas 2,5); en los demás, lo previsto.
    expect(
      await finish('terminarla con las horas reales', 'produccion', table, 1, [
        { operation_id: tableOperations[0].id, hours: 3 },
      ]),
    ).not.toBeNull()
    expect(status(table)).toBe('TERMINADA')
    await sameRead(
      'costos de producción del día',
      'contabilidad',
      (b) => b.api.productionCosts(companyPg, todayAR(), todayAR()),
      (u) => Q.productionCosts(mock, u, company, todayAR(), todayAR()),
    )
    const cancel = (label: string, id: string, reason: string) =>
      step(
        label,
        'produccion',
        (c) => E.cmdCancelProductionOrder(c, id, reason),
        (b) => b.commands.cancelProductionOrder(pg(id), reason),
      )
    expect(await cancel('una terminada no se anula', table, 'Me equivoqué')).toBeNull()

    // Anular: la planificada sin motivo no; con motivo sí. La de la demo, entregada y anulada.
    expect(await cancel('sin motivo', placards, '')).toBeNull()
    expect(await cancel('los placards', placards, 'Se compran hechos')).not.toBeNull()
    const demo = mock.documents.find((d) => d.company_id === company && d.display_number === 'OPR-00001')!.id
    expect(await issue('entregar los materiales de la demo', 'deposito', demo, (_c, q) => q)).not.toBeNull()
    expect(await cancel('anularla con devolución', demo, 'Se rompió la sierra')).not.toBeNull()
    expect(status(demo)).toBe('ANULADA')
    await reads('después de las órdenes')
  })

  it('necesidades de materiales: lo que falta de las planificadas y la solicitud de compra vinculada', async () => {
    const companyPg = pg(company)
    const ordersIn = (...statuses: string[]) =>
      mock.documents
        .filter((d) => d.company_id === company && d.doc_type === 'PRODUCTION_ORDER' && statuses.includes(d.status))
        .map((d) => d.id)
    // Quinientos placards: seguro faltan placas, más allá de lo que ya pidieron las pruebas anteriores.
    const input: E.ProductionOrderInput = {
      product_id: product('PT-003').id,
      quantity: 500,
      materials_warehouse_id: warehouse('DEP-MP'),
      output_warehouse_id: warehouse('DEP-PT'),
      due_date: addDays(todayAR(), 9),
      notes: 'Para una licitación',
    }
    await created(
      'planificar quinientos placards',
      'produccion',
      (c) => E.cmdCreateProductionOrder(c, company, input, false),
      (b) =>
        b.commands.createProductionOrder(
          companyPg,
          {
            ...input,
            product_id: pg(input.product_id),
            materials_warehouse_id: pg(input.materials_warehouse_id),
            output_warehouse_id: pg(input.output_warehouse_id),
          },
          false,
        ),
    )
    const planned = ordersIn('BORRADOR')
    expect(planned.length).toBeGreaterThan(1)
    const numberOf = (id: string) => mock.documents.find((d) => d.id === id)!.display_number
    const needs = async (label: string) => {
      await sameRead(
        `necesidades ${label}`,
        'produccion',
        (b) => b.api.productionNeeds(companyPg),
        (u) => Q.productionNeedsView(mock, u, company),
      )
      for (const id of planned)
        await sameRead(
          `necesidades de ${numberOf(id)} ${label}`,
          'deposito',
          (b) => b.api.productionNeeds(companyPg, [pg(id)]),
          (u) => Q.productionNeedsView(mock, u, company, [id]),
        )
    }
    const request = (label: string, username: string, ids: string[]) =>
      step(
        label,
        username,
        (c) => E.cmdRequestProductionMaterials(c, company, ids),
        (b) => b.commands.requestProductionMaterials(companyPg, ids.map(pg)),
      )
    const requestCreated = (label: string, username: string, ids: string[]) =>
      created(
        label,
        username,
        (c) => E.cmdRequestProductionMaterials(c, company, ids),
        (b) => b.commands.requestProductionMaterials(companyPg, ids.map(pg)),
      )
    const details = async (label: string, ids: string[]) => {
      for (const id of ids) {
        const d = mock.documents.find((x) => x.id === id)!
        await sameRead(
          `${d.display_number} ${label}`,
          'produccion',
          (b) => b.api.document(companyPg, d.doc_type, d.display_number),
          (u) => Q.documentDetail(mock, u, company, d.doc_type, d.display_number),
        )
      }
    }
    await needs('al empezar')

    // Quién pide y qué órdenes.
    expect(await request('ventas no pide materiales', 'ventas', planned)).toBeNull()
    expect(await request('compras tampoco', 'compras1', planned)).toBeNull()
    expect(await request('sin órdenes', 'produccion', [])).toBeNull()
    for (const id of ordersIn('LIBERADA', 'EN_PROCESO', 'TERMINADA', 'ANULADA').slice(0, 3))
      expect(await request(`${numberOf(id)} no está planificada`, 'produccion', [id])).toBeNull()

    // Pedir los faltantes: una solicitud en borrador, vinculada a las órdenes que los necesitan.
    const sc = await requestCreated('pedir los faltantes', 'produccion', planned)
    await details('con lo pedido', [sc, ...planned])
    await needs('con lo pedido')
    expect(await request('ya está todo pedido', 'produccion', planned)).toBeNull()

    // Anulada, el faltante vuelve; lo pide Depósito.
    expect(
      await step(
        'anular la solicitud',
        'produccion',
        (c) => E.cmdCancelRequisition(c, sc, 'Se pidió de más'),
        (b) => b.commands.cancelRequisition(pg(sc), 'Se pidió de más'),
      ),
    ).not.toBeNull()
    await needs('con la solicitud anulada')
    const again = await requestCreated('Depósito los pide', 'deposito', planned)
    await details('pedidos por Depósito', [again])
    await needs('pedidos otra vez')
  })

  it('personal: categorías y legajos (alta, cambios, validaciones y baja)', async () => {
    const companyPg = pg(company)
    const inCompany = <R extends { company_id: string; code: string }>(rows: R[], code: string) =>
      rows.find((r) => r.company_id === company && r.code === code)!
    /** El id de la base si el registro existe; si no (vacío o inventado), tal cual. */
    const known = (id: string | null) =>
      id && [...mock.jobCategories, ...mock.sectors, ...mock.workCenters, ...mock.employees].some((x) => x.id === id)
        ? pg(id)
        : id
    const reads = async (label: string) => {
      for (const username of ['rrhh', 'gerencia'])
        await sameRead(
          `categorías ${label} (${username})`,
          username,
          (b) => b.api.jobCategories(companyPg),
          (u) => Q.listJobCategories(mock, u, company),
        )
      for (const username of ['rrhh', 'auditor'])
        await sameRead(
          `legajos ${label} (${username})`,
          username,
          (b) => b.api.employees(companyPg),
          (u) => Q.listEmployees(mock, u, company),
        )
    }
    await reads('al empezar')

    // Categorías.
    const categoryInput = (over: Partial<E.JobCategoryInput> = {}): E.JobCategoryInput => ({
      id: '',
      code: 'BARNIZADOR',
      name: 'Barnizador',
      basic_salary: 1080000.5,
      is_direct_labor: true,
      ...over,
    })
    const saveCategory = (label: string, username: string, input: E.JobCategoryInput) =>
      step(
        label,
        username,
        (c) => E.cmdSaveJobCategory(c, company, input),
        (b) => b.commands.saveJobCategory(companyPg, { ...input, id: known(input.id) ?? '' }),
      )
    expect(await saveCategory('Producción no lleva las categorías', 'produccion', categoryInput())).toBeNull()
    for (const [label, over] of [
      ['un código repetido', { code: 'OFICIAL' }],
      ['un código con espacios', { code: 'con espacios' }],
      ['un nombre corto', { name: 'B' }],
      ['un sueldo de cero', { basic_salary: 0 }],
      ['un sueldo con tres decimales', { basic_salary: 1000.555 }],
      ['sin decir si es del taller', { is_direct_labor: 'sí' as unknown as boolean }],
      ['una categoría que no existe', { id: crypto.randomUUID() }],
    ] as [string, Partial<E.JobCategoryInput>][])
      expect(await saveCategory(label, 'rrhh', categoryInput(over)), label).toBeNull()
    const created = await saveCategory('la categoría de barnizador', 'rrhh', categoryInput())
    expect(created).not.toBeNull()
    loaded.link(created!.mock.id, (created!.pg as { id: string }).id)
    const barnizador = created!.mock.id
    expect(await saveCategory('sin cambios', 'rrhh', categoryInput({ id: barnizador }))).not.toBeNull()
    expect(
      await saveCategory('un aumento', 'rrhh', categoryInput({ id: barnizador, basic_salary: 1120000 })),
    ).not.toBeNull()
    const oficial = inCompany(mock.jobCategories, 'OFICIAL')
    expect(
      await saveCategory(
        'el oficial, con personal activo, no deja de ser del taller',
        'rrhh',
        categoryInput({
          id: oficial.id,
          code: 'OFICIAL',
          name: oficial.name,
          basic_salary: oficial.basic_salary,
          is_direct_labor: false,
        }),
      ),
    ).toBeNull()
    const setActive = (label: string, id: string, active: boolean) =>
      step(
        label,
        'rrhh',
        (c) => E.cmdSetJobCategoryActive(c, company, id, active),
        (b) => b.commands.setJobCategoryActive(companyPg, pg(id), active),
      )
    expect(await setActive('desactivar el barnizador', barnizador, false)).not.toBeNull()
    expect(await setActive('desactivarlo otra vez', barnizador, false)).not.toBeNull()
    await reads('con las categorías')

    // Legajos.
    const employeeInput = (over: Partial<E.EmployeeInput> = {}): E.EmployeeInput => ({
      id: '',
      first_name: 'Mirta',
      last_name: 'Sosa Benítez',
      hire_date: addDays(todayAR(), -10),
      category_id: inCompany(mock.jobCategories, 'AYUDANTE').id,
      sector_id: inCompany(mock.sectors, 'PRO').id,
      work_center_id: inCompany(mock.workCenters, 'CORTE').id,
      ...over,
    })
    const saveEmployee = (label: string, username: string, input: E.EmployeeInput) =>
      step(
        label,
        username,
        (c) => E.cmdSaveEmployee(c, company, input),
        (b) =>
          b.commands.saveEmployee(companyPg, {
            ...input,
            id: known(input.id) ?? '',
            category_id: known(input.category_id) ?? '',
            sector_id: known(input.sector_id) ?? '',
            work_center_id: known(input.work_center_id),
          }),
      )
    expect(await saveEmployee('Gerencia no da de alta', 'gerencia', employeeInput())).toBeNull()
    for (const [label, over] of [
      ['un nombre corto', { first_name: 'M' }],
      ['sin apellido', { last_name: ' ' }],
      ['una fecha que no existe', { hire_date: '2027-02-30' }],
      ['un ingreso futuro', { hire_date: addDays(todayAR(), 1) }],
      ['un ingreso antes del inicio de actividades', { hire_date: '2015-03-01' }],
      ['sin categoría', { category_id: '' }],
      ['una categoría inactiva', { category_id: barnizador }],
      ['sin sector', { sector_id: '' }],
      ['del taller sin centro', { work_center_id: null }],
      [
        'administrativo con centro',
        { category_id: inCompany(mock.jobCategories, 'ADMIN').id, sector_id: inCompany(mock.sectors, 'CON').id },
      ],
      ['un legajo que no existe', { id: crypto.randomUUID() }],
    ] as [string, Partial<E.EmployeeInput>][])
      expect(await saveEmployee(label, 'rrhh', employeeInput(over)), label).toBeNull()
    const hired = await saveEmployee('el alta', 'rrhh', employeeInput())
    expect(hired).not.toBeNull()
    loaded.link(hired!.mock.id, (hired!.pg as { id: string }).id)
    const mirta = hired!.mock.id
    expect(await saveEmployee('sin cambios', 'rrhh', employeeInput({ id: mirta }))).not.toBeNull()
    expect(
      await saveEmployee(
        'pasa a medio oficial en armado',
        'rrhh',
        employeeInput({
          id: mirta,
          category_id: inCompany(mock.jobCategories, 'MEDIO-OF').id,
          work_center_id: inCompany(mock.workCenters, 'ARMADO').id,
        }),
      ),
    ).not.toBeNull()
    await reads('con el alta')

    const terminate = (label: string, username: string, date: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdTerminateEmployee(c, company, mirta, date, reason),
        (b) => b.commands.terminateEmployee(companyPg, pg(mirta), date, reason),
      )
    expect(await terminate('Contabilidad no da de baja', 'contabilidad', todayAR(), 'Renuncia')).toBeNull()
    expect(await terminate('antes del ingreso', 'rrhh', addDays(todayAR(), -11), 'Renuncia')).toBeNull()
    expect(await terminate('una fecha futura', 'rrhh', addDays(todayAR(), 1), 'Renuncia')).toBeNull()
    expect(await terminate('una fecha que no existe', 'rrhh', '2027-13-01', 'Renuncia')).toBeNull()
    expect(await terminate('sin motivo', 'rrhh', todayAR(), ' ')).toBeNull()
    expect(await terminate('la baja', 'rrhh', todayAR(), 'Renuncia para mudarse')).not.toBeNull()
    expect(await terminate('otra vez', 'rrhh', todayAR(), 'Renuncia')).toBeNull()
    expect(await saveEmployee('después de la baja no se modifica', 'rrhh', employeeInput({ id: mirta }))).toBeNull()
    await reads('con la baja')
  })

  it('liquidación de sueldos: crear, novedades, confirmar con su asiento, anular y los porcentajes del docente', async () => {
    const companyPg = pg(company)
    const month = (offset: number) => {
      const d = new Date(`${todayAR().slice(0, 7)}-15T12:00:00Z`)
      d.setUTCMonth(d.getUTCMonth() + offset)
      return d.toISOString().slice(0, 7)
    }
    const payrolls = () => mock.documents.filter((d) => d.company_id === company && d.doc_type === 'PAYROLL')
    const reads = async (label: string) => {
      for (const d of payrolls())
        await sameRead(
          `${d.display_number} ${label}`,
          'rrhh',
          (b) => b.api.document(companyPg, 'PAYROLL', d.display_number),
          (u) => Q.documentDetail(mock, u, company, 'PAYROLL', d.display_number),
        )
      await sameRead(
        `liquidaciones ${label}`,
        'tesoreria',
        (b) => b.api.documents(companyPg, 'PAYROLL'),
        (u) => Q.listDocuments(mock, u, company, 'PAYROLL'),
      )
    }
    await reads('al empezar')

    // Crearla: quién y con qué datos.
    const input = (over: Partial<E.PayrollInput> = {}): E.PayrollInput => ({
      period: month(-2),
      payment_date: `${month(-1)}-04`,
      notes: '',
      ...over,
    })
    const create = (label: string, username: string, data: E.PayrollInput) =>
      step(
        label,
        username,
        (c) => E.cmdCreatePayroll(c, company, data),
        (b) => b.commands.createPayroll(companyPg, data),
      )
    expect(await create('Contabilidad no liquida', 'contabilidad', input())).toBeNull()
    for (const [label, over] of [
      ['un mes mal escrito', { period: '2026-1' }],
      ['un mes que no empezó', { period: month(1), payment_date: `${month(1)}-28` }],
      ['antes del inicio de actividades', { period: '2015-02', payment_date: '2015-03-04' }],
      ['un mes ya liquidado', { period: month(0), payment_date: `${month(1)}-05` }],
      ['una fecha de pago que no existe', { payment_date: '2026-02-30' }],
      ['una fecha de pago anterior al mes', { payment_date: `${month(-3)}-28` }],
    ] as [string, Partial<E.PayrollInput>][])
      expect(await create(label, 'rrhh', input(over)), label).toBeNull()
    const createdPayroll = (label: string, data: E.PayrollInput) =>
      created(
        label,
        'rrhh',
        (c) => E.cmdCreatePayroll(c, company, data),
        (b) => b.commands.createPayroll(companyPg, data),
      )
    const older = await createdPayroll('la de hace dos meses', input())

    // Novedades.
    const lines = E.payrollLines(mock, older)
    type Row = E.PayrollLineInput
    const update = (label: string, username: string, docId: string, rows: Row[]) =>
      step(
        label,
        username,
        (c) => E.cmdUpdatePayrollLines(c, docId, rows),
        (b) =>
          b.commands.updatePayrollLines(
            pg(docId),
            rows.map((r) => ({
              ...r,
              line_id: mock.pyLines.some((l) => l.id === r.line_id) ? pg(r.line_id) : r.line_id,
            })),
          ),
      )
    const row = (i: number, over: Partial<Row> = {}): Row => ({
      line_id: lines[i].id,
      days_worked: 30,
      absence_days: 0,
      overtime_50: 0,
      overtime_100: 0,
      ...over,
    })
    expect(await update('Contabilidad no carga novedades', 'contabilidad', older, [row(0)])).toBeNull()
    for (const [label, rows] of [
      ['31 días', [row(0, { days_worked: 31 })]],
      ['días y ausencias que pasan de 30', [row(0, { days_worked: 29, absence_days: 2 })]],
      ['medio día', [row(0, { days_worked: 29.5 })]],
      ['250 horas extra', [row(1, { overtime_50: 250 })]],
      ['horas con tres decimales', [row(1, { overtime_100: 1.555 })]],
      ['un empleado de otra liquidación', [{ ...row(0), line_id: E.payrollLines(mock, payrolls()[0].id)[0].id }]],
      ['un empleado dos veces', [row(0), row(0)]],
    ] as [string, Row[]][])
      expect(await update(label, 'rrhh', older, rows), label).toBeNull()
    expect(
      await update('las novedades del mes', 'rrhh', older, [
        row(0, { days_worked: 27, absence_days: 3 }),
        row(1, { overtime_50: 6.5, overtime_100: 2 }),
        row(3, { days_worked: 0 }),
      ]),
    ).not.toBeNull()
    await reads('con las novedades')

    // Confirmar y anular.
    const confirm = (label: string, username: string, docId: string) =>
      step(
        label,
        username,
        (c) => E.cmdConfirmPayroll(c, docId),
        (b) => b.commands.confirmPayroll(pg(docId)),
      )
    const cancel = (label: string, username: string, docId: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelPayroll(c, docId, reason),
        (b) => b.commands.cancelPayroll(pg(docId), reason),
      )
    expect(await confirm('Tesorería no la confirma', 'tesoreria', older)).toBeNull()
    expect(await confirm('confirmarla', 'rrhh', older)).not.toBeNull()
    expect(await confirm('otra vez', 'rrhh', older)).toBeNull()
    expect(await update('confirmada, sin novedades', 'rrhh', older, [row(0)])).toBeNull()
    expect(await cancel('sin motivo', 'rrhh', older, ' ')).toBeNull()
    expect(await cancel('Tesorería no la anula', 'tesoreria', older, 'Error de cálculo')).toBeNull()
    expect(await cancel('anularla con su contraasiento', 'rrhh', older, 'Faltaban las horas extra')).not.toBeNull()
    const draft = payrolls().find((d) => d.status === 'BORRADOR')!
    expect(await cancel('el borrador sin motivo', 'rrhh', draft.id, '')).toBeNull()
    expect(await cancel('el borrador', 'rrhh', draft.id, 'Se rehace con las horas extra')).not.toBeNull()
    await reads('después de confirmar y anular')

    // Los porcentajes los cambia el docente; la liquidación nueva los usa.
    const settings = (label: string, username: string, data: Partial<CompanySettings>) =>
      step(
        label,
        username,
        (c) => E.cmdUpdateCompanySettings(c, company, data),
        (b) => b.commands.updateCompanySettings(companyPg, data),
      )
    expect(await settings('RRHH no cambia los porcentajes', 'rrhh', { payroll: { employer_pct: 22 } })).toBeNull()
    expect(await settings('un porcentaje de más de 100', 'docente', { payroll: { employer_pct: 120 } })).toBeNull()
    expect(await settings('con tres decimales', 'docente', { payroll: { attendance_pct: 8.333 } })).toBeNull()
    expect(
      await settings('contribuciones del 22 %', 'docente', { payroll: { employer_pct: 22, attendance_pct: 8.5 } }),
    ).not.toBeNull()
    await createdPayroll('otra vez la de hace dos meses', input({ notes: 'Con los porcentajes nuevos' }))
    await createdPayroll('y la de este mes', input({ period: month(0), payment_date: `${month(1)}-05` }))
    await reads('con los porcentajes nuevos')
    await sameRead(
      'la configuración de la empresa',
      'docente',
      (b) => b.api.companyContext(mock.companies.find((c) => c.id === company)!.slug),
      (u) => Q.companyContext(mock, u, mock.companies.find((c) => c.id === company)!.slug),
    )
  })

  it('pago de sueldos y cargas sociales: fondos, separación de funciones, asientos y flujo de fondos', async () => {
    const companyPg = pg(company)
    const month = (offset: number) => {
      const d = new Date(`${todayAR().slice(0, 7)}-15T12:00:00Z`)
      d.setUTCMonth(d.getUTCMonth() + offset)
      return d.toISOString().slice(0, 7)
    }
    const from = `${todayAR().slice(0, 7)}-01`
    const payrolls = () => mock.documents.filter((d) => d.company_id === company && d.doc_type === 'PAYROLL')
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const reads = async (label: string) => {
      for (const d of payrolls())
        await sameRead(
          `${d.display_number} ${label}`,
          'tesoreria',
          (b) => b.api.document(companyPg, 'PAYROLL', d.display_number),
          (u) => Q.documentDetail(mock, u, company, 'PAYROLL', d.display_number),
        )
      await sameRead(
        `liquidaciones ${label}`,
        'contabilidad',
        (b) => b.api.documents(companyPg, 'PAYROLL'),
        (u) => Q.listDocuments(mock, u, company, 'PAYROLL'),
      )
      await sameRead(
        `flujo proyectado ${label}`,
        'tesoreria',
        (b) => b.api.cashProjection(companyPg),
        (u) => Q.cashProjection(mock, u, company),
      )
      await sameRead(
        `flujo real ${label}`,
        'tesoreria',
        (b) => b.api.cashFlow(companyPg, from, todayAR()),
        (u) => Q.cashFlow(mock, u, company, from, todayAR()),
      )
      for (const period of [month(-2), month(-1), month(0)])
        await sameRead(
          `mano de obra de ${period} ${label}`,
          'contabilidad',
          (b) => b.api.laborVariance(companyPg, period),
          (u) => Q.laborVariance(mock, u, company, period),
        )
    }
    await reads('al empezar')

    // La de hace dos meses, en borrador: sólo con el empleado de menor básico, así alcanza el banco.
    const target = payrolls().find((d) => d.status === 'BORRADOR' && d.py!.period === month(-2))!
    const lines = E.payrollLines(mock, target.id)
    const cheapest = lines.reduce((a, b) => (b.basic_salary < a.basic_salary ? b : a))
    const rows = lines
      .filter((l) => l.id !== cheapest.id)
      .map((l) => ({ line_id: l.id, days_worked: 0, absence_days: 0, overtime_50: 0, overtime_100: 0 }))
    await ok(
      'dejar un solo empleado',
      'rrhh',
      (c) => E.cmdUpdatePayrollLines(c, target.id, rows),
      (b) =>
        b.commands.updatePayrollLines(
          pg(target.id),
          rows.map((r) => ({ ...r, line_id: pg(r.line_id) })),
        ),
    )
    await ok(
      'confirmarla',
      'rrhh',
      (c) => E.cmdConfirmPayroll(c, target.id),
      (b) => b.commands.confirmPayroll(pg(target.id)),
    )
    const pay = (label: string, username: string, docId: string, accountId: string, salaries = true) =>
      step(
        label,
        username,
        (c) => (salaries ? E.cmdPayPayrollSalaries(c, docId, accountId) : E.cmdPayPayrollCharges(c, docId, accountId)),
        (b) =>
          salaries
            ? b.commands.payPayrollSalaries(pg(docId), pg(accountId))
            : b.commands.payPayrollCharges(pg(docId), pg(accountId)),
      )
    const bank = account('1.1.01.03')
    const charges = (docId: string) => E.payrollCharges(mock, docId)
    // Cada paso reemplaza los documentos del simulador: el neto se lee del vigente.
    const net = () => mock.documents.find((d) => d.id === target.id)!.total
    /** Una caja o un banco activo en el que no alcanza para pagar un importe. */
    const short = (amount: number) =>
      mock.accounts.find(
        (a) =>
          a.company_id === company &&
          a.is_active &&
          a.is_imputable &&
          a.code.startsWith('1.1.01.') &&
          E.accountBalance(mock, a.id) < amount,
      )!.id
    expect(E.accountBalance(mock, bank)).toBeGreaterThan(net() + charges(target.id))
    expect(await pay('RRHH no paga', 'rrhh', target.id, bank)).toBeNull()
    expect(await pay('las cargas antes que los sueldos', 'tesoreria', target.id, bank, false)).toBeNull()
    expect(
      await pay('desde una cuenta que no es caja ni banco', 'tesoreria', target.id, account('2.1.03.01')),
    ).toBeNull()
    expect(await pay('desde una cuenta sin fondos', 'tesoreria', target.id, short(net()))).toBeNull()
    expect(await pay('pagar los sueldos', 'tesoreria', target.id, bank)).not.toBeNull()
    expect(await pay('otra vez', 'tesoreria', target.id, bank)).toBeNull()
    expect(
      await step(
        'anularla con los sueldos pagados',
        'rrhh',
        (c) => E.cmdCancelPayroll(c, target.id, 'Error de cálculo'),
        (b) => b.commands.cancelPayroll(pg(target.id), 'Error de cálculo'),
      ),
    ).toBeNull()
    await reads('con los sueldos pagados')

    // SoD-6: con el rol de Tesorería, quien la liquidó tampoco paga sus cargas sociales.
    const tes = mock.sectors.find((s) => s.company_id === company && s.code === 'TES')!.id
    await ok(
      'el docente le suma Tesorería a RRHH',
      'docente',
      (c) => E.cmdAssignRole(c, company, mockId('rrhh'), 'TESORERIA', tes),
      (b) => b.commands.assignRole(companyPg, pg(mockId('rrhh')), 'TESORERIA', pg(tes)),
    )
    await sameRead(
      'las acciones de quien la liquidó',
      'rrhh',
      (b) => b.api.document(companyPg, 'PAYROLL', target.display_number),
      (u) => Q.documentDetail(mock, u, company, 'PAYROLL', target.display_number),
    )
    expect(await pay('las cargas de una liquidación que liquidó', 'rrhh', target.id, bank, false)).toBeNull()
    expect(await pay('pagar las cargas sociales', 'tesoreria', target.id, bank, false)).not.toBeNull()
    expect(await pay('las cargas otra vez', 'tesoreria', target.id, bank, false)).toBeNull()

    // Las cargas sociales del mes pasado (sus sueldos los pagó el escenario), sin fondos.
    const last = payrolls().find((d) => d.status === 'SUELDOS_PAGADOS')!
    expect(
      await pay('las cargas del mes pasado sin fondos', 'tesoreria', last.id, short(charges(last.id)), false),
    ).toBeNull()
    await reads('después de pagar')
  })

  it('declaración de IVA: preparar, presentar con su asiento, anular, separación de funciones y pago', async () => {
    const companyPg = pg(company)
    const month = (offset: number) => {
      const d = new Date(`${todayAR().slice(0, 7)}-15T12:00:00Z`)
      d.setUTCMonth(d.getUTCMonth() + offset)
      return d.toISOString().slice(0, 7)
    }
    const from = `${todayAR().slice(0, 7)}-01`
    const returns = () => mock.documents.filter((d) => d.company_id === company && d.doc_type === 'TAX_RETURN')
    const reads = async (label: string) => {
      for (const d of returns())
        await sameRead(
          `${d.display_number} ${label}`,
          'contabilidad',
          (b) => b.api.document(companyPg, 'TAX_RETURN', d.display_number),
          (u) => Q.documentDetail(mock, u, company, 'TAX_RETURN', d.display_number),
        )
      await sameRead(
        `declaraciones ${label}`,
        'tesoreria',
        (b) => b.api.documents(companyPg, 'TAX_RETURN'),
        (u) => Q.listDocuments(mock, u, company, 'TAX_RETURN'),
      )
      for (const period of [month(-1), month(0)])
        for (const sales of [true, false])
          await sameRead(
            `libro IVA ${sales ? 'ventas' : 'compras'} de ${period} ${label}`,
            'contabilidad',
            (b) => b.api.ivaBook(companyPg, period, sales),
            (u) => Q.ivaBook(mock, u, company, period, sales),
          )
      await sameRead(
        `flujo proyectado ${label}`,
        'tesoreria',
        (b) => b.api.cashProjection(companyPg),
        (u) => Q.cashProjection(mock, u, company),
      )
      await sameRead(
        `flujo real ${label}`,
        'tesoreria',
        (b) => b.api.cashFlow(companyPg, from, todayAR()),
        (u) => Q.cashFlow(mock, u, company, from, todayAR()),
      )
    }
    await reads('al empezar')

    // Prepararla: quién, qué mes y en qué orden.
    const input = (over: Partial<E.TaxReturnInput> = {}): E.TaxReturnInput => ({
      tax: 'IVA',
      period: month(-1),
      notes: '',
      ...over,
    })
    const create = (label: string, username: string, data: E.TaxReturnInput) =>
      step(
        label,
        username,
        (c) => E.cmdCreateTaxReturn(c, company, data),
        (b) => b.commands.createTaxReturn(companyPg, data),
      )
    const createdReturn = (label: string, data: E.TaxReturnInput) =>
      created(
        label,
        'contabilidad',
        (c) => E.cmdCreateTaxReturn(c, company, data),
        (b) => b.commands.createTaxReturn(companyPg, data),
      )
    expect(await create('Tesorería no la prepara', 'tesoreria', input())).toBeNull()
    for (const [label, over] of [
      ['un mes que no terminó', { period: month(0) }],
      ['otro impuesto', { tax: 'IIBB' }],
      ['un mes mal escrito', { period: '2026-1' }],
      ['antes del inicio de actividades', { period: '2015-02' }],
    ] as [string, Partial<E.TaxReturnInput>][])
      expect(await create(label, 'contabilidad', input(over)), label).toBeNull()
    const draft = await createdReturn('la del mes pasado', input())
    expect(await create('otra del mismo mes', 'contabilidad', input())).toBeNull()
    expect(await create('un mes anterior a la última', 'contabilidad', input({ period: month(-2) }))).toBeNull()

    // Anular y presentar.
    const cancel = (label: string, username: string, docId: string, reason: string) =>
      step(
        label,
        username,
        (c) => E.cmdCancelTaxReturn(c, docId, reason),
        (b) => b.commands.cancelTaxReturn(pg(docId), reason),
      )
    const present = (label: string, username: string, docId: string) =>
      step(
        label,
        username,
        (c) => E.cmdPresentTaxReturn(c, docId),
        (b) => b.commands.presentTaxReturn(pg(docId)),
      )
    expect(await cancel('el borrador sin motivo', 'contabilidad', draft, '')).toBeNull()
    expect(await cancel('el borrador', 'contabilidad', draft, 'Faltaba revisar las compras')).not.toBeNull()
    const first = await createdReturn('otra vez la del mes pasado', input({ notes: 'Revisada con los libros' }))
    expect(await present('Tesorería no la presenta', 'tesoreria', first)).toBeNull()
    expect(await present('presentarla', 'contabilidad', first)).not.toBeNull()
    expect(await present('presentarla otra vez', 'contabilidad', first)).toBeNull()
    expect(mock.documents.find((d) => d.id === first)!.status).toBe('PRESENTADA')
    await reads('presentada')
    expect(await cancel('anular la presentada sin motivo', 'contabilidad', first, ' ')).toBeNull()
    expect(
      await cancel('anularla con su contraasiento', 'contabilidad', first, 'Se rehace con una nota de crédito'),
    ).not.toBeNull()
    const second = await createdReturn('la del mes pasado, por tercera vez', input())
    expect(await present('presentar la nueva', 'contabilidad', second)).not.toBeNull()

    // Pagarla: quién, desde dónde y SoD-10.
    const pay = (label: string, username: string, accountId: string) =>
      step(
        label,
        username,
        (c) => E.cmdPayTaxReturn(c, second, accountId),
        (b) => b.commands.payTaxReturn(pg(second), pg(accountId)),
      )
    const account = (code: string) => mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
    const due = () => mock.documents.find((d) => d.id === second)!.total
    const short = mock.accounts.find(
      (a) =>
        a.company_id === company &&
        a.is_active &&
        a.is_imputable &&
        a.code.startsWith('1.1.01.') &&
        E.accountBalance(mock, a.id) < due(),
    )!.id
    expect(E.accountBalance(mock, account('1.1.01.03'))).toBeGreaterThan(due())
    expect(await pay('Contabilidad no paga', 'contabilidad', account('1.1.01.03'))).toBeNull()
    expect(await pay('desde una cuenta sin fondos', 'tesoreria', short)).toBeNull()
    const tes = mock.sectors.find((s) => s.company_id === company && s.code === 'TES')!.id
    await ok(
      'el docente le suma Tesorería a Contabilidad',
      'docente',
      (c) => E.cmdAssignRole(c, company, mockId('contabilidad'), 'TESORERIA', tes),
      (b) => b.commands.assignRole(companyPg, pg(mockId('contabilidad')), 'TESORERIA', pg(tes)),
    )
    await sameRead(
      'las acciones de quien la liquidó',
      'contabilidad',
      (b) => b.api.document(companyPg, 'TAX_RETURN', mock.documents.find((d) => d.id === second)!.display_number),
      (u) =>
        Q.documentDetail(mock, u, company, 'TAX_RETURN', mock.documents.find((d) => d.id === second)!.display_number),
    )
    expect(await pay('pagar la que liquidó', 'contabilidad', account('1.1.01.03'))).toBeNull()
    expect(await pay('pagarla', 'tesoreria', account('1.1.01.03'))).not.toBeNull()
    expect(await pay('pagarla otra vez', 'tesoreria', account('1.1.01.03'))).toBeNull()
    expect(await cancel('anular la pagada', 'contabilidad', second, 'Tarde')).toBeNull()
    await reads('pagada')
  })

  it('después de los comandos, cada usuario lee lo mismo en ambos lados', async () => {
    const companyPg = pg(company)
    const types: DocType[] = [
      'PURCHASE_REQUISITION',
      'PURCHASE_ORDER',
      'GOODS_RECEIPT',
      'STOCK_ADJUSTMENT',
      'JOURNAL_ENTRY',
      'SUPPLIER_INVOICE',
      'PAYMENT_ORDER',
      'RFQ',
      'SUPPLIER_QUOTE',
      'FUNDS_TRANSFER',
      'BANK_RECONCILIATION',
      'SALES_ORDER',
      'DELIVERY_NOTE',
      'SALES_INVOICE',
      'CUSTOMER_RECEIPT',
      'SALES_QUOTE',
      'PRODUCTION_ORDER',
      'PAYROLL',
      'TAX_RETURN',
    ]
    const year = Number(todayAR().slice(0, 4))
    const taskKey = (t: { status: string; created_at: string }) => `${t.status === 'EN_CURSO'}|${t.created_at}`
    expect(mock.documents.filter((x) => x.created_at > cutoff).length).toBeGreaterThanOrEqual(9)
    await sameRead(
      'integrantes y actividad',
      'docente',
      (b) => b.api.members(companyPg),
      (u) => Q.listMembers(mock, u, company),
    )
    const users = [
      'docente',
      'compras1',
      'compras2',
      'deposito',
      'produccion',
      'gerencia',
      'auditor',
      'contabilidad',
      'tesoreria',
      'ventas',
    ]
    for (const username of users) {
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
      for (const code of ['MP-002', 'IN-001', 'MP-006', 'PT-002', 'MR-001'])
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
      await sameRead(
        `plan de cuentas (${username})`,
        username,
        (b) => b.api.accounts(companyPg),
        (u) => Q.listAccounts(mock, u, company),
      )
      await sameRead(
        `ejercicios (${username})`,
        username,
        (b) => b.api.fiscalYears(companyPg),
        (u) => Q.listFiscalYears(mock, u, company),
      )
      const [from, to] = [`${year}-01-01`, `${year}-12-31`]
      await sameRead(
        `libro diario (${username})`,
        username,
        (b) => b.api.journalBook(companyPg, from, to),
        (u) => Q.journalBook(mock, u, company, from, to),
      )
      await sameRead(
        `sumas y saldos (${username})`,
        username,
        (b) => b.api.trialBalance(companyPg, from, to),
        (u) => Q.trialBalance(mock, u, company, from, to),
      )
      for (const code of ['1.1.01.03', '2.1.01.01', '1.1.05.02']) {
        const id = mock.accounts.find((a) => a.company_id === company && a.code === code)!.id
        await sameRead(
          `mayor de ${code} (${username})`,
          username,
          (b) => b.api.ledger(companyPg, pg(id), from, to),
          (u) => Q.ledger(mock, u, company, id, from, to),
        )
      }
      await sameRead(
        `por facturar (${username})`,
        username,
        (b) => b.api.invoiceableOrders(companyPg),
        (u) => Q.invoiceableOrders(mock, u, company),
      )
      await sameRead(
        `cuentas corrientes (${username})`,
        username,
        (b) => b.api.payables(companyPg),
        (u) => Q.listPayables(mock, u, company),
      )
      for (const code of ['PRV-001', 'PRV-010'])
        await sameRead(
          `cuenta corriente de ${code} (${username})`,
          username,
          (b) => b.api.supplierAccount(companyPg, pg(supplier(code))),
          (u) => Q.supplierAccount(mock, u, company, supplier(code)),
        )
      await sameRead(
        `imputación automática (${username})`,
        username,
        (b) => b.api.postingRules(companyPg),
        (u) => Q.listPostingRules(mock, u, company),
      )
      await sameRead(
        `cajas y bancos (${username})`,
        username,
        (b) => b.api.treasuryAccounts(companyPg),
        (u) => Q.treasuryAccounts(mock, u, company),
      )
      for (const code of ['PRV-001', 'PRV-010'])
        await sameRead(
          `facturas para pagar de ${code} (${username})`,
          username,
          (b) => b.api.paymentCandidates(companyPg, pg(supplier(code))),
          (u) => Q.paymentCandidates(mock, u, company, supplier(code)),
        )
      await sameRead(
        `flujo de fondos (${username})`,
        username,
        (b) => b.api.cashFlow(companyPg, `${year}-01-01`, `${year}-12-31`),
        (u) => Q.cashFlow(mock, u, company, `${year}-01-01`, `${year}-12-31`),
      )
      await sameRead(
        `flujo de fondos proyectado (${username})`,
        username,
        (b) => b.api.cashProjection(companyPg),
        (u) => Q.cashProjection(mock, u, company),
      )
      await sameRead(
        `cheques emitidos (${username})`,
        username,
        (b) => b.api.issuedCheques(companyPg),
        (u) => Q.issuedCheques(mock, u, company),
      )
      const bank = mock.accounts.find((a) => a.company_id === company && a.code === '1.1.01.03')!.id
      await sameRead(
        `movimientos para conciliar (${username})`,
        username,
        (b) => b.api.reconciliationCandidates(companyPg, pg(bank), todayAR()),
        (u) => Q.reconciliationCandidates(mock, u, company, bank, todayAR()),
      )
    }
  })
})
