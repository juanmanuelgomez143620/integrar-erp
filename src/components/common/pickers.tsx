import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PRODUCT_TYPES } from '@/lib/domain/catalog'
import type { Product, ProductType } from '@/lib/domain/types'
import { cn } from '@/lib/utils'

/** Atributos que `Field` asigna al control para vincular etiqueta, ayuda y error. */
type ControlAria = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-label'?: string }

export function ProductSelect({
  products,
  value,
  onChange,
  placeholder = 'Elegí un producto',
  className,
  disabled,
  ...aria
}: {
  products: Pick<Product, 'id' | 'code' | 'name' | 'product_type'>[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
} & ControlAria) {
  const groups = (Object.keys(PRODUCT_TYPES) as ProductType[])
    .map((type) => ({ type, items: products.filter((p) => p.product_type === type) }))
    .filter((g) => g.items.length)
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn('w-full min-w-0', className)} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {groups.map((g) => (
          <SelectGroup key={g.type}>
            <SelectLabel>{PRODUCT_TYPES[g.type]}</SelectLabel>
            {g.items.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="font-mono text-xs font-semibold">{p.code}</span> {p.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SimpleSelect<V extends string>({
  value,
  onChange,
  options,
  placeholder,
  className,
  disabled,
  emptyLabel,
  ...aria
}: {
  value: V | ''
  onChange: (value: V) => void
  options: { value: V; label: string }[]
  placeholder?: string
  className?: string
  disabled?: boolean
  emptyLabel?: string
} & ControlAria) {
  return (
    <Select
      value={value || (emptyLabel ? '__empty__' : '')}
      onValueChange={(v) => onChange((v === '__empty__' ? '' : v) as V)}
      disabled={disabled}
    >
      <SelectTrigger className={cn('w-full', className)} {...aria}>
        <SelectValue placeholder={placeholder ?? 'Elegí una opción'} />
      </SelectTrigger>
      <SelectContent>
        {emptyLabel && <SelectItem value="__empty__">{emptyLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
