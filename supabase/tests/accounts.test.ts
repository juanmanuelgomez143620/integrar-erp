// Cuentas de usuario en la base: lo que la Edge Function "admin-users" valida
// y registra antes y después de crear o modificar la cuenta en Auth (acá, un
// insert en auth.users hace de Auth). Mismos usuarios y mensajes que el motor
// simulado y que src/lib/domain/students.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_BULK_STUDENTS, baseUsername, uniqueUsername } from '../../src/lib/domain/students'
import { businessError, createTestDb, type TestDb } from './support/db'
import { addMember, createCompany, createUser, seedSchool, type TestCompany } from './support/fixtures'

let db: TestDb
let a: TestCompany
let b: TestCompany
const u: Record<string, string> = {}

/** Lo que hace Auth al crear la cuenta: el perfil nace del trigger con los datos de la aplicación. */
async function authCreate(username: string, first_name: string, last_name: string, app_role = 'ESTUDIANTE') {
  const [row] = await db.admin<{ id: string }>(
    `insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id`,
    [
      `${username}@usuarios.test`,
      JSON.stringify({ username, first_name, last_name, app_role, must_change_password: true }),
    ],
  )
  return row.id
}

const call = async <R = unknown>(user: string, fn: string, ...args: unknown[]) =>
  (await db.as<{ r: R }>(u[user], `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r

beforeAll(async () => {
  db = await createTestDb()
  await seedSchool(db)
  a = await createCompany(db, 'empresa-a')
  b = await createCompany(db, 'empresa-b')
  u.admin = await createUser(db, 'secretaria', 'ADMIN')
  u.soporte = await createUser(db, 'soporte', 'SUPERADMIN')
  u.docente = await createUser(db, 'docente', 'DOCENTE')
  u.colega = await createUser(db, 'colega', 'DOCENTE')
  u.otro = await createUser(db, 'otrodocente', 'DOCENTE')
  u.alumno = await createUser(db, 'alumno', 'ESTUDIANTE')
  await addMember(db, a, u.docente, [['DOCENTE', null]])
  await addMember(db, a, u.colega, [['DOCENTE', null]])
  await addMember(db, b, u.otro, [['DOCENTE', null]])
  await addMember(db, a, u.alumno, [['COMPRAS', 'COM']])
  // Usuarios que ya existen: el alta masiva tiene que esquivarlos.
  await authCreate('jgomez', 'Julia', 'Gómez')
  await authCreate('jgomez2', 'Javier', 'Gómez')
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('nombres de usuario', () => {
  it('la base arma el mismo usuario que la interfaz', async () => {
    const names: [string, string][] = [
      ['Juan Manuel', 'Gómez Paz'],
      ['Ñandú', 'Núñez'],
      ['Ana', "D'Angelo"],
      ['  María José ', '  De   La Fuente'],
      ['Ü', 'Müller'],
      ['Íñigo', 'Ávalos'],
      ['Al', 'X'],
      ['', ''],
    ]
    for (const [first, last] of names) {
      const [{ r }] = await db.admin<{ r: string }>('select private.base_username($1, $2) as r', [first, last])
      expect(r, `${first} ${last}`).toBe(baseUsername(first, last))
    }
  })

  it('agrega números a partir de 2 y nunca deja usuarios de menos de 3 caracteres', async () => {
    const cases: [string, string[]][] = [
      ['jgomez', []],
      ['jgomez', ['jgomez3']],
      ['al', []],
      ['', []],
      ['a'.repeat(40), []],
    ]
    const existing = new Set(['jgomez', 'jgomez2'])
    for (const [base, taken] of cases) {
      const [{ r }] = await db.admin<{ r: string }>('select private.unique_username($1, $2) as r', [base, taken])
      expect(r, base).toBe(uniqueUsername(base, new Set([...existing, ...taken])))
    }
  })
})

describe('alta de estudiantes', () => {
  it('alta masiva: valida la lista y elige usuarios únicos contra los existentes y entre sí', async () => {
    const rows = [
      { first_name: 'Juan Manuel', last_name: 'Gómez Paz' },
      { first_name: 'Josefina', last_name: 'Gómez' },
      { first_name: 'Lucía', last_name: 'Benítez' },
    ]
    const plan = await call<{ first_name: string; last_name: string; username: string }[]>(
      'docente',
      'students_plan',
      a.id,
      JSON.stringify(rows),
    )
    expect(plan.map((p) => p.username)).toEqual(['jgomez3', 'jgomez4', 'lbenitez'])
    // Validar no escribe nada.
    const [{ n }] = await db.admin<{ n: number }>(
      `select count(*)::int as n from public.profiles where username like 'jgomez%'`,
    )
    expect(n).toBe(2)
  })

  it('rechaza listas vacías, demasiado largas o con nombres cortos (indicando la fila)', async () => {
    expect((await businessError(call('docente', 'students_plan', a.id, '[]'))).message).toBe(
      'Pegá al menos un estudiante.',
    )
    const many = Array.from({ length: MAX_BULK_STUDENTS + 1 }, (_, i) => ({
      first_name: `Nombre${i}`,
      last_name: 'Apellido',
    }))
    expect((await businessError(call('docente', 'students_plan', a.id, JSON.stringify(many)))).message).toBe(
      `Se pueden dar de alta hasta ${MAX_BULK_STUDENTS} estudiantes por vez.`,
    )
    const short = [
      { first_name: 'Ana', last_name: 'Pérez' },
      { first_name: 'B', last_name: 'Sosa' },
    ]
    expect((await businessError(call('docente', 'students_plan', a.id, JSON.stringify(short)))).message).toBe(
      'Fila 2: el apellido y el nombre deben tener al menos 2 letras.',
    )
  })

  it('alta individual: mismos controles que el simulador', async () => {
    expect(await call('docente', 'student_check', a.id, 'Sofía', 'Acosta', '  SAcosta ')).toBe('sacosta')
    const cases: [string, string, string, string][] = [
      ['Sofía', 'Acosta', 'sa', 'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto o guion.'],
      ['Sofía', 'Acosta', 'jgomez', 'El usuario jgomez ya existe.'],
      ['S', 'Acosta', 'sacosta', 'Ingresá nombre y apellido.'],
    ]
    for (const [first, last, username, message] of cases)
      expect((await businessError(call('docente', 'student_check', a.id, first, last, username))).message).toBe(message)
  })

  it('sólo el docente de la empresa (o soporte) da de alta estudiantes', async () => {
    for (const user of ['alumno', 'admin', 'otro'])
      expect(
        (await businessError(call(user, 'students_plan', a.id, '[{"first_name":"Ana","last_name":"Sosa"}]'))).code,
        user,
      ).toBe('SIN_PERMISO')
    expect(await call('soporte', 'student_check', a.id, 'Ana', 'Sosa', 'asosa')).toBe('asosa')
    expect((await businessError(db.anon(`select public.students_plan($1, '[]')`, [a.id]))).code).toBe('SQL:42501')
  })

  it('registrar: incorpora a la empresa y audita a nombre del docente', async () => {
    const id = await authCreate('lbenitez', 'Lucía', 'Benítez')
    await call('docente', 'students_register', a.id, [id])
    const [member] = await db.admin(
      `select job_title, is_active from public.company_members where company_id = $1 and user_id = $2`,
      [a.id, id],
    )
    expect(member).toEqual({ job_title: '', is_active: true })
    const [event] = await db.admin<{ actor_user_id: string; actor_role_code: string; summary: string }>(
      `select actor_user_id, actor_role_code, summary from public.audit_events where entity_id = $1 and action = 'CREATE'`,
      [id],
    )
    expect(event).toEqual({
      actor_user_id: u.docente,
      actor_role_code: 'DOCENTE',
      summary: 'Dio de alta al estudiante Lucía Benítez (lbenitez)',
    })
    const [profile] = await db.admin(`select app_role, must_change_password from public.profiles where id = $1`, [id])
    expect(profile).toEqual({ app_role: 'ESTUDIANTE', must_change_password: true })
  })

  it('registrar sólo acepta estudiantes nuevos: no sirve para sumar cuentas ajenas a la empresa', async () => {
    expect((await businessError(call('docente', 'students_register', a.id, [u.alumno]))).code).toBe('DATO_INVALIDO')
    expect((await businessError(call('docente', 'students_register', a.id, [u.otro]))).code).toBe('DATO_INVALIDO')
    const fresh = await authCreate('nuevo', 'Nuevo', 'Alumno')
    expect((await businessError(call('otro', 'students_register', a.id, [fresh]))).code).toBe('SIN_PERMISO')
  })
})

describe('restablecer contraseña', () => {
  it('del estudiante de la empresa: lo obliga a cambiarla y queda auditado', async () => {
    await call('docente', 'member_password_check', a.id, u.alumno)
    await call('docente', 'member_password_reset', a.id, u.alumno)
    const [profile] = await db.admin(`select must_change_password from public.profiles where id = $1`, [u.alumno])
    expect(profile).toEqual({ must_change_password: true })
    const [event] = await db.admin<{ action: string; summary: string }>(
      `select action, summary from public.audit_events where entity_id = $1 and action = 'RESET_PASSWORD'`,
      [u.alumno],
    )
    expect(event.summary).toBe('Restableció la contraseña de alumno Prueba')
  })

  it('nunca la de otro docente, la de alguien de otra empresa ni sin ser supervisor', async () => {
    expect(await businessError(call('docente', 'member_password_check', a.id, u.colega))).toMatchObject({
      code: 'SIN_PERMISO',
      message: 'Sólo se puede restablecer la contraseña de un estudiante.',
    })
    expect((await businessError(call('docente', 'member_password_check', a.id, u.otro))).message).toBe(
      'El usuario no participa en esta empresa.',
    )
    expect((await businessError(call('alumno', 'member_password_reset', a.id, u.alumno))).code).toBe('SIN_PERMISO')
    expect((await businessError(call('otro', 'member_password_check', a.id, u.alumno))).code).toBe('SIN_PERMISO')
  })
})

describe('alta de docentes', () => {
  it('la administración de la escuela valida y registra; queda auditado sin empresa', async () => {
    expect(await call('admin', 'teacher_check', 'Marina', 'Testigo', 'mtestigo')).toBe('mtestigo')
    const id = await authCreate('mtestigo', 'Marina', 'Testigo', 'DOCENTE')
    await call('admin', 'teacher_register', id)
    const [event] = await db.admin(
      `select company_id, actor_role_code, summary from public.audit_events where entity_id = $1 and action = 'CREATE'`,
      [id],
    )
    expect(event).toEqual({
      company_id: null,
      actor_role_code: 'ADMIN',
      summary: 'Dio de alta al docente Marina Testigo (mtestigo)',
    })
  })

  it('nadie más da de alta docentes, y registrar exige una cuenta de docente', async () => {
    for (const user of ['docente', 'alumno'])
      expect((await businessError(call(user, 'teacher_check', 'Ana', 'Sosa', 'asosa'))).code, user).toBe('SIN_PERMISO')
    expect((await businessError(call('admin', 'teacher_register', u.alumno))).code).toBe('DATO_INVALIDO')
  })
})
