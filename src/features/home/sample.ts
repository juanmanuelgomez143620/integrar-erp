// La muestra de la página pública (D18, docs/PAGINA_DE_INICIO.md): la empresa de demostración armada en
// memoria con el simulador y una semana de pedidos de clientes, para ver cómo se trabaja sin usuario.
// No lee ni escribe la base guardada en el navegador ni la base real: todo vive en el objeto que arma.

import type { ControlAlert, DocumentDetail, DocumentListItem, TaskItem } from '@/lib/api'
import { todayAR } from '@/lib/format'
import { BusinessError, cmdConfirmSalesOrder, cmdGenerateEnvironmentWeek, type Ctx } from '@/lib/mock/engine'
import { controlPanel, documentDetail, listDocuments, listTasks } from '@/lib/mock/queries'
import { buildSeed } from '@/lib/mock/seed'
import { FLOW_DOC_TYPES } from '@/features/flow/flow-model'

/** Un importe del tablero de control, con su explicación. */
export interface SampleFigure {
  key: string
  label: string
  value: number
  hint: string
}

export interface Sample {
  company: string
  /** La semana ISO de la actividad del entorno ("2026-W48"). */
  week: string
  /** Los pedidos que mandaron los clientes en la semana y cómo los revisó Ventas. */
  orders: { total: number; confirmed: number; waiting: number; toReview: number }
  /** El tamaño de la empresa. */
  size: { people: number; customers: number; suppliers: number; products: number }
  figures: SampleFigure[]
  alerts: ControlAlert[]
  /** Los documentos en curso y las tareas pendientes de todos los sectores. */
  docs: DocumentListItem[]
  tasks: TaskItem[]
  /** Un pedido que mandó un cliente, tal como lo ve Ventas. */
  order: DocumentDetail | null
  /** Una factura de proveedor con su flujo documental y el asiento que generó. */
  purchase: DocumentDetail | null
  journal: DocumentDetail | null
}

/** Los importes del tablero que se muestran (los que tienen saldo apenas empieza el mes). */
const FIGURES = ['DISPONIBLE', 'BIENES_DE_CAMBIO', 'DEUDA_PROVEEDORES', 'PRESTAMOS']

export function buildSample(): Sample {
  const db = buildSeed()
  const company = db.companies.find((c) => c.is_template) ?? db.companies[0]
  const user = (username: string) => db.profiles.find((p) => p.username === username)!.id
  const ctx = (username: string): Ctx => ({ db, userId: user(username), now: new Date().toISOString() })
  const byNumber = (number: string) =>
    db.documents.find((d) => d.company_id === company.id && d.display_number === number)!

  // Llegan los pedidos de la semana y Ventas ya revisó la primera mitad: confirma los que tienen stock (si
  // superan el crédito, esperan a Gerencia); los demás siguen recibidos.
  const { week, orders } = cmdGenerateEnvironmentWeek(ctx('docente'), company.id)
  for (const number of orders.slice(0, Math.ceil(orders.length / 2))) {
    try {
      cmdConfirmSalesOrder(ctx('ventas'), byNumber(number).id)
    } catch (error) {
      if (!(error instanceof BusinessError)) throw error
    }
  }
  const statuses = orders.map((n) => byNumber(n).status)
  const count = (status: string) => statuses.filter((s) => s === status).length

  const panel = controlPanel(db, user('gerencia'), company.id, todayAR().slice(0, 7))
  const figures = panel.areas
    .flatMap((a) => a.indicators)
    .filter((i) => FIGURES.includes(i.key))
    .sort((a, b) => FIGURES.indexOf(a.key) - FIGURES.indexOf(b.key))
    .map(({ key, label, value, hint }) => ({ key, label, value, hint }))

  const teacher = user('docente')
  const docs = FLOW_DOC_TYPES.flatMap((type) => listDocuments(db, teacher, company.id, type)).filter(
    (d) => !d.status_info.final,
  )
  const tasks = listTasks(db, teacher, company.id, 'all')

  const received = orders.find((n) => byNumber(n).status === 'RECIBIDO')
  const invoice = db.documents.find(
    (d) => d.company_id === company.id && d.doc_type === 'SUPPLIER_INVOICE' && d.status === 'REGISTRADA',
  )
  const purchase = invoice ? documentDetail(db, teacher, company.id, 'SUPPLIER_INVOICE', invoice.display_number) : null
  const entry = purchase?.flow.find((f) => f.doc_type === 'JOURNAL_ENTRY')

  return {
    company: company.legal_name,
    week,
    orders: {
      total: orders.length,
      confirmed: count('CONFIRMADO'),
      waiting: count('PENDIENTE_APROBACION'),
      toReview: count('RECIBIDO'),
    },
    size: {
      people: db.employees.filter((e) => e.company_id === company.id && e.status === 'ACTIVO').length,
      customers: db.customers.filter((c) => c.company_id === company.id && c.is_active).length,
      suppliers: db.suppliers.filter((s) => s.company_id === company.id && s.is_active).length,
      products: db.products.filter((p) => p.company_id === company.id && p.is_active).length,
    },
    figures,
    alerts: panel.alerts,
    docs,
    tasks,
    order: received ? documentDetail(db, user('ventas'), company.id, 'SALES_ORDER', received) : null,
    purchase,
    journal: entry ? documentDetail(db, teacher, company.id, 'JOURNAL_ENTRY', entry.display_number) : null,
  }
}
