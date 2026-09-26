import { cn } from '@/lib/utils'

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="11" r="3" />
        <circle cx="22" cy="11" r="3" />
        <circle cx="16" cy="22" r="3" />
        <path d="M12.6 12.6 14.6 19.4M19.4 12.6 17.4 19.4M13 11h6" />
      </g>
    </svg>
  )
}

/** Logotipo de la familia GEST-AR: nombre en marino con el sufijo "-AR" en azul. */
export function BrandMark({ tone = 'light', subtitle = true, className }: { tone?: 'light' | 'dark'; subtitle?: boolean; className?: string }) {
  const onDark = tone === 'dark'
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-[10px]', onDark ? 'bg-white/10 text-white' : 'bg-navy text-white')}>
        <Mark className="size-5" />
      </div>
      <div className="leading-none">
        <div className={cn('text-[17px] font-black tracking-tight', onDark ? 'text-white' : 'text-navy')}>
          INTEGR<span className={onDark ? 'text-sky-300' : 'text-brand-blue'}>-AR</span>
        </div>
        {subtitle && <div className={cn('mt-1 text-[11px] font-medium', onDark ? 'text-slate-400' : 'text-muted-foreground')}>ERP educativo · familia GEST-AR</div>}
      </div>
    </div>
  )
}
