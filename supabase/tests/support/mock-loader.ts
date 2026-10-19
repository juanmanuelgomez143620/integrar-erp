// Copia el estado completo del backend simulado (un objeto DB de src/lib/mock)
// a la base de prueba, con los mismos datos y relaciones. Así cada lectura SQL
// se compara con su equivalente de queries.ts sobre datos idénticos.

import { randomUUID } from 'node:crypto'
import type { DB } from '../../../src/lib/mock/db'
import type { TestDb } from './db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export interface LoadedMock {
  /** Id del simulador → uuid de la base. */
  pg(id: string): string
  /** Registra que un registro creado después de la carga es el mismo en ambos lados. */
  link(mockId: string, pgId: string): void
  /** Respuesta de la base con los ids del simulador, fechas en ISO (UTC) y números redondeados. */
  fromPg<T>(value: T): T
}

/** Fechas en ISO con milisegundos y números con 6 decimales: así se comparan ambos lados. */
export function normalize<T>(value: T, rename: (s: string) => string = (s) => s): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return TIMESTAMP.test(v) ? new Date(v).toISOString() : rename(v)
    if (typeof v === 'number') return Math.round(v * 1e6) / 1e6
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

type Row = Record<string, unknown>

export async function loadMockDb(db: TestDb, mock: DB): Promise<LoadedMock> {
  const toPg = new Map<string, string>()
  const fromPg = new Map<string, string>()
  const collections = Object.values(mock).filter(Array.isArray) as Row[][]
  for (const rows of collections)
    for (const row of rows)
      if (typeof row.id === 'string' && !toPg.has(row.id)) {
        const id = UUID.test(row.id) ? row.id : randomUUID()
        toPg.set(row.id, id)
        fromPg.set(id, row.id)
      }
  const map = <T>(value: T): T => {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return toPg.get(v) ?? v
      if (Array.isArray(v)) return v.map(walk)
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
      return v
    }
    return walk(value) as T
  }

  const columns = new Map<string, string[]>()
  async function insert(table: string, rows: Row[], identity = false) {
    if (!rows.length) return
    const [schema, name] = table.includes('.') ? table.split('.') : ['public', table]
    if (!columns.has(table))
      columns.set(
        table,
        (
          await db.admin<{ column_name: string }>(
            'select column_name from information_schema.columns where table_schema = $1 and table_name = $2',
            [schema, name],
          )
        ).map((c) => c.column_name),
      )
    const keys = columns.get(table)!.filter((c) => rows.some((r) => c in r))
    const list = keys.map((k) => `"${k}"`).join(', ')
    await db.admin(
      `insert into ${schema}.${name} (${list}) ${identity ? 'overriding system value' : ''}
       select ${list} from jsonb_populate_recordset(null::${schema}.${name}, $1::jsonb)`,
      [JSON.stringify(map(rows))],
    )
  }

  // Sin disparadores ni controles de FK durante la carga: los datos ya son
  // consistentes y deben quedar tal cual (fechas, autores, auditoría).
  await db.admin(`set session_replication_role = replica`)
  try {
    await insert('school_settings', [{ id: 1, ...mock.school }])
    await insert(
      'auth.users',
      mock.profiles.map((p) => ({
        id: p.id,
        email: `${p.username}@simulador.test`,
        raw_app_meta_data: { username: p.username, app_role: p.app_role },
      })),
    )
    await insert(
      'profiles',
      mock.profiles.map(({ password: _password, ...p }) => p),
    )
    await insert('courses', mock.courses as unknown as Row[])
    await insert('companies', mock.companies as unknown as Row[])
    await insert('islands', mock.islands as unknown as Row[])
    await insert('sectors', mock.sectors as unknown as Row[])
    await insert('warehouses', mock.warehouses as unknown as Row[])
    await insert('company_members', mock.members as unknown as Row[])
    await insert('member_roles', mock.memberRoles as unknown as Row[])
    await insert('company_modules', mock.companyModules as unknown as Row[])
    await insert('approval_rules', mock.approvalRules as unknown as Row[])
    await insert('customers', mock.customers as unknown as Row[])
    await insert('suppliers', mock.suppliers as unknown as Row[])
    await insert('products', mock.products as unknown as Row[])
    await insert('accounts', mock.accounts as unknown as Row[])
    await insert('posting_rules', mock.postingRules as unknown as Row[])
    await insert('fiscal_years', mock.fiscalYears as unknown as Row[])
    await insert('fiscal_periods', mock.fiscalPeriods as unknown as Row[])
    await insert('document_sequences', mock.documentSequences as unknown as Row[])
    await insert(
      'documents',
      mock.documents.map(
        ({ pr: _pr, po: _po, gr: _gr, sa: _sa, je: _je, si: _si, op: _op, rq: _rq, sq: _sq, ft: _ft, ...d }) => d,
      ),
    )
    const sub = (key: 'pr' | 'po' | 'gr' | 'sa' | 'je' | 'si' | 'op' | 'rq' | 'sq' | 'ft') =>
      mock.documents.filter((d) => d[key]).map((d) => ({ ...d[key], document_id: d.id, company_id: d.company_id }))
    await insert('purchase_requisitions', sub('pr'))
    await insert('purchase_orders', sub('po'))
    await insert('goods_receipts', sub('gr'))
    await insert('stock_adjustments', sub('sa'))
    await insert('journal_entries', sub('je'))
    await insert('supplier_invoices', sub('si'))
    await insert('payment_orders', sub('op'))
    await insert('rfqs', sub('rq'))
    await insert('supplier_quotes', sub('sq'))
    await insert('funds_transfers', sub('ft'))
    await insert('purchase_requisition_lines', mock.prLines as unknown as Row[])
    await insert('purchase_order_lines', mock.poLines as unknown as Row[])
    await insert('goods_receipt_lines', mock.grLines as unknown as Row[])
    await insert('stock_adjustment_lines', mock.saLines as unknown as Row[])
    await insert('journal_entry_lines', mock.jeLines as unknown as Row[])
    await insert('supplier_invoice_lines', mock.siLines as unknown as Row[])
    await insert('payment_order_lines', mock.opLines as unknown as Row[])
    await insert('rfq_lines', mock.rfqLines as unknown as Row[])
    await insert('rfq_suppliers', mock.rfqSuppliers as unknown as Row[])
    await insert('supplier_quote_lines', mock.sqLines as unknown as Row[])
    await insert('document_links', mock.docLinks as unknown as Row[])
    await insert('stock_movements', mock.stockMovements as unknown as Row[], true)
    await insert('stock_balances', mock.stockBalances as unknown as Row[])
    await insert('approval_requests', mock.approvalRequests as unknown as Row[])
    await insert('tasks', mock.tasks as unknown as Row[])
    await insert('notifications', mock.notifications as unknown as Row[])
    await insert('audit_events', mock.audit as unknown as Row[], true)
    for (const table of ['stock_movements', 'audit_events'])
      await db.admin(
        `select setval(pg_get_serial_sequence('public.${table}', 'id'), coalesce((select max(id) from public.${table}), 0) + 1, false)`,
      )
  } finally {
    await db.admin(`set session_replication_role = origin`)
  }

  return {
    pg: (id) => {
      const mapped = toPg.get(id)
      if (!mapped) throw new Error(`Id desconocido: ${id}`)
      return mapped
    },
    link: (mockId, pgId) => {
      toPg.set(mockId, pgId)
      fromPg.set(pgId, mockId)
    },
    fromPg: (value) => normalize(value, (s) => fromPg.get(s) ?? s),
  }
}
