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

export function ProductSelect({
  products,
  value,
  onChange,
  placeholder = 'Elegí un producto',
  className,
  disabled,
}: {
  products: Product[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  const groups = (Object.keys(PRODUCT_TYPES) as ProductType[])
    .map((type) => ({ type, items: products.filter((p) => p.product_type === type) }))
    .filter((g) => g.items.length)
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn('w-full min-w-0', className)}>
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
}: {
  value: V | ''
  onChange: (value: V) => void
  options: { value: V; label: string }[]
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  return (
    <Select value={value || undefined} onValueChange={(v) => onChange(v as V)} disabled={disabled}>
      <SelectTrigger className={cn('w-full', className)}>
        <SelectValue placeholder={placeholder ?? 'Elegí una opción'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
