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
    ['rfq_lines', mock.rfqLines],
    ['supplier_quote_lines', mock.sqLines],
    ['bank_reconciliation_lines', mock.brLines],
    ['sales_order_lines', mock.soLines],
    ['delivery_note_lines', mock.dnLines],
    ['sales_invoice_lines', mock.fvLines],
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
