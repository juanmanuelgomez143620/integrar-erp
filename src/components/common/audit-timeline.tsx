import { Link } from 'react-router'
import type { AuditEvent } from '@/lib/domain/types'
import { dateTime, relative } from '@/lib/format'
import { ROLES } from '@/lib/domain/catalog'
import { cn } from '@/lib/utils'

const roleName = (code: string) =>
  code in ROLES ? ROLES[code as keyof typeof ROLES].name : code === 'SISTEMA' ? 'Sistema' : code

const ACTION_DOT: Record<string, string> = {
  APPROVE: 'bg-green-600',
  CONFIRM: 'bg-green-600',
  REJECT: 'bg-red-600',
  CANCEL: 'bg-red-600',
  ALERT: 'bg-amber-500',
  SYSTEM: 'bg-slate-400',
}

export function AuditTimeline({
  events,
  compact = false,
  linkFor,
}: {
  events: AuditEvent[]
  compact?: boolean
  linkFor?: (e: AuditEvent) => string | null
}) {
  if (!events.length) return <p className="text-sm text-muted-foreground">Sin movimientos registrados.</p>
  return (
    <ol className="relative flex flex-col gap-3">
      {events.map((e, i) => {
        const link = linkFor?.(e)
        return (
          <li key={e.id} className="relative flex gap-3">
            <div className="flex flex-col items-center">
              <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', ACTION_DOT[e.action] ?? 'bg-brand-blue')} />
              {i < events.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                <span title={dateTime(e.occurred_at)}>
                  {compact ? relative(e.occurred_at) : dateTime(e.occurred_at)}
                </span>
                <span className="font-medium text-foreground">{e.actor_name}</span>
                <span>
                  · {roleName(e.actor_role_code)}
                  {e.actor_sector_name !== '—' && e.actor_sector_name !== roleName(e.actor_role_code)
                    ? ` (${e.actor_sector_name})`
                    : ''}
                </span>
              </div>
              <div className="mt-0.5 text-sm">
                {link ? (
                  <Link to={link} className="hover:underline">
                    {e.summary}
                  </Link>
                ) : (
                  e.summary
                )}
              </div>
              {!compact && e.changes && Object.keys(e.changes).length > 0 && (
                <ul className="mt-1 text-xs text-muted-foreground">
                  {Object.entries(e.changes)
                    .slice(0, 6)
                    .map(([field, c]) => (
                      <li key={field}>
                        <span className="font-mono">{field}</span>: {String(c.from ?? '—')} → {String(c.to ?? '—')}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
