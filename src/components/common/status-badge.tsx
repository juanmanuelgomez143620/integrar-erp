import type { Badge } from '@/lib/domain/types'
import { cn } from '@/lib/utils'

export const BADGE_CLASSES: Record<Badge, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-blue-50 text-blue-700 ring-blue-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  success: 'bg-green-50 text-green-700 ring-green-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
}

export function StatusBadge({ label, badge, className }: { label: string; badge: Badge; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset', BADGE_CLASSES[badge], className)}>
      {label}
    </span>
  )
}

export function DocStatus({ info }: { info: { label: string; badge: Badge } | undefined }) {
  if (!info) return null
  return <StatusBadge label={info.label} badge={info.badge} />
}
