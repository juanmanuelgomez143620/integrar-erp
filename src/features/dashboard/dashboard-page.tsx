import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, ClipboardList, Clock, Hourglass, Inbox, PackageSearch, ShoppingCart, Truck, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, KpiCard, Loading, Section } from '@/components/common/blocks'
import { AuditTimeline } from '@/components/common/audit-timeline'
import { BADGE_CLASSES } from '@/components/common/status-badge'
import { PageHeader } from '@/components/common/page-header'
import { api } from '@/lib/api'
import { ROLES } from '@/lib/domain/catalog'
import { money, moneyShort, qty, relative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { useMe } from '@/app/session'

export function DashboardPage() {
  const company = useCompany()
  const { data: me } = useMe()
  const { data, isLoading } = useQuery({ queryKey: ['dashboard', company.companyId], queryFn: () => api.dashboard(company.companyId) })
  if (isLoading || !data) return <Loading />
  const k = data.kpis
  const mainRole = company.roles.find((r) => r.role_code !== 'DOCENTE')
  const maxStatus = Math.max(1, ...data.po_by_status.map((s) => s.count))

  return (
    <>
      <PageHeader
        title={`Hola, ${me?.user.first_name ?? ''}`}
        description={
          company.supervisor
            ? 'Tenés vista de supervisión sobre toda la empresa. Desde el panel docente podés asignar roles, bloquear módulos y reiniciar los datos.'
            : mainRole
              ? `Trabajás en ${mainRole.sector_name} como ${ROLES[mainRole.role_code].name}. ${ROLES[mainRole.role_code].description}`
              : undefined
        }
        actions={<Button variant="outline" asChild><Link to={company.to('mi-trabajo')}><Inbox /> Mi trabajo ({k.my_tasks})</Link></Button>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Mis tareas" value={k.my_tasks} icon={Inbox} to={company.to('mi-trabajo')} hint="Operaciones que esperan tu intervención" tone={k.my_tasks ? 'warning' : 'default'} />
        {data.can.purchasing && (
          <>
            <KpiCard label="Solicitudes a atender" value={k.pr_pending} icon={ClipboardList} to={company.to('compras/solicitudes')} hint="Enviadas a Compras" />
            <KpiCard label="OC por aprobar" value={k.po_pending_approval} icon={Hourglass} to={company.to('compras/ordenes')} hint={k.po_pending_amount ? moneyShort(k.po_pending_amount) : 'Sin montos pendientes'} tone={k.po_pending_approval ? 'warning' : 'default'} />
            <KpiCard label="OC en tránsito" value={k.po_in_transit} icon={Truck} to={company.to('compras/ordenes')} hint="Enviadas, esperando mercadería" />
          </>
        )}
        {data.can.stock && (
          <>
            <KpiCard label="Bajo stock mínimo" value={k.below_min} icon={AlertTriangle} to={company.to('stock')} hint="Productos a reponer" tone={k.below_min ? 'danger' : 'default'} />
            <KpiCard label="Valor del inventario" value={k.inventory_value != null ? moneyShort(k.inventory_value) : '—'} icon={Wallet} hint="A costo promedio ponderado" />
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section
          title="Mi trabajo"
          description="Lo que el proceso espera de tu sector."
          className="lg:col-span-2"
          actions={<Button variant="ghost" size="sm" asChild><Link to={company.to('mi-trabajo')}>Ver todo <ArrowRight /></Link></Button>}
          bodyClassName="p-0"
        >
          {data.tasks.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No tenés tareas pendientes. Cuando otro sector necesite tu intervención, va a aparecer acá automáticamente.</p>
          ) : (
            <ul className="divide-y">
              {data.tasks.map((t) => (
                <li key={t.id}>
                  <Link to={t.path ?? company.to('mi-trabajo')} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                    <span className={cn('size-2 shrink-0 rounded-full', t.status === 'EN_CURSO' ? 'bg-brand-blue' : t.priority === 'ALTA' || t.priority === 'URGENTE' ? 'bg-red-500' : 'bg-amber-400')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{t.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{t.description}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{relative(t.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {data.can.stock ? (
          <Section title="Stock crítico" description="Productos por debajo del mínimo." bodyClassName="p-0">
            {data.low_stock.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Todos los productos están sobre su stock mínimo.</p>
            ) : (
              <ul className="divide-y">
                {data.low_stock.map((p) => (
                  <li key={p.code}>
                    <Link to={company.to(`productos/${p.code}`)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                      <PackageSearch className="size-4 shrink-0 text-red-600" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm"><span className="font-mono text-xs font-semibold">{p.code}</span> {p.name}</span>
                        <span className="text-xs text-muted-foreground">Hay {qty(p.qty, p.uom)} · mínimo {qty(p.min, p.uom)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : (
          <Section title="Tu rol en el circuito">
            <p className="text-sm text-muted-foreground">
              En esta etapa tu sector consulta la información. Observá cómo avanzan las solicitudes y órdenes de compra: pronto vas a operar tu propio módulo.
            </p>
          </Section>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {data.can.purchasing && (
          <Section title="Órdenes de compra por estado" description={`Compras aprobadas este mes: ${money(k.purchases_month)}`}>
            {data.po_by_status.length === 0 ? (
              <EmptyState icon={ShoppingCart} title="Sin órdenes de compra" />
            ) : (
              <ul className="flex flex-col gap-2.5">
                {data.po_by_status.map((s) => (
                  <li key={s.status} className="text-sm">
                    <div className="mb-1 flex justify-between"><span>{s.label}</span><span className="tabular font-semibold">{s.count}</span></div>
                    <div className="h-2 rounded-full bg-muted">
                      <div className={cn('h-2 rounded-full ring-1 ring-inset', BADGE_CLASSES[s.badge])} style={{ width: `${(s.count / maxStatus) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data.lead_time_hours != null && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Clock className="size-4 text-brand-blue" />
                Tiempo promedio de la solicitud a la recepción: <span className="font-semibold text-foreground">{data.lead_time_hours < 48 ? `${data.lead_time_hours.toFixed(1)} h` : `${(data.lead_time_hours / 24).toFixed(1)} días`}</span>
              </div>
            )}
          </Section>
        )}
        <Section
          title="Actividad reciente"
          description="Quién hizo qué, en qué sector y cuándo."
          className={data.can.purchasing ? 'lg:col-span-2' : 'lg:col-span-3'}
          actions={data.can.audit ? <Button variant="ghost" size="sm" asChild><Link to={company.to('auditoria')}>Auditoría <ArrowRight /></Link></Button> : undefined}
        >
          <AuditTimeline events={data.activity} compact />
        </Section>
      </div>
    </>
  )
}
