import { describe, expect, it } from 'vitest'
import type { DocumentListItem, StockRow } from '@/lib/api'
import type { AuditEvent } from '@/lib/domain/types'
import { PLACES, PLACE_IDS, rackSlots, replaySteps, ROUTES, trucks } from './twin-model'

function doc(
  partial: Partial<DocumentListItem> & Pick<DocumentListItem, 'id' | 'doc_type' | 'status'>,
): DocumentListItem {
  return { sector_name: 'Compras', display_number: partial.id, ...partial } as DocumentListItem
}

function event(partial: Partial<AuditEvent> & Pick<AuditEvent, 'id' | 'occurred_at'>): AuditEvent {
  return { document_id: 'oc', actor_sector_name: 'Compras', ...partial } as AuditEvent
}

function stock(code: string, type: string, qty: number, reserved = 0): StockRow {
  return {
    product: { id: code, code, name: code, product_type: type, min_stock: 0 },
    warehouse: { id: 'w' },
    qty,
    reserved,
    total_qty: qty,
    below_min: false,
  } as unknown as StockRow
}

describe('gemelo digital: planta', () => {
  it('no superpone sectores en el piso', () => {
    for (const [i, a] of PLACE_IDS.entries()) {
      for (const b of PLACE_IDS.slice(i + 1)) {
        const pa = PLACES[a]
        const pb = PLACES[b]
        const apart = Math.abs(pa.x - pb.x) >= (pa.w + pb.w) / 2 || Math.abs(pa.z - pb.z) >= (pa.d + pb.d) / 2
        expect(apart, `${a} y ${b}`).toBe(true)
      }
    }
  })

  it('sólo traza caminos entre lugares que existen', () => {
    for (const route of ROUTES) {
      expect(PLACES[route.from]).toBeDefined()
      expect(PLACES[route.to]).toBeDefined()
    }
  })
})

describe('gemelo digital: muelles', () => {
  it('pone camiones en los muelles para las OC enviadas y los remitos en preparación', () => {
    const list = trucks([
      doc({ id: 'oc1', doc_type: 'PURCHASE_ORDER', status: 'ENVIADO' }),
      doc({ id: 'oc2', doc_type: 'PURCHASE_ORDER', status: 'APROBADO' }),
      doc({ id: 'rem', doc_type: 'DELIVERY_NOTE', status: 'BORRADOR' }),
    ])
    expect(list.map((t) => [t.docId, t.direction])).toEqual([
      ['oc1', 'in'],
      ['rem', 'out'],
    ])
  })
})

describe('gemelo digital: depósitos y recorridos', () => {
  it('reparte el stock entre materias primas y terminados con la altura relativa', () => {
    const slots = rackSlots([
      stock('MAD', 'MATERIA_PRIMA', 50),
      stock('TOR', 'INSUMO', 100),
      stock('MESA', 'PRODUCTO_TERMINADO', 4, 1),
    ])
    expect(slots.map((s) => [s.code, s.place, s.level, s.reserved])).toEqual([
      ['MAD', 'DEP_MP', 0.5, false],
      ['TOR', 'DEP_MP', 1, false],
      ['MESA', 'DEP_PT', 1, true],
    ])
  })

  it('arma el recorrido del documento en orden y en el sector de quien actuó', () => {
    const oc = doc({ id: 'oc', doc_type: 'PURCHASE_ORDER', status: 'APROBADO' })
    const steps = replaySteps(oc, [
      event({ id: 2, occurred_at: '2026-10-02T10:00:00Z', actor_sector_name: 'Gerencia' }),
      event({ id: 1, occurred_at: '2026-10-01T10:00:00Z' }),
      event({ id: 3, occurred_at: '2026-10-03T10:00:00Z', document_id: 'otro' }),
      event({ id: 4, occurred_at: '2026-10-04T10:00:00Z', actor_sector_name: '—' }),
    ])
    expect(steps.map((s) => [s.event?.id, s.place])).toEqual([
      [1, 'COM'],
      [2, 'GER'],
      [4, 'COM'],
    ])
  })

  it('termina en el sector donde el documento espera hoy', () => {
    const op = doc({ id: 'oc', doc_type: 'PAYMENT_ORDER', status: 'PENDIENTE_APROBACION' })
    const steps = replaySteps(op, [
      event({ id: 1, occurred_at: '2026-10-01T10:00:00Z', actor_sector_name: 'Contabilidad' }),
    ])
    expect(steps.map((s) => [s.event?.id ?? null, s.place])).toEqual([
      [1, 'CON'],
      [null, 'GER'],
    ])
  })
})
