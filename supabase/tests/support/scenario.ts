// Estado de prueba para comparar lecturas: el seed de la demo más operaciones
// hechas con el motor simulado que dejan documentos en (casi) todos los
// estados, tareas tomadas, avisos leídos y movimientos de stock de cada tipo.

import { todayAR } from '../../../src/lib/format'
import type { DB } from '../../../src/lib/mock/db'
import * as E from '../../../src/lib/mock/engine'
import { buildSeed } from '../../../src/lib/mock/seed'

export function buildScenario(): DB {
  const db = buildSeed()
  const company = db.companies.find((c) => c.is_template)!.id
  // Cada operación un minuto después de la anterior: el orden por fecha no tiene empates.
  let clock = Date.parse(db.seededAt) + 60_000
  const as = (username: string): E.Ctx => ({
    db,
    userId: db.profiles.find((p) => p.username === username)!.id,
    now: new Date((clock += 60_000)).toISOString(),
  })
  const product = (code: string) => db.products.find((p) => p.code === code)!
  const supplier = (code: string) => db.suppliers.find((s) => s.code === code)!.id
  const warehouse = (code: string) => db.warehouses.find((w) => w.code === code)!.id
  const requisition = (lines: [string, number][], reason = 'Reposición para la producción del mes') => ({
    needed_by: null,
    priority: 'NORMAL' as const,
    reason,
    notes: '',
    lines: lines.map(([code, quantity]) => ({ product_id: product(code).id, quantity })),
  })
  const order = (supplierCode: string, lines: [string, number, number, string | null][]): E.PurchaseOrderInput => ({
    supplier_id: supplier(supplierCode),
    expected_date: null,
    warehouse_id: warehouse('DEP-MP'),
    payment_terms_days: 30,
    delivery_terms: 'Puesto en planta',
    notes: '',
    lines: lines.map(([code, quantity, unit_price, requisition_line_id]) => ({
      product_id: product(code).id,
      requisition_line_id,
      quantity,
      unit_price,
      vat_rate: 21,
    })),
  })

  // SC solicitada y atendida en parte por una OC aprobada, enviada y recibida a medias.
  const sc2 = E.cmdCreateRequisition(
    as('produccion'),
    company,
    requisition([
      ['MP-001', 100],
      ['MP-004', 10],
    ]),
    true,
  )
  const sc2Line = db.prLines.find((l) => l.document_id === sc2.id && l.product_id === product('MP-001').id)!
  const oc2 = E.cmdCreatePurchaseOrder(as('compras1'), company, order('PRV-001', [['MP-001', 60, 1300, sc2Line.id]]))
  E.cmdSubmitPurchaseOrder(as('compras1'), oc2.id)
  E.cmdApprovePurchaseOrder(as('compras2'), oc2.id, 'Precio dentro de lo presupuestado')
  E.cmdSendPurchaseOrder(as('compras1'), oc2.id)
  const oc2Line = db.poLines.find((l) => l.document_id === oc2.id)!
  const receipt = (quantity: number, note: string): E.GoodsReceiptInput => ({
    purchase_order_id: oc2.id,
    warehouse_id: warehouse('DEP-MP'),
    supplier_delivery_note: note,
    carrier_name: 'Transporte Iguazú',
    notes: '',
    lines: [{ po_line_id: oc2Line.id, quantity }],
  })
  E.cmdCreateGoodsReceipt(as('deposito'), company, receipt(30, 'R-0001-00000451'), true)
  E.cmdCreateGoodsReceipt(as('deposito'), company, receipt(10, 'R-0001-00000478'), false)

  // SC en borrador y SC rechazada por Compras.
  E.cmdCreateRequisition(as('produccion'), company, requisition([['IN-001', 5]]), false)
  const sc4 = E.cmdCreateRequisition(as('produccion'), company, requisition([['IN-002', 8]]), true)
  E.cmdRejectRequisition(as('compras1'), sc4.id, 'Hay barniz suficiente en el depósito')

  // OC en borrador, OC grande esperando a Gerencia, OC rechazada y OC anulada.
  E.cmdCreatePurchaseOrder(as('compras2'), company, order('PRV-002', [['MP-004', 5, 92000, null]]))
  const big = E.cmdCreatePurchaseOrder(as('compras1'), company, order('PRV-002', [['MP-006', 10, 115000, null]]))
  E.cmdSubmitPurchaseOrder(as('compras1'), big.id)
  const rejected = E.cmdCreatePurchaseOrder(as('compras1'), company, order('PRV-004', [['IN-002', 10, 18000, null]]))
  E.cmdSubmitPurchaseOrder(as('compras1'), rejected.id)
  E.cmdRejectPurchaseOrder(as('compras2'), rejected.id, 'Pedí otra cotización: el precio subió')
  const cancelled = E.cmdCreatePurchaseOrder(as('compras2'), company, order('PRV-005', [['IN-003', 4, 14000, null]]))
  E.cmdCancelPurchaseOrder(as('compras2'), cancelled.id, 'Se cargó por error')

  // Ajustes: una rotura confirmada y un conteo en borrador.
  E.cmdCreateStockAdjustment(
    as('deposito'),
    company,
    {
      warehouse_id: warehouse('DEP-MP'),
      reason_code: 'ROTURA',
      notes: 'Tablas dañadas por humedad',
      lines: [{ product_id: product('MP-001').id, quantity_delta: -2 }],
    },
    true,
  )
  E.cmdCreateStockAdjustment(
    as('deposito'),
    company,
    {
      warehouse_id: warehouse('DEP-MP'),
      reason_code: 'CONTEO_FISICO',
      notes: '',
      lines: [{ product_id: product('IN-003').id, quantity_delta: 3, unit_cost: 14000 }],
    },
    false,
  )

  // Contabilidad: un asiento registrado, otro anulado con contraasiento, un
  // borrador descartado, una cuenta nueva y un mes cerrado que no es el actual
  // (además de la apertura, el depósito y el borrador del seed).
  const account = (code: string) => db.accounts.find((a) => a.company_id === company && a.code === code)!.id
  const entry = (description: string, debitCode: string, creditCode: string, amount: number): E.JournalEntryInput => ({
    document_date: todayAR(),
    description,
    lines: [
      { account_id: account(debitCode), debit: amount, credit: 0 },
      { account_id: account(creditCode), debit: 0, credit: amount, notes: 'Pago en el día' },
    ],
  })
  E.cmdCreateJournalEntry(
    as('contabilidad'),
    company,
    entry('Compra de útiles de librería en efectivo.', '5.2.02.05', '1.1.01.01', 42500),
    true,
  )
  const wrong = E.cmdCreateJournalEntry(
    as('contabilidad'),
    company,
    entry('Pago de la póliza de seguros por banco.', '5.2.02.06', '1.1.01.03', 120000),
    true,
  )
  E.cmdCancelJournalEntry(as('contabilidad'), wrong.id, 'Se cargó un importe equivocado')
  const discarded = E.cmdCreateJournalEntry(
    as('contabilidad'),
    company,
    entry('Borrador de prueba.', '5.2.02.07', '1.1.01.01', 1000),
    false,
  )
  E.cmdCancelJournalEntry(as('contabilidad'), discarded.id, 'Era una prueba')
  E.cmdSaveAccount(as('contabilidad'), company, {
    code: '1.1.01.05',
    name: 'Banco de la Selva caja de ahorro',
    description: 'Segunda cuenta bancaria (ficticia).',
    is_contra: false,
  })
  const otherMonth = todayAR().slice(5, 7) === '01' ? 12 : 1
  const closed = db.fiscalPeriods.find((p) => p.company_id === company && p.number === otherMonth)!
  E.cmdSetPeriodStatus(as('contabilidad'), company, closed.id, 'CERRADO', '')

  // Una tarea tomada y los avisos de Compras leídos.
  const task = db.tasks.find(
    (t) => t.company_id === company && t.assigned_role === 'COMPRAS' && t.status === 'PENDIENTE',
  )!
  E.cmdClaimTask(as('compras1'), task.id, true)
  E.cmdMarkNotificationsRead(as('compras2'), 'all', company)
  return db
}
