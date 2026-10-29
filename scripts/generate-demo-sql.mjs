// Genera la función private.seed_demo_company() a partir del seed del backend
// simulado (src/lib/mock/seed.ts → buildSeed): la empresa plantilla Forestal
// del Norte SRL con su estructura, maestros, inventario inicial y contabilidad,
// iguales a los de la demo local. No incluye las operaciones de ejemplo de la
// demo (SC, OC, REC y asientos manuales): las empresas de los cursos tampoco
// las copian. También genera los datos del plan de cuentas básico y de la
// apertura (src/lib/domain/chart-of-accounts.ts) que usa private.start_accounting.
//
// Uso: npm run db:demo [-- nombre-de-archivo.sql]
// Sin argumento reescribe la última migración de la plantilla (la de la Fase 7c.1).
// Las funciones son "create or replace": si cambian después de aplicada, se
// regeneran en una migración nueva con otro nombre.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

const root = join(import.meta.dirname, '..')
const target = process.argv[2] ?? '20261029150200_demo_template_transporte.sql'

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
})

const sql = (value) =>
  value === null || value === undefined
    ? 'null'
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : `'${String(value).replace(/'/g, "''")}'`

const values = (rows, columns) => rows.map((r) => `      (${columns.map((c) => sql(r[c])).join(', ')})`).join(',\n')

try {
  const { buildSeed } = await server.ssrLoadModule('/src/lib/mock/seed.ts')
  const chart = await server.ssrLoadModule('/src/lib/domain/chart-of-accounts.ts')
  const { IIBB_DEFAULT_PCT } = await server.ssrLoadModule('/src/lib/domain/catalog.ts')
  const { DEMO_BOMS, DEMO_BOM_OPERATIONS, DEMO_WORK_CENTERS } = await server.ssrLoadModule('/src/lib/domain/boms.ts')
  const { DEMO_EMPLOYEES, DEMO_JOB_CATEGORIES, DEMO_LABOR_AGREEMENTS, MONTH_HOURS } =
    await server.ssrLoadModule('/src/lib/domain/employees.ts')
  const { DEMO_CARRIERS, DEMO_VEHICLES } = await server.ssrLoadModule('/src/lib/domain/logistics.ts')
  const driver = DEMO_EMPLOYEES.find((e) => e.category === 'CHOFER')
  if (!driver) throw new Error('El personal de la demo no tiene chofer')
  const bomOperationRows = DEMO_BOM_OPERATIONS.flatMap((b) =>
    b.operations.map(([center, hours], i) => ({ product: b.product, line_no: i + 1, center, hours })),
  )
  const bomRows = DEMO_BOMS.flatMap((b) =>
    b.components.map(([component, quantity], i) => ({ product: b.product, line_no: i + 1, component, quantity })),
  )
  const db = buildSeed()
  const accounts = chart.BASE_CHART.map(([code, name, description = '', contra = false]) => {
    const type = chart.accountTypeOf(code)
    const level = chart.accountLevel(code)
    return {
      code,
      name,
      account_type: type,
      normal_side: chart.normalSideOf(type, contra),
      level,
      is_imputable: level === chart.IMPUTABLE_LEVEL,
      description,
    }
  })
  const inventoryCases = Object.entries(chart.INVENTORY_ACCOUNTS)
    .filter(([, code]) => code)
    .map(([type, code]) => `when ${sql(type)} then ${sql(code)}`)
    .join(' ')
  const company = db.companies.find((c) => c.is_template)
  if (!company) throw new Error('El seed no tiene una empresa plantilla')
  const of = (rows) => rows.filter((r) => r.company_id === company.id)
  const islands = of(db.islands)
  const islandNumber = Object.fromEntries(islands.map((i) => [i.id, i.number]))
  const warehouses = of(db.warehouses)
  const warehouseCode = Object.fromEntries(warehouses.map((w) => [w.id, w.code]))
  const suppliers = of(db.suppliers)
  const supplierCode = Object.fromEntries(suppliers.map((s) => [s.id, s.code]))
  const products = of(db.products)
  const productCode = Object.fromEntries(products.map((p) => [p.id, p.code]))
  const sectors = of(db.sectors).map((s) => ({ ...s, island: islandNumber[s.island_id] ?? null }))
  const productRows = products.map((p) => ({
    ...p,
    supplier_code: supplierCode[p.default_supplier_id] ?? null,
    warehouse_code: warehouseCode[p.default_warehouse_id] ?? null,
  }))
  const initial = of(db.documents)
    .filter(
      (d) =>
        d.doc_type === 'STOCK_ADJUSTMENT' && d.status === 'CONFIRMADO' && d.sa?.reason_code === 'INVENTARIO_INICIAL',
    )
    .sort((x, y) => x.number - y.number)
    .map((d) => ({
      warehouse: warehouseCode[d.sa.warehouse_id],
      lines: db.saLines
        .filter((l) => l.document_id === d.id && l.quantity_delta > 0)
        .sort((x, y) => x.line_no - y.line_no)
        .map((l, i) => ({ code: productCode[l.product_id], qty: l.quantity_delta, cost: l.unit_cost, ord: i + 1 })),
    }))

  const stockBlocks = initial
    .map(
      (adj) => `  perform private.post_initial_stock(v_id,
    (select w.id from public.warehouses w where w.company_id = v_id and w.code = ${sql(adj.warehouse)}),
    (select jsonb_agg(jsonb_build_object('product_id', p.id, 'quantity_delta', l.qty, 'unit_cost', l.cost) order by l.ord)
       from (values
${values(adj.lines, ['code', 'qty', 'cost', 'ord'])}
       ) as l (code, qty, cost, ord)
       join public.products p on p.company_id = v_id and p.code = l.code));`,
    )
    .join('\n')

  const out = `-- 16. Empresa plantilla de demostración: FORESTAL DEL NORTE SRL (datos ficticios),
-- ahora con su contabilidad, y los datos del plan de cuentas básico y de la apertura.
-- GENERADO por scripts/generate-demo-sql.mjs desde src/lib/mock/seed.ts y
-- src/lib/domain/chart-of-accounts.ts: no editar a mano.
-- Se ejecuta al instalar una escuela (docs/INSTANCIAS.md): select private.seed_demo_company();
-- Idempotente: si la plantilla ya existe, devuelve su id sin tocarla.

-- ------------------------------------------------------------------ Plan de cuentas básico (a validar por el docente)
create or replace function private.insert_base_chart(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.accounts (company_id, code, name, account_type, normal_side, level, is_imputable, description)
  select p_company, a.code, a.name, a.account_type, a.normal_side, a.level, a.is_imputable, a.description
    from (values
${values(accounts, ['code', 'name', 'account_type', 'normal_side', 'level', 'is_imputable', 'description'])}
    ) as a (code, name, account_type, normal_side, level, is_imputable, description)
   where not exists (select 1 from public.accounts x where x.company_id = p_company and x.code = a.code);
end;
$$;

-- Saldos fijos del asiento de apertura; los bienes de cambio salen del inventario inicial.
create or replace function private.opening_amounts()
returns table (code text, debit numeric, credit numeric)
language sql
immutable
set search_path = ''
as $$
  select o.code::text, o.debit::numeric, o.credit::numeric
    from (values
${values(chart.OPENING_BALANCES, ['code', 'debit', 'credit'])}
    ) as o (code, debit, credit)
$$;

-- Cuenta de bienes de cambio de cada tipo de producto.
create or replace function private.inventory_account(p_product_type text)
returns text
language sql
immutable
set search_path = ''
as $$ select case p_product_type ${inventoryCases} end $$;

-- La diferencia del asiento de apertura.
create or replace function private.opening_balancing_account()
returns text
language sql
immutable
set search_path = ''
as $$ select ${sql(chart.OPENING_BALANCING_ACCOUNT)}::text $$;

-- Reglas base de la imputación automática, sin pisar las que la empresa ya tiene.
create or replace function private.insert_base_posting_rules(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.posting_rules (company_id, event, key, account_id)
  select p_company, r.event, r.key, a.id
    from (values
${values(chart.BASE_POSTING_RULES, ['event', 'key', 'code'])}
    ) as r (event, key, code)
    join public.accounts a on a.company_id = p_company and a.code = r.code
   where not exists (
     select 1 from public.posting_rules x where x.company_id = p_company and x.event = r.event and x.key = r.key
   );
end;
$$;

-- Rubro de las cajas y los bancos: sus cuentas imputables son desde donde se paga.
create or replace function private.treasury_rubro()
returns text
language sql
immutable
set search_path = ''
as $$ select ${sql(chart.TREASURY_RUBRO)}::text $$;

-- La alícuota de ingresos brutos si el docente no la cambió (IIBB_DEFAULT_PCT, a validar).
create or replace function private.iibb_default_pct()
returns numeric
language sql
immutable
set search_path = ''
as $$ select ${IIBB_DEFAULT_PCT}::numeric $$;

-- ------------------------------------------------------------------ Listas de materiales de la demo (a validar)
create or replace function private.demo_bom_rows()
returns table (product text, line_no int, component text, quantity numeric)
language sql
immutable
set search_path = ''
as $$
  select b.product::text, b.line_no::int, b.component::text, b.quantity::numeric
    from (values
${values(bomRows, ['product', 'line_no', 'component', 'quantity'])}
    ) as b (product, line_no, component, quantity)
$$;

-- Carga las listas de la demo por código (insertBoms): sólo para los productos
-- terminados que existen y todavía no tienen, y si todos sus componentes existen
-- y son materias primas o insumos.
create or replace function private.insert_demo_boms(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_bom uuid;
begin
  for v_product in
    select p.* from public.products p
     where p.company_id = p_company and p.product_type = 'PRODUCTO_TERMINADO'
       and p.code in (select r.product from private.demo_bom_rows() r)
       and not exists (select 1 from public.boms b where b.product_id = p.id)
     order by p.code collate "C"
  loop
    continue when exists (
      select 1 from private.demo_bom_rows() r
       where r.product = v_product.code
         and not exists (select 1 from public.products c
                          where c.company_id = p_company and c.code = r.component
                            and c.product_type in ('MATERIA_PRIMA', 'INSUMO')));
    insert into public.boms (company_id, product_id) values (p_company, v_product.id) returning id into v_bom;
    insert into public.bom_lines (company_id, bom_id, line_no, component_id, quantity)
    select p_company, v_bom, r.line_no, c.id, r.quantity
      from private.demo_bom_rows() r join public.products c on c.company_id = p_company and c.code = r.component
     where r.product = v_product.code;
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Centros de trabajo y horas de la demo (a validar)
create or replace function private.demo_work_center_rows()
returns table (code text, name text, labor_rate numeric, overhead_rate numeric)
language sql
immutable
set search_path = ''
as $$
  select w.code::text, w.name::text, w.labor_rate::numeric, w.overhead_rate::numeric
    from (values
${values(DEMO_WORK_CENTERS, ['code', 'name', 'labor_rate', 'overhead_rate'])}
    ) as w (code, name, labor_rate, overhead_rate)
$$;

-- Los centros de la demo que la empresa todavía no tiene, por código (insertWorkCenters).
create or replace function private.insert_demo_work_centers(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.work_centers (company_id, code, name, labor_rate, overhead_rate)
  select p_company, r.code, r.name, r.labor_rate, r.overhead_rate
    from private.demo_work_center_rows() r
   where not exists (select 1 from public.work_centers w where w.company_id = p_company and w.code = r.code)
$$;

create or replace function private.demo_bom_operation_rows()
returns table (product text, line_no int, center text, hours numeric)
language sql
immutable
set search_path = ''
as $$
  select o.product::text, o.line_no::int, o.center::text, o.hours::numeric
    from (values
${values(bomOperationRows, ['product', 'line_no', 'center', 'hours'])}
    ) as o (product, line_no, center, hours)
$$;

-- Las horas de la demo en las listas de esos productos que todavía no tienen,
-- si existen todos sus centros de trabajo (insertBomOperations).
create or replace function private.insert_demo_bom_operations(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bom record;
begin
  for v_bom in
    select b.id, p.code from public.boms b join public.products p on p.id = b.product_id
     where b.company_id = p_company
       and p.code in (select r.product from private.demo_bom_operation_rows() r)
       and not exists (select 1 from public.bom_operations o where o.bom_id = b.id)
     order by p.code collate "C"
  loop
    continue when exists (
      select 1 from private.demo_bom_operation_rows() r
       where r.product = v_bom.code
         and not exists (select 1 from public.work_centers w where w.company_id = p_company and w.code = r.center));
    insert into public.bom_operations (company_id, bom_id, line_no, work_center_id, hours)
    select p_company, v_bom.id, r.line_no, w.id, r.hours
      from private.demo_bom_operation_rows() r join public.work_centers w on w.company_id = p_company and w.code = r.center
     where r.product = v_bom.code;
  end loop;
end;
$$;

-- ------------------------------------------------------------------ El personal de la demo (a validar)
-- Las horas de un mes completo de quien cobra por hora (MONTH_HOURS).
create or replace function private.month_hours()
returns numeric
language sql
immutable
set search_path = ''
as $$ select ${MONTH_HOURS}::numeric $$;

create or replace function private.demo_labor_agreement_rows()
returns table (code text, name text, union_name text, pay_basis text, seniority_pct numeric, attendance_pct numeric,
               union_pct numeric, union_employer_pct numeric)
language sql
immutable
set search_path = ''
as $$
  select a.code::text, a.name::text, a.union_name::text, a.pay_basis::text, a.seniority_pct::numeric,
         a.attendance_pct::numeric, a.union_pct::numeric, a.union_employer_pct::numeric
    from (values
${values(DEMO_LABOR_AGREEMENTS, ['code', 'name', 'union_name', 'pay_basis', 'seniority_pct', 'attendance_pct', 'union_pct', 'union_employer_pct'])}
    ) as a (code, name, union_name, pay_basis, seniority_pct, attendance_pct, union_pct, union_employer_pct)
$$;

-- Los convenios de la demo que la empresa todavía no tiene, por código (insertLaborAgreements).
create or replace function private.insert_demo_labor_agreements(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.labor_agreements (company_id, code, name, union_name, pay_basis, seniority_pct, attendance_pct,
                                       union_pct, union_employer_pct)
  select p_company, r.code, r.name, r.union_name, r.pay_basis, r.seniority_pct, r.attendance_pct, r.union_pct,
         r.union_employer_pct
    from private.demo_labor_agreement_rows() r
   where not exists (select 1 from public.labor_agreements a where a.company_id = p_company and a.code = r.code)
$$;

-- Ahora cada categoría trae su convenio: cambia lo que devuelve, así que se vuelve a crear.
drop function if exists private.demo_job_category_rows();
create or replace function private.demo_job_category_rows()
returns table (code text, name text, agreement text, basic_salary numeric, is_direct_labor boolean)
language sql
immutable
set search_path = ''
as $$
  select c.code::text, c.name::text, c.agreement::text, c.basic_salary::numeric, c.is_direct_labor::boolean
    from (values
${values(DEMO_JOB_CATEGORIES, ['code', 'name', 'agreement', 'basic_salary', 'is_direct_labor'])}
    ) as c (code, name, agreement, basic_salary, is_direct_labor)
$$;

-- Las categorías de la demo que la empresa todavía no tiene, por código, cada una en su
-- convenio; si la empresa no tiene ese convenio, esa no (insertJobCategories).
create or replace function private.insert_demo_job_categories(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.job_categories (company_id, code, name, agreement_id, basic_salary, is_direct_labor)
  select p_company, r.code, r.name, a.id, r.basic_salary, r.is_direct_labor
    from private.demo_job_category_rows() r
    join public.labor_agreements a on a.company_id = p_company and a.code = r.agreement
   where not exists (select 1 from public.job_categories c where c.company_id = p_company and c.code = r.code)
$$;

create or replace function private.demo_employee_rows()
returns table (file_number int, first_name text, last_name text, hire_date date, category text, sector text,
               work_center text)
language sql
immutable
set search_path = ''
as $$
  select e.file_number::int, e.first_name::text, e.last_name::text, e.hire_date::date, e.category::text,
         e.sector::text, e.work_center::text
    from (values
${values(DEMO_EMPLOYEES, ['file_number', 'first_name', 'last_name', 'hire_date', 'category', 'sector', 'work_center'])}
    ) as e (file_number, first_name, last_name, hire_date, category, sector, work_center)
$$;

-- El personal de la demo, si la empresa todavía no tiene legajos: cada uno con su
-- categoría, su sector y su centro de trabajo por código; si falta alguno, ese no
-- (insertEmployees).
create or replace function private.insert_demo_employees(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.employees (company_id, file_number, first_name, last_name, hire_date, category_id, sector_id,
                                work_center_id)
  select p_company, r.file_number, r.first_name, r.last_name, r.hire_date, c.id, s.id, w.id
    from private.demo_employee_rows() r
    join public.job_categories c on c.company_id = p_company and c.code = r.category
    join public.sectors s on s.company_id = p_company and s.code = r.sector
    left join public.work_centers w on w.company_id = p_company and w.code = r.work_center
   where not exists (select 1 from public.employees x where x.company_id = p_company)
     and (r.work_center is null or w.id is not null)
$$;

-- El chofer de la demo (Fase 6d) en una empresa que ya tiene personal pero ningún chofer:
-- con el número de legajo siguiente (insertDriver).
create or replace function private.insert_demo_driver(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.employees (company_id, file_number, first_name, last_name, hire_date, category_id, sector_id)
  select p_company, (select max(x.file_number) + 1 from public.employees x where x.company_id = p_company),
         r.first_name, r.last_name, r.hire_date, c.id, s.id
    from private.demo_employee_rows() r
    join public.job_categories c on c.company_id = p_company and c.code = r.category
    join public.sectors s on s.company_id = p_company and s.code = r.sector
   where r.category = ${sql(driver.category)}
     and exists (select 1 from public.employees x where x.company_id = p_company)
     and not exists (select 1 from public.employees x where x.category_id = c.id)
$$;

-- ------------------------------------------------------------------ El transporte de la demo (a validar)
create or replace function private.demo_carrier_rows()
returns table (code text, legal_name text, tax_id text, phone text)
language sql
immutable
set search_path = ''
as $$
  select c.code::text, c.legal_name::text, c.tax_id::text, c.phone::text
    from (values
${values(DEMO_CARRIERS, ['code', 'legal_name', 'tax_id', 'phone'])}
    ) as c (code, legal_name, tax_id, phone)
$$;

-- Los transportistas de la demo que la empresa todavía no tiene, por código (insertCarriers).
create or replace function private.insert_demo_carriers(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.carriers (company_id, code, legal_name, tax_id, phone)
  select p_company, r.code, r.legal_name, r.tax_id, r.phone
    from private.demo_carrier_rows() r
   where not exists (select 1 from public.carriers c where c.company_id = p_company and c.code = r.code)
$$;

create or replace function private.demo_vehicle_rows()
returns table (code text, plate text, description text)
language sql
immutable
set search_path = ''
as $$
  select v.code::text, v.plate::text, v.description::text
    from (values
${values(DEMO_VEHICLES, ['code', 'plate', 'description'])}
    ) as v (code, plate, description)
$$;

-- Los vehículos de la demo que la empresa todavía no tiene: ni su código ni su dominio
-- (insertVehicles).
create or replace function private.insert_demo_vehicles(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.vehicles (company_id, code, plate, description)
  select p_company, r.code, r.plate, r.description
    from private.demo_vehicle_rows() r
   where not exists (select 1 from public.vehicles v
                      where v.company_id = p_company and (v.code = r.code or v.plate = r.plate))
$$;

-- ------------------------------------------------------------------ Empresa plantilla
create or replace function private.seed_demo_company()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id from public.companies c where c.slug = ${sql(company.slug)};
  if found then
    return v_id;
  end if;

  insert into public.companies (slug, legal_name, trade_name, tax_id, vat_condition, activity, address_line, city, province,
                                start_date, is_template, settings)
  values (${sql(company.slug)}, ${sql(company.legal_name)}, ${sql(company.trade_name)}, ${sql(company.tax_id)},
          ${sql(company.vat_condition)}, ${sql(company.activity)}, ${sql(company.address_line)}, ${sql(company.city)},
          ${sql(company.province)}, ${sql(company.start_date)}, true, ${sql(JSON.stringify(company.settings))})
  returning id into v_id;

  insert into public.islands (company_id, number, name)
  select v_id, i.number, i.name from (values
${values(islands, ['number', 'name'])}
    ) as i (number, name);

  insert into public.sectors (company_id, code, name, island_id)
  select v_id, s.code, s.name, i.id
    from (values
${values(sectors, ['code', 'name', 'island'])}
    ) as s (code, name, island)
    left join public.islands i on i.company_id = v_id and i.number = s.island;

  insert into public.warehouses (company_id, code, name)
  select v_id, w.code, w.name from (values
${values(warehouses, ['code', 'name'])}
    ) as w (code, name);

  insert into public.company_modules (company_id, module_code, is_enabled)
  select v_id, m.code, m.enabled from (values
${values(
  of(db.companyModules).map((m) => ({ code: m.module_code, enabled: m.is_enabled })),
  ['code', 'enabled'],
)}
    ) as m (code, enabled);

  insert into public.approval_rules (company_id, doc_type, level, min_amount, max_amount, approver_role,
                                     require_different_user, description)
  select v_id, r.doc_type, r.level, r.min_amount, r.max_amount::numeric, r.approver_role, r.require_different_user, r.description
    from (values
${values(of(db.approvalRules), ['doc_type', 'level', 'min_amount', 'max_amount', 'approver_role', 'require_different_user', 'description'])}
    ) as r (doc_type, level, min_amount, max_amount, approver_role, require_different_user, description);

  insert into public.suppliers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, lead_time_days, category, notes)
  select v_id, s.code, s.legal_name, s.trade_name, s.tax_id, s.vat_condition, s.address_line, s.city, s.province,
         s.phone, s.email, s.contact_name, s.payment_terms_days, s.lead_time_days, s.category, s.notes
    from (values
${values(suppliers, ['code', 'legal_name', 'trade_name', 'tax_id', 'vat_condition', 'address_line', 'city', 'province', 'phone', 'email', 'contact_name', 'payment_terms_days', 'lead_time_days', 'category', 'notes'])}
    ) as s (code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province, phone, email,
            contact_name, payment_terms_days, lead_time_days, category, notes);

  insert into public.customers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, credit_limit, notes)
  select v_id, c.code, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.address_line, c.city, c.province,
         c.phone, c.email, c.contact_name, c.payment_terms_days, c.credit_limit::numeric, c.notes
    from (values
${values(of(db.customers), ['code', 'legal_name', 'trade_name', 'tax_id', 'vat_condition', 'address_line', 'city', 'province', 'phone', 'email', 'contact_name', 'payment_terms_days', 'credit_limit', 'notes'])}
    ) as c (code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province, phone, email,
            contact_name, payment_terms_days, credit_limit, notes);

  insert into public.products (company_id, code, name, description, category, product_type, uom_code, is_stockable,
                               standard_cost, sale_price, vat_rate, min_stock, reorder_qty, default_supplier_id,
                               default_warehouse_id, location)
  select v_id, p.code, p.name, p.description, p.category, p.product_type, p.uom_code, p.is_stockable,
         p.standard_cost, p.sale_price::numeric, p.vat_rate, p.min_stock, p.reorder_qty::numeric, s.id, w.id, p.location
    from (values
${values(productRows, ['code', 'name', 'description', 'category', 'product_type', 'uom_code', 'is_stockable', 'standard_cost', 'sale_price', 'vat_rate', 'min_stock', 'reorder_qty', 'supplier_code', 'warehouse_code', 'location'])}
    ) as p (code, name, description, category, product_type, uom_code, is_stockable, standard_cost, sale_price, vat_rate,
            min_stock, reorder_qty, supplier_code, warehouse_code, location)
    left join public.suppliers s on s.company_id = v_id and s.code = p.supplier_code
    left join public.warehouses w on w.company_id = v_id and w.code = p.warehouse_code;

  -- Los centros de trabajo y las listas de materiales de los muebles, con sus horas.
  perform private.insert_demo_work_centers(v_id);
  perform private.insert_demo_boms(v_id);
  perform private.insert_demo_bom_operations(v_id);
  -- El personal: convenios, categorías y legajos (a validar).
  perform private.insert_demo_labor_agreements(v_id);
  perform private.insert_demo_job_categories(v_id);
  perform private.insert_demo_employees(v_id);
  -- El transporte: los fletes contratados y el camión propio (a validar).
  perform private.insert_demo_carriers(v_id);
  perform private.insert_demo_vehicles(v_id);

  -- Inventario inicial documentado (un ajuste por depósito), contabilidad con su
  -- asiento de apertura y alertas de arranque.
${stockBlocks}
  perform private.start_accounting(v_id);
  perform private.scan_stock_alerts(v_id);
  return v_id;
end;
$$;
`
  const file = join(root, 'supabase', 'migrations', target)
  writeFileSync(file, out)
  console.log(
    `${file}\n${sectors.length} sectores · ${warehouses.length} depósitos · ${suppliers.length} proveedores · ` +
      `${of(db.customers).length} clientes · ${products.length} productos · ${initial.length} ajustes de inventario inicial · ` +
      `${accounts.length} cuentas · ${DEMO_BOMS.length} listas de materiales · ${DEMO_WORK_CENTERS.length} centros de trabajo · ${DEMO_LABOR_AGREEMENTS.length} convenios · ${DEMO_JOB_CATEGORIES.length} categorías · ${DEMO_EMPLOYEES.length} legajos`,
  )
} finally {
  await server.close()
}
