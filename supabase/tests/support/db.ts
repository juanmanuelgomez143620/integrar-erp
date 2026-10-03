// Banco de pruebas de la base: PGlite (PostgreSQL en WebAssembly) con la
// imitación de Supabase y todas las migraciones de supabase/migrations, en
// orden. Permite probar tablas, RLS y funciones RPC sin Docker, en local y en CI.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = join(import.meta.dirname, '..', '..')

export function migrationFiles(): string[] {
  const dir = join(root, 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(dir, f))
}

export interface TestDb {
  pg: PGlite
  /** Ejecuta como superusuario (preparación de datos de prueba). */
  admin<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>
  /** Ejecuta como un usuario autenticado de la app (rol authenticated + JWT con su id). */
  as<R = Record<string, unknown>>(userId: string, sql: string, params?: unknown[]): Promise<R[]>
  /** Ejecuta como visitante sin sesión (rol anon). */
  anon<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>
  close(): Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const pg = await PGlite.create()
  await pg.exec(readFileSync(join(import.meta.dirname, 'supabase-shim.sql'), 'utf8'))
  for (const file of migrationFiles()) {
    try {
      await pg.exec(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`Falló la migración ${file}: ${(error as Error).message}`, { cause: error })
    }
  }

  async function run<R>(setup: string, sql: string, params?: unknown[]): Promise<R[]> {
    await pg.exec(setup)
    try {
      return (await pg.query<R>(sql, params)).rows
    } finally {
      await pg.exec(`reset role; select set_config('request.jwt.claims', '', false);`)
    }
  }

  return {
    pg,
    admin: async (sql, params) => (await pg.query(sql, params)).rows as never,
    as: (userId, sql, params) =>
      run(
        `set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: userId, role: 'authenticated' })}', false);`,
        sql,
        params,
      ),
    anon: (sql, params) =>
      run(`set role anon; select set_config('request.jwt.claims', '{"role":"anon"}', false);`, sql, params),
    close: () => pg.close(),
  }
}

export interface BusinessErrorShape {
  code: string
  message: string
  hint?: string
}

/** Ejecuta y devuelve el error de negocio (código en DETAIL, como lo entrega PostgREST en "details"). */
export async function businessError(promise: Promise<unknown>): Promise<BusinessErrorShape> {
  try {
    await promise
  } catch (error) {
    const e = error as { detail?: string; message: string; hint?: string; code?: string }
    return { code: e.code === 'P0001' ? (e.detail ?? '') : `SQL:${e.code}`, message: e.message, hint: e.hint }
  }
  throw new Error('Se esperaba un error y la operación terminó bien')
}
