import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Bell, Check, CheckCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api, commands } from '@/lib/api'
import { NOTIFICATION_TYPES } from '@/lib/domain/catalog'
import type { Notification } from '@/lib/domain/types'
import { dateTime, relative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

type Filter = 'unread' | 'read' | 'all'

const EMPTY: Record<Filter, { title: string; text: string }> = {
  unread: {
    title: 'Estás al día',
    text: 'No tenés avisos sin leer. Cuando otro sector haga algo que te involucra, te va a llegar un aviso acá y en la campana.',
  },
  read: { title: 'Sin avisos leídos', text: 'Los avisos que abras o marques como leídos van a quedar en esta lista.' },
  all: {
    title: 'Todavía no recibiste avisos',
    text: 'Te llegan cuando otro sector hace algo que te involucra: una tarea nueva, una orden aprobada, mercadería recibida.',
  },
}

export function NotificationsPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('unread')
  const { data = [], isLoading } = useQuery({
    queryKey: ['notifications', company.companyId, 'history'],
    queryFn: () => api.notifications(company.companyId, null),
  })
  const markRead = useCommand(commands.markNotificationsRead)
  const unread = data.filter((n) => !n.read_at)
  const rows = filter === 'unread' ? unread : filter === 'read' ? data.filter((n) => n.read_at) : data

  const open = (n: Notification) => {
    if (!n.read_at) markRead.mutate([company.companyId, [n.id]])
    navigate(n.link_path)
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Notificaciones' }]}
        title="Notificaciones"
        description="Avisos sobre lo que pasa con las operaciones que te involucran. Lo que tenés que resolver vos está en Mi trabajo."
        actions={
          unread.length > 0 ? (
            <Button
              variant="outline"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate([company.companyId, 'all'])}
            >
              <CheckCheck /> Marcar todas como leídas
            </Button>
          ) : undefined
        }
      />
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="mb-3">
        <TabsList>
          <TabsTrigger value="unread">No leídas ({unread.length})</TabsTrigger>
          <TabsTrigger value="read">Leídas</TabsTrigger>
          <TabsTrigger value="all">Todas ({data.length})</TabsTrigger>
        </TabsList>
      </Tabs>
      <DataTable<Notification>
        rows={rows}
        loading={isLoading}
        rowKey={(n) => n.id}
        search={(n) => `${n.title} ${n.body} ${NOTIFICATION_TYPES[n.type] ?? ''}`}
        searchPlaceholder="Buscar en los avisos…"
        onRowClick={open}
        rowClassName={(n) => (n.read_at ? undefined : 'bg-brand-blue-soft/40')}
        empty={
          <EmptyState icon={Bell} title={EMPTY[filter].title}>
            {EMPTY[filter].text}
          </EmptyState>
        }
        columns={[
          {
            key: 'title',
            header: 'Aviso',
            cell: (n) => (
              <div className="flex min-w-56 gap-2">
                <span
                  className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-brand-blue')}
                  aria-hidden="true"
                />
                <div>
                  <div className={cn(!n.read_at && 'font-semibold')}>
                    {n.title}
                    {!n.read_at && <span className="sr-only"> (no leída)</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">{n.body}</div>
                </div>
              </div>
            ),
          },
          {
            key: 'type',
            header: 'Tipo',
            className: 'hidden md:table-cell',
            cell: (n) => <span className="text-xs">{NOTIFICATION_TYPES[n.type] ?? n.type}</span>,
          },
          {
            key: 'created',
            header: 'Recibida',
            sort: (n) => n.created_at,
            cell: (n) => (
              <span className="text-xs whitespace-nowrap text-muted-foreground" title={dateTime(n.created_at)}>
                {relative(n.created_at)}
              </span>
            ),
          },
          {
            key: 'actions',
            header: '',
            align: 'right',
            cell: (n) =>
              n.read_at ? null : (
                <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={markRead.isPending}
                    onClick={() => markRead.mutate([company.companyId, [n.id]])}
                  >
                    <Check /> Marcar leída
                  </Button>
                </div>
              ),
          },
        ]}
      />
    </>
  )
}
