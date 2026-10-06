// El adaptador de la interfaz para Supabase (src/lib/api/supabase.ts) de punta
// a punta: sesión con Auth, cada consulta del contrato contra su función SQL
// (con el mismo resultado que el simulador), cada comando contra su RPC o la
// Edge Function, y los errores tal como los muestra la interfaz.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSupabaseBackend, normalizeTimestamps } from '../../src/lib/api/supabase'
import type { DB } from '../../src/lib/mock/db'
import { BusinessError } from '../../src/lib/mock/engine'
import * as Q from '../../src/lib/mock/queries'
import { DEMO_PASSWORD } from '../../src/lib/mock/seed'
import { project, sortTies } from './support/compare'
import { createTestDb, type TestDb } from './support/db'
import { createFakeSupabase, PUBLIC_KEY, SUPABASE_URL, type FakeSupabase } from './support/fake-supabase'
import { loadMockDb, normalize, type LoadedMock } from './support/mock-loader'
import { buildScenario } from './support/scenario'

vi.setConfig({ testTimeout: 120_000 })

const DOMAIN = 'simulador.test' // los emails que arma el cargador

let db: TestDb
let fake: FakeSupabase
let mock: DB
let loaded: LoadedMock
let company: string
let slug: string

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

const backend = () =>
  createSupabaseBackend({
    url: SUPABASE_URL,
    publishableKey: PUBLIC_KEY,
    emailDomain: DOMAIN,
    fetch: fake.fetch,
    storage: memoryStorage(),
  })

type Backend = ReturnType<typeof backend>

async function as(username: string): Promise<Backend> {
  const b = backend()
  await b.auth.login(username, DEMO_PASSWORD)
  return b
}

const mockId = (username: string) => mock.profiles.find((p) => p.username === username)!.id
const pgId = (username: string) => loaded.pg(mockId(username))

async function businessCode(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof BusinessError) return error.code
    throw error
  }
  throw new Error('Se esperaba un error de negocio')
}

beforeAll(async () => {
  mock = buildScenario()
  db = await createTestDb()
  loaded = await loadMockDb(db, mock)
  fake = createFakeSupabase(db, DOMAIN)
  for (const p of mock.profiles) fake.passwords.set(loaded.pg(p.id), DEMO_PASSWORD)
  const template = mock.companies.find((c) => c.is_template)!
  company = loaded.pg(template.id)
  slug = template.slug
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('sesión', () => {
  it('ingresa con usuario y contraseña; la contraseña equivocada da el mensaje de siempre', async () => {
    const b = backend()
    expect(await businessCode(b.auth.login('compras1', 'otra'))).toBe('CREDENCIALES')
    expect(b.currentUserId()).toBeNull()
    expect(await b.auth.login(' Compras1 ', DEMO_PASSWORD)).toBe(pgId('compras1'))
    expect(b.currentUserId()).toBe(pgId('compras1'))
    expect(b.auth.demoUsers()).toEqual([])
    expect(await businessCode(b.auth.loginAs('docente'))).toBe('NO_DISPONIBLE')
  })

  it('el nombre de la escuela se lee sin sesión', async () => {
    expect(await backend().auth.schoolInfo()).toEqual(Q.publicSchoolInfo(mock))
  })

  it('un usuario desactivado no entra y no queda sesión abierta', async () => {
    await db.admin(`update public.profiles set is_active = false where id = $1`, [pgId('rrhh')])
    const b = backend()
    expect(await businessCode(b.auth.login('rrhh', DEMO_PASSWORD))).toBe('USUARIO_INACTIVO')
    expect(b.currentUserId()).toBeNull()
    await db.admin(`update public.profiles set is_active = true where id = $1`, [pgId('rrhh')])
  })

  it('renueva el token vencido sin que se note; si la sesión se revocó, pide volver a ingresar', async () => {
    const b = await as('ventas')
    fake.expireAccessTokens()
    const refreshes = () => fake.log.filter((l) => l === 'POST /auth/v1/token').length
    const before = refreshes()
    expect((await b.api.me()).user.username).toBe('ventas')
    expect(refreshes()).toBe(before + 1)
    fake.expireAccessTokens()
    fake.revokeRefreshTokens()
    expect(await businessCode(b.api.me())).toBe('SIN_SESION')
    expect(b.currentUserId()).toBeNull()
  })

  it('al salir, la sesión se cierra en el servidor y en la pestaña', async () => {
    const b = await as('auditor')
    b.auth.logout()
    expect(b.currentUserId()).toBeNull()
    expect(await businessCode(b.api.me())).toBe('SIN_SESION')
  })
})

describe('consultas: cada una llega a su función y devuelve lo mismo que el simulador', () => {
  it('como docente y como Compras', async () => {
    const po = mock.documents.find((d) => d.display_number === 'OC-00002')!
    for (const username of ['docente', 'compras1']) {
      const b = await as(username)
      const user = mockId(username)
      const tmpl = mock.companies.find((c) => c.is_template)!.id
      const cases: [string, () => Promise<unknown>, () => unknown, ((x: never) => unknown)?][] = [
        ['me', () => b.api.me(), () => Q.meContext(mock, user)],
        ['companyContext', () => b.api.companyContext(slug), () => Q.companyContext(mock, user, slug)],
        ['customers', () => b.api.customers(company), () => Q.listCustomers(mock, user, tmpl)],
        ['suppliers', () => b.api.suppliers(company), () => Q.listSuppliers(mock, user, tmpl)],
        ['products', () => b.api.products(company), () => Q.listProducts(mock, user, tmpl)],
        ['product', () => b.api.product(company, 'MP-001'), () => Q.productDetail(mock, user, tmpl, 'MP-001')],
        ['stock', () => b.api.stock(company), () => Q.listStock(mock, user, tmpl)],
        [
          'documents',
          () => b.api.documents(company, 'PURCHASE_ORDER'),
          () => Q.listDocuments(mock, user, tmpl, 'PURCHASE_ORDER'),
        ],
        [
          'document',
          () => b.api.document(company, 'PURCHASE_ORDER', 'OC-00002'),
          () => Q.documentDetail(mock, user, tmpl, 'PURCHASE_ORDER', 'OC-00002'),
        ],
        ['documentById', () => b.api.documentById(loaded.pg(po.id)), () => Q.documentDetailById(mock, user, po.id)],
        [
          'pendingRequisitionLines',
          () => b.api.pendingRequisitionLines(company),
          () => Q.pendingRequisitionLines(mock, user, tmpl),
        ],
        ['receivableOrders', () => b.api.receivableOrders(company), () => Q.receivableOrders(mock, user, tmpl)],
        [
          'tasks',
          () => b.api.tasks(company, 'all', true),
          () => Q.listTasks(mock, user, tmpl, 'all', true),
          (t: { status: string; created_at: string }) => `${t.status === 'EN_CURSO'}|${t.created_at}`,
        ],
        [
          'notifications',
          () => b.api.notifications(company, null),
          () => Q.listNotifications(mock, user, tmpl, null),
          (n: { created_at: string }) => n.created_at,
        ],
        ['audit', () => b.api.audit(company), () => Q.listAudit(mock, user, tmpl)],
        ['exportProducts', () => b.api.exportProducts(company), () => Q.exportProducts(mock, user, tmpl)],
        ['exportAudit', () => b.api.exportAudit(company), () => Q.exportAudit(mock, user, tmpl)],
      ]
      if (username === 'docente') {
        cases.push(['members', () => b.api.members(company), () => Q.listMembers(mock, user, tmpl)])
        cases.push(['courses', () => b.api.courses(), () => Q.listCourses(mock, user)])
      }
      for (const [name, real, simulated, ties] of cases) {
        let want: unknown
        try {
          want = normalize(JSON.parse(JSON.stringify(simulated() ?? null)))
        } catch {
          // Sin permiso en el simulador: el adaptador también lo rechaza.
          await expect(real(), `${name} como ${username}`).rejects.toBeInstanceOf(BusinessError)
          continue
        }
        let got = project(loaded.fromPg(await real()), want)
        let expected: unknown = want
        if (ties) {
          got = sortTies(got, ties)
          expected = sortTies(want, ties)
        }
        expect(got, `${name} como ${username}`).toEqual(expected)
      }
      const board = loaded.fromPg(await b.api.dashboard(company))
      const { tasks: _tasks, ...rest } = normalize(JSON.parse(JSON.stringify(Q.dashboard(mock, user, tmpl))))
      expect(project(board, rest), `dashboard como ${username}`).toEqual(rest)
    }
  })

  it('las consultas de la administración escolar', async () => {
    const b = await as('admin')
    expect((await b.api.teachers()).length).toBe(Q.listTeachers(mock, mockId('admin')).length)
    expect((await b.api.users()).length).toBe(mock.profiles.length)
    const student = await as('ventas')
    expect(await businessCode(student.api.users())).toBe('SIN_PERMISO')
  })

  it('los errores de permiso llegan como errores de negocio', async () => {
    const b = await as('ventas')
    expect(await businessCode(b.api.documents(company, 'PURCHASE_ORDER'))).toBe('SIN_PERMISO')
    expect(await businessCode(b.api.exportStock(company))).toBe('SIN_PERMISO')
  })
})

describe('comandos: el circuito de compras completo por el adaptador', () => {
  it('SC → OC → aprobación (con separación de funciones) → envío → recepción', async () => {
    const produccion = await as('produccion')
    const compras1 = await as('compras1')
    const compras2 = await as('compras2')
    const deposito = await as('deposito')
    const product = (code: string) => loaded.pg(mock.products.find((p) => p.code === code)!.id)
    const warehouse = loaded.pg(mock.warehouses.find((w) => w.code === 'DEP-MP')!.id)
    const supplier = loaded.pg(mock.suppliers.find((s) => s.code === 'PRV-001')!.id)

    const sc = await produccion.commands.createRequisition(
      company,
      {
        needed_by: null,
        priority: 'ALTA',
        reason: 'Pedido especial de un cliente',
        notes: '',
        lines: [{ product_id: product('MP-002'), quantity: 40 }],
      },
      true,
    )
    expect(sc.display_number).toMatch(/^SC-\d{5}$/)
    const pending = (await compras1.api.pendingRequisitionLines(company)).find((l) => l.requisition.id === sc.id)!
    const oc = await compras1.commands.createPurchaseOrder(company, {
      supplier_id: supplier,
      expected_date: null,
      warehouse_id: warehouse,
      payment_terms_days: 30,
      delivery_terms: 'Puesto en planta',
      notes: '',
      lines: [
        {
          product_id: product('MP-002'),
          requisition_line_id: pending.line.id,
          quantity: 40,
          unit_price: 1600,
          vat_rate: 21,
        },
      ],
    })
    await compras1.commands.submitPurchaseOrder(oc.id)
    expect(await businessCode(compras1.commands.approvePurchaseOrder(oc.id, 'Me la apruebo'))).toBe(
      'SEPARACION_FUNCIONES',
    )
    await compras2.commands.approvePurchaseOrder(oc.id, 'Precio de lista')
    await compras1.commands.sendPurchaseOrder(oc.id)
    const order = (await deposito.api.receivableOrders(company)).find((o) => o.order.id === oc.id)!
    const rec = await deposito.commands.createGoodsReceipt(
      company,
      {
        purchase_order_id: oc.id,
        warehouse_id: warehouse,
        supplier_delivery_note: 'R-0002-00001234',
        carrier_name: '',
        notes: '',
        lines: order.lines.map((l) => ({ po_line_id: l.line.id, quantity: l.pending })),
      },
      true,
    )
    expect(rec.display_number).toMatch(/^REC-\d{5}$/)
    const detail = (await compras1.api.document(company, 'PURCHASE_ORDER', oc.display_number))!
    expect(detail.doc.status).toBe('RECIBIDO')
    expect(detail.flow.map((f) => f.display_number)).toEqual([sc.display_number, oc.display_number, rec.display_number])
    expect((await produccion.api.document(company, 'PURCHASE_REQUISITION', sc.display_number))!.doc.status).toBe(
      'ORDENADO',
    )
  })

  it('el resto de las transiciones de documentos', async () => {
    const produccion = await as('produccion')
    const compras1 = await as('compras1')
    const compras2 = await as('compras2')
    const deposito = await as('deposito')
    const product = (code: string) => loaded.pg(mock.products.find((p) => p.code === code)!.id)
    const warehouse = loaded.pg(mock.warehouses.find((w) => w.code === 'DEP-MP')!.id)
    const supplier = loaded.pg(mock.suppliers.find((s) => s.code === 'PRV-002')!.id)
    const status = async (
      b: Backend,
      type: 'PURCHASE_REQUISITION' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT' | 'STOCK_ADJUSTMENT',
      number: string,
    ) => (await b.api.document(company, type, number))!.doc.status
    const scInput = (code: string) => ({
      needed_by: null,
      priority: 'NORMAL' as const,
      reason: 'Reposición del mes',
      notes: '',
      lines: [{ product_id: product(code), quantity: 3 }],
    })

    const draft = await produccion.commands.createRequisition(company, scInput('IN-001'), false)
    await produccion.commands.updateRequisition(draft.id, scInput('IN-002'))
    await produccion.commands.submitRequisition(draft.id)
    await compras1.commands.rejectRequisition(draft.id, 'Hay en el depósito')
    expect(await status(produccion, 'PURCHASE_REQUISITION', draft.display_number)).toBe('RECHAZADO')

    const cancelled = await produccion.commands.createRequisition(company, scInput('IN-003'), true)
    await produccion.commands.cancelRequisition(cancelled.id, 'Ya no hace falta')
    expect(await status(produccion, 'PURCHASE_REQUISITION', cancelled.display_number)).toBe('ANULADO')

    const partial = mock.documents.find((d) => d.display_number === 'SC-00002')!
    await compras1.commands.closeRequisition(loaded.pg(partial.id), 'El resto no se compra')
    expect(await status(compras1, 'PURCHASE_REQUISITION', 'SC-00002')).toBe('CERRADO')

    const blank = {
      supplier_id: supplier,
      expected_date: null,
      warehouse_id: warehouse,
      payment_terms_days: 30,
      delivery_terms: '',
      notes: '',
      lines: [
        { product_id: product('MP-004'), requisition_line_id: null, quantity: 2, unit_price: 92000, vat_rate: 21 },
      ],
    }
    const oc = await compras1.commands.createPurchaseOrder(company, blank)
    await compras1.commands.updatePurchaseOrder(oc.id, { ...blank, delivery_terms: 'Retira el comprador' })
    await compras1.commands.submitPurchaseOrder(oc.id)
    await compras1.commands.withdrawPurchaseOrder(oc.id)
    await compras1.commands.submitPurchaseOrder(oc.id)
    await compras2.commands.rejectPurchaseOrder(oc.id, 'Falta una cotización')
    await compras1.commands.reopenPurchaseOrder(oc.id)
    await compras1.commands.cancelPurchaseOrder(oc.id, 'Se compra en otro momento')
    expect(await status(compras1, 'PURCHASE_ORDER', oc.display_number)).toBe('ANULADO')

    const partialOrder = mock.documents.find((d) => d.display_number === 'OC-00002')!
    const draftReceipt = mock.documents.find((d) => d.doc_type === 'GOODS_RECEIPT' && d.status === 'BORRADOR')!
    await deposito.commands.cancelGoodsReceipt(loaded.pg(draftReceipt.id), 'Se cargó dos veces')
    await compras1.commands.closePurchaseOrder(loaded.pg(partialOrder.id), 'El saldo no llega')
    expect(await status(compras1, 'PURCHASE_ORDER', 'OC-00002')).toBe('CERRADO')

    const adjustment = await deposito.commands.createStockAdjustment(
      company,
      {
        warehouse_id: warehouse,
        reason_code: 'CONTEO_FISICO',
        notes: '',
        lines: [{ product_id: product('IN-001'), quantity_delta: 1 }],
      },
      false,
    )
    await deposito.commands.confirmStockAdjustment(adjustment.id)
    const other = await deposito.commands.createStockAdjustment(
      company,
      {
        warehouse_id: warehouse,
        reason_code: 'ROTURA',
        notes: '',
        lines: [{ product_id: product('IN-001'), quantity_delta: -1 }],
      },
      false,
    )
    await deposito.commands.cancelStockAdjustment(other.id, 'Era otro producto')
    expect(await status(deposito, 'STOCK_ADJUSTMENT', adjustment.display_number)).toBe('CONFIRMADO')
    expect(await status(deposito, 'STOCK_ADJUSTMENT', other.display_number)).toBe('ANULADO')
  })
})

describe('comandos: maestros, tareas, avisos, panel docente y escuela', () => {
  it('maestros, tareas y avisos', async () => {
    const compras1 = await as('compras1')
    const id = await compras1.commands.saveMaster('supplier', company, {
      code: 'prv-099',
      legal_name: 'Herrajes del Litoral SA',
      vat_condition: 'RESPONSABLE_INSCRIPTO',
      payment_terms_days: 15,
    })
    await compras1.commands.setMasterActive('supplier', company, id, false)
    const supplier = (await compras1.api.suppliers(company)).find((s) => s.id === id)!
    expect(supplier).toMatchObject({ code: 'PRV-099', is_active: false })

    const task = (await compras1.api.tasks(company, 'mine')).find((t) => t.status === 'PENDIENTE')!
    await compras1.commands.claimTask(task.id, true)
    expect((await compras1.api.tasks(company, 'mine')).find((t) => t.id === task.id)!.status).toBe('EN_CURSO')
    await compras1.commands.claimTask(task.id, false)

    await compras1.commands.markNotificationsRead(company, 'all')
    expect((await compras1.api.notifications(company, null)).every((n) => n.read_at)).toBe(true)
  })

  it('panel docente: roles, módulos y control interno', async () => {
    const docente = await as('docente')
    const sector = loaded.pg(mock.sectors.find((s) => s.code === 'VEN')!.id)
    await docente.commands.assignRole(company, pgId('produccion'), 'VENTAS', sector)
    const member = (await docente.api.members(company)).find((m) => m.user.id === pgId('produccion'))!
    const added = member.roles.find((r) => r.role_code === 'VENTAS')!
    await docente.commands.removeRole(company, added.id)
    await docente.commands.setModule(company, 'audit', false)
    expect((await docente.api.companyContext(slug))!.modules.find((m) => m.module_code === 'audit')!.is_enabled).toBe(
      false,
    )
    await docente.commands.setModule(company, 'audit', true)
    await docente.commands.updateCompanySettings(company, { allow_negative_stock: true })
    expect((await docente.api.companyContext(slug))!.company.settings.allow_negative_stock).toBe(true)
    await docente.commands.updateCompanySettings(company, { allow_negative_stock: false })
  })

  it('cuentas por la Edge Function: altas de estudiantes y restablecer contraseña', async () => {
    const docente = await as('docente')
    const created = await docente.commands.createStudentsBulk(company, [
      { first_name: 'Paula', last_name: 'Quiroga' },
      { first_name: 'Ramiro', last_name: 'Quiroga' },
    ])
    expect(created.map((c) => c.username)).toEqual(['pquiroga', 'rquiroga'])
    const studentId = await docente.commands.createStudent(company, {
      first_name: 'Tomás',
      last_name: 'Ibáñez',
      username: 'tibanez',
      password: 'inicial12',
    })
    expect((await docente.api.members(company)).some((m) => m.user.id === studentId)).toBe(true)
    await docente.commands.resetPassword(company, studentId, 'temporal34')
    const student = backend()
    await student.auth.login('tibanez', 'temporal34')
    expect((await student.api.me()).user.must_change_password).toBe(true)
    expect(await businessCode(docente.commands.resetPassword(company, pgId('docente'), 'algo1234'))).toBe('SIN_PERMISO')
  })

  it('cambio de la propia contraseña, con los controles del simulador', async () => {
    const b = await as('tesoreria')
    const change = (current_password: string, new_password: string) =>
      b.commands.changePassword({ current_password, new_password })
    expect(await businessCode(change('equivocada', 'nueva1234'))).toBe('DATO_INVALIDO')
    expect(await businessCode(change(DEMO_PASSWORD, '123'))).toBe('DATO_INVALIDO')
    expect(await businessCode(change(DEMO_PASSWORD, DEMO_PASSWORD))).toBe('DATO_INVALIDO')
    await change(DEMO_PASSWORD, 'nueva1234')
    expect((await b.api.me()).user.must_change_password).toBe(false)
    const again = backend()
    expect(await businessCode(again.auth.login('tesoreria', DEMO_PASSWORD))).toBe('CREDENCIALES')
    await again.auth.login('tesoreria', 'nueva1234')
    const [event] = await db.admin(
      `select summary from public.audit_events where actor_user_id = $1 and action = 'CHANGE_PASSWORD'`,
      [pgId('tesoreria')],
    )
    expect(event).toEqual({ summary: 'Cambió su contraseña' })
  })

  it('administración escolar: cursos, datos de la escuela, docentes y la empresa de un curso', async () => {
    const admin = await as('admin')
    const course = await admin.commands.createCourse({ academic_year: 2027, name: '5.º B', orientation: 'Economía' })
    await admin.commands.updateSchoolSettings({
      official_name: 'Escuela Normal Superior N.º 9',
      short_name: 'ENS N.º 9',
      city: 'Eldorado',
      province: 'Misiones',
      contact_email: '',
      session_timeout_minutes: 20,
    })
    expect((await admin.api.me()).school.session_timeout_minutes).toBe(20)
    const teacher = await admin.commands.createTeacher({
      first_name: 'Marina',
      last_name: 'Testigo',
      username: 'mtestigo',
      password: 'inicial12',
    })
    expect((await admin.api.teachers()).some((t) => t.id === teacher)).toBe(true)
    const docente = await as('docente')
    const created = await docente.commands.createCompanyFromTemplate(course)
    expect(created.slug).toBe('forestal-del-norte-5-b-2027')
    expect(await businessCode(docente.commands.resetDemoData())).toBe('NO_DISPONIBLE')
  })
})

describe('formato', () => {
  it('las fechas con hora quedan como en el simulador', () => {
    expect(normalizeTimestamps({ a: ['2026-10-03T19:43:54.123456+00:00'], b: '2026-10-03', c: 1 })).toEqual({
      a: ['2026-10-03T19:43:54.123Z'],
      b: '2026-10-03',
      c: 1,
    })
  })
})
