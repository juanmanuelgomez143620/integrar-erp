// Datos de prueba mínimos, insertados como superusuario (sin pasar por RLS).

import type { TestDb } from './db'

export async function seedSchool(db: TestDb) {
  await db.admin(
    `insert into public.school_settings (official_name, short_name) values ('Escuela de Prueba N.º 1', 'EP N.º 1')
     on conflict (id) do nothing`,
  )
}

/** Usuario de Auth + perfil (lo crea el trigger a partir de raw_app_meta_data). */
export async function createUser(
  db: TestDb,
  username: string,
  appRole: 'SUPERADMIN' | 'ADMIN' | 'DOCENTE' | 'ESTUDIANTE' = 'ESTUDIANTE',
): Promise<string> {
  const [row] = await db.admin<{ id: string }>(
    `insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id`,
    [
      `${username}@usuarios.test`,
      JSON.stringify({
        username,
        first_name: username,
        last_name: 'Prueba',
        app_role: appRole,
        must_change_password: false,
      }),
    ],
  )
  return row.id
}

export interface TestCompany {
  id: string
  slug: string
  sector: Record<string, string>
  warehouse: string
}

const SECTORS: [string, string][] = [
  ['GER', 'Gerencia'],
  ['CGE', 'Control de Gestión'],
  ['COM', 'Compras'],
  ['VEN', 'Ventas'],
  ['PRO', 'Producción'],
  ['DEP', 'Depósito'],
]

/** Empresa con sectores, un depósito y las reglas de aprobación del MVP. */
export async function createCompany(db: TestDb, slug: string): Promise<TestCompany> {
  const [company] = await db.admin<{ id: string }>(
    `insert into public.companies (slug, legal_name, trade_name, tax_id) values ($1, $2, $2, '30-00000001-0') returning id`,
    [slug, `Empresa ${slug}`],
  )
  const sector: Record<string, string> = {}
  for (const [code, name] of SECTORS) {
    const [s] = await db.admin<{ id: string }>(
      `insert into public.sectors (company_id, code, name) values ($1, $2, $3) returning id`,
      [company.id, code, name],
    )
    sector[code] = s.id
  }
  const [warehouse] = await db.admin<{ id: string }>(
    `insert into public.warehouses (company_id, code, name) values ($1, 'DEP-MP', 'Depósito de materias primas') returning id`,
    [company.id],
  )
  await db.admin(
    `insert into public.approval_rules (company_id, doc_type, min_amount, max_amount, approver_role, description) values
       ($1, 'PURCHASE_ORDER', 0, 500000, 'COMPRAS', 'Hasta $ 500.000: otro integrante de Compras.'),
       ($1, 'PURCHASE_ORDER', 500000.01, null, 'GERENCIA', 'Más de $ 500.000: Gerencia.')`,
    [company.id],
  )
  return { id: company.id, slug, sector, warehouse: warehouse.id }
}

/** Integrante con roles; cada rol con su sector (código) o sin sector. */
export async function addMember(db: TestDb, company: TestCompany, userId: string, roles: [string, string | null][]) {
  const [member] = await db.admin<{ id: string }>(
    `insert into public.company_members (company_id, user_id) values ($1, $2) returning id`,
    [company.id, userId],
  )
  for (const [role, sectorCode] of roles) {
    await db.admin(
      `insert into public.member_roles (company_id, member_id, role_code, sector_id) values ($1, $2, $3, $4)`,
      [company.id, member.id, role, sectorCode ? company.sector[sectorCode] : null],
    )
  }
  return member.id
}

export async function createSupplier(db: TestDb, company: TestCompany, code: string, name = `Proveedor ${code}`) {
  const [row] = await db.admin<{ id: string }>(
    `insert into public.suppliers (company_id, code, legal_name) values ($1, $2, $3) returning id`,
    [company.id, code, name],
  )
  return row.id
}

export async function createProduct(
  db: TestDb,
  company: TestCompany,
  code: string,
  opts: { supplierId?: string; minStock?: number; cost?: number } = {},
) {
  const [row] = await db.admin<{ id: string }>(
    `insert into public.products (company_id, code, name, product_type, uom_code, is_stockable, standard_cost,
                                  min_stock, default_supplier_id, default_warehouse_id)
     values ($1, $2, $3, 'MATERIA_PRIMA', 'UN', true, $4, $5, $6, $7) returning id`,
    [
      company.id,
      code,
      `Producto ${code}`,
      opts.cost ?? 1000,
      opts.minStock ?? 0,
      opts.supplierId ?? null,
      company.warehouse,
    ],
  )
  return row.id
}
