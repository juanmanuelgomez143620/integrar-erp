// Las migraciones se aplican de punta a punta sobre una base vacía, y los
// catálogos de la base coinciden con src/lib/domain/catalog.ts (la fuente que
// usa la interfaz): si alguien cambia uno sin regenerar el otro, esta prueba falla.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DOC_STATUSES,
  DOC_TYPES,
  POSTING_EVENTS,
  ROLE_PERMISSIONS,
  ROLES,
  TASK_RULES,
  TRANSITIONS,
} from '../../src/lib/domain/catalog'
import { createTestDb, type TestDb } from './support/db'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('catálogos del sistema', () => {
  it('roles y matriz rol → permiso iguales a catalog.ts', async () => {
    const roles = await db.admin<{ code: string; is_supervisor: boolean }>(
      'select code, is_supervisor from public.roles',
    )
    expect(roles.map((r) => r.code).sort()).toEqual(Object.keys(ROLES).sort())
    expect(roles.find((r) => r.code === 'DOCENTE')?.is_supervisor).toBe(true)
    const pairs = await db.admin<{ role_code: string; permission_code: string }>(
      'select role_code, permission_code from public.role_permissions',
    )
    const expected = Object.entries(ROLE_PERMISSIONS).flatMap(([role, perms]) => perms.map((p) => `${role}:${p}`))
    expect(pairs.map((p) => `${p.role_code}:${p.permission_code}`).sort()).toEqual(expected.sort())
  })

  it('tipos, estados, transiciones y reglas de tareas iguales a catalog.ts', async () => {
    const types = await db.admin<{ code: string }>('select code from public.document_types')
    expect(types.map((t) => t.code).sort()).toEqual(Object.keys(DOC_TYPES).sort())
    const statuses = await db.admin<{ doc_type: string; code: string }>(
      'select doc_type, code from public.document_statuses',
    )
    const expectedStatuses = Object.entries(DOC_STATUSES).flatMap(([t, map]) =>
      Object.keys(map).map((s) => `${t}:${s}`),
    )
    expect(statuses.map((s) => `${s.doc_type}:${s.code}`).sort()).toEqual(expectedStatuses.sort())
    const transitions = await db.admin<{ n: number }>('select count(*)::int as n from public.document_transitions')
    expect(transitions[0].n).toBe(TRANSITIONS.length)
    const rules = await db.admin<{ n: number }>('select count(*)::int as n from public.task_rules')
    expect(rules[0].n).toBe(TASK_RULES.length)
  })

  it('eventos y claves de la imputación automática iguales a catalog.ts, en el mismo orden', async () => {
    const keys = await db.admin<{ event: string; key: string; key_label: string }>(
      'select event, key, key_label from public.posting_keys order by sort',
    )
    expect(keys.map((k) => `${k.event}/${k.key}: ${k.key_label}`)).toEqual(
      Object.entries(POSTING_EVENTS).flatMap(([event, e]) =>
        Object.entries(e.keys).map(([key, label]) => `${event}/${key}: ${label}`),
      ),
    )
  })
})
