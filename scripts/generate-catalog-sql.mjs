// Genera los datos de los catálogos del sistema para Supabase a partir de
// src/lib/domain/catalog.ts, la misma fuente que usa la interfaz: roles,
// permisos, matriz rol → permiso, módulos, tipos y estados de documento,
// transiciones, reglas de tareas, unidades, tipos de movimiento de stock y
// claves de la imputación automática (posting_keys, desde la Fase 3).
//
// Uso: npm run db:catalog [-- nombre-de-archivo.sql]
// Sin argumento reescribe la última migración de catálogos (la de la Fase 6d.2).
// Una migración ya aplicada en alguna instancia no se reescribe: si cambian
// los catálogos después, se genera una nueva con otro nombre (el script es
// idempotente: inserta o actualiza, y reemplaza las tablas de correspondencias).

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

const root = join(import.meta.dirname, '..')
const target = process.argv[2] ?? '20261029120100_catalog_data_autorizacion_sueldos.sql'

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
})

/** Dirección de cada tipo de movimiento de stock (+ entra, − sale). */
const MOVEMENT_DIRECTION = {
  STOCK_INICIAL: 1,
  RECEPCION_COMPRA: 1,
  ANULACION_RECEPCION: -1,
  AJUSTE_POSITIVO: 1,
  AJUSTE_NEGATIVO: -1,
  DESPACHO_VENTA: -1,
  ANULACION_DESPACHO: 1,
  CONSUMO_PRODUCCION: -1,
  DEVOLUCION_PRODUCCION: 1,
  INGRESO_PRODUCCION: 1,
}

const sql = (value) =>
  value === null || value === undefined
    ? 'null'
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : `'${String(value).replace(/'/g, "''")}'`

function insert(table, rows) {
  const columns = Object.keys(rows[0])
  const values = rows.map((r) => `  (${columns.map((c) => sql(r[c])).join(', ')})`).join(',\n')
  return `insert into public.${table} (${columns.join(', ')}) values\n${values}`
}

/** Catálogos con clave: inserta o actualiza (otras tablas pueden referenciarlos). */
function upsert(table, key, rows) {
  const updates = Object.keys(rows[0]).filter((c) => !key.includes(c))
  return `${insert(table, rows)}\non conflict (${key.join(', ')}) do ${
    updates.length ? `update set ${updates.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'nothing'
  };\n`
}

/** Tablas de correspondencias (nadie las referencia): se reemplazan enteras. */
function replaceAll(table, rows) {
  return `delete from public.${table};\n${insert(table, rows)};\n`
}

try {
  const c = await server.ssrLoadModule('/src/lib/domain/catalog.ts')

  const modules = Object.entries(c.MODULES).map(([code, m], sort) => ({
    code,
    name: m.name,
    is_lockable: m.lockable,
    sort,
  }))
  const roles = c.ROLE_ORDER.map((code, sort) => {
    const r = c.ROLES[code]
    return {
      code,
      name: r.name,
      island: r.island,
      default_sector_code: r.defaultSector,
      description: r.description,
      is_supervisor: r.isSupervisor,
      sort,
    }
  })
  const permissionCodes = new Set([
    ...Object.values(c.ROLE_PERMISSIONS).flat(),
    ...c.TRANSITIONS.map((t) => t.permission).filter(Boolean),
  ])
  const permissions = [...permissionCodes].sort().map((code) => {
    const [resource, action] = code.split('.')
    return { code, module_code: c.permissionModule(code), resource, action }
  })
  const rolePermissions = Object.entries(c.ROLE_PERMISSIONS).flatMap(([role_code, perms]) =>
    perms.map((permission_code) => ({ role_code, permission_code })),
  )
  const units = Object.entries(c.UNITS).map(([code, u]) => ({ code, name: u.name, allows_decimals: u.decimals }))
  const docTypes = Object.values(c.DOC_TYPES).map((d) => ({
    code: d.code,
    prefix: d.prefix,
    name: d.name,
    plural: d.plural,
    module_code: d.module,
    resource: d.resource,
    path: d.path,
    description: d.description,
  }))
  const statuses = Object.entries(c.DOC_STATUSES).flatMap(([doc_type, map]) =>
    Object.entries(map).map(([code, s], sort) => ({
      doc_type,
      code,
      label: s.label,
      description: s.description,
      badge: s.badge,
      is_final: s.final,
      sort,
    })),
  )
  const transitions = c.TRANSITIONS.map((t, i) => ({
    doc_type: t.docType,
    from_status: t.from,
    action: t.action,
    to_status: t.to,
    permission_code: t.permission,
    label: t.label,
    help_text: t.help,
    requires_comment: t.requiresComment,
    tone: t.tone,
    sort: i + 1,
  }))
  const taskRules = c.TASK_RULES.map((r) => ({
    doc_type: r.docType,
    status: r.status,
    task_type: r.taskType,
    assignee_kind: r.assignee,
    role_code: r.role ?? null,
    title_template: r.title,
    description: r.description,
  }))
  const movementTypes = Object.entries(c.MOVEMENT_TYPES).map(([code, name]) => ({
    code,
    name,
    direction: MOVEMENT_DIRECTION[code],
  }))
  for (const m of movementTypes) {
    if (!m.direction) throw new Error(`Falta la dirección del tipo de movimiento ${m.code}`)
  }
  const auditActions = Object.entries(c.ACTION_VERBS).map(([code, verb]) => ({ code, verb }))
  const postingKeys = Object.entries(c.POSTING_EVENTS).flatMap(([event, e], i) =>
    Object.entries(e.keys).map(([key, label], j) => ({
      event,
      key,
      event_label: e.label,
      key_label: label,
      sort: i * 100 + j,
    })),
  )

  const out = [
    '-- Datos de los catálogos del sistema (con los de los centros de trabajo y la conversión, Fase 5b).',
    '-- GENERADO por scripts/generate-catalog-sql.mjs desde src/lib/domain/catalog.ts: no editar a mano.',
    '-- Idempotente: inserta o actualiza, y reemplaza las tablas de correspondencias.',
    '',
    upsert('modules', ['code'], modules),
    upsert('roles', ['code'], roles),
    upsert('permissions', ['code'], permissions),
    replaceAll('role_permissions', rolePermissions),
    upsert('units_of_measure', ['code'], units),
    upsert('document_types', ['code'], docTypes),
    upsert('document_statuses', ['doc_type', 'code'], statuses),
    replaceAll('document_transitions', transitions),
    replaceAll('task_rules', taskRules),
    upsert('stock_movement_types', ['code'], movementTypes),
    upsert('audit_actions', ['code'], auditActions),
    upsert('posting_keys', ['event', 'key'], postingKeys),
  ].join('\n')

  const file = join(root, 'supabase', 'migrations', target)
  writeFileSync(file, out)
  console.log(
    `${file}\n${roles.length} roles · ${permissions.length} permisos · ${rolePermissions.length} asignaciones · ` +
      `${statuses.length} estados · ${transitions.length} transiciones · ${taskRules.length} reglas de tareas`,
  )
} finally {
  await server.close()
}
