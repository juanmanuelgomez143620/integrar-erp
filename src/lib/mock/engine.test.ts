// Pruebas del motor de negocio. Trabajan directamente sobre `buildSeed()` y
// las funciones `cmd*`, sin pasar por `db.ts` ni localStorage (ver
// docs/PROMPT_CONTINUACION.md §1). `buildSeed()` ya arma una empresa
// completa (usuarios, sectores, productos, proveedores, reglas de
// aprobación) más un circuito de ejemplo — se reutiliza como fixture en vez
// de armar una base mínima aparte.

import { beforeEach, describe, expect, it } from 'vitest'
import { buildSeed, DEMO_PASSWORD } from './seed'
import { DB_VERSION, upgradeDatabase, type DB } from './db'
import { companyContext } from './queries'
import type { RoleCode } from '../domain/types'
import {
  BusinessError,
  cmdApprovePurchaseOrder,
  cmdAssignRole,
  cmdCancelGoodsReceipt,
  cmdCancelPurchaseOrder,
  cmdChangePassword,
  cmdCreateCompanyFromTemplate,
  cmdCreateCourse,
  cmdCreateGoodsReceipt,
  cmdCreatePurchaseOrder,
  cmdCreateRequisition,
  cmdCreateStockAdjustment,
  cmdCreateStudent,
  cmdCreateStudentsBulk,
  cmdCreateTeacher,
  cmdResetPassword,
  cmdSendPurchaseOrder,
  cmdSubmitPurchaseOrder,
  cmdUpdateSchoolSettings,
  cmdWithdrawPurchaseOrder,
  effectivePermissions,
  type Ctx,
  type PurchaseOrderInput,
  type SchoolSettingsInput,
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

describe('contraseñas', () => {
  it('un estudiante nuevo debe cambiar su contraseña en el primer ingreso', () => {
    const id = cmdCreateStudent(ctx('docente'), companyId(), {
      first_name: 'Nueva',
      last_name: 'Alumna',
      username: 'nueva1',
      password: 'inicial1',
    })
    expect(db.profiles.find((p) => p.id === id)!.must_change_password).toBe(true)
  })

  it('cambia la contraseña con la actual correcta', () => {
    cmdChangePassword(ctx('ventas'), { current_password: DEMO_PASSWORD, new_password: 'nueva-clave-1' })
    const profile = db.profiles.find((p) => p.username === 'ventas')!
    expect(profile.password).toBe('nueva-clave-1')
    expect(profile.must_change_password).toBe(false)
  })

  it('rechaza el cambio si la actual no coincide, la nueva es muy corta, o es igual a la actual', () => {
    expectBusinessError(
      () => cmdChangePassword(ctx('ventas'), { current_password: 'mal', new_password: 'nueva-clave-1' }),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdChangePassword(ctx('ventas'), { current_password: DEMO_PASSWORD, new_password: 'abc' }),
      'DATO_INVALIDO',
    )
    expectBusinessError(
      () => cmdChangePassword(ctx('ventas'), { current_password: DEMO_PASSWORD, new_password: DEMO_PASSWORD }),
      'DATO_INVALIDO',
    )
  })

  it('el docente restablece la contraseña de un integrante y lo fuerza a cambiarla en el próximo ingreso', () => {
    const ventasId = db.profiles.find((p) => p.username === 'ventas')!.id
    cmdResetPassword(ctx('docente'), companyId(), ventasId, 'temporal99')
    const profile = db.profiles.find((p) => p.id === ventasId)!
    expect(profile.password).toBe('temporal99')
    expect(profile.must_change_password).toBe(true)
  })

  it('no se puede restablecer la contraseña de alguien que no participa en la empresa', () => {
    const outsiderId = cmdCreateTeacher(ctx('admin'), {
      first_name: 'Otro',
      last_name: 'Docente',
      username: 'otrodoc',
      password: 'demo1234',
    })
    expectBusinessError(() => cmdResetPassword(ctx('docente'), companyId(), outsiderId, 'nueva1234'), 'DATO_INVALIDO')
  })

  it('sólo se restablece la contraseña de estudiantes: un docente no toma la cuenta de otro', () => {
    const colleagueId = cmdCreateTeacher(ctx('admin'), {
      first_name: 'Otra',
      last_name: 'Colega',
      username: 'ocolega',
      password: 'demo1234',
    })
    cmdAssignRole(ctx('docente'), companyId(), colleagueId, 'DOCENTE', null)
    expectBusinessError(() => cmdResetPassword(ctx('docente'), companyId(), colleagueId, 'tomada123'), 'SIN_PERMISO')
    expect(db.profiles.find((p) => p.id === colleagueId)!.password).toBe('demo1234')
  })
})

describe('administración de la escuela', () => {
  it('ADMIN da de alta un docente y un curso; asignarlo a una empresa queda pendiente', () => {
    const teacherId = cmdCreateTeacher(ctx('admin'), {
      first_name: 'Marina',
      last_name: 'Testigo',
      username: 'mtestigo',
      password: 'inicial12',
    })
    const teacher = db.profiles.find((p) => p.id === teacherId)!
    expect(teacher.app_role).toBe('DOCENTE')
    expect(teacher.must_change_password).toBe(true)
    expect(db.members.some((m) => m.user_id === teacherId)).toBe(false)

    const courseId = cmdCreateCourse(ctx('admin'), {
      academic_year: 2027,
      name: '6.º B',
      orientation: 'Gestión y Administración de las Organizaciones',
    })
    expect(db.courses.some((c) => c.id === courseId && c.name === '6.º B')).toBe(true)
  })

  it('un usuario que no es ADMIN ni SUPERADMIN no puede dar de alta docentes ni cursos', () => {
    expectBusinessError(
      () =>
        cmdCreateTeacher(ctx('docente'), { first_name: 'X', last_name: 'Y', username: 'xy1', password: 'demo1234' }),
      'SIN_PERMISO',
    )
    expectBusinessError(
      () => cmdCreateCourse(ctx('gerencia'), { academic_year: 2027, name: '5.º C', orientation: '' }),
      'SIN_PERMISO',
    )
  })

  it('no admite dos cursos con el mismo nombre en el mismo año', () => {
    cmdCreateCourse(ctx('admin'), { academic_year: 2027, name: '6.º A', orientation: 'Test' })
    expectBusinessError(
      () => cmdCreateCourse(ctx('admin'), { academic_year: 2027, name: '6.º A', orientation: 'Otra' }),
      'DATO_INVALIDO',
    )
  })
})

describe('alta masiva de estudiantes (H-21)', () => {
  it('crea a todos con usuario único, contraseña inicial legible y cambio obligatorio', () => {
    const events = db.audit.length
    const credentials = cmdCreateStudentsBulk(ctx('docente'), companyId(), [
      { first_name: 'Juan', last_name: 'Pérez' },
      { first_name: 'Julia', last_name: 'Pérez' },
      { first_name: 'Ana', last_name: 'Sosa' },
    ])
    expect(credentials.map((c) => c.username)).toEqual(['jperez', 'jperez2', 'asosa'])
    expect(new Set(credentials.map((c) => c.password)).size).toBe(3)
    for (const c of credentials) {
      expect(c.password).toMatch(/^[a-hjkmnp-z2-9]{8}$/) // sin 0/O ni 1/l/I
      const profile = db.profiles.find((p) => p.id === c.user_id)!
      expect(profile).toMatchObject({ app_role: 'ESTUDIANTE', must_change_password: true, password: c.password })
      expect(db.members.some((m) => m.user_id === c.user_id && m.company_id === companyId())).toBe(true)
    }
    expect(db.audit.length - events).toBe(3)
  })

  it('valida toda la lista antes de crear a nadie', () => {
    const profiles = db.profiles.length
    expectBusinessError(
      () =>
        cmdCreateStudentsBulk(ctx('docente'), companyId(), [
          { first_name: 'Juan', last_name: 'Pérez' },
          { first_name: 'X', last_name: 'Y' },
        ]),
      'DATO_INVALIDO',
    )
    expect(db.profiles).toHaveLength(profiles)
  })

  it('sólo el docente de la empresa puede hacerlo', () => {
    expectBusinessError(
      () => cmdCreateStudentsBulk(ctx('compras1'), companyId(), [{ first_name: 'Juan', last_name: 'Pérez' }]),
      'SIN_PERMISO',
    )
  })
})

describe('empresa desde la plantilla (H-20)', () => {
  const countOf = (rows: { company_id: string }[], id: string) => rows.filter((r) => r.company_id === id).length
  const initialStock = (id: string) =>
    db.stockMovements
      .filter((m) => m.company_id === id && m.movement_type === 'STOCK_INICIAL')
      .reduce((s, m) => s + m.quantity, 0)

  function newCourse(name = '6.º B') {
    return cmdCreateCourse(ctx('admin'), { academic_year: 2027, name, orientation: 'Gestión' })
  }

  it('copia estructura y maestros, recarga el inventario inicial y empieza la numeración en 1', () => {
    const template = db.companies[0]
    const templateDocs = countOf(db.documents, template.id)
    const { id, slug } = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: newCourse() })
    expect(slug).toBe('forestal-del-norte-6-b-2027')
    for (const rows of [
      db.islands,
      db.sectors,
      db.warehouses,
      db.approvalRules,
      db.suppliers,
      db.customers,
      db.products,
      db.accounts,
    ])
      expect(countOf(rows, id)).toBe(countOf(rows, template.id))
    // Sólo los documentos del inventario inicial y el asiento de apertura, numerados desde 1 y confirmados.
    const docs = db.documents.filter((d) => d.company_id === id)
    expect(docs.map((d) => `${d.display_number} ${d.status}`)).toEqual([
      'AJS-00001 CONFIRMADO',
      'AJS-00002 CONFIRMADO',
      'AS-00001 CONFIRMADO',
    ])
    expect(initialStock(id)).toBe(initialStock(template.id))
    // Los productos apuntan a los proveedores y depósitos de la empresa nueva, no a los de la plantilla.
    const product = db.products.find((p) => p.company_id === id && p.default_supplier_id)!
    expect(db.suppliers.find((s) => s.id === product.default_supplier_id)!.company_id).toBe(id)
    expect(db.warehouses.find((w) => w.id === product.default_warehouse_id)!.company_id).toBe(id)
    // Las alertas de stock mínimo de arranque también se generan.
    expect(db.tasks.some((t) => t.company_id === id && t.task_type === 'REPONER_STOCK')).toBe(true)
    // La plantilla no cambia.
    expect(countOf(db.documents, template.id)).toBe(templateDocs)
  })

  it('el docente queda como supervisor y nadie de la plantilla accede a la empresa nueva', () => {
    const { id, slug } = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: newCourse() })
    const members = db.members.filter((m) => m.company_id === id)
    expect(members.map((m) => m.user_id)).toEqual([ctx('docente').userId])
    expect(effectivePermissions(db, ctx('docente').userId!, id).supervisor).toBe(true)
    expect(companyContext(db, ctx('compras1').userId!, slug)).toBeNull()
  })

  it('dos empresas para el mismo curso tienen direcciones distintas', () => {
    const course = newCourse()
    const first = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course })
    const second = cmdCreateCompanyFromTemplate(ctx('docente'), { course_id: course })
    expect(second.slug).toBe(`${first.slug}-2`)
  })

  it('sólo un docente puede crearla (ni estudiantes ni la administración escolar)', () => {
    const course = newCourse()
    expectBusinessError(() => cmdCreateCompanyFromTemplate(ctx('compras1'), { course_id: course }), 'SIN_PERMISO')
    expectBusinessError(() => cmdCreateCompanyFromTemplate(ctx('admin'), { course_id: course }), 'SIN_PERMISO')
  })
})

describe('datos de la escuela', () => {
  const schoolInput = (patch: Partial<SchoolSettingsInput> = {}): SchoolSettingsInput => ({
    official_name: 'Escuela de Prueba N.º 1',
    short_name: 'EP N.º 1',
    city: 'Posadas',
    province: 'Misiones',
    contact_email: 'secretaria@escuela.test',
    session_timeout_minutes: 20,
    ...patch,
  })

  it('ADMIN los actualiza y queda en la auditoría qué cambió', () => {
    cmdUpdateSchoolSettings(ctx('admin'), schoolInput())
    expect(db.school).toMatchObject({ official_name: 'Escuela de Prueba N.º 1', session_timeout_minutes: 20 })
    const event = db.audit.at(-1)!
    expect(event).toMatchObject({ action: 'SETTINGS', entity_type: 'school_settings', company_id: null })
    expect(event.changes?.official_name).toEqual({
      from: 'Escuela Normal Superior N.º 9',
      to: 'Escuela de Prueba N.º 1',
    })
  })

  it('guardar sin cambios no agrega ruido a la auditoría', () => {
    cmdUpdateSchoolSettings(ctx('admin'), schoolInput())
    const events = db.audit.length
    cmdUpdateSchoolSettings(ctx('admin'), schoolInput())
    expect(db.audit).toHaveLength(events)
  })

  it('sólo la administración escolar puede cambiarlos, ni siquiera el docente', () => {
    expectBusinessError(() => cmdUpdateSchoolSettings(ctx('docente'), schoolInput()), 'SIN_PERMISO')
  })

  it('valida nombre corto, email y minutos de inactividad (0 = sin cierre automático)', () => {
    expectBusinessError(() => cmdUpdateSchoolSettings(ctx('admin'), schoolInput({ short_name: 'X' })), 'DATO_INVALIDO')
    expectBusinessError(
      () => cmdUpdateSchoolSettings(ctx('admin'), schoolInput({ contact_email: 'sin-arroba' })),
      'DATO_INVALIDO',
    )
    for (const minutes of [3, 241, 7.5])
      expectBusinessError(
        () => cmdUpdateSchoolSettings(ctx('admin'), schoolInput({ session_timeout_minutes: minutes })),
        'DATO_INVALIDO',
      )
    cmdUpdateSchoolSettings(ctx('admin'), schoolInput({ session_timeout_minutes: 0 }))
    expect(db.school.session_timeout_minutes).toBe(0)
  })
})

describe('base guardada con una versión anterior', () => {
  it('se actualiza sin perder datos: v1 → v2 agrega contacto e inactividad con valores por defecto', () => {
    const { contact_email: _email, session_timeout_minutes: _minutes, ...schoolV1 } = db.school
    const stored = { ...db, version: 1, school: schoolV1 } as unknown as DB
    const documents = stored.documents.length
    const upgraded = upgradeDatabase(stored)!
    expect(upgraded.version).toBe(DB_VERSION)
    expect(upgraded.school).toMatchObject({ contact_email: '', session_timeout_minutes: 15, short_name: 'ENS N.º 9' })
    expect(upgraded.documents).toHaveLength(documents)
  })

  it('una versión desconocida no se puede actualizar (se archiva y se vuelve a sembrar)', () => {
    expect(upgradeDatabase({ ...db, version: 0 })).toBeNull()
    expect(upgradeDatabase({ ...db, version: DB_VERSION + 1 })).toBeNull()
  })
})
