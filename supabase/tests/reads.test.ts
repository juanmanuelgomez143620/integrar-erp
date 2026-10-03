// Lecturas de la base contra las del backend simulado (src/lib/mock/queries.ts),
// que es la especificación: el mismo estado (seed + escenario) se carga en
// PGlite y cada función de lectura tiene que devolver lo mismo que su
// equivalente, para cada usuario. Así la interfaz no cambia al pasar a Supabase.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../../src/lib/mock/db'
import * as Q from '../../src/lib/mock/queries'
import type { DocType } from '../../src/lib/domain/types'
import { createTestDb, type TestDb } from './support/db'
import { loadMockDb, normalize, type LoadedMock } from './support/mock-loader'
import { buildScenario } from './support/scenario'

let db: TestDb
let mock: DB
let loaded: LoadedMock
let company: string
let companyPg: string
let slug: string

const USERS = [
  'docente',
  'gerencia',
  'auditor',
  'compras1',
  'compras2',
  'ventas',
  'contabilidad',
  'produccion',
  'deposito',
  'admin',
]
const DOC_TYPES: DocType[] = ['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT']
const userId = (username: string) => mock.profiles.find((p) => p.username === username)!.id

type Outcome = { ok: true; value: unknown } | { ok: false; error: string }

/** Resultado del simulador, como JSON y normalizado (o el error). */
function fromMock(fn: () => unknown): Outcome {
  try {
    const value = fn()
    return { ok: true, value: normalize(value === undefined ? null : JSON.parse(JSON.stringify(value))) }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** Llama una función de lectura como el usuario indicado. */
async function fromSql(username: string, fn: string, args: unknown[]): Promise<Outcome> {
  const params = args.map((_, i) => `$${i + 1}`).join(', ')
  try {
    const [row] = await db.as<{ r: unknown }>(loaded.pg(userId(username)), `select public.${fn}(${params}) as r`, args)
    return { ok: true, value: loaded.fromPg(row.r) }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** Deja en `actual` sólo las claves que tiene `expected` (la base puede traer columnas de más). */
function project(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(actual) && Array.isArray(expected))
    return actual.map((a, i) => project(a, expected[Math.min(i, expected.length - 1)]))
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object' && !Array.isArray(actual))
    return Object.fromEntries(
      Object.keys(expected as object)
        .filter((k) => k in (actual as object))
        .map((k) => [k, project((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k])]),
    )
  return actual
}

/** Ordena dentro de cada grupo de elementos consecutivos con la misma clave (p. ej. creados en el mismo instante). */
function sortTies(list: unknown, key: (x: never) => unknown): unknown {
  if (!Array.isArray(list)) return list
  const out: unknown[] = []
  for (let i = 0; i < list.length;) {
    let j = i + 1
    while (j < list.length && key(list[j] as never) === key(list[i] as never)) j++
    out.push(...list.slice(i, j).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)))
    i = j
  }
  return out
}

interface Options {
  /** Clave de orden de una lista: el orden entre empates no está definido. */
  ties?: (x: never) => unknown
  /** Ajuste de ambos resultados antes de comparar. */
  pick?: (value: never) => unknown
}

/** Comparaciones por función: con datos y con error en ambos lados (para detectar pruebas vacías). */
const tally: Record<string, { data: number; errors: number }> = {}

async function same(username: string, mockFn: () => unknown, fn: string, args: unknown[], options: Options = {}) {
  const expected = fromMock(mockFn)
  const actual = await fromSql(username, fn, args)
  tally[fn] ??= { data: 0, errors: 0 }
  tally[fn][expected.ok && actual.ok ? 'data' : 'errors']++
  const label = `${fn}(${args.join(', ')}) como ${username}`
  if (!expected.ok || !actual.ok) {
    expect(
      actual.ok,
      `${label}: ${actual.ok ? 'no falla' : actual.error} / simulador: ${expected.ok ? 'no falla' : expected.error}`,
    ).toBe(expected.ok)
    return
  }
  const pick = options.pick ?? ((v: unknown) => v)
  let want = pick(expected.value as never)
  let got = project(pick(actual.value as never), want)
  if (options.ties) {
    want = sortTies(want, options.ties)
    got = sortTies(got, options.ties)
  }
  expect(got, label).toEqual(want)
}

beforeAll(async () => {
  mock = buildScenario()
  const template = mock.companies.find((c) => c.is_template)!
  db = await createTestDb()
  loaded = await loadMockDb(db, mock)
  company = template.id
  companyPg = loaded.pg(company)
  slug = template.slug
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('contexto', () => {
  it('my_context = meContext', async () => {
    for (const u of USERS) await same(u, () => Q.meContext(mock, userId(u)), 'my_context', [])
  })

  it('company_context = companyContext', async () => {
    for (const u of USERS) await same(u, () => Q.companyContext(mock, userId(u), slug), 'company_context', [slug])
    await same('docente', () => Q.companyContext(mock, userId('docente'), 'no-existe'), 'company_context', [
      'no-existe',
    ])
  })
})

describe('maestros y stock', () => {
  it('clientes, proveedores y productos', async () => {
    for (const u of USERS) {
      await same(u, () => Q.listCustomers(mock, userId(u), company), 'customers_list', [companyPg])
      await same(u, () => Q.listSuppliers(mock, userId(u), company), 'suppliers_list', [companyPg])
      await same(u, () => Q.listProducts(mock, userId(u), company), 'products_list', [companyPg])
    }
  })

  it('ficha de producto con saldos y kardex', async () => {
    const codes = ['MP-001', 'MP-004', 'IN-003', 'SV-001', 'NO-EXISTE']
    for (const u of USERS)
      for (const code of codes)
        await same(u, () => Q.productDetail(mock, userId(u), company, code), 'product_detail', [companyPg, code])
  })

  it('stock por depósito', async () => {
    for (const u of USERS) await same(u, () => Q.listStock(mock, userId(u), company), 'stock_list', [companyPg])
  })
})

describe('documentos', () => {
  it('listados por tipo', async () => {
    for (const u of USERS)
      for (const type of DOC_TYPES)
        await same(u, () => Q.listDocuments(mock, userId(u), company, type), 'documents_list', [companyPg, type])
  })

  it('detalle de cada documento: líneas, flujo, historial, acciones, próximo paso y firmas', async () => {
    const docs = mock.documents.filter((d) => d.company_id === company)
    expect(new Set(docs.map((d) => `${d.doc_type}:${d.status}`)).size).toBeGreaterThanOrEqual(12)
    for (const u of USERS)
      for (const d of docs)
        await same(
          u,
          () => Q.documentDetail(mock, userId(u), company, d.doc_type, d.display_number),
          'document_detail',
          [companyPg, d.doc_type, d.display_number],
        )
    await same(
      'compras1',
      () => Q.documentDetail(mock, userId('compras1'), company, 'PURCHASE_ORDER', 'OC-99999'),
      'document_detail',
      [companyPg, 'PURCHASE_ORDER', 'OC-99999'],
    )
  })

  it('detalle por id (desde una tarea o un aviso)', async () => {
    for (const u of ['compras1', 'ventas', 'deposito'])
      for (const d of mock.documents.filter((x) => x.company_id === company))
        await same(u, () => Q.documentDetailById(mock, userId(u), d.id), 'document_detail_by_id', [loaded.pg(d.id)])
  })

  it('insumos para armar una OC y una recepción', async () => {
    for (const u of USERS) {
      await same(u, () => Q.pendingRequisitionLines(mock, userId(u), company), 'requisition_lines_pending', [companyPg])
      await same(u, () => Q.receivableOrders(mock, userId(u), company), 'orders_receivable', [companyPg])
    }
  })
})

const taskKey = (t: { status: string; created_at: string }) => `${t.status === 'EN_CURSO'}|${t.created_at}`

describe('tareas, avisos y auditoría', () => {
  it('bandeja de tareas: propias y todas, con y sin resueltas', async () => {
    for (const u of USERS)
      for (const scope of ['mine', 'all'] as const)
        for (const closed of [false, true])
          await same(
            u,
            () => Q.listTasks(mock, userId(u), company, scope, closed),
            'tasks_list',
            [companyPg, scope, closed],
            {
              ties: taskKey,
            },
          )
  })

  it('avisos propios, con límite y completos', async () => {
    for (const u of USERS)
      for (const limit of [60, 3, null])
        await same(
          u,
          () => Q.listNotifications(mock, userId(u), company, limit),
          'notifications_list',
          [companyPg, limit],
          {
            ties: (n: { created_at: string }) => n.created_at,
          },
        )
  })

  it('auditoría visible para cada rol', async () => {
    for (const u of USERS) await same(u, () => Q.listAudit(mock, userId(u), company), 'audit_list', [companyPg])
  })

  it('exportaciones con su permiso propio', async () => {
    const kinds = {
      customers: Q.exportCustomers,
      suppliers: Q.exportSuppliers,
      products: Q.exportProducts,
      stock: Q.exportStock,
      audit: Q.exportAudit,
    }
    for (const u of USERS)
      for (const [kind, query] of Object.entries(kinds))
        await same(u, () => query(mock, userId(u), company), 'export_rows', [companyPg, kind])
  })
})

describe('tablero', () => {
  it('indicadores, estados, stock bajo, actividad y permisos', async () => {
    for (const u of USERS)
      await same(u, () => Q.dashboard(mock, userId(u), company), 'dashboard', [companyPg], {
        pick: ({ tasks: _tasks, ...rest }: Q.Dashboard) => rest,
      })
  })

  it('las tareas del tablero son las primeras seis de la bandeja propia', async () => {
    for (const u of USERS) {
      const board = await fromSql(u, 'dashboard', [companyPg])
      const inbox = await fromSql(u, 'tasks_list', [companyPg, 'mine', false])
      expect(board.ok && inbox.ok).toBe(true)
      if (board.ok && inbox.ok)
        expect((board.value as Q.Dashboard).tasks).toEqual((inbox.value as unknown[]).slice(0, 6))
    }
  })
})

describe('panel docente y escuela', () => {
  it('integrantes con roles y actividad (sólo supervisores)', async () => {
    for (const u of USERS) await same(u, () => Q.listMembers(mock, userId(u), company), 'members_list', [companyPg])
  })

  it('cursos y docentes', async () => {
    for (const u of USERS) {
      await same(u, () => Q.listCourses(mock, userId(u)), 'courses_list', [])
      await same(u, () => Q.listTeachers(mock, userId(u)), 'teachers_list', [])
    }
  })
})

// Al final: ninguna lectura pasó sólo porque ambos lados fallaban.
describe('cobertura', () => {
  it('cada lectura se comparó con datos al menos una vez', () => {
    expect(Object.keys(tally).length).toBeGreaterThanOrEqual(20)
    for (const [fn, t] of Object.entries(tally)) expect(t.data, fn).toBeGreaterThan(0)
  })
})
