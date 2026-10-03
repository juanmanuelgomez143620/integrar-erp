// Circuito de compras en la base (RPC pr_*, po_*, gr_*, sa_*): los mismos
// escenarios que prueban el motor simulado (src/lib/mock/engine.test.ts), para
// que la interfaz se comporte igual al pasar a Supabase.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessError, createTestDb, type TestDb } from './support/db'
import {
  addMember,
  createCompany,
  createProduct,
  createSupplier,
  createUser,
  seedSchool,
  type TestCompany,
} from './support/fixtures'

let db: TestDb
let a: TestCompany
let b: TestCompany
const u: Record<string, string> = {}
const p: Record<string, string> = {}
let supplier: string

beforeAll(async () => {
  db = await createTestDb()
  await seedSchool(db)
  a = await createCompany(db, 'empresa-a')
  b = await createCompany(db, 'empresa-b')
  const people: [string, string, string | null][] = [
    ['docente', 'DOCENTE', null],
    ['produccion', 'PRODUCCION', 'PRO'],
    ['compras1', 'COMPRAS', 'COM'],
    ['compras2', 'COMPRAS', 'COM'],
    ['gerencia', 'GERENCIA', 'GER'],
    ['deposito', 'DEPOSITO', 'DEP'],
    ['deposito2', 'DEPOSITO', 'DEP'],
    ['ventas', 'VENTAS', 'VEN'],
  ]
  for (const [name, role, sector] of people) {
    u[name] = await createUser(db, name, role === 'DOCENTE' ? 'DOCENTE' : 'ESTUDIANTE')
    await addMember(db, a, u[name], [[role, sector]])
  }
  u.intruso = await createUser(db, 'intruso')
  await addMember(db, b, u.intruso, [['GERENCIA', 'GER']])
  supplier = await createSupplier(db, a, 'PRV-001', 'Aserradero de Prueba')
  p.mp1 = await createProduct(db, a, 'MP-001', { supplierId: supplier, cost: 1000 })
  p.mp2 = await createProduct(db, a, 'MP-002', { supplierId: supplier, cost: 500, minStock: 20 })
  p.mp3 = await createProduct(db, a, 'MP-003', { supplierId: supplier, cost: 200 })
  // Inventario inicial documentado, como en la empresa plantilla.
  await call(
    'deposito',
    'sa_create',
    a.id,
    {
      warehouse_id: a.warehouse,
      reason_code: 'INVENTARIO_INICIAL',
      notes: 'Inventario inicial',
      lines: [
        { product_id: p.mp1, quantity_delta: 100, unit_cost: 1000 },
        { product_id: p.mp2, quantity_delta: 30, unit_cost: 500 },
      ],
    },
    true,
  )
}, 90_000)

afterAll(async () => {
  await db.close()
})

// ---------------------------------------------------------------- Helpers

async function call<T = unknown>(user: string, fn: string, ...args: unknown[]): Promise<T> {
  const params = args.map((_, i) => `$${i + 1}`).join(', ')
  const [row] = await db.as<{ r: T }>(u[user], `select public.${fn}(${params}) as r`, args)
  return row.r
}

const fails = (user: string, fn: string, ...args: unknown[]) => businessError(call(user, fn, ...args))

async function status(docId: string) {
  const [row] = await db.admin<{ status: string }>('select status from public.documents where id = $1', [docId])
  return row.status
}

async function stockOf(productId: string) {
  const [row] = await db.admin<{ qty: string; avg: string }>(
    'select qty_on_hand as qty, avg_unit_cost as avg from public.stock_balances where product_id = $1',
    [productId],
  )
  return { qty: Number(row.qty), avg: Number(row.avg) }
}

/** Producción pide y envía la SC; devuelve su id y el de su primera línea. */
async function requisition(productId: string, quantity: number) {
  const created = await call<{ id: string }>(
    'produccion',
    'pr_create',
    a.id,
    {
      needed_by: null,
      priority: 'NORMAL',
      reason: 'Necesidad de prueba para producción',
      notes: '',
      lines: [{ product_id: productId, quantity }],
    },
    true,
  )
  const [line] = await db.admin<{ id: string }>(
    'select id from public.purchase_requisition_lines where document_id = $1',
    [created.id],
  )
  return { id: created.id, lineId: line.id }
}

function order(lines: { product: string; quantity: number; price: number; requisitionLine?: string }[]) {
  return {
    supplier_id: supplier,
    expected_date: null,
    warehouse_id: a.warehouse,
    payment_terms_days: 30,
    delivery_terms: 'Entrega en planta',
    notes: '',
    lines: lines.map((l) => ({
      product_id: l.product,
      requisition_line_id: l.requisitionLine ?? null,
      quantity: l.quantity,
      unit_price: l.price,
      vat_rate: 21,
    })),
  }
}

/** OC dentro del umbral de Compras, aprobada por otro integrante y enviada al proveedor. */
async function sentOrder(quantity: number, price = 1000, product = p.mp1) {
  const created = await call<{ id: string }>('compras1', 'po_create', a.id, order([{ product, quantity, price }]))
  await call('compras1', 'po_submit', created.id)
  await call('compras2', 'po_approve', created.id, 'OK')
  await call('compras1', 'po_send', created.id)
  const [line] = await db.admin<{ id: string }>('select id from public.purchase_order_lines where document_id = $1', [
    created.id,
  ])
  return { id: created.id, lineId: line.id }
}

let remito = 0
function receipt(
  orderId: string,
  lines: { lineId: string; quantity: number }[],
  note = `0001-${String(++remito).padStart(8, '0')}`,
) {
  return {
    purchase_order_id: orderId,
    warehouse_id: a.warehouse,
    supplier_delivery_note: note,
    carrier_name: '',
    notes: '',
    lines: lines.map((l) => ({ po_line_id: l.lineId, quantity: l.quantity })),
  }
}

// ---------------------------------------------------------------- Circuito

describe('circuito completo de compras', () => {
  it('SC → OC → aprobación → envío → recepción, con tareas, avisos y stock', async () => {
    const sc = await requisition(p.mp1, 50)
    expect(await status(sc.id)).toBe('SOLICITADO')
    // Compras recibe la tarea y un aviso por integrante (quien pide no se avisa a sí mismo).
    const tasks = await db.admin<{ task_type: string; assigned_role: string }>(
      `select task_type, assigned_role from public.tasks where document_id = $1 and status = 'PENDIENTE'`,
      [sc.id],
    )
    expect(tasks).toEqual([{ task_type: 'ATENDER_SC', assigned_role: 'COMPRAS' }])
    const notified = await db.admin<{ recipient_user_id: string }>(
      `select recipient_user_id from public.notifications where document_id = $1 and type = 'NUEVA_TAREA'`,
      [sc.id],
    )
    expect(notified.map((n) => n.recipient_user_id).sort()).toEqual([u.compras1, u.compras2].sort())

    const oc = await call<{ id: string; display_number: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp1, quantity: 50, price: 1300, requisitionLine: sc.lineId }]),
    )
    // Un borrador no compromete a la empresa: la SC todavía no está "Ordenada".
    expect(await status(sc.id)).toBe('SOLICITADO')
    await call('compras1', 'po_submit', oc.id)
    expect(await status(oc.id)).toBe('PENDIENTE_APROBACION')
    expect(await status(sc.id)).toBe('ORDENADO')

    await call('compras2', 'po_approve', oc.id, 'Precio habitual')
    expect(await status(oc.id)).toBe('APROBADO')
    const approved = await db.admin(
      'select 1 from public.notifications where recipient_user_id = $1 and type = $2 and document_id = $3',
      [u.compras1, 'OC_APROBADA', oc.id],
    )
    expect(approved).toHaveLength(1)

    await call('compras1', 'po_send', oc.id)
    expect(await status(oc.id)).toBe('ENVIADO')
    const [line] = await db.admin<{ id: string }>('select id from public.purchase_order_lines where document_id = $1', [
      oc.id,
    ])
    const rec = await call<{ id: string }>(
      'deposito',
      'gr_create',
      a.id,
      receipt(oc.id, [{ lineId: line.id, quantity: 50 }]),
      true,
    )
    expect(await status(rec.id)).toBe('CONFIRMADO')
    expect(await status(oc.id)).toBe('RECIBIDO')
    // Quien pidió el material se entera de que llegó.
    const available = await db.admin('select 1 from public.notifications where recipient_user_id = $1 and type = $2', [
      u.produccion,
      'MATERIAL_DISPONIBLE',
    ])
    expect(available.length).toBeGreaterThan(0)
  })
})

describe('aprobación por monto', () => {
  it('hasta $ 500.000 (incluido) aprueba otro integrante de Compras; Gerencia no corresponde', async () => {
    // 413.223,14 + 21 % de IVA = 500.000,00 justos.
    const oc = await call<{ id: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 1, price: 413223.14 }]),
    )
    await call('compras1', 'po_submit', oc.id)
    const [req] = await db.admin<{ approver_role: string; amount: string }>(
      `select approver_role, amount from public.approval_requests where document_id = $1`,
      [oc.id],
    )
    expect(req).toEqual({ approver_role: 'COMPRAS', amount: '500000.00' })
    expect((await fails('gerencia', 'po_approve', oc.id, '')).code).toBe('APROBADOR_INCORRECTO')
    await call('compras2', 'po_approve', oc.id, '')
    expect(await status(oc.id)).toBe('APROBADO')
  })

  it('más de $ 500.000 aprueba Gerencia; Compras no corresponde', async () => {
    const oc = await call<{ id: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 1, price: 413223.15 }]),
    )
    await call('compras1', 'po_submit', oc.id)
    const error = await fails('compras2', 'po_approve', oc.id, '')
    expect(error.code).toBe('APROBADOR_INCORRECTO')
    expect(error.message).toContain('Gerencia')
    await call('gerencia', 'po_approve', oc.id, 'Autorizado')
    expect(await status(oc.id)).toBe('APROBADO')
  })
})

describe('separación de funciones', () => {
  it('quien crea una OC no puede aprobarla', async () => {
    const oc = await call<{ id: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 1, price: 1000 }]),
    )
    await call('compras1', 'po_submit', oc.id)
    const error = await fails('compras1', 'po_approve', oc.id, '')
    expect(error.code).toBe('SEPARACION_FUNCIONES')
    expect(error.hint).toContain('quien compra no autoriza su propia compra')
  })

  it('quien confirma una recepción no la anula; otro integrante de Depósito sí', async () => {
    const oc = await sentOrder(5, 1000, p.mp3)
    const rec = await call<{ id: string }>(
      'deposito',
      'gr_create',
      a.id,
      receipt(oc.id, [{ lineId: oc.lineId, quantity: 5 }]),
      true,
    )
    expect((await fails('deposito', 'gr_cancel', rec.id, 'Error de carga')).code).toBe('SEPARACION_FUNCIONES')
    await call('deposito2', 'gr_cancel', rec.id, 'Error de carga')
    expect(await status(rec.id)).toBe('ANULADO')
    expect(await status(oc.id)).toBe('ENVIADO')
  })
})

describe('recepciones', () => {
  it('la recepción parcial deja tarea por el saldo y la del saldo completa la orden', async () => {
    const oc = await sentOrder(40, 1000, p.mp3)
    await call('deposito', 'gr_create', a.id, receipt(oc.id, [{ lineId: oc.lineId, quantity: 30 }]), true)
    expect(await status(oc.id)).toBe('RECIBIDO_PARCIAL')
    const [task] = await db.admin<{ title: string }>(
      `select title from public.tasks where document_id = $1 and status = 'PENDIENTE' and task_type = 'RECIBIR_MERCADERIA'`,
      [oc.id],
    )
    expect(task.title).toMatch(/^Recibir saldo de OC-/)
    await call('deposito', 'gr_create', a.id, receipt(oc.id, [{ lineId: oc.lineId, quantity: 10 }]), true)
    expect(await status(oc.id)).toBe('RECIBIDO')
    const open = await db.admin(
      `select 1 from public.tasks where document_id = $1 and status in ('PENDIENTE', 'EN_CURSO')`,
      [oc.id],
    )
    expect(open).toEqual([])
  })

  it('no se puede ordenar más de lo pendiente de la SC ni recibir más de lo ordenado', async () => {
    const sc = await requisition(p.mp3, 10)
    const tooMuch = await fails(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 11, price: 100, requisitionLine: sc.lineId }]),
    )
    expect(tooMuch.code).toBe('CANTIDAD_EXCEDE_PENDIENTE')
    const oc = await sentOrder(5, 1000, p.mp3)
    const over = await fails('deposito', 'gr_create', a.id, receipt(oc.id, [{ lineId: oc.lineId, quantity: 6 }]), true)
    expect(over.code).toBe('CANTIDAD_EXCEDE_PENDIENTE')
  })

  it('el mismo remito no se carga dos veces contra la misma orden, salvo que la anterior se anule', async () => {
    const oc = await sentOrder(10, 1000, p.mp3)
    const first = await call<{ id: string }>(
      'deposito',
      'gr_create',
      a.id,
      receipt(oc.id, [{ lineId: oc.lineId, quantity: 4 }], '0003-00004521'),
      true,
    )
    const dup = await fails(
      'deposito',
      'gr_create',
      a.id,
      receipt(oc.id, [{ lineId: oc.lineId, quantity: 4 }], ' 0003-00004521 '),
      true,
    )
    expect(dup.code).toBe('REMITO_DUPLICADO')
    await call('deposito2', 'gr_cancel', first.id, 'Cargado con error')
    await call(
      'deposito',
      'gr_create',
      a.id,
      receipt(oc.id, [{ lineId: oc.lineId, quantity: 4 }], '0003-00004521'),
      true,
    )
  })
})

describe('stock', () => {
  it('el costo promedio ponderado se recalcula con cada entrada', async () => {
    // MP-001 arrancó con 100 a $ 1.000 y recibió 50 a $ 1.300 en el circuito completo.
    expect(await stockOf(p.mp1)).toEqual({ qty: 150, avg: 1100 })
  })

  it('no se puede sacar lo que no está, salvo que el docente habilite el stock negativo', async () => {
    const input = {
      warehouse_id: a.warehouse,
      reason_code: 'ROTURA',
      notes: 'Rotura',
      lines: [{ product_id: p.mp1, quantity_delta: -1000 }],
    }
    const error = await fails('deposito', 'sa_create', a.id, input, true)
    expect(error.code).toBe('STOCK_INSUFICIENTE')
    expect(error.message).toContain('hay 150 UN')
    await call('docente', 'company_update_settings', a.id, { allow_negative_stock: true })
    await call('deposito', 'sa_create', a.id, { ...input, lines: [{ product_id: p.mp1, quantity_delta: -151 }] }, true)
    expect((await stockOf(p.mp1)).qty).toBe(-1)
    await call('docente', 'company_update_settings', a.id, { allow_negative_stock: false })
    await call(
      'deposito',
      'sa_create',
      a.id,
      { ...input, reason_code: 'CONTEO_FISICO', lines: [{ product_id: p.mp1, quantity_delta: 151 }] },
      true,
    )
  })

  it('bajar del mínimo genera la alerta para Depósito y Compras; pedir el producto la resuelve', async () => {
    await call(
      'deposito',
      'sa_create',
      a.id,
      {
        warehouse_id: a.warehouse,
        reason_code: 'ROTURA',
        notes: 'Rotura',
        lines: [{ product_id: p.mp2, quantity_delta: -15 }],
      },
      true,
    )
    const [alert] = await db.admin<{ id: string; status: string; title: string }>(
      `select id, status, title from public.tasks where task_type = 'REPONER_STOCK' and context ->> 'product_id' = $1`,
      [p.mp2],
    )
    expect(alert).toMatchObject({ status: 'PENDIENTE', title: 'Evaluar reposición de MP-002 Producto MP-002' })
    const warned = await db.admin<{ recipient_user_id: string }>(
      `select recipient_user_id from public.notifications where task_id = $1 and type = 'STOCK_MINIMO'`,
      [alert.id],
    )
    expect(warned.map((n) => n.recipient_user_id).sort()).toEqual(
      [u.compras1, u.compras2, u.deposito, u.deposito2].sort(),
    )
    await requisition(p.mp2, 40)
    const [after] = await db.admin<{ status: string }>('select status from public.tasks where id = $1', [alert.id])
    expect(after.status).toBe('RESUELTA')
  })

  it('invariante: el saldo de cada producto es la suma de sus movimientos, incluso con anulaciones', async () => {
    const rows = await db.admin<{ product_id: string; balance: string; moves: string }>(
      `select b.product_id, b.qty_on_hand as balance, coalesce(sum(m.quantity), 0) as moves
         from public.stock_balances b
         left join public.stock_movements m on m.product_id = b.product_id and m.warehouse_id = b.warehouse_id
        group by b.product_id, b.warehouse_id, b.qty_on_hand`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(Number(r.balance), r.product_id).toBe(Number(r.moves))
    expect((await businessError(db.admin('delete from public.stock_movements'))).code).toBe('INMUTABLE')
  })
})

describe('anulaciones y reapertura', () => {
  it('anular una OC libera la SC y le vuelve a abrir la tarea a Compras', async () => {
    const sc = await requisition(p.mp3, 8)
    const oc = await call<{ id: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 8, price: 100, requisitionLine: sc.lineId }]),
    )
    await call('compras1', 'po_submit', oc.id)
    expect(await status(sc.id)).toBe('ORDENADO')
    await call('compras2', 'po_approve', oc.id, '')
    await call('compras1', 'po_cancel', oc.id, 'El proveedor no tiene stock')
    expect(await status(sc.id)).toBe('SOLICITADO')
    const open = await db.admin<{ task_type: string }>(
      `select task_type from public.tasks where document_id = $1 and status = 'PENDIENTE'`,
      [sc.id],
    )
    expect(open.map((t) => t.task_type)).toEqual(['ATENDER_SC'])
  })

  it('retirar una OC de aprobación la vuelve a borrador y la SC a "Solicitada"; sólo puede su creador', async () => {
    const sc = await requisition(p.mp3, 3)
    const oc = await call<{ id: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 3, price: 100, requisitionLine: sc.lineId }]),
    )
    await call('compras1', 'po_submit', oc.id)
    expect((await fails('compras2', 'po_withdraw', oc.id)).code).toBe('SIN_PERMISO')
    await call('compras1', 'po_withdraw', oc.id)
    expect(await status(oc.id)).toBe('BORRADOR')
    expect(await status(sc.id)).toBe('SOLICITADO')
  })

  it('rechazar exige motivo, avisa al solicitante y se puede reabrir para corregir', async () => {
    const sc = await requisition(p.mp3, 2)
    expect((await fails('compras1', 'pr_reject', sc.id, '')).code).toBe('MOTIVO_REQUERIDO')
    await call('compras1', 'pr_reject', sc.id, 'Hay stock suficiente')
    expect(await status(sc.id)).toBe('RECHAZADO')
    const warned = await db.admin(
      'select 1 from public.notifications where recipient_user_id = $1 and type = $2 and document_id = $3',
      [u.produccion, 'SC_RECHAZADA', sc.id],
    )
    expect(warned).toHaveLength(1)
    const oc = await call<{ id: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 1, price: 100 }]),
    )
    await call('compras1', 'po_submit', oc.id)
    await call('compras2', 'po_reject', oc.id, 'Precio alto')
    await call('compras1', 'po_reopen', oc.id)
    expect(await status(oc.id)).toBe('BORRADOR')
  })
})

describe('auditoría y permisos', () => {
  it('cada transición queda registrada con usuario, rol, sector y estados', async () => {
    const oc = await sentOrder(1, 100, p.mp3)
    const events = await db.admin<{
      action: string
      actor_user_id: string
      actor_role_code: string
      actor_sector_name: string
      from_status: string
      to_status: string
    }>(
      `select action, actor_user_id, actor_role_code, actor_sector_name, from_status, to_status
         from public.audit_events where document_id = $1 order by id`,
      [oc.id],
    )
    expect(events.map((e) => `${e.action}:${e.from_status ?? '—'}→${e.to_status}`)).toEqual([
      'CREATE:—→BORRADOR',
      'SUBMIT:BORRADOR→PENDIENTE_APROBACION',
      'APPROVE:PENDIENTE_APROBACION→APROBADO',
      'SEND:APROBADO→ENVIADO',
    ])
    const approve = events.find((e) => e.action === 'APPROVE')!
    expect(approve).toMatchObject({
      actor_user_id: u.compras2,
      actor_role_code: 'COMPRAS',
      actor_sector_name: 'Compras',
    })
  })

  it('sin el permiso no se ejecuta el comando, aunque se llame directo a la base', async () => {
    expect((await fails('ventas', 'po_create', a.id, order([{ product: p.mp3, quantity: 1, price: 1 }]))).code).toBe(
      'SIN_PERMISO',
    )
    const oc = await sentOrder(1, 100, p.mp3)
    expect(
      (await fails('produccion', 'gr_create', a.id, receipt(oc.id, [{ lineId: oc.lineId, quantity: 1 }]), true)).code,
    ).toBe('SIN_PERMISO')
    // Gerencia de OTRA empresa no puede aprobar órdenes de ésta.
    const other = await call<{ id: string }>(
      'compras1',
      'po_create',
      a.id,
      order([{ product: p.mp3, quantity: 1, price: 600000 }]),
    )
    await call('compras1', 'po_submit', other.id)
    expect((await fails('intruso', 'po_approve', other.id, '')).code).toBe('SIN_PERMISO')
  })

  it('cada rol lee sólo los documentos de los tipos que le corresponden', async () => {
    expect(await db.as(u.ventas, `select id from public.documents where doc_type = 'PURCHASE_ORDER'`)).toEqual([])
    expect(
      (await db.as(u.compras1, `select id from public.documents where doc_type = 'PURCHASE_ORDER'`)).length,
    ).toBeGreaterThan(0)
    expect(await db.as(u.intruso, 'select id from public.documents')).toEqual([])
  })
})

describe('tareas y notificaciones', () => {
  it('una tarea la toma una sola persona, y la libera quien la tomó', async () => {
    const sc = await requisition(p.mp3, 1)
    const [task] = await db.admin<{ id: string }>(
      `select id from public.tasks where document_id = $1 and status = 'PENDIENTE'`,
      [sc.id],
    )
    await call('compras1', 'task_claim', task.id, true)
    expect((await fails('compras2', 'task_claim', task.id, true)).code).toBe('TAREA_TOMADA')
    expect((await fails('compras2', 'task_claim', task.id, false)).code).toBe('SIN_PERMISO')
    await call('compras1', 'task_claim', task.id, false)
    expect((await fails('intruso', 'task_claim', task.id, true)).code).toBe('DATO_INVALIDO')
  })

  it('marcar como leídas afecta sólo a las propias', async () => {
    await call('compras1', 'notifications_mark_read', a.id, null)
    const mine = await db.as<{ n: number }>(
      u.compras1,
      'select count(*)::int as n from public.notifications where read_at is null',
    )
    const theirs = await db.as<{ n: number }>(
      u.compras2,
      'select count(*)::int as n from public.notifications where read_at is null',
    )
    expect(mine[0].n).toBe(0)
    expect(theirs[0].n).toBeGreaterThan(0)
  })
})
