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
    const pay = (label: string, username: string, id: string, reference = '') =>
      step(
        label,
        username,
        (c) => E.cmdPayPaymentOrder(c, id, reference),
        (b) => b.commands.payPaymentOrder(pg(id), reference),
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
    expect(await pay('pagar', 'tesoreria', partial, 'Transferencia 000777')).not.toBeNull()
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
    expect(await pay('pagar el resto', 'tesoreria', balance, 'Cheque 000321')).not.toBeNull()
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
    }
  })
})
