// Genera la función private.seed_demo_company() a partir del seed del backend
// simulado (src/lib/mock/seed.ts → buildSeed): la empresa plantilla Forestal
// del Norte SRL con su estructura, maestros e inventario inicial, iguales a los
// de la demo local. No incluye las operaciones de ejemplo de la demo (SC, OC y
// REC): las empresas de los cursos tampoco las copian.
//
// Uso: npm run db:demo [-- nombre-de-archivo.sql]
// La función es "create or replace": regenerarla en una migración nueva la actualiza.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

const root = join(import.meta.dirname, '..')
const target = process.argv[2] ?? '20261003191200_demo_template.sql'

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
  const db = buildSeed()
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

  const out = `-- 13. Empresa plantilla de demostración: FORESTAL DEL NORTE SRL (datos ficticios).
-- GENERADO por scripts/generate-demo-sql.mjs desde src/lib/mock/seed.ts: no editar a mano.
-- Se ejecuta al instalar una escuela (docs/INSTANCIAS.md): select private.seed_demo_company();
-- Idempotente: si la plantilla ya existe, devuelve su id sin tocarla.

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

  -- Inventario inicial documentado (un ajuste por depósito) y alertas de arranque.
${stockBlocks}
  perform private.scan_stock_alerts(v_id);
  return v_id;
end;
$$;
`
  const file = join(root, 'supabase', 'migrations', target)
  writeFileSync(file, out)
  console.log(
    `${file}\n${sectors.length} sectores · ${warehouses.length} depósitos · ${suppliers.length} proveedores · ` +
      `${of(db.customers).length} clientes · ${products.length} productos · ${initial.length} ajustes de inventario inicial`,
  )
} finally {
  await server.close()
}
