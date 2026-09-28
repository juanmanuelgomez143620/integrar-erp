import { useEffect } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Field } from '@/components/common/blocks'
import { SimpleSelect } from '@/components/common/pickers'
import { api, commands, type ProductRow } from '@/lib/api'
import { PRODUCT_TYPES, UNITS, VAT_RATES } from '@/lib/domain/catalog'
import type { ProductType } from '@/lib/domain/types'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const decimal = z.string().regex(/^\d*([.,]\d+)?$/, 'Número inválido')

const schema = z.object({
  code: z.string().trim().min(1, 'Ingresá el código'),
  name: z.string().trim().min(2, 'Ingresá la descripción'),
  category: z.string(),
  product_type: z.enum(['MATERIA_PRIMA', 'INSUMO', 'PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO']),
  uom_code: z.string().min(1),
  standard_cost: decimal,
  sale_price: decimal,
  vat_rate: z.string(),
  min_stock: decimal,
  reorder_qty: decimal,
  default_supplier_id: z.string(),
  default_warehouse_id: z.string(),
  location: z.string(),
})

type FormValues = z.infer<typeof schema>
const toNum = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')))

export function ProductSheet({ open, onOpenChange, product }: { open: boolean; onOpenChange: (o: boolean) => void; product: ProductRow | null }) {
  const company = useCompany()
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers', company.companyId], queryFn: () => api.suppliers(company.companyId), enabled: open && company.can('supplier.read') })
  const form = useForm<FormValues>({ resolver: zodResolver(schema) })

  useEffect(() => {
    if (!open) return
    form.reset({
      code: product?.code ?? '', name: product?.name ?? '', category: product?.category ?? '', product_type: product?.product_type ?? 'MATERIA_PRIMA',
      uom_code: product?.uom_code ?? 'UN', standard_cost: String(product?.standard_cost ?? ''), sale_price: product?.sale_price != null ? String(product.sale_price) : '',
      vat_rate: String(product?.vat_rate ?? 21), min_stock: String(product?.min_stock ?? 0), reorder_qty: product?.reorder_qty != null ? String(product.reorder_qty) : '',
      default_supplier_id: product?.default_supplier_id ?? '', default_warehouse_id: product?.default_warehouse_id ?? company.warehouses[0]?.id ?? '', location: product?.location ?? '',
    })
  }, [open, product, form, company.warehouses])

  const save = useCommand(
    (v: FormValues) => commands.saveMaster('product', company.companyId, {
      ...(product ? { id: product.id } : {}),
      code: v.code, name: v.name, category: v.category, product_type: v.product_type, uom_code: v.uom_code, description: product?.description ?? '',
      standard_cost: toNum(v.standard_cost) ?? 0, sale_price: toNum(v.sale_price), vat_rate: Number(v.vat_rate), min_stock: toNum(v.min_stock) ?? 0,
      reorder_qty: toNum(v.reorder_qty), default_supplier_id: v.default_supplier_id || null, default_warehouse_id: v.default_warehouse_id || null, location: v.location,
    }),
    { success: 'Producto guardado.', onSuccess: () => onOpenChange(false) },
  )
  const err = form.formState.errors
  // useWatch (no form.watch) para no perder la memoización: form.watch() devuelve
  // una función que React Compiler no puede memoizar de forma segura.
  const type = useWatch({ control: form.control, name: 'product_type' })
  const uomCode = useWatch({ control: form.control, name: 'uom_code' })
  const vatRate = useWatch({ control: form.control, name: 'vat_rate' })
  const defaultWarehouseId = useWatch({ control: form.control, name: 'default_warehouse_id' })
  const defaultSupplierId = useWatch({ control: form.control, name: 'default_supplier_id' })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{product ? `Editar ${product.code}` : 'Nuevo producto'}</SheetTitle>
          <SheetDescription>El stock no se edita acá: se modifica sólo con recepciones, ajustes y (más adelante) producción y ventas.</SheetDescription>
        </SheetHeader>
        <form id="product-form" onSubmit={form.handleSubmit((v) => save.mutate([v]))} className="grid gap-4 px-4 sm:grid-cols-2">
          <Field label="Código" required error={err.code?.message}><Input {...form.register('code')} placeholder="MP-008" /></Field>
          <Field label="Tipo" required>
            <SimpleSelect value={type} onChange={(v: ProductType) => form.setValue('product_type', v)} options={(Object.keys(PRODUCT_TYPES) as ProductType[]).map((t) => ({ value: t, label: PRODUCT_TYPES[t] }))} />
          </Field>
          <Field label="Descripción" required className="sm:col-span-2" error={err.name?.message}><Input {...form.register('name')} /></Field>
          <Field label="Categoría"><Input {...form.register('category')} /></Field>
          <Field label="Unidad de medida">
            <SimpleSelect value={uomCode} onChange={(v) => form.setValue('uom_code', v)} options={Object.entries(UNITS).map(([k, u]) => ({ value: k, label: `${k} · ${u.name}` }))} />
          </Field>
          <Field label="Costo de referencia ($)" error={err.standard_cost?.message}><Input inputMode="decimal" {...form.register('standard_cost')} /></Field>
          <Field label="Precio de venta ($)" error={err.sale_price?.message}><Input inputMode="decimal" {...form.register('sale_price')} placeholder="Si se vende" /></Field>
          <Field label="Alícuota de IVA">
            <SimpleSelect value={vatRate} onChange={(v) => form.setValue('vat_rate', v)} options={VAT_RATES.map((r) => ({ value: String(r), label: `${String(r).replace('.', ',')} %` }))} />
          </Field>
          {type !== 'SERVICIO' && (
            <>
              <Field label="Stock mínimo" error={err.min_stock?.message} hint="Debajo de este valor se genera una alerta."><Input inputMode="decimal" {...form.register('min_stock')} /></Field>
              <Field label="Cantidad de reposición" error={err.reorder_qty?.message} hint="Sugerida al crear la solicitud."><Input inputMode="decimal" {...form.register('reorder_qty')} /></Field>
              <Field label="Depósito habitual">
                <SimpleSelect value={defaultWarehouseId} onChange={(v) => form.setValue('default_warehouse_id', v)} options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))} />
              </Field>
              <Field label="Ubicación"><Input {...form.register('location')} placeholder="Nave 1 · estantería B-3" /></Field>
            </>
          )}
          {suppliers.length > 0 && (
            <Field label="Proveedor habitual" className="sm:col-span-2">
              <SimpleSelect value={defaultSupplierId} onChange={(v) => form.setValue('default_supplier_id', v)} options={suppliers.map((s) => ({ value: s.id, label: `${s.code} · ${s.legal_name}` }))} placeholder="Sin proveedor habitual" />
            </Field>
          )}
        </form>
        <SheetFooter className="flex-row justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="submit" form="product-form" disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
