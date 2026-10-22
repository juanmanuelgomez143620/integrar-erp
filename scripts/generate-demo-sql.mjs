// Genera la función private.seed_demo_company() a partir del seed del backend
// simulado (src/lib/mock/seed.ts → buildSeed): la empresa plantilla Forestal
// del Norte SRL con su estructura, maestros, inventario inicial y contabilidad,
// iguales a los de la demo local. No incluye las operaciones de ejemplo de la
// demo (SC, OC, REC y asientos manuales): las empresas de los cursos tampoco
// las copian. También genera los datos del plan de cuentas básico y de la
// apertura (src/lib/domain/chart-of-accounts.ts) que usa private.start_accounting.
//
// Uso: npm run db:demo [-- nombre-de-archivo.sql]
// Sin argumento reescribe la última migración de la plantilla (la de la Fase 5a).
// Las funciones son "create or replace": si cambian después de aplicada, se
// regeneran en una migración nueva con otro nombre.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

const root = join(import.meta.dirname, '..')
const target = process.argv[2] ?? '20261022140200_demo_template_produccion.sql'

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
  const { DEMO_BOMS } = await server.ssrLoadModule('/src/lib/domain/boms.ts')
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
    ) as a (code, name, account_type, normal_side, level, is_imputable, description);
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

  -- Las listas de materiales de los muebles.
  perform private.insert_demo_boms(v_id);

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
      `${accounts.length} cuentas · ${DEMO_BOMS.length} listas de materiales`,
  )
} finally {
  await server.close()
}
