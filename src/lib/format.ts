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

/**
 * Importe en pesos escrito por el estudiante: "1300,50" y "1.300,50" (es-AR),
 * "1.000.000" (puntos de miles, sin decimales), "1300.50" o "$ 1.300"; NaN si
 * no es un número. Sólo para importes: en una cantidad, "1.500" puede ser 1,5 kg.
 */
export function parseAmount(text: string): number {
  const t = text.replace(/\s/g, '').replace(/^\$/, '')
  if (!t) return Number.NaN
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'))
  if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''))
  return Number(t)
}

export function qty(value: number | null | undefined, uom?: string): string {
  if (value == null || Number.isNaN(value)) return '—'
  const n = numberFmt.format(value)
  return uom ? `${n} ${uom}` : n
}

const percentFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 })
const signedPercentFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1, signDisplay: 'exceptZero' })

/** Un por ciento con un decimal: 12.5 → '12,5 %'; con signo, para una diferencia: '+0,5 %'. */
export function percent(value: number | null | undefined, signed = false): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${(signed ? signedPercentFmt : percentFmt).format(value)} %`
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
