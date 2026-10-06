// Imitación de los servicios HTTP de Supabase sobre la base de prueba (PGlite):
// PostgREST (sólo RPC), Auth (sesiones y administración de cuentas) y la Edge
// Function "admin-users" detrás del control de JWT. Permite probar el
// adaptador de la interfaz (src/lib/api/supabase.ts) y la función sin red.
//
// Reproduce lo que importa del original: errores de PostgREST con el mismo
// formato y código HTTP, tokens que vencen y se renuevan (rotando el de
// renovación), y la API de administración que exige la clave de servicio.

import { handle } from '../../functions/admin-users/handler'
import type { TestDb } from './db'

export const SUPABASE_URL = 'https://instancia.test'
export const PUBLIC_KEY = 'sb_publishable_prueba'
export const SERVICE_KEY = 'sb_secret_prueba'

export interface FakeSupabase {
  fetch: typeof fetch
  /** Contraseña vigente de cada cuenta (id de auth.users). */
  passwords: Map<string, string>
  /** Duración de los tokens de acceso, en segundos. */
  tokenTtl: number
  /** Pedidos recibidos ("POST /rest/v1/rpc/my_context"). */
  log: string[]
  /** Hace fallar la enésima creación de cuenta siguiente (para probar que no quedan altas a medias). */
  failAccountCreation: number | null
  /** Vence todos los tokens de acceso emitidos hasta ahora. */
  expireAccessTokens(): void
  /** Invalida todos los tokens de renovación (como cerrar todas las sesiones). */
  revokeRefreshTokens(): void
}

type Json = Record<string, unknown>

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export function createFakeSupabase(db: TestDb, emailDomain: string): FakeSupabase {
  const access = new Map<string, { user: string; expires: number }>()
  const refresh = new Map<string, string>()
  let serial = 0

  function issue(user: string, email: string) {
    serial++
    const accessToken = `at.${user}.${serial}`
    const refreshToken = `rt.${user}.${serial}`
    const now = Math.floor(Date.now() / 1000)
    access.set(accessToken, { user, expires: now + fake.tokenTtl })
    refresh.set(refreshToken, user)
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: fake.tokenTtl,
      expires_at: now + fake.tokenTtl,
      refresh_token: refreshToken,
      user: { id: user, email },
    }
  }

  /** Usuario del token Bearer: null sin token; undefined si es inválido o venció. */
  function bearer(req: Request): string | null | undefined {
    const header = req.headers.get('Authorization')
    if (!header) return null
    const token = access.get(header.replace(/^Bearer\s+/, ''))
    if (!token || token.expires <= Math.floor(Date.now() / 1000)) return undefined
    return token.user
  }

  const emailOf = async (user: string) =>
    (await db.admin<{ email: string }>('select email from auth.users where id = $1', [user]))[0]?.email ?? ''

  async function rpc(fn: string, req: Request) {
    if (req.headers.get('apikey') !== PUBLIC_KEY) return reply(401, { message: 'Invalid API key' })
    const user = bearer(req)
    if (user === undefined) return reply(401, { code: 'PGRST301', message: 'JWT expired', details: null, hint: null })
    const routine = await db.admin<{ data_type: string }>(
      `select data_type from information_schema.routines where routine_schema = 'public' and routine_name = $1`,
      [fn],
    )
    if (!routine.length) return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn}` })
    const params = await db.admin<{ name: string; data_type: string; udt_name: string }>(
      `select p.parameter_name as name, p.data_type, p.udt_name
         from information_schema.routines r
         join information_schema.parameters p on p.specific_schema = r.specific_schema and p.specific_name = r.specific_name
        where r.routine_schema = 'public' and r.routine_name = $1 and p.parameter_mode = 'IN'
        order by p.ordinal_position`,
      [fn],
    )
    const args = ((await req.json().catch(() => ({}))) ?? {}) as Json
    const named: string[] = []
    for (const key of Object.keys(args)) {
      const p = params.find((x) => x.name === key)
      if (!p) return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn}(${key})` })
      const value = `($1::jsonb -> '${key}')`
      named.push(
        `${key} => ${
          p.udt_name === 'jsonb'
            ? value
            : p.data_type === 'ARRAY'
              ? `case when jsonb_typeof(${value}) = 'array' then array(select jsonb_array_elements_text(${value}))::${p.udt_name.slice(1)}[] end`
              : `($1::jsonb ->> '${key}')::${p.udt_name}`
        }`,
      )
    }
    const call = `public.${fn}(${named.join(', ')})`
    const sql = routine[0].data_type === 'void' ? `select ${call}` : `select to_jsonb(${call}) as r`
    const values = named.length ? [JSON.stringify(args)] : []
    try {
      const rows = user ? await db.as<{ r: unknown }>(user, sql, values) : await db.anon<{ r: unknown }>(sql, values)
      return routine[0].data_type === 'void' ? new Response(null, { status: 204 }) : reply(200, rows[0].r ?? null)
    } catch (error) {
      const e = error as { code?: string; message: string; detail?: string; hint?: string }
      const status =
        e.code === 'P0001' ? 400 : e.code === '42501' ? (user ? 403 : 401) : e.code?.startsWith('22') ? 400 : 500
      return reply(status, { code: e.code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null })
    }
  }

  async function auth(path: string, req: Request) {
    const url = new URL(req.url)
    const body = ((await req.json().catch(() => ({}))) ?? {}) as Json
    if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const [account] = await db.admin<{ id: string }>('select id from auth.users where email = $1', [body.email])
      if (!account || fake.passwords.get(account.id) !== body.password)
        return reply(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
      return reply(200, issue(account.id, String(body.email)))
    }
    if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const user = refresh.get(String(body.refresh_token))
      if (!user) return reply(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' })
      refresh.delete(String(body.refresh_token)) // rotación: cada token de renovación se usa una vez
      return reply(200, issue(user, await emailOf(user)))
    }
    if (path === '/auth/v1/logout') {
      const user = bearer(req)
      if (user) for (const [token, owner] of refresh) if (owner === user) refresh.delete(token)
      return new Response(null, { status: 204 })
    }
    if (path === '/auth/v1/user' && req.method === 'PUT') {
      const user = bearer(req)
      if (!user) return reply(401, { code: 401, msg: 'Invalid JWT' })
      fake.passwords.set(user, String(body.password))
      return reply(200, { id: user })
    }
    // API de administración: sólo con la clave de servicio.
    if (path.startsWith('/auth/v1/admin/users')) {
      if (req.headers.get('apikey') !== SERVICE_KEY) return reply(401, { code: 401, msg: 'Invalid API key' })
      const id = path.split('/')[5]
      if (!id && req.method === 'POST') {
        if (fake.failAccountCreation !== null && --fake.failAccountCreation <= 0) {
          fake.failAccountCreation = null
          return reply(500, { code: 500, msg: 'Database error creating new user' })
        }
        const exists = await db.admin('select 1 from auth.users where email = $1', [body.email])
        if (exists.length)
          return reply(422, {
            code: 422,
            error_code: 'email_exists',
            msg: 'A user with this email address has already been registered',
          })
        const [row] = await db.admin<{ id: string }>(
          'insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id',
          [body.email, JSON.stringify(body.app_metadata ?? {})],
        )
        fake.passwords.set(row.id, String(body.password))
        return reply(200, { id: row.id, email: body.email, app_metadata: body.app_metadata })
      }
      if (id && req.method === 'PUT') {
        const exists = await db.admin('select 1 from auth.users where id = $1', [id])
        if (!exists.length) return reply(404, { code: 404, msg: 'User not found' })
        if (typeof body.password === 'string') fake.passwords.set(id, body.password)
        return reply(200, { id })
      }
      if (id && req.method === 'DELETE') {
        await db.admin('delete from auth.users where id = $1', [id])
        fake.passwords.delete(id)
        return reply(200, {})
      }
    }
    return reply(404, { msg: 'Not found' })
  }

  async function route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    fake.log.push(`${req.method} ${path}`)
    if (path.startsWith('/rest/v1/rpc/')) return rpc(path.slice('/rest/v1/rpc/'.length), req)
    if (path.startsWith('/auth/v1/')) return auth(path, req)
    if (path === '/functions/v1/admin-users') {
      // Supabase verifica el JWT antes de invocar la función (verify_jwt).
      if (req.method !== 'OPTIONS' && !bearer(req)) return reply(401, { code: 401, message: 'Invalid JWT' })
      return handle(req, { url: SUPABASE_URL, publicKey: PUBLIC_KEY, serviceKey: SERVICE_KEY, emailDomain }, fake.fetch)
    }
    return reply(404, { message: 'Not found' })
  }

  const fake: FakeSupabase = {
    fetch: async (input, init) => route(new Request(input, init)),
    passwords: new Map(),
    tokenTtl: 3600,
    log: [],
    failAccountCreation: null,
    expireAccessTokens() {
      for (const token of access.values()) token.expires = 0
    },
    revokeRefreshTokens() {
      refresh.clear()
    },
  }
  return fake
}
