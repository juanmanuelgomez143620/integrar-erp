import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ChevronRight } from 'lucide-react'

export interface Crumb {
  label: string
  to?: string
}

export function PageHeader({ crumbs, title, description, actions, meta }: {
  crumbs?: Crumb[]
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-col gap-3">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Ruta" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3" />}
              {c.to ? <Link to={c.to} className="hover:text-foreground hover:underline">{c.label}</Link> : <span className="text-foreground">{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-navy sm:text-2xl">{title}</h1>
            {meta}
          </div>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
