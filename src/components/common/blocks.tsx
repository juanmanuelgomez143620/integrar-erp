import type { ComponentType, ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

/** Tarjeta de sección con título: base visual de fichas y tableros. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-navy">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  to,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ComponentType<{ className?: string }>
  to?: string
  tone?: 'default' | 'warning' | 'danger'
}) {
  const body = (
    <div
      className={cn(
        'flex h-full flex-col gap-1 rounded-xl border bg-card p-4 transition-colors',
        to && 'hover:border-brand-blue/40 hover:bg-brand-blue-soft/40',
        tone === 'warning' && 'border-amber-200',
        tone === 'danger' && 'border-red-200',
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        {label}
        {Icon && (
          <Icon
            className={cn(
              'size-4',
              tone === 'warning' ? 'text-amber-600' : tone === 'danger' ? 'text-red-600' : 'text-brand-blue',
            )}
          />
        )}
      </div>
      <div className="tabular text-2xl font-semibold tracking-tight text-navy">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: ComponentType<{ className?: string }>
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card px-6 py-12 text-center">
      {Icon && <Icon className="size-8 text-slate-300" />}
      <div className="text-sm font-semibold text-navy">{title}</div>
      {children && <p className="max-w-md text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(110px,40%)_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium text-foreground">{children}</dd>
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  required,
}: {
  label: string
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
  required?: boolean
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label className="text-xs font-medium text-slate-700">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return <div className="py-16 text-center text-sm text-muted-foreground">{label}</div>
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[13px] font-medium tracking-tight text-navy">{children}</span>
}
