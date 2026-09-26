import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Hand, Inbox, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Mono } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type TaskItem } from '@/lib/api'
import { TASK_TYPE_LABELS } from '@/lib/domain/catalog'
import { dateTime, relative } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useSession } from '@/app/session'
import { useCompany } from '@/app/company'

const TASK_STATUS = {
  PENDIENTE: { label: 'Pendiente', badge: 'warning' },
  EN_CURSO: { label: 'En curso', badge: 'info' },
  RESUELTA: { label: 'Resuelta', badge: 'success' },
  CANCELADA: { label: 'Cancelada', badge: 'neutral' },
} as const

export function MyWorkPage() {
  const company = useCompany()
  const { userId } = useSession()
  const navigate = useNavigate()
  const canAll = company.can('task.read')
  const [tab, setTab] = useState<'mine' | 'all' | 'closed'>('mine')
  const { data = [], isLoading } = useQuery({
    queryKey: ['tasks', company.companyId, tab],
    queryFn: () => api.tasks(company.companyId, tab === 'mine' ? 'mine' : 'all', tab === 'closed'),
  })
  const rows = tab === 'closed' ? data.filter((t) => t.status === 'RESUELTA' || t.status === 'CANCELADA') : data
  const claim = useCommand(commands.claimTask, { success: 'Tarea actualizada' })

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Mi trabajo' }]}
        title="Mi trabajo"
        description="Cada sector ve automáticamente las operaciones que requieren su intervención. Cuando resolvés el documento, la tarea se cierra sola y pasa al sector siguiente."
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-3">
        <TabsList>
          <TabsTrigger value="mine">Mis tareas</TabsTrigger>
          {canAll && <TabsTrigger value="all">Todas las pendientes</TabsTrigger>}
          <TabsTrigger value="closed">Resueltas</TabsTrigger>
        </TabsList>
      </Tabs>
      {!isLoading && rows.length === 0 && tab === 'mine' ? (
        <EmptyState icon={Inbox} title="No tenés tareas pendientes">
          Cuando otro sector envíe algo que requiere tu intervención (una solicitud, una orden para aprobar, mercadería para recibir), va a aparecer acá.
        </EmptyState>
      ) : (
        <DataTable<TaskItem>
          rows={rows}
          loading={isLoading}
          rowKey={(t) => t.id}
          search={(t) => `${t.title} ${t.document_label ?? ''} ${t.assignee_label}`}
          onRowClick={(t) => t.path && navigate(t.path)}
          columns={[
            {
              key: 'title', header: 'Tarea', cell: (t) => (
                <div className="min-w-64">
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-muted-foreground">{t.description}</div>
                </div>
              ),
            },
            { key: 'type', header: 'Tipo', cell: (t) => <span className="text-xs">{TASK_TYPE_LABELS[t.task_type] ?? t.task_type}</span> },
            { key: 'doc', header: 'Documento', cell: (t) => (t.document_label ? <Mono>{t.document_label}</Mono> : '—') },
            {
              key: 'assignee', header: 'Asignada a', cell: (t) => (
                <div className="text-xs">
                  <div>{t.assignee_label}</div>
                  {t.claimed_by_name && t.status === 'EN_CURSO' && <div className="text-muted-foreground">Tomada por {t.claimed_by_name}</div>}
                  {t.completed_by_name && tab === 'closed' && <div className="text-muted-foreground">Resuelta por {t.completed_by_name}</div>}
                </div>
              ),
            },
            { key: 'created', header: 'Desde', sort: (t) => t.created_at, cell: (t) => <span className="text-xs text-muted-foreground" title={dateTime(t.created_at)}>{relative(t.created_at)}</span> },
            { key: 'status', header: 'Estado', cell: (t) => <StatusBadge {...TASK_STATUS[t.status]} /> },
            {
              key: 'actions', header: '', align: 'right', cell: (t) => (
                <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  {t.mine && t.status === 'PENDIENTE' && (
                    <Button size="xs" variant="outline" onClick={() => claim.mutate([t.id, true])} title="Avisá al resto de tu isla que te ocupás vos"><Hand /> Tomar</Button>
                  )}
                  {t.status === 'EN_CURSO' && t.claimed_by === userId && (
                    <Button size="xs" variant="ghost" onClick={() => claim.mutate([t.id, false])}><Undo2 /> Liberar</Button>
                  )}
                  {t.path && <Button size="xs" asChild><Link to={t.path}>Abrir</Link></Button>}
                </div>
              ),
            },
          ]}
        />
      )}
    </>
  )
}
