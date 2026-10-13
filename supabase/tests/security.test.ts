// Seguridad de la base (Fase 1A del roadmap): dos integrantes autorizados
// comparten una empresa y un tercero no puede acceder, ni leyendo las tablas
// directamente (RLS) ni llamando a las funciones. Mismas reglas que el motor
// simulado: permisos por rol, módulos bloqueables, docente supervisor,
// usuario activo en cada pedido, ADMIN fuera de las empresas.

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

beforeAll(async () => {
  db = await createTestDb()
  await seedSchool(db)
  for (const [name, role] of [
    ['superadmin', 'SUPERADMIN'],
    ['admin', 'ADMIN'],
    ['docente', 'DOCENTE'],
    ['compras1', 'ESTUDIANTE'],
    ['compras2', 'ESTUDIANTE'],
    ['ventas', 'ESTUDIANTE'],
    ['intruso', 'ESTUDIANTE'],
  ] as const) {
    u[name] = await createUser(db, name, role)
  }
  a = await createCompany(db, 'empresa-a')
  b = await createCompany(db, 'empresa-b')
  await addMember(db, a, u.docente, [['DOCENTE', null]])
  await addMember(db, a, u.compras1, [['COMPRAS', 'COM']])
  await addMember(db, a, u.compras2, [['COMPRAS', 'COM']])
  await addMember(db, a, u.ventas, [['VENTAS', 'VEN']])
  await addMember(db, b, u.intruso, [['COMPRAS', 'COM']])
  await createSupplier(db, a, 'PRV-001')
  await createSupplier(db, b, 'PRV-900')
  await db.admin(`insert into public.customers (company_id, code, legal_name) values ($1, 'CLI-001', 'Cliente A')`, [
    a.id,
  ])
}, 60_000)

afterAll(async () => {
  await db.close()
})

const codes = (rows: { code: string }[]) => rows.map((r) => r.code).sort()

describe('aislamiento entre empresas', () => {
  it('dos integrantes de la empresa A ven los mismos datos; el de la empresa B, ninguno', async () => {
    const q = 'select code from public.suppliers'
    expect(codes(await db.as(u.compras1, q))).toEqual(['PRV-001'])
    expect(codes(await db.as(u.compras2, q))).toEqual(['PRV-001'])
    expect(codes(await db.as(u.intruso, q))).toEqual(['PRV-900'])
    const companies = await db.as<{ slug: string }>(u.intruso, 'select slug from public.companies')
    expect(companies.map((c) => c.slug)).toEqual(['empresa-b'])
  })

  it('el contexto de una empresa ajena es nulo, aunque se conozca su dirección', async () => {
    const [own] = await db.as<{ ctx: { company: { slug: string } } | null }>(
      u.compras1,
      `select public.company_context('empresa-a') as ctx`,
    )
    expect(own.ctx?.company.slug).toBe('empresa-a')
    const [other] = await db.as<{ ctx: unknown }>(u.intruso, `select public.company_context('empresa-a') as ctx`)
    expect(other.ctx).toBeNull()
  })

  it('nadie puede dar de alta datos en una empresa ajena llamando a la función', async () => {
    const error = await businessError(
      db.as(u.intruso, `select public.master_save('supplier', $1, $2)`, [
        a.id,
        { code: 'PRV-666', legal_name: 'Colado' },
      ]),
    )
    expect(error.code).toBe('SIN_PERMISO')
  })
})

describe('permisos por rol', () => {
  it('cada rol lee sólo lo que su permiso habilita', async () => {
    // Ventas consulta clientes pero no proveedores (no tiene supplier.read).
    expect(codes(await db.as(u.ventas, 'select code from public.customers'))).toEqual(['CLI-001'])
    expect(await db.as(u.ventas, 'select code from public.suppliers')).toEqual([])
    // Compras, al revés.
    expect(await db.as(u.compras1, 'select code from public.customers')).toEqual([])
  })

  it('un módulo bloqueado por el docente quita sus permisos, salvo al docente', async () => {
    await db.as(u.docente, `select public.company_set_module($1, 'masters', false)`, [a.id])
    expect(await db.as(u.ventas, 'select code from public.customers')).toEqual([])
    expect(codes(await db.as(u.docente, 'select code from public.customers'))).toEqual(['CLI-001'])
    const error = await businessError(
      db.as(u.ventas, `select public.master_save('customer', $1, $2)`, [a.id, { code: 'CLI-002', legal_name: 'Otro' }]),
    )
    expect(error.code).toBe('MODULO_BLOQUEADO')
    await db.as(u.docente, `select public.company_set_module($1, 'masters', true)`, [a.id])
    expect(codes(await db.as(u.ventas, 'select code from public.customers'))).toEqual(['CLI-001'])
  })

  it('sin permiso, el error dice qué rol corresponde', async () => {
    const error = await businessError(
      db.as(u.ventas, `select public.master_save('supplier', $1, $2)`, [
        a.id,
        { code: 'PRV-002', legal_name: 'Nuevo' },
      ]),
    )
    expect(error.code).toBe('SIN_PERMISO')
    expect(error.message).toContain('Compras')
    expect(error.hint).toContain('sector')
  })

  it('un usuario desactivado pierde el acceso en el próximo pedido', async () => {
    await db.admin('update public.profiles set is_active = false where id = $1', [u.compras2])
    expect(await db.as(u.compras2, 'select code from public.suppliers')).toEqual([])
    expect((await businessError(db.as(u.compras2, 'select public.my_context()'))).code).toBe('USUARIO_INACTIVO')
    await db.admin('update public.profiles set is_active = true where id = $1', [u.compras2])
  })
})

describe('roles de la escuela', () => {
  it('ADMIN administra la escuela pero no opera dentro de las empresas', async () => {
    expect(await db.as(u.admin, 'select slug from public.companies')).toEqual([])
    expect(await db.as(u.admin, 'select code from public.suppliers')).toEqual([])
    const [course] = await db.as<{ id: string }>(u.admin, `select public.course_create(2027, '5.º A', 'Gestión') as id`)
    expect(course.id).toBeTruthy()
  })

  it('SUPERADMIN (el proveedor) ve todas las empresas', async () => {
    const companies = await db.as<{ slug: string }>(u.superadmin, 'select slug from public.companies order by slug')
    expect(companies.map((c) => c.slug)).toEqual(['empresa-a', 'empresa-b'])
  })

  it('un estudiante no puede dar de alta cursos ni cambiar los datos de la escuela', async () => {
    expect((await businessError(db.as(u.compras1, `select public.course_create(2027, '6.º B')`))).code).toBe(
      'SIN_PERMISO',
    )
    const error = await businessError(
      db.as(u.docente, `select public.school_settings_update($1)`, [
        { official_name: 'Otra', short_name: 'OT', session_timeout_minutes: 15 },
      ]),
    )
    expect(error.code).toBe('SIN_PERMISO')
  })
})

describe('sin escritura directa', () => {
  it('nadie modifica tablas a mano: ni datos, ni roles, ni su propio perfil', async () => {
    for (const sql of [
      `insert into public.suppliers (company_id, code, legal_name) values ('${a.id}', 'PRV-X', 'Directo')`,
      `update public.profiles set app_role = 'SUPERADMIN' where id = '${u.compras1}'`,
      `insert into public.member_roles (company_id, member_id, role_code) select company_id, id, 'DOCENTE' from public.company_members where user_id = '${u.compras1}'`,
      `delete from public.audit_events`,
      `update public.role_permissions set role_code = 'VENTAS'`,
    ]) {
      const error = await businessError(db.as(u.compras1, sql))
      expect(error.code, sql).toBe('SQL:42501') // permission denied
    }
  })

  it('sin sesión sólo se puede leer el nombre de la escuela', async () => {
    const [info] = await db.anon<{ info: { short_name: string } }>('select public.public_school_info() as info')
    expect(info.info.short_name).toBe('EP N.º 1')
    expect((await businessError(db.anon('select * from public.profiles'))).code).toBe('SQL:42501')
    expect((await businessError(db.anon('select public.my_context()'))).code).toBe('SQL:42501')
  })

  it('la auditoría no se modifica ni siquiera con permisos de administrador de la base', async () => {
    await db.as(u.compras1, `select public.master_save('supplier', $1, $2)`, [
      a.id,
      { code: 'PRV-010', legal_name: 'Auditado' },
    ])
    const error = await businessError(db.admin(`update public.audit_events set summary = 'otra cosa'`))
    expect(error.code).toBe('INMUTABLE')
  })
})

describe('alta de usuarios', () => {
  it('el rol de la aplicación sólo sale de los metadatos del servidor, nunca de los del usuario', async () => {
    const [row] = await db.admin<{ id: string }>(
      `insert into auth.users (email, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3) returning id`,
      [
        'colado@usuarios.test',
        JSON.stringify({ username: 'colado', first_name: 'Co', last_name: 'Lado' }),
        JSON.stringify({ app_role: 'SUPERADMIN' }),
      ],
    )
    const [profile] = await db.admin<{ app_role: string }>('select app_role from public.profiles where id = $1', [
      row.id,
    ])
    expect(profile.app_role).toBe('ESTUDIANTE')
  })

  it('sin datos del servidor, la cuenta queda pendiente: inactiva, sin rol y sin poder hacer nada', async () => {
    // Aunque el usuario se ponga un rol en sus propios metadatos.
    const [row] = await db.admin<{ id: string }>(
      `insert into auth.users (email, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3) returning id`,
      [
        'Suelto.Uno@usuarios.test',
        JSON.stringify({ provider: 'email' }),
        JSON.stringify({ username: 'jefe', app_role: 'SUPERADMIN' }),
      ],
    )
    const [profile] = await db.admin(
      'select username, app_role, is_active, setup_pending from public.profiles where id = $1',
      [row.id],
    )
    expect(profile).toEqual({ username: 'suelto.uno', app_role: 'ESTUDIANTE', is_active: false, setup_pending: true })
    expect((await businessError(db.as(row.id, 'select public.my_context()'))).code).toBe('USUARIO_INACTIVO')
  })

  it('cuando el servidor carga sus datos, la cuenta pendiente se completa y se activa', async () => {
    const [row] = await db.admin<{ id: string }>(
      `insert into auth.users (email) values ('pendiente@usuarios.test') returning id`,
    )
    await db.admin(`update auth.users set raw_app_meta_data = raw_app_meta_data || $2 where id = $1`, [
      row.id,
      JSON.stringify({ username: 'mgarcia', first_name: 'Marta', last_name: 'García', app_role: 'ADMIN' }),
    ])
    const [profile] = await db.admin(
      'select username, first_name, app_role, is_active, setup_pending from public.profiles where id = $1',
      [row.id],
    )
    expect(profile).toEqual({
      username: 'mgarcia',
      first_name: 'Marta',
      app_role: 'ADMIN',
      is_active: true,
      setup_pending: false,
    })
  })

  it('a un usuario desactivado no lo reactiva ningún cambio en sus metadatos', async () => {
    const id = await createUser(db, 'desactivado')
    await db.admin('update public.profiles set is_active = false where id = $1', [id])
    await db.admin(
      `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"providers":["email"]}' where id = $1`,
      [id],
    )
    const [profile] = await db.admin('select is_active from public.profiles where id = $1', [id])
    expect(profile).toEqual({ is_active: false })
  })
})

describe('maestros por RPC', () => {
  it('el alta queda auditada con el rol y el sector de quien la hizo', async () => {
    const [created] = await db.as<{ id: string }>(u.compras1, `select public.master_save('supplier', $1, $2) as id`, [
      a.id,
      { code: 'prv-020 ', legal_name: 'Maderas del Sur', company_id: b.id, is_active: false },
    ])
    const [row] = await db.admin<{ company_id: string; code: string; is_active: boolean }>(
      'select company_id, code, is_active from public.suppliers where id = $1',
      [created.id],
    )
    // Se ignoran las columnas no editables (empresa, estado): no se puede colar datos en otra empresa.
    expect(row).toEqual({ company_id: a.id, code: 'PRV-020', is_active: true })
    const [event] = await db.admin<{
      action: string
      actor_role_code: string
      actor_sector_name: string
      summary: string
    }>(
      `select action, actor_role_code, actor_sector_name, summary from public.audit_events
        where entity_id = $1 order by id desc limit 1`,
      [created.id],
    )
    expect(event).toEqual({
      action: 'CREATE',
      actor_role_code: 'COMPRAS',
      actor_sector_name: 'Compras',
      summary: 'Dio de alta el proveedor PRV-020 Maderas del Sur',
    })
  })

  it('código repetido, nombre vacío y proveedor de otra empresa se rechazan con un mensaje claro', async () => {
    const dup = await businessError(
      db.as(u.compras1, `select public.master_save('supplier', $1, $2)`, [
        a.id,
        { code: 'PRV-001', legal_name: 'Repetido' },
      ]),
    )
    expect(dup).toMatchObject({ code: 'DATO_INVALIDO', message: 'Ya existe un proveedor con el código PRV-001.' })
    const foreign = await createSupplier(db, b, 'PRV-901')
    const product = await businessError(
      db.as(u.compras1, `select public.master_save('product', $1, $2)`, [
        a.id,
        { code: 'MP-100', name: 'Tabla', product_type: 'MATERIA_PRIMA', uom_code: 'UN', default_supplier_id: foreign },
      ]),
    )
    expect(product.message).toBe('El proveedor habitual no existe en esta empresa.')
  })

  it('una modificación audita sólo los campos que cambiaron', async () => {
    const supplierId = await createSupplier(db, a, 'PRV-030', 'Herrajes Norte')
    await db.as(u.compras1, `select public.master_save('supplier', $1, $2)`, [
      a.id,
      { id: supplierId, code: 'PRV-030', legal_name: 'Herrajes Norte', category: 'Herrajes' },
    ])
    const [event] = await db.admin<{ action: string; changes: Record<string, unknown> }>(
      `select action, changes from public.audit_events where entity_id = $1 order by id desc limit 1`,
      [supplierId],
    )
    expect(event.action).toBe('UPDATE')
    expect(Object.keys(event.changes)).toEqual(['category'])
  })

  it('un producto de servicio no maneja stock', async () => {
    const [created] = await db.as<{ id: string }>(u.docente, `select public.master_save('product', $1, $2) as id`, [
      a.id,
      { code: 'SV-001', name: 'Flete', product_type: 'SERVICIO', uom_code: 'UN' },
    ])
    const [row] = await db.admin<{ is_stockable: boolean }>('select is_stockable from public.products where id = $1', [
      created.id,
    ])
    expect(row.is_stockable).toBe(false)
    await createProduct(db, a, 'MP-001')
  })
})

describe('panel docente', () => {
  it('sólo el docente asigna roles, y no puede quitarse a sí mismo el de supervisor', async () => {
    expect(
      (
        await businessError(
          db.as(u.compras1, `select public.member_assign_role($1, $2, 'GERENCIA')`, [a.id, u.compras1]),
        )
      ).code,
    ).toBe('SIN_PERMISO')
    await db.as(u.docente, `select public.member_assign_role($1, $2, 'GERENCIA', $3)`, [a.id, u.compras2, a.sector.GER])
    const [ctx] = await db.as<{ ctx: { roles: { role_code: string; sector_name: string }[] } }>(
      u.compras2,
      `select public.company_context('empresa-a') as ctx`,
    )
    expect(ctx.ctx.roles.map((r) => `${r.role_code}:${r.sector_name}`).sort()).toEqual([
      'COMPRAS:Compras',
      'GERENCIA:Gerencia',
    ])
    const [own] = await db.admin<{ id: string }>(
      `select mr.id from public.member_roles mr join public.company_members m on m.id = mr.member_id
        where m.user_id = $1 and mr.role_code = 'DOCENTE'`,
      [u.docente],
    )
    expect(
      (await businessError(db.as(u.docente, `select public.member_remove_role($1, $2)`, [a.id, own.id]))).message,
    ).toBe('No podés quitarte tu propio rol de supervisor.')
  })
})
