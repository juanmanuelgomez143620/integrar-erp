// Formatos es-AR: $ 1.234.567,89 · dd/mm/aaaa · cantidades con decimales de la unidad.

const TZ = 'America/Argentina/Buenos_Aires'

const moneyFmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 })
const numberFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 })
const integerFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 })

export function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return moneyFmt.format(value)
}

export function moneyShort(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$ ${numberFmt.format(Math.round(value / 100_000) / 10)} M`
  if (Math.abs(value) >= 10_000) return `$ ${integerFmt.format(Math.round(value / 1000))} mil`
  return money(value)
}

export function qty(value: number | null | undefined, uom?: string): string {
  if (value == null || Number.isNaN(value)) return '—'
  const n = numberFmt.format(value)
  return uom ? `${n} ${uom}` : n
}

/** 'aaaa-mm-dd' → 'dd/mm/aaaa' */
export function date(value: string | null | undefined): string {
  if (!value) return '—'
  const [y, m, d] = value.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function time(iso: string): string {
  return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export function relative(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 45) return 'recién'
  if (diff < 3600) return `hace ${Math.round(diff / 60)} min`
  if (diff < 86400) return `hace ${Math.round(diff / 3600)} h`
  if (diff < 86400 * 7) return `hace ${Math.round(diff / 86400)} d`
  return date(iso)
}

/** Fecha de negocio de hoy en Argentina (aaaa-mm-dd). */
export function todayAR(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  )
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function initials(first: string, last: string): string {
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase()
}
