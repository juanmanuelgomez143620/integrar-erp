import { Fragment } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import type { FlowNode } from '@/lib/api'
import { DOC_TYPES } from '@/lib/domain/catalog'
import { dateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { StatusBadge } from './status-badge'

/** Cadena de documentos vinculados (SC → OC → REC): la integración entre áreas. */
export function DocumentFlow({ nodes }: { nodes: FlowNode[] }) {
  if (nodes.length <= 1) {
    return (
      <p className="text-sm text-muted-foreground">
        Este documento todavía no está vinculado con otros. Cuando el proceso avance, acá vas a ver la cadena completa
        de comprobantes.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {nodes.map((n, i) => (
        <Fragment key={n.id}>
          {i > 0 && <ArrowRight className="size-4 self-center text-slate-400" />}
          {n.readable ? (
            <Link
              to={n.path}
              className={cn(
                'flex min-w-40 flex-col gap-1 rounded-lg border bg-card px-3 py-2 transition-colors hover:border-brand-blue/50',
                n.current && 'border-brand-blue ring-2 ring-brand-blue/15',
              )}
            >
              <FlowContent node={n} />
            </Link>
          ) : (
            <div
              className="flex min-w-40 flex-col gap-1 rounded-lg border border-dashed bg-muted/40 px-3 py-2"
              title="Tu rol no tiene acceso a este tipo de documento"
            >
              <FlowContent node={n} />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}

function FlowContent({ node }: { node: FlowNode }) {
  return (
    <>
      <span className="text-[11px] text-muted-foreground">{DOC_TYPES[node.doc_type].name}</span>
      <span className="font-mono text-sm font-semibold text-navy">{node.display_number}</span>
      <StatusBadge label={node.status_info.label} badge={node.status_info.badge} className="w-fit" />
      <span className="text-[11px] text-muted-foreground">{dateTime(node.date)}</span>
    </>
  )
}
