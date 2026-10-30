import { describe, expect, it } from 'vitest'
import type { DocumentListItem, StockRow, TaskItem } from '@/lib/api'
import { buildNodeStats, coverageTone, documentNode, taskNode } from './flow-model'

function doc(partial: Partial<DocumentListItem> & Pick<DocumentListItem, 'doc_type' | 'status'>): DocumentListItem {
  return {
    sector_name: 'Compras',
    created_at: '2026-10-01T10:00:00.000Z',
    ...partial,
  } as DocumentListItem
}

function task(partial: Partial<TaskItem>): TaskItem {
  return {
    task_type: 'OTRA',
    assigned_role: null,
    created_at: '2026-10-01T10:00:00.000Z',
    ...partial,
  } as TaskItem
}

function row(opts: { belowMin?: boolean; min?: number; total?: number }): StockRow {
  return {
    below_min: opts.belowMin ?? false,
    total_qty: opts.total ?? 0,
    product: { min_stock: opts.min ?? 0 },
  } as StockRow
}

describe('mapa vivo: ubicación de documentos', () => {
  it('deja la solicitud en el sector que la preparó y la mueve a Compras al enviarla', () => {
    expect(documentNode(doc({ doc_type: 'PURCHASE_REQUISITION', status: 'BORRADOR', sector_name: 'Producción' }))).toBe(
      'PRO',
    )
    expect(documentNode(doc({ doc_type: 'PURCHASE_REQUISITION', status: 'SOLICITADO' }))).toBe('COM')
  })

  it('sigue la liquidación, la declaración y la hoja de ruta por los sectores que las atienden', () => {
    const at = (doc_type: DocumentListItem['doc_type'], status: string) => documentNode(doc({ doc_type, status }))
    expect([
      at('PAYROLL', 'BORRADOR'),
      at('PAYROLL', 'PENDIENTE_APROBACION'),
      at('PAYROLL', 'CONFIRMADA'),
      at('TAX_RETURN', 'BORRADOR'),
      at('TAX_RETURN', 'PRESENTADA'),
      at('ROUTE_SHEET', 'EN_CAMINO'),
    ]).toEqual(['RRH', 'GER', 'TES', 'IMP', 'TES', 'LOG'])
  })

  it('manda a Gerencia lo que espera aprobación', () => {
    expect(documentNode(doc({ doc_type: 'PURCHASE_ORDER', status: 'PENDIENTE_APROBACION' }))).toBe('GER')
    expect(documentNode(doc({ doc_type: 'SALES_ORDER', status: 'PENDIENTE_APROBACION' }))).toBe('GER')
  })

  it('ubica la mercadería y los materiales en el depósito correcto', () => {
    expect(documentNode(doc({ doc_type: 'PURCHASE_ORDER', status: 'RECIBIDO_PARCIAL' }))).toBe('DEP_MP')
    expect(documentNode(doc({ doc_type: 'PRODUCTION_ORDER', status: 'LIBERADA' }))).toBe('DEP_MP')
    expect(documentNode(doc({ doc_type: 'SALES_ORDER', status: 'CONFIRMADO' }))).toBe('DEP_PT')
    expect(documentNode(doc({ doc_type: 'DELIVERY_NOTE', status: 'BORRADOR' }))).toBe('DEP_PT')
  })
})

describe('mapa vivo: ubicación de tareas', () => {
  it('separa Recepción de Despacho dentro de Depósito', () => {
    expect(taskNode(task({ assigned_role: 'DEPOSITO', task_type: 'RECIBIR_MERCADERIA' }))).toBe('DEP_MP')
    expect(taskNode(task({ assigned_role: 'DEPOSITO', task_type: 'ENTREGAR_MATERIALES' }))).toBe('DEP_MP')
    expect(taskNode(task({ assigned_role: 'DEPOSITO', task_type: 'DESPACHAR_REMITO' }))).toBe('DEP_PT')
  })

  it('usa el sector del rol para el resto', () => {
    expect(taskNode(task({ assigned_role: 'GERENCIA', task_type: 'APROBAR_OC' }))).toBe('GER')
    expect(taskNode(task({ assigned_role: 'TESORERIA', task_type: 'PAGAR' }))).toBe('TES')
    expect(taskNode(task({ assigned_role: 'CONTABILIDAD', task_type: 'REGISTRAR_ASIENTO' }))).toBe('CON')
  })
})

describe('mapa vivo: cobertura de stock', () => {
  it('marca bajo mínimo, cerca del mínimo y suficiente', () => {
    expect(coverageTone(row({ belowMin: true, min: 10, total: 4 }))).toBe('danger')
    expect(coverageTone(row({ min: 10, total: 12 }))).toBe('warning')
    expect(coverageTone(row({ min: 10, total: 20 }))).toBe('ok')
    expect(coverageTone(row({ min: 0, total: 0 }))).toBe('ok')
  })
})

describe('mapa vivo: armado de sectores', () => {
  it('agrupa documentos y tareas y ordena por antigüedad', () => {
    const nodes = buildNodeStats(
      [doc({ doc_type: 'PURCHASE_ORDER', status: 'PENDIENTE_APROBACION', created_at: '2026-10-02T10:00:00.000Z' })],
      [
        task({ assigned_role: 'GERENCIA', created_at: '2026-10-01T10:00:00.000Z' }),
        task({ assigned_role: 'GERENCIA', created_at: '2026-10-03T10:00:00.000Z' }),
      ],
    )
    expect(nodes.GER.docs).toHaveLength(1)
    expect(nodes.GER.tasks.map((t) => t.created_at)).toEqual(['2026-10-01T10:00:00.000Z', '2026-10-03T10:00:00.000Z'])
  })
})
