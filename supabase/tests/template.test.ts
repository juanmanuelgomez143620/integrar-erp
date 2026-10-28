// Empresa plantilla en la base (private.seed_demo_company, generada desde el
// seed simulado) y empresas por curso (company_create_from_template): la misma
// estructura, los mismos maestros y el mismo inventario inicial que la demo
// local (src/lib/mock/seed.ts) y que cmdCreateCompanyFromTemplate. Las
// operaciones de ejemplo de la demo local (SC, OC y REC) no son parte de la plantilla.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSeed } from '../../src/lib/mock/seed'
import { businessError, createTestDb, type TestDb } from './support/db'
import { createUser, seedSchool } from './support/fixtures'

const seed = buildSeed()
const mockTemplate = seed.companies.find((c) => c.is_template)!
const ofTemplate = <R extends { company_id: string }>(rows: R[]) => rows.filter((r) => r.company_id === mockTemplate.id)
const codeOf = <R extends { id: string; code: string }>(rows: R[]) =>
  Object.fromEntries(rows.map((r) => [r.id, r.code])) as Record<string, string>
const mockWarehouse = codeOf(ofTemplate(seed.warehouses))
const mockSupplier = codeOf(ofTemplate(seed.suppliers))
const mockProduct = codeOf(ofTemplate(seed.products))

/** Inventario inicial de la demo: "depósito/producto" → cantidad y costo. */
const initialStock = (() => {
  const out: Record<string, { qty: number; cost: number }> = {}
  for (const d of ofTemplate(seed.documents)) {
    if (d.doc_type !== 'STOCK_ADJUSTMENT' || d.status !== 'CONFIRMADO' || d.sa?.reason_code !== 'INVENTARIO_INICIAL')
      continue
    for (const l of seed.saLines.filter((x) => x.document_id === d.id && x.quantity_delta > 0))
      out[`${mockWarehouse[d.sa.warehouse_id]}/${mockProduct[l.product_id]}`] = {
        qty: l.quantity_delta,
        cost: l.unit_cost,
      }
  }
  return out
})()

/** Productos que arrancan por debajo del mínimo (alerta de reposición). */
const belowMinimum = ofTemplate(seed.products)
  .filter((p) => {
    const total = Object.entries(initialStock)
      .filter(([key]) => key.endsWith(`/${p.code}`))
      .reduce((sum, [, s]) => sum + s.qty, 0)
    return p.is_stockable && p.min_stock > 0 && total < p.min_stock
  })
  .map((p) => p.code)
  .sort()

/** Asiento de apertura de la demo: cuenta, debe y haber de cada línea, en orden. */
const mockOpening = (() => {
  const doc = ofTemplate(seed.documents).find((d) => d.je?.origin === 'APERTURA')!
  const code = Object.fromEntries(ofTemplate(seed.accounts).map((a) => [a.id, a.code]))
  return seed.jeLines
    .filter((l) => l.document_id === doc.id)
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => ({ code: code[l.account_id], debit: l.debit, credit: l.credit }))
})()

/** Reglas de la imputación automática de la demo: "evento/clave → cuenta". */
const mockRules = (() => {
  const code = Object.fromEntries(ofTemplate(seed.accounts).map((a) => [a.id, a.code]))
  return ofTemplate(seed.postingRules)
    .map((r) => `${r.event}/${r.key} → ${code[r.account_id]}`)
    .sort()
})()

/** Listas de materiales de la demo: "producto línea componente cantidad". */
const mockBoms = ofTemplate(seed.boms)
  .flatMap((b) =>
    seed.bomLines
      .filter((l) => l.bom_id === b.id)
      .map((l) => `${mockProduct[b.product_id]} ${l.line_no} ${mockProduct[l.component_id]} ${l.quantity}`),
  )
  .sort()

/** Centros de trabajo y horas de la demo: "centro tarifas" y "producto línea centro horas". */
const mockCenterCode = Object.fromEntries(ofTemplate(seed.workCenters).map((w) => [w.id, w.code]))
const mockCenters = ofTemplate(seed.workCenters)
  .map((w) => `${w.code} ${w.labor_rate} ${w.overhead_rate}`)
  .sort()
const mockOperations = ofTemplate(seed.boms)
  .flatMap((b) =>
    seed.bomOperations
      .filter((o) => o.bom_id === b.id)
      .map((o) => `${mockProduct[b.product_id]} ${o.line_no} ${mockCenterCode[o.work_center_id]} ${o.hours}`),
  )
  .sort()

/**
 * El personal de la demo: "convenio forma porcentajes sindicato", "categoría convenio básico
 * taller" y "legajo apellido categoría sector centro ingreso".
 */
const mockAgreementCode = Object.fromEntries(ofTemplate(seed.laborAgreements).map((a) => [a.id, a.code]))
const mockAgreements = ofTemplate(seed.laborAgreements)
  .map(
    (a) =>
      `${a.code} ${a.pay_basis} ${a.seniority_pct} ${a.attendance_pct} ${a.union_pct} ${a.union_employer_pct} ${a.union_name}`,
  )
  .sort()
const mockCategoryCode = Object.fromEntries(ofTemplate(seed.jobCategories).map((c) => [c.id, c.code]))
const mockSectorCode = Object.fromEntries(ofTemplate(seed.sectors).map((x) => [x.id, x.code]))
const mockCategories = ofTemplate(seed.jobCategories)
  .map((c) => `${c.code} ${mockAgreementCode[c.agreement_id]} ${c.basic_salary} ${c.is_direct_labor}`)
  .sort()
const mockStaff = ofTemplate(seed.employees)
  .map(
    (e) =>
      `${e.file_number} ${e.last_name} ${mockCategoryCode[e.category_id]} ${mockSectorCode[e.sector_id]} ${
        e.work_center_id ? mockCenterCode[e.work_center_id] : '-'
      } ${e.hire_date}`,
  )
  .sort()

let db: TestDb
let template: string
const u: Record<string, string> = {}
let course: string

const count = async (table: string, company: string) =>
  Number(
    (
      await db.admin<{ n: number }>(`select count(*)::int as n from public.${table} where company_id = $1`, [company])
    )[0].n,
  )

const balances = async (company: string) =>
  Object.fromEntries(
    (
      await db.admin<{ key: string; qty: number; cost: number }>(
        `select w.code || '/' || p.code as key, b.qty_on_hand::float8 as qty, b.avg_unit_cost::float8 as cost
           from public.stock_balances b
           join public.warehouses w on w.id = b.warehouse_id
           join public.products p on p.id = b.product_id
          where b.company_id = $1`,
        [company],
      )
    ).map((r) => [r.key, { qty: r.qty, cost: r.cost }]),
  )

const alerts = async (company: string) =>
  (
    await db.admin<{ code: string }>(
      `select p.code from public.tasks t join public.products p on p.id = (t.context ->> 'product_id')::uuid
        where t.company_id = $1 and t.task_type = 'REPONER_STOCK' order by p.code`,
      [company],
    )
  ).map((r) => r.code)

const opening = async (company: string) =>
  db.admin<{ code: string; debit: number; credit: number }>(
    `select a.code, l.debit::float8 as debit, l.credit::float8 as credit
       from public.journal_entries je
       join public.journal_entry_lines l on l.document_id = je.document_id
       join public.accounts a on a.id = l.account_id
      where je.company_id = $1 and je.origin = 'APERTURA' and je.entry_number = 1
      order by l.line_no`,
    [company],
  )

const rules = async (company: string) =>
  (
    await db.admin<{ rule: string }>(
      `select r.event || '/' || r.key || ' → ' || a.code as rule
         from public.posting_rules r join public.accounts a on a.id = r.account_id
        where r.company_id = $1`,
      [company],
    )
  )
    .map((r) => r.rule)
    .sort()

const boms = async (company: string) =>
  (
    await db.admin<{ line: string }>(
      `select p.code || ' ' || l.line_no || ' ' || c.code || ' ' || (l.quantity::float8)::text as line
         from public.boms b
         join public.products p on p.id = b.product_id
         join public.bom_lines l on l.bom_id = b.id
         join public.products c on c.id = l.component_id
        where b.company_id = $1`,
      [company],
    )
  )
    .map((r) => r.line)
    .sort()

const centers = async (company: string) =>
  (
    await db.admin<{ line: string }>(
      `select code || ' ' || (labor_rate::float8)::text || ' ' || (overhead_rate::float8)::text as line
         from public.work_centers where company_id = $1`,
      [company],
    )
  )
    .map((r) => r.line)
    .sort()

const operations = async (company: string) =>
  (
    await db.admin<{ line: string }>(
      `select p.code || ' ' || o.line_no || ' ' || w.code || ' ' || (o.hours::float8)::text as line
         from public.bom_operations o
         join public.boms b on b.id = o.bom_id
         join public.products p on p.id = b.product_id
         join public.work_centers w on w.id = o.work_center_id
        where o.company_id = $1`,
      [company],
    )
  )
    .map((r) => r.line)
    .sort()

const agreements = async (company: string) =>
  (
    await db.admin<{ line: string }>(
      `select code || ' ' || pay_basis || ' ' || (seniority_pct::float8)::text || ' ' || (attendance_pct::float8)::text
              || ' ' || (union_pct::float8)::text || ' ' || (union_employer_pct::float8)::text || ' ' || union_name as line
         from public.labor_agreements where company_id = $1`,
      [company],
    )
  )
    .map((r) => r.line)
    .sort()

const categories = async (company: string) =>
  (
    await db.admin<{ line: string }>(
      `select c.code || ' ' || a.code || ' ' || (c.basic_salary::float8)::text || ' ' || c.is_direct_labor::text as line
         from public.job_categories c join public.labor_agreements a on a.id = c.agreement_id
        where c.company_id = $1`,
      [company],
    )
  )
    .map((r) => r.line)
    .sort()

const staff = async (company: string) =>
  (
    await db.admin<{ line: string }>(
      `select e.file_number || ' ' || e.last_name || ' ' || c.code || ' ' || s.code || ' ' || coalesce(w.code, '-')
              || ' ' || e.hire_date::text as line
         from public.employees e
         join public.job_categories c on c.id = e.category_id
         join public.sectors s on s.id = e.sector_id
         left join public.work_centers w on w.id = e.work_center_id
        where e.company_id = $1`,
      [company],
    )
  )
    .map((r) => r.line)
    .sort()

const createFor = async (user: string, courseId: string) =>
  (
    await db.as<{ r: { id: string; slug: string } }>(u[user], 'select public.company_create_from_template($1) as r', [
      courseId,
    ])
  )[0].r

beforeAll(async () => {
  db = await createTestDb()
  await seedSchool(db)
  template = (await db.admin<{ id: string }>('select private.seed_demo_company() as id'))[0].id
  u.docente = await createUser(db, 'docente', 'DOCENTE')
  u.superadmin = await createUser(db, 'soporte', 'SUPERADMIN')
  u.admin = await createUser(db, 'secretaria', 'ADMIN')
  u.alumno = await createUser(db, 'alumno', 'ESTUDIANTE')
  ;[{ id: course }] = await db.admin<{ id: string }>(
    `insert into public.courses (academic_year, name) values (2027, '5.º A') returning id`,
  )
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('plantilla Forestal del Norte (seed_demo_company)', () => {
  it('tiene la estructura de la demo: islas, sectores, depósitos, módulos y reglas de aprobación', async () => {
    const [company] = await db.admin<{ slug: string; legal_name: string; is_template: boolean; settings: object }>(
      'select slug, legal_name, is_template, settings from public.companies where id = $1',
      [template],
    )
    expect(company).toEqual({
      slug: mockTemplate.slug,
      legal_name: mockTemplate.legal_name,
      is_template: true,
      settings: mockTemplate.settings,
    })
    const islandNumber = Object.fromEntries(ofTemplate(seed.islands).map((i) => [i.id, i.number]))
    const sectors = await db.admin<{ code: string; name: string; island: number | null }>(
      `select s.code, s.name, i.number as island from public.sectors s left join public.islands i on i.id = s.island_id
        where s.company_id = $1 order by s.code`,
      [template],
    )
    expect(sectors).toEqual(
      ofTemplate(seed.sectors)
        .map((s) => ({ code: s.code, name: s.name, island: s.island_id ? islandNumber[s.island_id] : null }))
        .sort((x, y) => x.code.localeCompare(y.code)),
    )
    expect(await count('islands', template)).toBe(ofTemplate(seed.islands).length)
    const warehouses = await db.admin('select code, name from public.warehouses where company_id = $1 order by code', [
      template,
    ])
    expect(warehouses).toEqual(
      ofTemplate(seed.warehouses)
        .map((w) => ({ code: w.code, name: w.name }))
        .sort((x, y) => x.code.localeCompare(y.code)),
    )
    const modules = await db.admin<{ module_code: string }>(
      'select module_code from public.company_modules where company_id = $1 and is_enabled order by 1',
      [template],
    )
    expect(modules.map((m) => m.module_code)).toEqual(
      ofTemplate(seed.companyModules)
        .filter((m) => m.is_enabled)
        .map((m) => m.module_code)
        .sort(),
    )
    const rules = await db.admin(
      `select doc_type, level, min_amount::float8 as min, max_amount::float8 as max, approver_role
         from public.approval_rules where company_id = $1 order by min_amount`,
      [template],
    )
    expect(rules).toEqual(
      ofTemplate(seed.approvalRules)
        .sort((x, y) => x.min_amount - y.min_amount)
        .map((r) => ({
          doc_type: r.doc_type,
          level: r.level,
          min: r.min_amount,
          max: r.max_amount,
          approver_role: r.approver_role,
        })),
    )
  })

  it('tiene los mismos proveedores, clientes y productos (con su proveedor y depósito habituales)', async () => {
    const suppliers = await db.admin(
      `select code, legal_name, tax_id, payment_terms_days, lead_time_days, category
         from public.suppliers where company_id = $1 order by code`,
      [template],
    )
    expect(suppliers).toEqual(
      ofTemplate(seed.suppliers).map((s) => ({
        code: s.code,
        legal_name: s.legal_name,
        tax_id: s.tax_id,
        payment_terms_days: s.payment_terms_days,
        lead_time_days: s.lead_time_days,
        category: s.category,
      })),
    )
    const customers = await db.admin(
      `select code, legal_name, credit_limit::float8 as credit_limit from public.customers where company_id = $1 order by code`,
      [template],
    )
    expect(customers).toEqual(
      ofTemplate(seed.customers).map((c) => ({ code: c.code, legal_name: c.legal_name, credit_limit: c.credit_limit })),
    )
    const products = await db.admin(
      `select p.code, p.name, p.product_type, p.uom_code, p.standard_cost::float8 as cost, p.min_stock::float8 as min_stock,
              s.code as supplier, w.code as warehouse
         from public.products p
         left join public.suppliers s on s.id = p.default_supplier_id
         left join public.warehouses w on w.id = p.default_warehouse_id
        where p.company_id = $1 order by p.code`,
      [template],
    )
    expect(products).toEqual(
      ofTemplate(seed.products)
        .map((p) => ({
          code: p.code,
          name: p.name,
          product_type: p.product_type,
          uom_code: p.uom_code,
          cost: p.standard_cost,
          min_stock: p.min_stock,
          supplier: p.default_supplier_id ? mockSupplier[p.default_supplier_id] : null,
          warehouse: p.default_warehouse_id ? mockWarehouse[p.default_warehouse_id] : null,
        }))
        .sort((x, y) => x.code.localeCompare(y.code)),
    )
  })

  it('carga el inventario inicial con un ajuste confirmado por depósito, a nombre del Sistema', async () => {
    expect(Object.keys(initialStock).length).toBeGreaterThan(0)
    expect(await balances(template)).toEqual(initialStock)
    const docs = await db.admin<{ number: number; status: string; reason_code: string; created_by: string | null }>(
      `select d.number, d.status, sa.reason_code, d.created_by
         from public.documents d join public.stock_adjustments sa on sa.document_id = d.id
        where d.company_id = $1 order by d.number`,
      [template],
    )
    expect(docs).toEqual([
      { number: 1, status: 'CONFIRMADO', reason_code: 'INVENTARIO_INICIAL', created_by: null },
      { number: 2, status: 'CONFIRMADO', reason_code: 'INVENTARIO_INICIAL', created_by: null },
    ])
    const [{ moves }] = await db.admin<{ moves: number }>(
      `select count(*)::int as moves from public.stock_movements where company_id = $1 and movement_type = 'STOCK_INICIAL'`,
      [template],
    )
    expect(moves).toBe(Object.keys(initialStock).length)
    const actors = await db.admin<{ actor_name: string; actor_role_code: string }>(
      `select distinct actor_name, actor_role_code from public.audit_events where company_id = $1`,
      [template],
    )
    expect(actors).toEqual([{ actor_name: 'Sistema', actor_role_code: 'SISTEMA' }])
  })

  it('deja las alertas de stock mínimo de arranque', async () => {
    expect(belowMinimum.length).toBeGreaterThan(0)
    expect(await alerts(template)).toEqual(belowMinimum)
  })

  it('nace con el plan de cuentas, el ejercicio en curso y el mismo asiento de apertura que la demo', async () => {
    expect(await count('accounts', template)).toBe(ofTemplate(seed.accounts).length)
    expect(await count('fiscal_periods', template)).toBe(12)
    expect(await opening(template)).toEqual(mockOpening)
  })

  it('tiene las mismas reglas de imputación automática que la demo', async () => {
    expect(mockRules.length).toBeGreaterThan(0)
    expect(await rules(template)).toEqual(mockRules)
  })

  it('tiene las mismas listas de materiales que la demo', async () => {
    expect(mockBoms.length).toBeGreaterThan(0)
    expect(await boms(template)).toEqual(mockBoms)
  })

  it('tiene los mismos centros de trabajo y las mismas horas por lista que la demo', async () => {
    expect(mockCenters).toHaveLength(3)
    expect(await centers(template)).toEqual(mockCenters)
    expect(mockOperations).toHaveLength(12)
    expect(await operations(template)).toEqual(mockOperations)
  })

  it('tiene los mismos convenios, categorías y personal que la demo', async () => {
    expect(mockAgreements).toHaveLength(4)
    expect(await agreements(template)).toEqual(mockAgreements)
    expect(mockCategories).toHaveLength(8)
    expect(await categories(template)).toEqual(mockCategories)
    expect(mockStaff).toHaveLength(11)
    expect(await staff(template)).toEqual(mockStaff)
  })

  it('es idempotente: si la plantilla existe, no la vuelve a cargar', async () => {
    const before = await count('documents', template)
    const [{ id }] = await db.admin<{ id: string }>('select private.seed_demo_company() as id')
    expect(id).toBe(template)
    expect(await count('documents', template)).toBe(before)
    expect(await count('products', template)).toBe(ofTemplate(seed.products).length)
  })

  it('nadie la ejecuta desde la aplicación', async () => {
    expect((await businessError(db.as(u.superadmin, 'select private.seed_demo_company()'))).code).toBe('SQL:42501')
  })
})

describe('empresa de un curso (company_create_from_template)', () => {
  let created: { id: string; slug: string }

  beforeAll(async () => {
    created = await createFor('docente', course)
  })

  it('copia estructura, maestros e inventario inicial; la numeración empieza en 1', async () => {
    expect(created.slug).toBe('forestal-del-norte-5-a-2027')
    const [company] = await db.admin<{ course_id: string; is_template: boolean; legal_name: string }>(
      'select course_id, is_template, legal_name from public.companies where id = $1',
      [created.id],
    )
    expect(company).toEqual({ course_id: course, is_template: false, legal_name: mockTemplate.legal_name })
    for (const table of [
      'islands',
      'sectors',
      'warehouses',
      'company_modules',
      'approval_rules',
      'suppliers',
      'customers',
      'products',
    ])
      expect(await count(table, created.id), table).toBe(await count(table, template))
    const orphans = await db.admin(
      `select p.code from public.products p
         left join public.suppliers s on s.id = p.default_supplier_id
         left join public.warehouses w on w.id = p.default_warehouse_id
        where p.company_id = $1
          and (s.company_id is distinct from p.company_id and p.default_supplier_id is not null
            or w.company_id is distinct from p.company_id and p.default_warehouse_id is not null)`,
      [created.id],
    )
    expect(orphans).toEqual([])
    expect(await balances(created.id)).toEqual(initialStock)
    const docs = await db.admin<{ number: number; display_number: string }>(
      'select number, display_number from public.documents where company_id = $1 order by number',
      [created.id],
    )
    const templateDocs = await db.admin<{ number: number; display_number: string }>(
      'select number, display_number from public.documents where company_id = $1 order by number',
      [template],
    )
    expect(docs).toEqual(templateDocs)
    expect(await alerts(created.id)).toEqual(belowMinimum)
    expect(await count('accounts', created.id)).toBe(await count('accounts', template))
    expect(await opening(created.id)).toEqual(mockOpening)
    expect(await rules(created.id)).toEqual(mockRules)
    expect(await boms(created.id)).toEqual(mockBoms)
    expect(await centers(created.id)).toEqual(mockCenters)
    expect(await operations(created.id)).toEqual(mockOperations)
    expect(await agreements(created.id)).toEqual(mockAgreements)
    expect(await categories(created.id)).toEqual(mockCategories)
    expect(await staff(created.id)).toEqual(mockStaff)
  })

  it('el docente queda como supervisor; la plantilla y la empresa nueva están aisladas', async () => {
    const roles = await db.admin(
      `select m.job_title, r.role_code from public.company_members m join public.member_roles r on r.member_id = m.id
        where m.company_id = $1 and m.user_id = $2`,
      [created.id, u.docente],
    )
    expect(roles).toEqual([{ job_title: 'Docente a cargo', role_code: 'DOCENTE' }])
    const visible = async (user: string, company: string) =>
      (
        await db.as<{ n: number }>(user, 'select count(*)::int as n from public.products where company_id = $1', [
          company,
        ])
      )[0].n
    const products = ofTemplate(seed.products).length
    expect(await visible(u.docente, created.id)).toBe(products)
    expect(await visible(u.docente, template)).toBe(0)
    expect(await visible(u.alumno, created.id)).toBe(0)
    // Ya como integrante de la empresa del curso, el alumno la ve; la plantilla, nunca.
    const [{ id: member }] = await db.admin<{ id: string }>(
      `insert into public.company_members (company_id, user_id) values ($1, $2) returning id`,
      [created.id, u.alumno],
    )
    await db.admin(`insert into public.member_roles (company_id, member_id, role_code) values ($1, $2, 'COMPRAS')`, [
      created.id,
      member,
    ])
    expect(await visible(u.alumno, created.id)).toBe(products)
    expect(await visible(u.alumno, template)).toBe(0)
  })

  it('audita primero la creación (a nombre del docente) y después la carga del sistema', async () => {
    const events = await db.admin<{ actor_role_code: string; action: string; entity_type: string; summary: string }>(
      'select actor_role_code, action, entity_type, summary from public.audit_events where company_id = $1 order by id',
      [created.id],
    )
    expect(events[0]).toEqual({
      actor_role_code: 'DOCENTE',
      action: 'CREATE',
      entity_type: 'company',
      summary: 'Creó la empresa para 5.º A 2027 a partir de la plantilla Forestal del Norte SRL',
    })
    expect(new Set(events.slice(1).map((e) => e.actor_role_code))).toEqual(new Set(['SISTEMA']))
  })

  it('otra empresa para el mismo curso recibe una dirección distinta', async () => {
    const second = await createFor('superadmin', course)
    expect(second.slug).toBe('forestal-del-norte-5-a-2027-2')
  })

  it('sólo un docente (o soporte) crea empresas', async () => {
    for (const user of ['admin', 'alumno']) {
      const error = await businessError(createFor(user, course))
      expect(error.code, user).toBe('SIN_PERMISO')
    }
    const anon = await businessError(db.anon('select public.company_create_from_template($1)', [course]))
    expect(anon.code).toBe('SQL:42501')
  })

  it('valida el curso y que exista una plantilla activa', async () => {
    expect((await businessError(createFor('docente', '00000000-0000-0000-0000-000000000000'))).code).toBe(
      'DATO_INVALIDO',
    )
    await db.admin(`update public.companies set status = 'ARCHIVADA' where id = $1`, [template])
    try {
      const error = await businessError(createFor('docente', course))
      expect(error).toMatchObject({ code: 'DATO_INVALIDO', message: 'No hay una empresa plantilla disponible.' })
    } finally {
      await db.admin(`update public.companies set status = 'ACTIVA' where id = $1`, [template])
    }
  })

  it('arma la dirección sin acentos ni símbolos, como el motor simulado', async () => {
    const rows = await db.admin<{ slug: string }>(
      `select private.slugify(t) as slug from unnest(array['Forestal del Norte 5.º A 2027', 'ÑANDÚ Él', '  --Año 2027--  ']) as t`,
    )
    expect(rows.map((r) => r.slug)).toEqual(['forestal-del-norte-5-a-2027', 'nandu-el', 'ano-2027'])
  })
})
