// Edge Function "admin-users" de punta a punta: la función real (handler.ts)
// detrás de una imitación de Auth y PostgREST sobre PGlite. Comprueba que las
// cuentas quedan creadas en Auth con sus datos, que la base registra membresía
// y auditoría, y que ante cualquier falla no quedan cuentas a medias.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_AUTH_EMAIL_DOMAIN } from '../../src/lib/domain/accounts'
import { DEFAULT_EMAIL_DOMAIN, initialPassword } from '../functions/admin-users/handler'
import { createTestDb, type TestDb } from './support/db'
import { createFakeSupabase, PUBLIC_KEY, SUPABASE_URL, type FakeSupabase } from './support/fake-supabase'
import { addMember, createCompany, createUser, seedSchool, type TestCompany } from './support/fixtures'

const DOMAIN = 'usuarios.test' // el de createUser
let db: TestDb
let fake: FakeSupabase
let a: TestCompany
const u: Record<string, string> = {}

async function token(username: string, password = 'demo1234') {
  const res = await fake.fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${username}@${DOMAIN}`, password }),
  })
  return res.ok ? ((await res.json()) as { access_token: string }).access_token : null
}

async function edge(username: string | null, body: unknown) {
  const auth = username ? await token(username) : null
  const res = await fake.fetch(`${SUPABASE_URL}/functions/v1/admin-users`, {
    method: 'POST',
    headers: {
      apikey: PUBLIC_KEY,
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[] }
}

const accounts = async () => Number((await db.admin<{ n: number }>('select count(*)::int as n from auth.users'))[0].n)

beforeAll(async () => {
  db = await createTestDb()
  fake = createFakeSupabase(db, DOMAIN)
  await seedSchool(db)
  a = await createCompany(db, 'empresa-a')
  for (const [name, role] of [
    ['admin', 'ADMIN'],
    ['docente', 'DOCENTE'],
    ['colega', 'DOCENTE'],
    ['alumno', 'ESTUDIANTE'],
  ] as const) {
    u[name] = await createUser(db, name, role)
    fake.passwords.set(u[name], 'demo1234')
  }
  await addMember(db, a, u.docente, [['DOCENTE', null]])
  await addMember(db, a, u.colega, [['DOCENTE', null]])
  await addMember(db, a, u.alumno, [['COMPRAS', 'COM']])
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('alta masiva de estudiantes', () => {
  it('crea las cuentas en Auth, las suma a la empresa y devuelve usuarios y contraseñas para imprimir', async () => {
    const rows = [
      { first_name: 'Juan Manuel', last_name: 'Gómez Paz' },
      { first_name: 'Josefina', last_name: 'Gómez' },
      { first_name: 'Lucía', last_name: 'Benítez' },
    ]
    const { status, body } = await edge('docente', { action: 'create_students_bulk', company_id: a.id, rows })
    expect(status).toBe(200)
    expect((body as unknown as { username: string }[]).map((c) => c.username)).toEqual([
      'jgomez',
      'jgomez2',
      'lbenitez',
    ])
    for (const c of body as unknown as { user_id: string; username: string; password: string }[]) {
      expect(c.password).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/)
      const [profile] = await db.admin('select app_role, must_change_password from public.profiles where id = $1', [
        c.user_id,
      ])
      expect(profile).toEqual({ app_role: 'ESTUDIANTE', must_change_password: true })
      const [member] = await db.admin(
        'select 1 as ok from public.company_members where company_id = $1 and user_id = $2',
        [a.id, c.user_id],
      )
      expect(member).toEqual({ ok: 1 })
      // Cada estudiante entra con lo impreso.
      expect(await token(c.username, c.password)).not.toBeNull()
    }
    const audit = await db.admin<{ summary: string }>(
      `select summary from public.audit_events where action = 'CREATE' and entity_type = 'profile' order by id`,
    )
    expect(audit.map((e) => e.summary)).toEqual([
      'Dio de alta al estudiante Juan Manuel Gómez Paz (jgomez)',
      'Dio de alta al estudiante Josefina Gómez (jgomez2)',
      'Dio de alta al estudiante Lucía Benítez (lbenitez)',
    ])
  })

  it('valida toda la lista antes de crear a nadie', async () => {
    const before = await accounts()
    const { status, body } = await edge('docente', {
      action: 'create_students_bulk',
      company_id: a.id,
      rows: [
        { first_name: 'Ana', last_name: 'Sosa' },
        { first_name: 'B', last_name: 'Ruiz' },
      ],
    })
    expect(status).toBe(400)
    expect(body).toMatchObject({
      code: 'DATO_INVALIDO',
      message: 'Fila 2: el apellido y el nombre deben tener al menos 2 letras.',
    })
    expect(await accounts()).toBe(before)
  })

  it('si Auth falla a mitad de camino, borra las cuentas ya creadas', async () => {
    const before = await accounts()
    fake.failAccountCreation = 2
    const { status, body } = await edge('docente', {
      action: 'create_students_bulk',
      company_id: a.id,
      rows: [
        { first_name: 'Carla', last_name: 'Ríos' },
        { first_name: 'Diego', last_name: 'Luna' },
      ],
    })
    expect(status).toBe(500)
    expect(body.code).toBe('ERROR_AUTH')
    expect(await accounts()).toBe(before)
    expect(await db.admin(`select 1 from public.profiles where username in ('crios', 'dluna')`)).toEqual([])
  })

  it('sólo un supervisor de la empresa', async () => {
    const { status, body } = await edge('alumno', {
      action: 'create_students_bulk',
      company_id: a.id,
      rows: [{ first_name: 'Ana', last_name: 'Sosa' }],
    })
    expect(status).toBe(400)
    expect(body.code).toBe('SIN_PERMISO')
  })
})

describe('alta individual', () => {
  it('con el usuario y la contraseña que elige el docente', async () => {
    const { status, body } = await edge('docente', {
      action: 'create_student',
      company_id: a.id,
      first_name: ' Sofía ',
      last_name: 'Acosta',
      username: 'SAcosta',
      password: 'inicial12',
    })
    expect(status).toBe(200)
    const [profile] = await db.admin('select username, first_name, last_name from public.profiles where id = $1', [
      body.id,
    ])
    expect(profile).toEqual({ username: 'sacosta', first_name: 'Sofía', last_name: 'Acosta' })
    expect(await token('sacosta', 'inicial12')).not.toBeNull()
  })

  it('mismos controles que el simulador: usuario repetido y contraseña corta', async () => {
    const repeated = await edge('docente', {
      action: 'create_student',
      company_id: a.id,
      first_name: 'Otra',
      last_name: 'Acosta',
      username: 'sacosta',
      password: 'inicial12',
    })
    expect(repeated.body).toMatchObject({ code: 'DATO_INVALIDO', message: 'El usuario sacosta ya existe.' })
    const short = await edge('docente', {
      action: 'create_student',
      company_id: a.id,
      first_name: 'Pablo',
      last_name: 'Díaz',
      username: 'pdiaz',
      password: '123',
    })
    expect(short.body).toMatchObject({
      code: 'DATO_INVALIDO',
      message: 'La contraseña inicial debe tener al menos 6 caracteres.',
    })
    expect(await db.admin(`select 1 from public.profiles where username = 'pdiaz'`)).toEqual([])
  })
})

describe('restablecer contraseña', () => {
  it('el docente le pone una contraseña temporal a un estudiante, que deberá cambiarla', async () => {
    const { status } = await edge('docente', {
      action: 'reset_password',
      company_id: a.id,
      user_id: u.alumno,
      password: 'temporal99',
    })
    expect(status).toBe(200)
    expect(await token('alumno', 'demo1234')).toBeNull()
    expect(await token('alumno', 'temporal99')).not.toBeNull()
    const [profile] = await db.admin('select must_change_password from public.profiles where id = $1', [u.alumno])
    expect(profile).toEqual({ must_change_password: true })
    fake.passwords.set(u.alumno, 'demo1234')
  })

  it('nunca la de otro docente; con una contraseña corta no cambia nada', async () => {
    const colleague = await edge('docente', {
      action: 'reset_password',
      company_id: a.id,
      user_id: u.colega,
      password: 'tomada99',
    })
    expect(colleague.body).toMatchObject({
      code: 'SIN_PERMISO',
      message: 'Sólo se puede restablecer la contraseña de un estudiante.',
    })
    expect(await token('colega', 'demo1234')).not.toBeNull()
    const short = await edge('docente', {
      action: 'reset_password',
      company_id: a.id,
      user_id: u.alumno,
      password: '12',
    })
    expect(short.body).toMatchObject({
      code: 'DATO_INVALIDO',
      message: 'La contraseña debe tener al menos 6 caracteres.',
    })
    expect(await token('alumno', 'demo1234')).not.toBeNull()
  })
})

describe('alta de docentes', () => {
  it('la administración de la escuela crea la cuenta; nadie más puede', async () => {
    const created = await edge('admin', {
      action: 'create_teacher',
      first_name: 'Marina',
      last_name: 'Testigo',
      username: 'mtestigo',
      password: 'inicial12',
    })
    expect(created.status).toBe(200)
    const [profile] = await db.admin('select app_role from public.profiles where id = $1', [created.body.id])
    expect(profile).toEqual({ app_role: 'DOCENTE' })
    const denied = await edge('docente', {
      action: 'create_teacher',
      first_name: 'Otro',
      last_name: 'Docente',
      username: 'odocente',
      password: 'inicial12',
    })
    expect(denied.body.code).toBe('SIN_PERMISO')
  })
})

describe('protocolo', () => {
  it('sin sesión no llega a la función; responde la verificación previa de CORS', async () => {
    expect((await edge(null, { action: 'create_teacher' })).status).toBe(401)
    const preflight = await fake.fetch(`${SUPABASE_URL}/functions/v1/admin-users`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(200)
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('authorization')
    expect((await edge('docente', { action: 'borrar_todo' })).body).toMatchObject({ code: 'DATO_INVALIDO' })
  })

  it('contraseñas iniciales legibles y el mismo dominio de cuentas que el sitio', () => {
    for (let i = 0; i < 50; i++) expect(initialPassword()).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/)
    expect(DEFAULT_EMAIL_DOMAIN).toBe(DEFAULT_AUTH_EMAIL_DOMAIN)
  })
})
