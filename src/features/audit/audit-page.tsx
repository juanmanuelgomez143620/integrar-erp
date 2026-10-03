import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { DataTable } from '@/components/common/data-table'
import { ExportCsvButton } from '@/components/common/export-button'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api } from '@/lib/api'
import type { CsvColumn } from '@/lib/csv'
import { ACTION_VERBS, DOC_STATUSES, DOC_TYPES, ROLES } from '@/lib/domain/catalog'
import type { AuditEvent, DocType } from '@/lib/domain/types'
import { dateTime } from '@/lib/format'
import { useCompany } from '@/app/company'

const RESOURCE_TYPE = Object.fromEntries(Object.values(DOC_TYPES).map((d) => [d.resource, d.code])) as Record<
  string,
  DocType
>

function statusInfo(e: AuditEvent, status: string | null) {
  const docType = RESOURCE_TYPE[e.entity_type]
  return status && docType ? DOC_STATUSES[docType][status] : undefined
}

function statusBadge(e: AuditEvent, status: string | null) {
  if (!status) return <span className="text-muted-foreground">—</span>
  const info = statusInfo(e, status)
  return info ? <StatusBadge label={info.label} badge={info.badge} /> : <span className="text-xs">{status}</span>
}

const roleName = (code: string) => (code in ROLES ? ROLES[code as keyof typeof ROLES].name : code)

const CSV_COLUMNS: CsvColumn<AuditEvent>[] = [
  { header: 'Fecha y hora', value: (e) => dateTime(e.occurred_at) },
  { header: 'Usuario', value: (e) => e.actor_name },
  { header: 'Rol', value: (e) => roleName(e.actor_role_code) },
  { header: 'Sector', value: (e) => e.actor_sector_name },
  { header: 'Acción', value: (e) => ACTION_VERBS[e.action] ?? e.action },
  { header: 'Registro', value: (e) => e.entity_label },
  { header: 'Estado anterior', value: (e) => statusInfo(e, e.from_status)?.label ?? e.from_status },
  { header: 'Estado nuevo', value: (e) => statusInfo(e, e.to_status)?.label ?? e.to_status },
  { header: 'Detalle', value: (e) => e.summary },
]

export function AuditPage() {
  const company = useCompany()
  const { data = [], isLoading } = useQuery({
    queryKey: ['audit', company.companyId],
    queryFn: () => api.audit(company.companyId),
  })
  const [sector, setSector] = useState('ALL')
  const [action, setAction] = useState('ALL')
  const sectors = useMemo(() => [...new Set(data.map((e) => e.actor_sector_name))].sort(), [data])
  const actions = useMemo(() => [...new Set(data.map((e) => e.action))], [data])
  const matches = (e: AuditEvent) =>
    (sector === 'ALL' || e.actor_sector_name === sector) && (action === 'ALL' || e.action === action)
  const rows = data.filter(matches)

  const docLink = (e: AuditEvent) => {
    const docType = RESOURCE_TYPE[e.entity_type]
    return docType && e.document_id ? company.docPath(docType, e.entity_label) : null
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Control' }, { label: 'Auditoría' }]}
        title="Auditoría"
        description="Registro inmutable de todas las acciones: nadie puede modificarlo ni borrarlo, ni siquiera el docente. Es la base del control interno."
        actions={
          company.can('audit.export') ? (
            // Exporta con los filtros de sector y acción elegidos.
            <ExportCsvButton
              dataset="auditoria"
              companySlug={company.slug}
              load={async () => (await api.exportAudit(company.companyId)).filter(matches)}
              columns={CSV_COLUMNS}
            />
          ) : undefined
        }
      />
      <DataTable<AuditEvent>
        rows={rows}
        loading={isLoading}
        rowKey={(e) => String(e.id)}
        search={(e) => `${e.actor_name} ${e.summary} ${e.entity_label}`}
        searchPlaceholder="Buscar usuario, documento o acción…"
        pageSize={40}
        toolbar={
          <>
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              <option value="ALL">Todos los sectores</option>
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s === '—' ? 'Sin sector (sistema/docente)' : s}
                </option>
              ))}
            </select>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              <option value="ALL">Todas las acciones</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {ACTION_VERBS[a] ?? a}
                </option>
              ))}
            </select>
          </>
        }
        columns={[
          {
            key: 'at',
            header: 'Fecha y hora',
            sort: (e) => e.id,
            cell: (e) => <span className="text-xs whitespace-nowrap">{dateTime(e.occurred_at)}</span>,
          },
          {
            key: 'who',
            header: 'Usuario',
            sort: (e) => e.actor_name,
            cell: (e) => (
              <div className="text-xs">
                <div className="font-medium text-foreground">{e.actor_name}</div>
                <div className="text-muted-foreground">
                  {roleName(e.actor_role_code)} · {e.actor_sector_name}
                </div>
              </div>
            ),
          },
          {
            key: 'what',
            header: 'Acción',
            cell: (e) => {
              const link = docLink(e)
              return link ? (
                <Link to={link} className="hover:underline">
                  {e.summary}
                </Link>
              ) : (
                e.summary
              )
            },
          },
          { key: 'from', header: 'Estado anterior', cell: (e) => statusBadge(e, e.from_status) },
          { key: 'to', header: 'Estado nuevo', cell: (e) => statusBadge(e, e.to_status) },
        ]}
      />
    </>
  )
}
