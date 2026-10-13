// Criterio S01 del MVP: un usuario de la empresa A intenta leer o escribir la
// empresa B por cualquier RPC —lecturas, comandos, tareas, avisos— y no obtiene
// datos de B ni la modifica. La prueba recorre TODAS las funciones públicas de
// la base (también las que se agreguen después) con ids de B, de dos maneras:
// pidiendo directamente la empresa B, y desde su propia empresa pero con datos
// de B en los parámetros. Al final, B tiene que estar exactamente igual.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDb, type TestDb } from './support/db'
import { createUser, seedSchool } from './support/fixtures'

vi.setConfig({ testTimeout: 300_000 })

// Funciones de la escuela (no de una empresa): sus datos son visibles por diseño
// para los roles que corresponden, o crean cosas nuevas en vez de tocar B.
const SCHOOL_LEVEL = new Set([
  'public_school_info',
  'courses_list',
  'teachers_list',
  'users_list',
  'course_create',
  'school_settings_update',
  'teacher_check',
  'teacher_register',
  'profile_password_changed',
  'company_create_from_template',
])

let db: TestDb
const u: Record<string, string> = {}
const A: Record<string, string> = {}
const B: Record<string, string> = {}
/** Todos los ids de registros de la empresa B. */
let bIds: Set<string>

const one = async <R = Record<string, string>>(sql: string, params: unknown[] = []) =>
  (await db.admin<R>(sql, params))[0]

async function rpc<R = unknown>(user: string, fn: string, args: Record<string, unknown> = {}) {
  const keys = Object.keys(args)
  const sql = `select to_jsonb(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) as r`
  return (await db.as<{ r: R }>(u[user], sql, Object.values(args)))[0].r
}

/** Foto de la empresa B: todo lo que un intruso no debería poder cambiar. */
async function snapshot(company: string) {
  const tables = [
    'companies',
    'islands',
    'sectors',
    'warehouses',
    'company_members',
    'member_roles',
    'company_modules',
    'approval_rules',
    'customers',
    'suppliers',
    'products',
    'documents',
    'purchase_requisition_lines',
    'purchase_order_lines',
    'goods_receipt_lines',
    'stock_adjustment_lines',
    'document_links',
    'stock_movements',
    'stock_balances',
    'approval_requests',
    'tasks',
    'notifications',
    'audit_events',
  ]
  const out: Record<string, unknown> = {}
  for (const t of tables) {
    const column = t === 'companies' ? 'id' : 'company_id'
    out[t] = (await db.admin(`select to_jsonb(x) as r from public.${t} x where ${column} = $1 order by 1`, [company]))
      .map((row) => JSON.stringify(row))
      .sort()
  }
  return out
}

/** Argumentos para cada parámetro, apuntando a datos de B (y la empresa elegida). */
function argsFor(fn: string, params: { name: string; udt_name: string }[], company: string) {
  const doc = fn.startsWith('pr_')
    ? B.requisition
    : fn.startsWith('po_')
      ? B.order
      : fn.startsWith('gr_')
        ? B.receipt
        : fn.startsWith('sa_')
          ? B.adjustment
          : B.order
  const input = {
    reason: 'Necesidad urgente de la empresa',
    priority: 'NORMAL',
    notes: 'intento',
    supplier_id: B.supplier,
    warehouse_id: B.warehouse,
    purchase_order_id: B.order,
    supplier_delivery_note: 'R-9999',
    reason_code: 'CONTEO_FISICO',
    payment_terms_days: 0,
    lines: [
      {
        product_id: B.product,
        requisition_line_id: B.requisitionLine,
        po_line_id: B.orderLine,
        quantity: 1,
        quantity_delta: 1,
        unit_price: 1,
        vat_rate: 21,
      },
    ],
    id: B.product,
    code: 'MP-001',
    name: 'Intruso',
    legal_name: 'Intruso SA',
    product_type: 'MATERIA_PRIMA',
    uom_code: 'UN',
  }
  const values: Record<string, unknown> = {
    p_company_id: company,
    p_document_id: doc,
    p_task_id: B.task,
    p_ids: `{${B.notification}}`,
    p_user_id: u.alumnoB,
    p_user_ids: `{${u.alumnoB}}`,
    p_member_role_id: B.memberRole,
    p_id: B.product,
    p_kind: fn === 'export_rows' ? 'stock' : 'product',
    p_slug: B.slug,
    p_code: 'MP-001',
    p_doc_type: 'PURCHASE_ORDER',
    p_display_number: 'OC-00001',
    p_input: JSON.stringify(input),
    p_data: JSON.stringify(input),
    p_rows: JSON.stringify([{ first_name: 'Intruso', last_name: 'Externo' }]),
    p_settings: JSON.stringify({ sod_enabled: false, allow_negative_stock: true }),
    p_module: 'audit',
    p_role: 'GERENCIA',
    p_sector_id: B.sector,
    p_first_name: 'Intruso',
    p_last_name: 'Externo',
    p_username: 'intruso',
    p_reason: 'Intento de un intruso',
    p_comment: 'Intento de un intruso',
    p_scope: 'all',
    p_limit: null,
  }
  const args: Record<string, unknown> = {}
  for (const p of params) {
    if (p.name in values) args[p.name] = values[p.name]
    else if (p.udt_name === 'bool') args[p.name] = true
    else throw new Error(`Falta un valor de prueba para ${fn}(${p.name})`)
  }
  return args
}

beforeAll(async () => {
  db = await createTestDb()
  await seedSchool(db)
  await db.admin('select private.seed_demo_company()')
  for (const [name, role] of [
    ['docenteA', 'DOCENTE'],
    ['docenteB', 'DOCENTE'],
    ['alumnoA', 'ESTUDIANTE'],
    ['alumnoB', 'ESTUDIANTE'],
  ] as const)
    u[name] = await createUser(db, name, role)
  const courseA = await one(`insert into public.courses (academic_year, name) values (2027, '5.º A') returning id`)
  const courseB = await one(`insert into public.courses (academic_year, name) values (2027, '5.º B') returning id`)
  A.id = (await rpc<{ id: string }>('docenteA', 'company_create_from_template', { p_course_id: courseA.id })).id
  const created = await rpc<{ id: string; slug: string }>('docenteB', 'company_create_from_template', {
    p_course_id: courseB.id,
  })
  B.id = created.id
  B.slug = created.slug

  // Integrantes: el de A con muchos roles; el de B con Compras y Depósito.
  const sector = async (company: string, code: string) =>
    (await one(`select id from public.sectors where company_id = $1 and code = $2`, [company, code])).id
  for (const [role, code] of [
    ['GERENCIA', 'GER'],
    ['COMPRAS', 'COM'],
    ['DEPOSITO', 'DEP'],
    ['AUDITOR', 'CGE'],
    ['VENTAS', 'VEN'],
  ])
    await rpc('docenteA', 'member_assign_role', {
      p_company_id: A.id,
      p_user_id: u.alumnoA,
      p_role: role,
      p_sector_id: await sector(A.id, code),
    })
  for (const [role, code] of [
    ['COMPRAS', 'COM'],
    ['DEPOSITO', 'DEP'],
    ['PRODUCCION', 'PRO'],
  ])
    await rpc('docenteB', 'member_assign_role', {
      p_company_id: B.id,
      p_user_id: u.alumnoB,
      p_role: role,
      p_sector_id: await sector(B.id, code),
    })

  // Actividad en B: SC, OC aprobada y enviada, recepción, tareas y avisos.
  B.product = (await one(`select id from public.products where company_id = $1 and code = 'MP-001'`, [B.id])).id
  B.supplier = (await one(`select id from public.suppliers where company_id = $1 and code = 'PRV-001'`, [B.id])).id
  B.warehouse = (await one(`select id from public.warehouses where company_id = $1 and code = 'DEP-MP'`, [B.id])).id
  B.sector = await sector(B.id, 'COM')
  B.requisition = (
    await rpc<{ id: string }>('alumnoB', 'pr_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        reason: 'Reposición de tablas',
        priority: 'NORMAL',
        lines: [{ product_id: B.product, quantity: 50 }],
      }),
      p_submit: true,
    })
  ).id
  B.requisitionLine = (
    await one(`select id from public.purchase_requisition_lines where document_id = $1`, [B.requisition])
  ).id
  B.order = (
    await rpc<{ id: string }>('alumnoB', 'po_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        supplier_id: B.supplier,
        warehouse_id: B.warehouse,
        payment_terms_days: 30,
        lines: [
          {
            product_id: B.product,
            requisition_line_id: B.requisitionLine,
            quantity: 50,
            unit_price: 1300,
            vat_rate: 21,
          },
        ],
      }),
    })
  ).id
  B.orderLine = (await one(`select id from public.purchase_order_lines where document_id = $1`, [B.order])).id
  await rpc('alumnoB', 'po_submit', { p_document_id: B.order })
  await rpc('docenteB', 'po_approve', { p_document_id: B.order, p_comment: 'ok' })
  await rpc('alumnoB', 'po_send', { p_document_id: B.order })
  B.receipt = (
    await rpc<{ id: string }>('alumnoB', 'gr_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        purchase_order_id: B.order,
        warehouse_id: B.warehouse,
        supplier_delivery_note: 'R-0001-00000001',
        lines: [{ po_line_id: B.orderLine, quantity: 20 }],
      }),
      p_confirm: true,
    })
  ).id
  B.adjustment = (
    await one(`select id from public.documents where company_id = $1 and doc_type = 'STOCK_ADJUSTMENT' limit 1`, [B.id])
  ).id
  B.task = (await one(`select id from public.tasks where company_id = $1 limit 1`, [B.id])).id
  B.notification = (await one(`select id from public.notifications where company_id = $1 limit 1`, [B.id])).id
  B.memberRole = (await one(`select id from public.member_roles where company_id = $1 limit 1`, [B.id])).id

  bIds = new Set(
    (
      await db.admin<{ id: string }>(
        `select id::text from public.companies where id = $1
         union select id::text from public.documents where company_id = $1
         union select id::text from public.products where company_id = $1
         union select id::text from public.suppliers where company_id = $1
         union select id::text from public.customers where company_id = $1
         union select id::text from public.tasks where company_id = $1
         union select id::text from public.notifications where company_id = $1
         union select id::text from public.sectors where company_id = $1
         union select id::text from public.warehouses where company_id = $1
         union select id::text from public.company_members where company_id = $1
         union select id::text from public.member_roles where company_id = $1
         union select id::text from public.purchase_requisition_lines where company_id = $1
         union select id::text from public.purchase_order_lines where company_id = $1
         union select $2::text`,
        [B.id, u.alumnoB],
      )
    ).map((r) => r.id),
  )
}, 120_000)

afterAll(async () => {
  await db.close()
})

/** Ids de B que aparecen en una respuesta. */
function leaked(value: unknown): string[] {
  const found = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string' && bIds.has(v)) found.add(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(value)
  return [...found]
}

describe('S01: ninguna función pública da acceso a otra empresa', () => {
  it('ni pidiendo la empresa B, ni desde la propia con datos de B; B queda intacta', async () => {
    const before = await snapshot(B.id)
    const functions = await db.admin<{ name: string }>(
      `select distinct routine_name as name from information_schema.routines
        where routine_schema = 'public' and routine_type = 'FUNCTION' order by 1`,
    )
    expect(functions.length).toBeGreaterThan(55)
    const report: string[] = []
    let attempts = 0
    for (const { name } of functions) {
      if (SCHOOL_LEVEL.has(name)) continue
      const params = await db.admin<{ name: string; udt_name: string }>(
        `select p.parameter_name as name, p.udt_name
           from information_schema.routines r
           join information_schema.parameters p on p.specific_schema = r.specific_schema and p.specific_name = r.specific_name
          where r.routine_schema = 'public' and r.routine_name = $1 and p.parameter_mode = 'IN'
          order by p.ordinal_position`,
        [name],
      )
      for (const attacker of ['alumnoA', 'docenteA']) {
        for (const company of [B.id, A.id]) {
          attempts++
          try {
            const result = await rpc(attacker, name, argsFor(name, params, company))
            const leaks = leaked(result)
            if (leaks.length)
              report.push(`${name} como ${attacker} (${company === B.id ? 'B' : 'A'}): ${leaks.length} ids de B`)
          } catch {
            // Rechazado: es lo esperado para casi todo.
          }
        }
      }
    }
    expect(attempts).toBeGreaterThan(200)
    expect(report).toEqual([])
    expect(await snapshot(B.id)).toEqual(before)
  })

  it('sin sesión, ninguna función de empresa responde', async () => {
    const functions = await db.admin<{ name: string }>(
      `select distinct routine_name as name from information_schema.routines
        where routine_schema = 'public' and routine_type = 'FUNCTION' and routine_name <> 'public_school_info'`,
    )
    for (const { name } of functions) {
      const error = await db.anon(`select public.${name}()`).then(
        () => null,
        (e: { code?: string }) => e.code,
      )
      // Sin permiso de ejecución (42501) o, si faltan argumentos, la función ni siquiera se resuelve para anon.
      expect(['42501', '42883'], name).toContain(error)
    }
  })
})
