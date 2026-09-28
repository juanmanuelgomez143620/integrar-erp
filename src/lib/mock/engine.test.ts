// Pruebas del motor de negocio. Trabajan directamente sobre `buildSeed()` y
// las funciones `cmd*`, sin pasar por `db.ts` ni localStorage (ver
// docs/PROMPT_CONTINUACION.md §1). `buildSeed()` ya arma una empresa
// completa (usuarios, sectores, productos, proveedores, reglas de
// aprobación) más un circuito de ejemplo — se reutiliza como fixture en vez
// de armar una base mínima aparte.

import { beforeEach, describe, expect, it } from 'vitest'
import { buildSeed } from './seed'
import type { DB } from './db'
import type { RoleCode } from '../domain/types'
import {
  BusinessError,
  cmdApprovePurchaseOrder,
  cmdAssignRole,
  cmdCancelGoodsReceipt,
  cmdCancelPurchaseOrder,
  cmdCreateGoodsReceipt,
  cmdCreatePurchaseOrder,
  cmdCreateRequisition,
  cmdCreateStockAdjustment,
  cmdCreateStudent,
  cmdSendPurchaseOrder,
  cmdSubmitPurchaseOrder,
  cmdWithdrawPurchaseOrder,
  effectivePermissions,
  type Ctx,
  type PurchaseOrderInput,
} from './engine'

let db: DB

beforeEach(() => {
  db = buildSeed()
})

// ---------------------------------------------------------------- Helpers

function ctx(username: string | null): Ctx {
  const userId = username ? db.profiles.find((p) => p.username === username)!.id : null
  return { db, userId, now: new Date().toISOString() }
}

function companyId() {
  return db.companies[0].id
}

function productId(code: string) {
  return db.products.find((p) => p.code === code)!.id
}

function warehouseId(code: string) {
  return db.warehouses.find((w) => w.code === code)!.id
}

function doc(id: string) {
  return db.documents.find((d) => d.id === id)!
}

/** Orden en blanco (sin solicitud vinculada) con un total controlado, para probar reglas de aprobación. */
function orderInput(unitPrice: number, opts: { productCode?: string; quantity?: number } = {}): PurchaseOrderInput {
  return {
    supplier_id: db.suppliers.find((s) => s.code === 'PRV-001')!.id,
    expected_date: null,
    warehouse_id: warehouseId('DEP-MP'),
    payment_terms_days: 30,
    delivery_terms: 'Entrega de prueba',
    notes: '',
    lines: [
      {
        product_id: productId(opts.productCode ?? 'MP-001'),
        requisition_line_id: null,
        quantity: opts.quantity ?? 1,
        unit_price: unitPrice,
        vat_rate: 21,
      },
    ],
  }
}

/** Arma y envía una OC dentro del umbral de Compras ($500.000), lista para recibir. */
function sentOrder(quantity: number, unitPrice = 1000, productCode = 'MP-001') {
  const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), orderInput(unitPrice, { productCode, quantity }))
  cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
  cmdApprovePurchaseOrder(ctx('compras2'), oc.id, 'OK')
  cmdSendPurchaseOrder(ctx('compras1'), oc.id)
  return doc(oc.id)
}

/** Da de alta un segundo estudiante con un rol, para probar separación de funciones con "otro integrante". */
function addTeammate(username: string, role: RoleCode, sectorCode: string) {
  const userId = cmdCreateStudent(ctx('docente'), companyId(), {
    first_name: 'Otro',
    last_name: 'Estudiante',
    username,
    password: 'demo1234',
  })
  cmdAssignRole(ctx('docente'), companyId(), userId, role, db.sectors.find((s) => s.code === sectorCode)!.id)
}

function expectBusinessError(fn: () => void, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BusinessError)
    expect((e as BusinessError).code).toBe(code)
    return
  }
  expect.unreachable(`se esperaba BusinessError con código ${code}`)
}

// ---------------------------------------------------------------- Circuito

describe('circuito completo de compras', () => {
  it('recorre SC → OC → aprobación → envío → recepción, y la SC queda Ordenada', () => {
    const sc = cmdCreateRequisition(
      ctx('produccion'),
      companyId(),
      {
        needed_by: null,
        priority: 'NORMAL',
        reason: 'Prueba de circuito completo',
        notes: '',
        lines: [{ product_id: productId('MP-001'), quantity: 50 }],
      },
      true,
    )
    expect(doc(sc.id).status).toBe('SOLICITADO')

    const reqLine = db.prLines.find((l) => l.document_id === sc.id)!
    const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), {
      ...orderInput(1300, { quantity: 50 }),
      lines: [
        {
          product_id: reqLine.product_id,
          requisition_line_id: reqLine.id,
          quantity: 50,
          unit_price: 1300,
          vat_rate: 21,
        },
      ],
    })
    // Un borrador no compromete a la empresa: todavía no marca la SC como "Ordenada".
    expect(doc(sc.id).status).toBe('SOLICITADO')

    cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
    expect(doc(oc.id).status).toBe('PENDIENTE_APROBACION')
    expect(doc(sc.id).status).toBe('ORDENADO')

    cmdApprovePurchaseOrder(ctx('compras2'), oc.id, 'Precio habitual')
    expect(doc(oc.id).status).toBe('APROBADO')

    cmdSendPurchaseOrder(ctx('compras1'), oc.id)
    expect(doc(oc.id).status).toBe('ENVIADO')

    const poLine = db.poLines.find((l) => l.document_id === oc.id)!
    const rec = cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: '0001-00000001',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: poLine.id, quantity: 50 }],
      },
      true,
    )
    expect(doc(rec.id).status).toBe('CONFIRMADO')
    expect(doc(oc.id).status).toBe('RECIBIDO')
  })
})

describe('aprobación por monto', () => {
  it('hasta $500.000 la aprueba otro integrante de Compras (quien la aprobó no puede ser quien la creó)', () => {
    const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), orderInput(400_000))
    cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
    expect(db.approvalRequests.find((a) => a.document_id === oc.id)!.approver_role).toBe('COMPRAS')

    // A Gerencia no le corresponde este nivel.
    expectBusinessError(() => cmdApprovePurchaseOrder(ctx('gerencia'), oc.id, ''), 'APROBADOR_INCORRECTO')

    cmdApprovePurchaseOrder(ctx('compras2'), oc.id, 'OK')
    expect(doc(oc.id).status).toBe('APROBADO')
  })

  it('más de $500.000 la aprueba Gerencia', () => {
    const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), orderInput(500_000))
    cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
    expect(db.approvalRequests.find((a) => a.document_id === oc.id)!.approver_role).toBe('GERENCIA')

    // A Compras ya no le corresponde este nivel.
    expectBusinessError(() => cmdApprovePurchaseOrder(ctx('compras2'), oc.id, ''), 'APROBADOR_INCORRECTO')

    cmdApprovePurchaseOrder(ctx('gerencia'), oc.id, 'OK')
    expect(doc(oc.id).status).toBe('APROBADO')
  })
})

describe('separación de funciones', () => {
  it('quien crea una orden de compra no puede aprobarla', () => {
    const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), orderInput(100_000))
    cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
    expectBusinessError(() => cmdApprovePurchaseOrder(ctx('compras1'), oc.id, ''), 'SEPARACION_FUNCIONES')
  })

  it('quien confirma una recepción no puede anularla; otro integrante de Depósito sí', () => {
    const oc = sentOrder(20)
    const poLine = db.poLines.find((l) => l.document_id === oc.id)!
    const rec = cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: 'R-1',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: poLine.id, quantity: 20 }],
      },
      true,
    )

    expectBusinessError(
      () => cmdCancelGoodsReceipt(ctx('deposito'), rec.id, 'Motivo de prueba'),
      'SEPARACION_FUNCIONES',
    )

    addTeammate('deposito2', 'DEPOSITO', 'DEP')
    cmdCancelGoodsReceipt(ctx('deposito2'), rec.id, 'Motivo de prueba')
    expect(doc(rec.id).status).toBe('ANULADO')
  })
})

describe('recepciones', () => {
  it('la recepción parcial deja tarea por el saldo; una segunda recepción la completa', () => {
    const oc = sentOrder(100)

    cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: 'R-1',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: db.poLines.find((l) => l.document_id === oc.id)!.id, quantity: 60 }],
      },
      true,
    )
    expect(doc(oc.id).status).toBe('RECIBIDO_PARCIAL')
    expect(
      db.tasks.some((t) => t.document_id === oc.id && t.task_type === 'RECIBIR_MERCADERIA' && t.status === 'PENDIENTE'),
    ).toBe(true)

    cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: 'R-2',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: db.poLines.find((l) => l.document_id === oc.id)!.id, quantity: 40 }],
      },
      true,
    )
    expect(doc(oc.id).status).toBe('RECIBIDO')
  })

  it('no admite dos recepciones activas con el mismo remito contra la misma orden', () => {
    const oc = sentOrder(100)
    const poLine = db.poLines.find((l) => l.document_id === oc.id)!
    cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: '0001-00000099',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: poLine.id, quantity: 40 }],
      },
      true,
    )

    // Mismo remito (con mayúsculas/espacios distintos): se rechaza.
    expectBusinessError(
      () =>
        cmdCreateGoodsReceipt(
          ctx('deposito'),
          companyId(),
          {
            purchase_order_id: oc.id,
            warehouse_id: warehouseId('DEP-MP'),
            supplier_delivery_note: '  0001-00000099 ',
            carrier_name: '',
            notes: '',
            lines: [{ po_line_id: poLine.id, quantity: 10 }],
          },
          true,
        ),
      'REMITO_DUPLICADO',
    )

    // Un remito distinto contra la misma orden sí es válido.
    const second = cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: '0001-00000100',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: poLine.id, quantity: 10 }],
      },
      true,
    )
    expect(doc(second.id).status).toBe('CONFIRMADO')
  })

  it('no se puede recibir más de lo ordenado', () => {
    const oc = sentOrder(10)
    const poLine = db.poLines.find((l) => l.document_id === oc.id)!
    expectBusinessError(
      () =>
        cmdCreateGoodsReceipt(
          ctx('deposito'),
          companyId(),
          {
            purchase_order_id: oc.id,
            warehouse_id: warehouseId('DEP-MP'),
            supplier_delivery_note: 'R-1',
            carrier_name: '',
            notes: '',
            lines: [{ po_line_id: poLine.id, quantity: 11 }],
          },
          true,
        ),
      'CANTIDAD_EXCEDE_PENDIENTE',
    )
  })

  it('no se puede ordenar más de lo pendiente de una solicitud', () => {
    const sc = cmdCreateRequisition(
      ctx('produccion'),
      companyId(),
      {
        needed_by: null,
        priority: 'NORMAL',
        reason: 'Prueba de límite',
        notes: '',
        lines: [{ product_id: productId('MP-001'), quantity: 10 }],
      },
      true,
    )
    const reqLine = db.prLines.find((l) => l.document_id === sc.id)!
    expectBusinessError(
      () =>
        cmdCreatePurchaseOrder(ctx('compras1'), companyId(), {
          ...orderInput(1000),
          lines: [
            {
              product_id: reqLine.product_id,
              requisition_line_id: reqLine.id,
              quantity: 11,
              unit_price: 1000,
              vat_rate: 21,
            },
          ],
        }),
      'CANTIDAD_EXCEDE_PENDIENTE',
    )
  })
})

describe('stock', () => {
  it('bloquea que el stock quede negativo', () => {
    const current = db.stockBalances.find(
      (b) => b.product_id === productId('MP-001') && b.warehouse_id === warehouseId('DEP-MP'),
    )!.qty_on_hand
    expectBusinessError(
      () =>
        cmdCreateStockAdjustment(
          ctx('deposito'),
          companyId(),
          {
            warehouse_id: warehouseId('DEP-MP'),
            reason_code: 'CONTEO_FISICO',
            notes: 'Prueba',
            lines: [{ product_id: productId('MP-001'), quantity_delta: -(current + 1) }],
          },
          true,
        ),
      'STOCK_INSUFICIENTE',
    )
  })

  it('calcula el costo promedio ponderado (PPP) correctamente', () => {
    const before = db.stockBalances.find(
      (b) => b.product_id === productId('MP-001') && b.warehouse_id === warehouseId('DEP-MP'),
    )!
    expect(before.qty_on_hand).toBe(1200)
    expect(before.avg_unit_cost).toBe(1300)

    // Recibe 300 a un costo distinto del promedio actual (y bajo el umbral de
    // aprobación de Compras), para que el PPP se note.
    const oc = sentOrder(300, 1350)
    const poLine = db.poLines.find((l) => l.document_id === oc.id)!
    cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: 'R-PPP',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: poLine.id, quantity: 300 }],
      },
      true,
    )

    const after = db.stockBalances.find(
      (b) => b.product_id === productId('MP-001') && b.warehouse_id === warehouseId('DEP-MP'),
    )!
    expect(after.qty_on_hand).toBe(1500)
    // (1200 × 1300 + 300 × 1350) / 1500 = 1310
    expect(after.avg_unit_cost).toBe(1310)
  })

  it('el saldo de stock es siempre igual a la suma de sus movimientos (recepción + anulación con contramovimiento)', () => {
    const oc = sentOrder(20)
    const poLine = db.poLines.find((l) => l.document_id === oc.id)!
    const rec = cmdCreateGoodsReceipt(
      ctx('deposito'),
      companyId(),
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouseId('DEP-MP'),
        supplier_delivery_note: 'R-INV',
        carrier_name: '',
        notes: '',
        lines: [{ po_line_id: poLine.id, quantity: 20 }],
      },
      true,
    )

    const invariant = () => {
      const pid = productId('MP-001')
      const wid = warehouseId('DEP-MP')
      const balance = db.stockBalances.find((b) => b.product_id === pid && b.warehouse_id === wid)?.qty_on_hand ?? 0
      const sum = db.stockMovements
        .filter((m) => m.product_id === pid && m.warehouse_id === wid)
        .reduce((s, m) => s + m.quantity, 0)
      expect(balance).toBeCloseTo(sum, 6)
    }

    invariant()
    addTeammate('deposito3', 'DEPOSITO', 'DEP')
    cmdCancelGoodsReceipt(ctx('deposito3'), rec.id, 'Anulación de prueba')
    invariant()
  })
})

describe('anulaciones y reapertura', () => {
  it('anular una OC libera la SC asociada y reabre la tarea de Compras', () => {
    const sc = cmdCreateRequisition(
      ctx('produccion'),
      companyId(),
      {
        needed_by: null,
        priority: 'NORMAL',
        reason: 'Prueba de anulación',
        notes: '',
        lines: [{ product_id: productId('MP-001'), quantity: 15 }],
      },
      true,
    )
    const reqLine = db.prLines.find((l) => l.document_id === sc.id)!
    const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), {
      ...orderInput(1000),
      lines: [
        {
          product_id: reqLine.product_id,
          requisition_line_id: reqLine.id,
          quantity: 15,
          unit_price: 1000,
          vat_rate: 21,
        },
      ],
    })
    expect(doc(sc.id).status).toBe('SOLICITADO') // todavía borrador: no cuenta como ordenado

    // La lleva a un estado real (no un borrador) para poder verificar que anularla la libera de verdad.
    cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
    cmdApprovePurchaseOrder(ctx('compras2'), oc.id, 'OK')
    expect(doc(sc.id).status).toBe('ORDENADO')

    cmdCancelPurchaseOrder(ctx('compras1'), oc.id, 'Se decidió no comprar')
    expect(doc(oc.id).status).toBe('ANULADO')
    expect(doc(sc.id).status).toBe('SOLICITADO')
    expect(
      db.tasks.some((t) => t.document_id === sc.id && t.task_type === 'ATENDER_SC' && t.status === 'PENDIENTE'),
    ).toBe(true)
  })

  it('retirar una OC de aprobación también la vuelve a marcar como borrador para la SC', () => {
    const sc = cmdCreateRequisition(
      ctx('produccion'),
      companyId(),
      {
        needed_by: null,
        priority: 'NORMAL',
        reason: 'Prueba de retiro de aprobación',
        notes: '',
        lines: [{ product_id: productId('MP-001'), quantity: 8 }],
      },
      true,
    )
    const reqLine = db.prLines.find((l) => l.document_id === sc.id)!
    const oc = cmdCreatePurchaseOrder(ctx('compras1'), companyId(), {
      ...orderInput(1000),
      lines: [
        {
          product_id: reqLine.product_id,
          requisition_line_id: reqLine.id,
          quantity: 8,
          unit_price: 1000,
          vat_rate: 21,
        },
      ],
    })
    cmdSubmitPurchaseOrder(ctx('compras1'), oc.id)
    expect(doc(sc.id).status).toBe('ORDENADO')

    cmdWithdrawPurchaseOrder(ctx('compras1'), oc.id)
    expect(doc(oc.id).status).toBe('BORRADOR')
    expect(doc(sc.id).status).toBe('SOLICITADO') // vuelve a ser un borrador: ya no cuenta como ordenado
  })
})

describe('auditoría y permisos', () => {
  it('cada transición registra auditoría con usuario, rol, sector y estados', () => {
    const sc = cmdCreateRequisition(
      ctx('produccion'),
      companyId(),
      {
        needed_by: null,
        priority: 'NORMAL',
        reason: 'Prueba de auditoría',
        notes: '',
        lines: [{ product_id: productId('MP-001'), quantity: 5 }],
      },
      true,
    )
    const event = db.audit.find((e) => e.document_id === sc.id && e.action === 'SUBMIT')
    expect(event).toBeTruthy()
    expect(event!.actor_name).toBe('Ana Sosa')
    expect(event!.actor_role_code).toBe('PRODUCCION')
    expect(event!.actor_sector_name).toBe('Producción')
    expect(event!.from_status).toBe('BORRADOR')
    expect(event!.to_status).toBe('SOLICITADO')
  })

  it('un usuario sin permiso no puede ejecutar el comando', () => {
    // Ventas no tiene permiso para crear solicitudes de compra.
    expectBusinessError(
      () =>
        cmdCreateRequisition(
          ctx('ventas'),
          companyId(),
          {
            needed_by: null,
            priority: 'NORMAL',
            reason: 'No debería poder',
            notes: '',
            lines: [{ product_id: productId('MP-001'), quantity: 1 }],
          },
          true,
        ),
      'SIN_PERMISO',
    )
  })

  it('ADMIN (administración escolar) no hereda supervisor dentro de una empresa; DOCENTE y SUPERADMIN sí', () => {
    const admin = effectivePermissions(db, db.profiles.find((p) => p.username === 'admin')!.id, companyId())
    expect(admin.supervisor).toBe(false)
    expect(admin.all).toBe(false)
    expect(admin.perms.size).toBe(0) // ADMIN no tiene rol de empresa: no ve ni opera nada acá

    const docente = effectivePermissions(db, db.profiles.find((p) => p.username === 'docente')!.id, companyId())
    expect(docente.supervisor).toBe(true)

    db.profiles.push({
      id: 'usr-test-superadmin',
      username: 'superadmin-test',
      password: 'x',
      first_name: 'Super',
      last_name: 'Admin',
      app_role: 'SUPERADMIN',
      is_active: true,
      must_change_password: false,
      created_at: new Date().toISOString(),
    })
    const superadmin = effectivePermissions(db, 'usr-test-superadmin', companyId())
    expect(superadmin.supervisor).toBe(true)
  })
})
