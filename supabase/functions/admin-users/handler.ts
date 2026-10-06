// Lógica de la Edge Function "admin-users": altas de cuentas y contraseñas,
// que sólo se pueden hacer con la API de administración de Supabase Auth (con
// la clave de servicio, que nunca llega al navegador).
//
// Cada acción valida primero en la base con la sesión de quien la pide (las
// mismas reglas y mensajes que el motor simulado: ver
// supabase/migrations/20261003191400_accounts.sql), después crea o modifica la
// cuenta en Auth y por último registra membresía y auditoría. Si algo falla
// después de crear cuentas, se borran: no quedan altas a medias.
//
// Sólo usa APIs web estándar (Request, Response, fetch, crypto), así se prueba
// en Node contra PGlite (supabase/tests/admin-users.test.ts) y corre en Deno.

export interface Env {
  /** SUPABASE_URL */
  url: string
  /** Clave publicable (o anon): llamadas a la base con la sesión de quien opera. */
  publicKey: string
  /** Clave de servicio: sólo para la API de administración de Auth. */
  serviceKey: string
  /** Dominio sintético de las cuentas (usuario@dominio): igual al del sitio. */
  emailDomain: string
}

/** Igual que DEFAULT_AUTH_EMAIL_DOMAIN en src/lib/domain/accounts.ts (una prueba lo verifica). */
export const DEFAULT_EMAIL_DOMAIN = 'cuentas.integrar.invalid'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

class Failure extends Error {
  status: number
  code: string
  hint?: string
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message)
    this.status = status
    this.code = code
    this.hint = hint
  }
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

/** Sin 0/O ni 1/l/I: la contraseña inicial se lee de un papel impreso (igual que initialPassword del motor). */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function initialPassword(): string {
  const chars: string[] = []
  const limit = 256 - (256 % PASSWORD_ALPHABET.length)
  while (chars.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && chars.length < 8) chars.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length])
    }
  }
  return chars.join('')
}

interface Person {
  first_name: string
  last_name: string
  username: string
}

export async function handle(req: Request, env: Env, http: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return reply(405, { code: 'METODO', message: 'Usá POST.' })
  const authorization = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(authorization))
    return reply(401, { code: 'SIN_SESION', message: 'Tu sesión terminó. Volvé a ingresar.' })

  // Base de datos con la sesión de quien opera: valida permisos y audita a su nombre.
  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await http(`${env.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: env.publicKey, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (res.ok) return data as T
    if (data?.code === 'P0001') throw new Failure(400, data.details ?? 'ERROR', data.message, data.hint ?? undefined)
    if (res.status === 401) throw new Failure(401, 'SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
    throw new Failure(500, 'ERROR_BASE', data?.message ?? 'La base de datos no respondió como se esperaba.')
  }

  // API de administración de Auth (clave de servicio).
  const adminHeaders: Record<string, string> = { apikey: env.serviceKey, 'Content-Type': 'application/json' }
  // Las claves heredadas son JWT y van también como Bearer; las nuevas (sb_secret_…) sólo como apikey.
  if (env.serviceKey.split('.').length === 3) adminHeaders.Authorization = `Bearer ${env.serviceKey}`

  async function createAccount(person: Person, appRole: 'ESTUDIANTE' | 'DOCENTE', password: string): Promise<string> {
    const res = await http(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: `${person.username}@${env.emailDomain}`,
        password,
        email_confirm: true,
        // El perfil nace de estos datos (private.handle_new_user); el usuario no puede modificarlos.
        app_metadata: {
          username: person.username,
          first_name: person.first_name,
          last_name: person.last_name,
          app_role: appRole,
          must_change_password: true,
        },
      }),
    })
    const data = await res.json().catch(() => null)
    if (res.ok && data?.id) return data.id as string
    if (res.status === 422 && /already|exists|registered/i.test(String(data?.msg ?? data?.message ?? data?.error_code)))
      throw new Failure(400, 'DATO_INVALIDO', `El usuario ${person.username} ya existe.`)
    throw new Failure(500, 'ERROR_AUTH', `No se pudo crear la cuenta de ${person.username}.`)
  }

  async function setPassword(userId: string, password: string) {
    const res = await http(`${env.url}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ password }),
    })
    if (!res.ok) throw new Failure(500, 'ERROR_AUTH', 'No se pudo cambiar la contraseña.')
  }

  async function removeAccounts(ids: string[]) {
    await Promise.allSettled(
      ids.map((id) => http(`${env.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders })),
    )
  }

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const text = (key: string) => (typeof body?.[key] === 'string' ? (body[key] as string) : '')
    switch (body?.action) {
      // Alta individual (cmdCreateStudent): el docente elige usuario y contraseña inicial.
      case 'create_student': {
        const company = text('company_id')
        const username = await rpc<string>('student_check', {
          p_company_id: company,
          p_first_name: text('first_name'),
          p_last_name: text('last_name'),
          p_username: text('username'),
        })
        const password = text('password')
        if (password.length < 6)
          throw new Failure(400, 'DATO_INVALIDO', 'La contraseña inicial debe tener al menos 6 caracteres.')
        const person = { first_name: text('first_name').trim(), last_name: text('last_name').trim(), username }
        const id = await createAccount(person, 'ESTUDIANTE', password)
        try {
          await rpc('students_register', { p_company_id: company, p_user_ids: [id] })
        } catch (error) {
          await removeAccounts([id])
          throw error
        }
        return reply(200, { id })
      }

      // Alta masiva (cmdCreateStudentsBulk): usuarios y contraseñas iniciales para imprimir.
      case 'create_students_bulk': {
        const company = text('company_id')
        const plan = await rpc<Person[]>('students_plan', { p_company_id: company, p_rows: body.rows ?? [] })
        const created: (Person & { user_id: string; password: string })[] = []
        try {
          for (const person of plan) {
            const password = initialPassword()
            created.push({ user_id: await createAccount(person, 'ESTUDIANTE', password), ...person, password })
          }
          await rpc('students_register', { p_company_id: company, p_user_ids: created.map((c) => c.user_id) })
        } catch (error) {
          await removeAccounts(created.map((c) => c.user_id))
          throw error
        }
        return reply(
          200,
          created.map((c) => ({
            user_id: c.user_id,
            first_name: c.first_name,
            last_name: c.last_name,
            username: c.username,
            password: c.password,
          })),
        )
      }

      // Restablecer la contraseña de un estudiante de la empresa (cmdResetPassword).
      case 'reset_password': {
        const args = { p_company_id: text('company_id'), p_user_id: text('user_id') }
        await rpc('member_password_check', args)
        const password = text('password')
        if (password.length < 6)
          throw new Failure(400, 'DATO_INVALIDO', 'La contraseña debe tener al menos 6 caracteres.')
        await setPassword(args.p_user_id, password)
        await rpc('member_password_reset', args)
        return reply(200, {})
      }

      // Alta de un docente por la administración de la escuela (cmdCreateTeacher).
      case 'create_teacher': {
        const username = await rpc<string>('teacher_check', {
          p_first_name: text('first_name'),
          p_last_name: text('last_name'),
          p_username: text('username'),
        })
        const password = text('password')
        if (password.length < 6)
          throw new Failure(400, 'DATO_INVALIDO', 'La contraseña inicial debe tener al menos 6 caracteres.')
        const person = { first_name: text('first_name').trim(), last_name: text('last_name').trim(), username }
        const id = await createAccount(person, 'DOCENTE', password)
        try {
          await rpc('teacher_register', { p_user_id: id })
        } catch (error) {
          await removeAccounts([id])
          throw error
        }
        return reply(200, { id })
      }

      default:
        throw new Failure(400, 'DATO_INVALIDO', 'Acción desconocida.')
    }
  } catch (error) {
    if (error instanceof Failure)
      return reply(error.status, { code: error.code, message: error.message, hint: error.hint ?? null })
    return reply(500, { code: 'ERROR', message: 'Ocurrió un error inesperado al administrar las cuentas.' })
  }
}
