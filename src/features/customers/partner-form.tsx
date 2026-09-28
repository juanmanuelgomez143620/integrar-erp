import { useEffect } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Field } from '@/components/common/blocks'
import { SimpleSelect } from '@/components/common/pickers'
import { commands } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import type { Customer, Supplier, VatCondition } from '@/lib/domain/types'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const schema = z.object({
  code: z.string().trim().min(1, 'Ingresá el código'),
  legal_name: z.string().trim().min(2, 'Ingresá la razón social'),
  trade_name: z.string(),
  tax_id: z.string().trim().regex(/^(\d{2}-\d{8}-\d)?$/, 'Formato: 30-12345678-9 (o vacío)'),
  vat_condition: z.enum(['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL']),
  address_line: z.string(),
  city: z.string(),
  province: z.string(),
  phone: z.string(),
  email: z.union([z.literal(''), z.email('Email inválido')]),
  contact_name: z.string(),
  payment_terms_days: z.string().regex(/^\d*$/, 'Sólo números'),
  credit_limit: z.string().regex(/^\d*$/, 'Sólo números'),
  lead_time_days: z.string().regex(/^\d*$/, 'Sólo números'),
  category: z.string(),
  notes: z.string(),
})

type FormValues = z.infer<typeof schema>

const empty: FormValues = {
  code: '', legal_name: '', trade_name: '', tax_id: '', vat_condition: 'RESPONSABLE_INSCRIPTO', address_line: '', city: '',
  province: 'Misiones', phone: '', email: '', contact_name: '', payment_terms_days: '30', credit_limit: '', lead_time_days: '', category: '', notes: '',
}

export function PartnerSheet({ kind, open, onOpenChange, partner, nextCode }: {
  kind: 'customer' | 'supplier'
  open: boolean
  onOpenChange: (open: boolean) => void
  partner: Customer | Supplier | null
  nextCode: string
}) {
  const company = useCompany()
  const label = kind === 'customer' ? 'cliente' : 'proveedor'
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: empty })

  useEffect(() => {
    if (!open) return
    if (!partner) {
      form.reset({ ...empty, code: nextCode })
      return
    }
    form.reset({
      ...empty,
      ...Object.fromEntries(Object.entries(partner).map(([k, v]) => [k, v == null ? '' : String(v)])),
      vat_condition: partner.vat_condition,
    })
  }, [open, partner, nextCode, form])

  const save = useCommand(
    (values: FormValues) => commands.saveMaster(kind, company.companyId, {
      ...(partner ? { id: partner.id } : {}),
      code: values.code, legal_name: values.legal_name, trade_name: values.trade_name, tax_id: values.tax_id, vat_condition: values.vat_condition,
      address_line: values.address_line, city: values.city, province: values.province, phone: values.phone, email: values.email,
      contact_name: values.contact_name, payment_terms_days: Number(values.payment_terms_days) || 0, notes: values.notes,
      ...(kind === 'customer'
        ? { credit_limit: values.credit_limit ? Number(values.credit_limit) : null }
        : { category: values.category, lead_time_days: values.lead_time_days ? Number(values.lead_time_days) : null }),
    }),
    { success: `Se guardó el ${label}.`, onSuccess: () => onOpenChange(false) },
  )

  const err = form.formState.errors
  // useWatch (no form.watch) para no perder la memoización: form.watch() devuelve
  // una función que React Compiler no puede memoizar de forma segura.
  const vatCondition = useWatch({ control: form.control, name: 'vat_condition' })
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{partner ? `Editar ${label}` : `Nuevo ${label}`}</SheetTitle>
          <SheetDescription>Datos ficticios de la simulación. Los cambios quedan en la auditoría.</SheetDescription>
        </SheetHeader>
        <form id="partner-form" onSubmit={form.handleSubmit((v) => save.mutate([v]))} className="grid gap-4 px-4 sm:grid-cols-2">
          <Field label="Código" required error={err.code?.message}><Input {...form.register('code')} /></Field>
          <Field label="CUIT (simulado)" error={err.tax_id?.message}><Input {...form.register('tax_id')} placeholder="30-00000000-0" /></Field>
          <Field label="Razón social" required className="sm:col-span-2" error={err.legal_name?.message}><Input {...form.register('legal_name')} /></Field>
          <Field label="Nombre comercial" className="sm:col-span-2"><Input {...form.register('trade_name')} /></Field>
          <Field label="Condición frente al IVA" className="sm:col-span-2">
            <SimpleSelect
              value={vatCondition}
              onChange={(v: VatCondition) => form.setValue('vat_condition', v)}
              options={(Object.keys(VAT_CONDITIONS) as VatCondition[]).map((v) => ({ value: v, label: VAT_CONDITIONS[v] }))}
            />
          </Field>
          <Field label="Domicilio" className="sm:col-span-2"><Input {...form.register('address_line')} /></Field>
          <Field label="Localidad"><Input {...form.register('city')} /></Field>
          <Field label="Provincia"><Input {...form.register('province')} /></Field>
          <Field label="Contacto"><Input {...form.register('contact_name')} /></Field>
          <Field label="Teléfono"><Input {...form.register('phone')} /></Field>
          <Field label="Email" className="sm:col-span-2" error={err.email?.message}><Input {...form.register('email')} /></Field>
          <Field label="Plazo de pago (días)" error={err.payment_terms_days?.message}><Input inputMode="numeric" {...form.register('payment_terms_days')} /></Field>
          {kind === 'customer' ? (
            <Field label="Límite de crédito ($)" error={err.credit_limit?.message}><Input inputMode="numeric" {...form.register('credit_limit')} /></Field>
          ) : (
            <>
              <Field label="Demora de entrega (días)" error={err.lead_time_days?.message}><Input inputMode="numeric" {...form.register('lead_time_days')} /></Field>
              <Field label="Rubro" className="sm:col-span-2"><Input {...form.register('category')} /></Field>
            </>
          )}
          <Field label="Observaciones" className="sm:col-span-2"><Textarea rows={2} {...form.register('notes')} /></Field>
        </form>
        <SheetFooter className="flex-row justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="submit" form="partner-form" disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
