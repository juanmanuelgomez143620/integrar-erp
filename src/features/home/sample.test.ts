// La muestra de la página pública (D18): la demo en memoria, con la semana de pedidos de los clientes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSample } from './sample'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2027-05-14T15:00:00-03:00'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('la muestra de la página pública (D18)', () => {
  it('arma la empresa de demostración con la semana de pedidos, algunos ya revisados por Ventas', () => {
    const sample = buildSample()
    expect(sample.company).toBe('Forestal del Norte SRL')
    expect(sample.week).toBe('2027-W19')
    const { total, confirmed, waiting, toReview } = sample.orders
    expect(total).toBeGreaterThanOrEqual(8)
    expect(confirmed).toBeGreaterThan(0)
    // Los de la segunda mitad no se revisaron; de la primera, los que no tenían stock siguen recibidos.
    expect(toReview).toBeGreaterThanOrEqual(Math.floor(total / 2))
    expect(confirmed + waiting + toReview).toBe(total)
    expect(sample.size).toEqual({ people: 36, customers: 40, suppliers: 20, products: 35 })
  })

  it('trae los importes del tablero, el trabajo de cada sector y los documentos de ejemplo', () => {
    const sample = buildSample()
    expect(sample.figures.map((f) => f.key)).toEqual([
      'DISPONIBLE',
      'BIENES_DE_CAMBIO',
      'DEUDA_PROVEEDORES',
      'PRESTAMOS',
    ])
    expect(sample.figures.every((f) => f.value > 0 && f.hint.length > 0)).toBe(true)
    expect(sample.docs.length).toBeGreaterThan(sample.orders.total)
    expect(sample.docs.every((d) => !d.status_info.final)).toBe(true)
    expect(sample.tasks.filter((t) => t.task_type === 'REVISAR_PEDIDO_CLIENTE')).toHaveLength(sample.orders.toReview)
    // El pedido, como lo ve Ventas: con lo que sigue.
    expect(sample.order).toMatchObject({ doc: { status: 'RECIBIDO' }, next_step: { who: 'Ventas' } })
    expect(sample.order!.lines.length).toBeGreaterThan(0)
    // La compra de punta a punta, con su asiento balanceado.
    expect(sample.purchase!.flow.map((f) => f.doc_type)).toEqual(
      expect.arrayContaining(['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'SUPPLIER_INVOICE']),
    )
    const journal = sample.journal!.journal!
    expect(journal.lines.length).toBeGreaterThanOrEqual(2)
    expect(journal.total_debit).toBe(journal.total_credit)
  })

  it('cada vez arma una empresa nueva: lo mismo para la misma semana', () => {
    const first = buildSample()
    const second = buildSample()
    expect(second.orders).toEqual(first.orders)
    expect(second.order!.doc.display_number).toBe(first.order!.doc.display_number)
    expect(second.order!.doc.id).not.toBe(first.order!.doc.id)
  })
})
