// Piezas comunes de las pantallas de Contabilidad: cuentas, rango de fechas
// de los libros (en la URL, así la impresión usa el mismo) y saldos.

import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Field } from '@/components/common/blocks'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type AccountRow } from '@/lib/api'
import { money, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

export function useAccounts() {
  const company = useCompany()
  return useQuery({ queryKey: ['accounts', company.companyId], queryFn: () => api.accounts(company.companyId) })
}

type ControlAria = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-label'?: string }

/** Cuentas imputables agrupadas por rubro. Las desactivadas sólo aparecen si se pide (o si ya estaban elegidas). */
export function AccountSelect({
  accounts,
  value,
  onChange,
  includeInactive = false,
  placeholder = 'Elegí una cuenta',
  className,
  ...aria
}: {
  accounts: AccountRow[]
  value: string
  onChange: (id: string) => void
  includeInactive?: boolean
  placeholder?: string
  className?: string
} & ControlAria) {
  const groups = accounts
    .filter((r) => r.level === 3)
    .map((rubro) => ({
      rubro,
      items: accounts.filter(
        (a) =>
          a.is_imputable && a.code.startsWith(`${rubro.code}.`) && (a.is_active || includeInactive || a.id === value),
      ),
    }))
    .filter((g) => g.items.length)
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={cn('w-full min-w-0', className)} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {groups.map((g) => (
          <SelectGroup key={g.rubro.id}>
            <SelectLabel>
              {g.rubro.code} {g.rubro.name}
            </SelectLabel>
            {g.items.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="font-mono text-xs font-semibold">{a.code}</span> {a.name}
                {!a.is_active && ' (desactivada)'}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

export interface DateRange {
  from: string
  to: string
}

/** Rango de los libros, guardado en la URL (?desde=…&hasta=…): por defecto, el ejercicio en curso hasta hoy. */
export function useBookRange(): [DateRange, (range: DateRange) => void] {
  const [params, setParams] = useSearchParams()
  const today = todayAR()
  const range = { from: params.get('desde') || `${today.slice(0, 4)}-01-01`, to: params.get('hasta') || today }
  const setRange = (next: DateRange) =>
    setParams(
      (current) => {
        const p = new URLSearchParams(current)
        p.set('desde', next.from)
        p.set('hasta', next.to)
        return p
      },
      { replace: true },
    )
  return [range, setRange]
}

export function RangePicker({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  const today = todayAR()
  const presets = [
    { label: 'Ejercicio en curso', from: `${today.slice(0, 4)}-01-01`, to: today },
    { label: 'Este mes', from: `${today.slice(0, 7)}-01`, to: today },
  ]
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Desde">
        <Input
          type="date"
          value={range.from}
          onChange={(e) => e.target.value && onChange({ ...range, from: e.target.value })}
          className="w-40"
        />
      </Field>
      <Field label="Hasta">
        <Input
          type="date"
          value={range.to}
          onChange={(e) => e.target.value && onChange({ ...range, to: e.target.value })}
          className="w-40"
        />
      </Field>
      {presets.map((p) => (
        <Button
          key={p.label}
          variant="outline"
          size="sm"
          className="mb-0.5"
          onClick={() => onChange({ from: p.from, to: p.to })}
        >
          {p.label}
        </Button>
      ))}
    </div>
  )
}

/** Saldo como en los libros: el importe sin signo y D (deudor) o A (acreedor). */
export function balanceText(balance: number) {
  if (balance === 0) return money(0)
  return `${money(Math.abs(balance))} ${balance > 0 ? 'D' : 'A'}`
}

export function ContraryBadge() {
  return <StatusBadge label="Saldo contrario a su naturaleza" badge="danger" />
}

/** Recordatorio de la partida doble para quien registra. */
export function DoubleEntryHelp() {
  return (
    <section className="rounded-xl border bg-card p-4 text-sm">
      <div className="font-semibold text-navy">¿Debe o haber?</div>
      <ul className="mt-2 flex flex-col gap-1.5 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Activo:</span> aumenta por el debe, disminuye por el haber.
        </li>
        <li>
          <span className="font-medium text-foreground">Pasivo y patrimonio neto:</span> aumentan por el haber,
          disminuyen por el debe.
        </li>
        <li>
          <span className="font-medium text-foreground">Pérdidas y gastos</span> (resultados negativos): al debe.
        </li>
        <li>
          <span className="font-medium text-foreground">Ganancias e ingresos</span> (resultados positivos): al haber.
        </li>
        <li>El total del debe tiene que ser igual al total del haber.</li>
      </ul>
    </section>
  )
}
