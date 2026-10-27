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
    'accounts',
    'fiscal_years',
    'fiscal_periods',
    'journal_entries',
    'journal_entry_lines',
    'posting_rules',
    'supplier_invoices',
    'supplier_invoice_lines',
    'payment_orders',
    'payment_order_lines',
    'rfqs',
    'rfq_lines',
    'rfq_suppliers',
    'supplier_quotes',
    'supplier_quote_lines',
    'funds_transfers',
    'bank_reconciliations',
    'bank_reconciliation_lines',
    'sales_orders',
    'sales_order_lines',
    'delivery_notes',
    'delivery_note_lines',
    'sales_invoices',
    'sales_invoice_lines',
    'customer_receipts',
    'customer_receipt_lines',
    'price_lists',
    'price_list_items',
    'sales_quotes',
    'sales_quote_lines',
    'boms',
    'bom_lines',
    'production_orders',
    'production_order_lines',
    'work_centers',
    'bom_operations',
    'production_order_operations',
    'job_categories',
    'employees',
    'payrolls',
    'payroll_lines',
    'tax_returns',
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
          : fn.startsWith('je_')
            ? B.journal
            : fn.startsWith('si_')
              ? B.invoice
              : fn.startsWith('op_')
                ? B.paymentOrder
                : fn.startsWith('rfq_')
                  ? B.rfq
                  : fn.startsWith('sq_')
                    ? B.quote
                    : fn.startsWith('ft_')
                      ? B.transfer
                      : fn.startsWith('br_')
                        ? B.reconciliation
                        : fn.startsWith('so_')
                          ? B.salesOrder
                          : fn.startsWith('dn_')
                            ? B.delivery
                            : fn.startsWith('fv_')
                              ? B.salesInvoice
                              : fn.startsWith('rc_')
                                ? B.customerReceipt
                                : fn.startsWith('pre_')
                                  ? B.salesQuote
                                  : fn.startsWith('opr_')
                                    ? B.productionOrder
                                    : fn.startsWith('payroll_')
                                      ? B.payroll
                                      : fn.startsWith('tax_return_')
                                        ? B.taxReturn
                                        : B.order
  const input = {
    reason: 'Necesidad urgente de la empresa',
    priority: 'NORMAL',
    notes: 'intento',
    supplier_id: B.supplier,
    warehouse_id: B.warehouse,
    purchase_order_id: B.order,
    supplier_delivery_note: 'R-9999',
    point_of_sale: '1',
    invoice_number: '99',
    treasury_account_id: B.account,
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
        account_id: B.account,
        debit: 1,
        credit: 0,
        invoice_id: B.invoice,
        amount: 1,
        rfq_line_id: B.rfqLine,
        so_line_id: B.salesLine,
        component_id: B.product,
        line_id: B.productionLine,
        work_center_id: B.workCenter,
        hours: 1,
      },
      { account_id: B.account, debit: 0, credit: 1 },
    ],
    document_date: '2027-03-01',
    rfq_id: B.rfq,
    supplier_ids: [B.supplier, B.supplier2],
    response_due: '2099-12-31',
    valid_until: '2099-12-31',
    delivery_days: 1,
    supplier_reference: 'Intruso',
    from_account_id: B.account,
    to_account_id: B.bank,
    amount: 1,
    reference: 'Intruso',
    account_id: B.bank,
    statement_date: '2027-12-31',
    statement_balance: 0,
    journal_line_ids: [B.bankLine],
    description: 'Asiento de un intruso',
    is_contra: false,
    id: B.product,
    code: 'MP-001',
    name: 'Intruso',
    legal_name: 'Intruso SA',
    product_type: 'MATERIA_PRIMA',
    uom_code: 'UN',
    customer_id: B.customer,
    sales_order_id: B.salesOrder,
    carrier_name: 'Intruso',
    delivery_date: null,
    customer_reference: 'Intruso',
    payment_method: 'TRANSFERENCIA',
    copy_from: B.priceList,
    percent: 5,
    price_list_id: B.priceList,
    quantity: 1,
    materials_warehouse_id: B.warehouse,
    output_warehouse_id: B.warehouse,
    labor_rate: 1,
    overhead_rate: 1,
    basic_salary: 1,
    is_direct_labor: true,
    first_name: 'Intruso',
    last_name: 'Externo',
    hire_date: '2027-03-01',
    category_id: B.jobCategory,
    sector_id: B.sector,
    work_center_id: B.workCenter,
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
    // La lista de B se busca por su código.
    p_code: fn === 'price_list_detail' ? 'MAY' : 'MP-001',
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
    p_reference: 'Transferencia de un intruso',
    p_scope: 'all',
    p_limit: null,
    p_account_id: B.account,
    p_supplier_id: B.supplier,
    p_customer_id: B.customer,
    p_rule_id: B.rule,
    p_quote_id: B.quote,
    p_method: 'TRANSFERENCIA',
    p_statement_date: '2027-12-31',
    p_period_id: B.period,
    p_status: 'CERRADO',
    p_year: 2028,
    p_from: '2027-01-01',
    p_to: '2027-12-31',
    p_price_list_id: B.priceList,
    p_product_id: B.product,
    p_price: 1,
    p_percent: 5,
    p_bom_id: B.bom,
    p_quantity: 1,
    p_work_center_id: B.workCenter,
    p_hours: JSON.stringify([{ operation_id: B.productionOperation, hours: 1 }]),
    p_job_category_id: B.jobCategory,
    p_employee_id: B.employee,
    p_date: '2027-05-01',
    p_lines: JSON.stringify([
      { line_id: B.payrollLine, days_worked: 30, absence_days: 0, overtime_50: 0, overtime_100: 0 },
    ]),
    p_document_ids: `{${B.productionOrder}}`,
    p_period: '2027-05',
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
  B.invoice = (
    await rpc<{ id: string }>('alumnoB', 'si_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        purchase_order_id: B.order,
        point_of_sale: '3',
        invoice_number: '1234',
        document_date: (await one<{ d: string }>(`select private.business_date($1)::text as d`, [B.id])).d,
        lines: [{ po_line_id: B.orderLine, quantity: 20, unit_price: 1300 }],
      }),
      p_register: true,
    })
  ).id
  B.rule = (await one(`select id from public.posting_rules where company_id = $1 limit 1`, [B.id])).id
  B.paymentOrder = (
    await rpc<{ id: string }>('docenteB', 'op_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        supplier_id: B.supplier,
        treasury_account_id: (
          await one(`select id from public.accounts where company_id = $1 and code = '1.1.01.03'`, [B.id])
        ).id,
        lines: [{ invoice_id: B.invoice, amount: 1000 }],
      }),
      p_submit: true,
    })
  ).id
  B.supplier2 = (await one(`select id from public.suppliers where company_id = $1 and code = 'PRV-002'`, [B.id])).id
  const today = (await one<{ d: string }>(`select private.business_date($1)::text as d`, [B.id])).d
  B.rfq = (
    await rpc<{ id: string }>('alumnoB', 'rfq_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        response_due: today,
        warehouse_id: B.warehouse,
        supplier_ids: [B.supplier, B.supplier2],
        lines: [{ product_id: B.product, quantity: 10 }],
      }),
      p_send: true,
    })
  ).id
  B.rfqLine = (await one(`select id from public.rfq_lines where document_id = $1`, [B.rfq])).id
  B.quote = (
    await rpc<{ id: string }>('alumnoB', 'sq_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        rfq_id: B.rfq,
        supplier_id: B.supplier,
        valid_until: today,
        delivery_days: 3,
        payment_terms_days: 30,
        lines: [{ rfq_line_id: B.rfqLine, unit_price: 1250, vat_rate: 21 }],
      }),
    })
  ).id
  B.adjustment = (
    await one(`select id from public.documents where company_id = $1 and doc_type = 'STOCK_ADJUSTMENT' limit 1`, [B.id])
  ).id
  B.task = (await one(`select id from public.tasks where company_id = $1 limit 1`, [B.id])).id
  B.notification = (await one(`select id from public.notifications where company_id = $1 limit 1`, [B.id])).id
  B.memberRole = (await one(`select id from public.member_roles where company_id = $1 limit 1`, [B.id])).id
  B.account = (await one(`select id from public.accounts where company_id = $1 and code = '1.1.01.01'`, [B.id])).id
  B.bank = (await one(`select id from public.accounts where company_id = $1 and code = '1.1.01.03'`, [B.id])).id
  B.transfer = (
    await rpc<{ id: string }>('docenteB', 'ft_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        from_account_id: B.account,
        to_account_id: B.bank,
        amount: 1000,
        reference: 'Boleta 1',
      }),
      p_confirm: true,
    })
  ).id
  // Una conciliación del banco de B con todos sus movimientos.
  const bankLines = await db.admin<{ id: string; net: string }>(
    `select l.id, l.debit - l.credit as net from public.journal_entry_lines l
       join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
      where l.account_id = $1`,
    [B.bank],
  )
  B.bankLine = bankLines[0].id
  B.reconciliation = (
    await rpc<{ id: string }>('docenteB', 'br_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        account_id: B.bank,
        statement_date: (await one<{ d: string }>(`select private.business_date($1)::text as d`, [B.id])).d,
        statement_balance: Math.round(bankLines.reduce((s, l) => s + Number(l.net), 0) * 100) / 100,
        journal_line_ids: bankLines.map((l) => l.id),
      }),
    })
  ).id
  B.period = (
    await one(`select id from public.fiscal_periods where company_id = $1 order by start_date limit 1`, [B.id])
  ).id
  B.journal = (
    await one(`select document_id as id from public.journal_entries where company_id = $1 limit 1`, [B.id])
  ).id
  // Un pedido de venta confirmado de B y un remito despachado en parte.
  B.customer = (await one(`select id from public.customers where company_id = $1 and code = 'CLI-001'`, [B.id])).id
  B.salesOrder = (
    await rpc<{ id: string }>('docenteB', 'so_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        customer_id: B.customer,
        warehouse_id: (await one(`select id from public.warehouses where company_id = $1 and code = 'DEP-PT'`, [B.id]))
          .id,
        delivery_date: null,
        payment_terms_days: 30,
        customer_reference: '',
        lines: [
          {
            product_id: (await one(`select id from public.products where company_id = $1 and code = 'PT-002'`, [B.id]))
              .id,
            quantity: 4,
            unit_price: 125000,
          },
        ],
      }),
      p_confirm: true,
    })
  ).id
  B.salesLine = (await one(`select id from public.sales_order_lines where document_id = $1`, [B.salesOrder])).id
  B.delivery = (
    await rpc<{ id: string }>('alumnoB', 'dn_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        sales_order_id: B.salesOrder,
        carrier_name: '',
        lines: [{ so_line_id: B.salesLine, quantity: 2 }],
      }),
      p_confirm: true,
    })
  ).id
  B.salesInvoice = (
    await rpc<{ id: string }>('docenteB', 'fv_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({ sales_order_id: B.salesOrder, lines: [{ so_line_id: B.salesLine, quantity: 2 }] }),
      p_register: true,
    })
  ).id
  // Un cobro de B, en parte, al banco.
  B.customerReceipt = (
    await rpc<{ id: string }>('docenteB', 'rc_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        customer_id: B.customer,
        treasury_account_id: B.bank,
        payment_method: 'TRANSFERENCIA',
        reference: 'TRF 1',
        lines: [{ invoice_id: B.salesInvoice, amount: 100000 }],
      }),
      p_confirm: true,
    })
  ).id
  // Una lista de precios de B, asignada a su cliente, y un presupuesto enviado.
  B.priceList = (
    await rpc<{ id: string }>('docenteB', 'pl_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        code: 'MAY',
        name: 'Mayorista',
        description: '',
        copy_from: 'SALE_PRICE',
        percent: -10,
      }),
    })
  ).id
  await rpc('docenteB', 'master_save', {
    p_kind: 'customer',
    p_company_id: B.id,
    p_data: JSON.stringify({
      id: B.customer,
      code: 'CLI-001',
      legal_name: (await one(`select legal_name from public.customers where id = $1`, [B.customer])).legal_name,
      price_list_id: B.priceList,
    }),
  })
  B.salesQuote = (
    await rpc<{ id: string }>('docenteB', 'pre_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        customer_id: B.customer,
        warehouse_id: (await one(`select id from public.warehouses where company_id = $1 and code = 'DEP-PT'`, [B.id]))
          .id,
        valid_until: '2099-12-31',
        payment_terms_days: 30,
        customer_reference: '',
        notes: '',
        lines: [
          {
            product_id: (await one(`select id from public.products where company_id = $1 and code = 'PT-002'`, [B.id]))
              .id,
            quantity: 2,
            unit_price: 112500,
          },
        ],
      }),
      p_send: true,
    })
  ).id

  // Una orden de producción de B, liberada (las listas de materiales vienen de la plantilla).
  B.bom = (await one(`select id from public.boms where company_id = $1 order by created_at limit 1`, [B.id])).id
  B.productionOrder = (
    await rpc<{ id: string }>('docenteB', 'opr_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({
        product_id: (await one(`select id from public.products where company_id = $1 and code = 'PT-002'`, [B.id])).id,
        quantity: 1,
        materials_warehouse_id: (
          await one(`select id from public.warehouses where company_id = $1 and code = 'DEP-MP'`, [B.id])
        ).id,
        output_warehouse_id: (
          await one(`select id from public.warehouses where company_id = $1 and code = 'DEP-PT'`, [B.id])
        ).id,
        due_date: null,
        notes: '',
      }),
      p_release: true,
    })
  ).id
  B.workCenter = (
    await one(`select id from public.work_centers where company_id = $1 order by code limit 1`, [B.id])
  ).id
  B.productionOperation = (
    await one(`select id from public.production_order_operations where document_id = $1 order by line_no limit 1`, [
      B.productionOrder,
    ])
  ).id
  B.productionLine = (
    await one(`select id from public.production_order_lines where document_id = $1 order by line_no limit 1`, [
      B.productionOrder,
    ])
  ).id

  B.jobCategory = (
    await one(`select id from public.job_categories where company_id = $1 and code = 'OFICIAL'`, [B.id])
  ).id
  B.employee = (await one(`select id from public.employees where company_id = $1 and file_number = 2`, [B.id])).id
  // La liquidación de B, del mes en curso.
  const thisMonth = (await one("select to_char(private.business_date($1), 'YYYY-MM') as id", [B.id])).id
  B.payroll = (
    await rpc<{ id: string }>('docenteB', 'payroll_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({ period: thisMonth, payment_date: `${thisMonth}-28`, notes: '' }),
    })
  ).id
  B.payrollLine = (
    await one(`select id from public.payroll_lines where document_id = $1 order by line_no limit 1`, [B.payroll])
  ).id
  // La declaración de IVA de B, del mes pasado.
  const lastMonth = (
    await one("select to_char(private.business_date($1) - interval '1 month', 'YYYY-MM') as id", [B.id])
  ).id
  B.taxReturn = (
    await rpc<{ id: string }>('docenteB', 'tax_return_create', {
      p_company_id: B.id,
      p_input: JSON.stringify({ tax: 'IVA', period: lastMonth, notes: '' }),
    })
  ).id

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
         union select id::text from public.accounts where company_id = $1
         union select id::text from public.fiscal_years where company_id = $1
         union select id::text from public.fiscal_periods where company_id = $1
         union select id::text from public.journal_entry_lines where company_id = $1
         union select id::text from public.supplier_invoice_lines where company_id = $1
         union select id::text from public.posting_rules where company_id = $1
         union select id::text from public.payment_order_lines where company_id = $1
         union select id::text from public.rfq_lines where company_id = $1
         union select id::text from public.supplier_quote_lines where company_id = $1
         union select id::text from public.bank_reconciliation_lines where company_id = $1
         union select id::text from public.sales_order_lines where company_id = $1
         union select id::text from public.delivery_note_lines where company_id = $1
         union select id::text from public.sales_invoice_lines where company_id = $1
         union select id::text from public.customer_receipt_lines where company_id = $1
         union select id::text from public.price_lists where company_id = $1
         union select id::text from public.price_list_items where company_id = $1
         union select id::text from public.sales_quote_lines where company_id = $1
         union select id::text from public.boms where company_id = $1
         union select id::text from public.bom_lines where company_id = $1
         union select id::text from public.production_order_lines where company_id = $1
         union select id::text from public.work_centers where company_id = $1
         union select id::text from public.bom_operations where company_id = $1
         union select id::text from public.production_order_operations where company_id = $1
         union select id::text from public.job_categories where company_id = $1
         union select id::text from public.employees where company_id = $1
         union select id::text from public.payroll_lines where company_id = $1
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
          // Fuera del try: si a una función nueva le falta un valor de prueba, la prueba falla (no se saltea).
          const args = argsFor(name, params, company)
          try {
            const result = await rpc(attacker, name, args)
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
