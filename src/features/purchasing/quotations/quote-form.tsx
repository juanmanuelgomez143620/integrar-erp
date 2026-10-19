import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { api, commands, type DocumentDetail, type SupplierQuoteInput } from '@/lib/api'
import { VAT_CONDITIONS, VAT_RATES } from '@/lib/domain/catalog'
import type { Supplier } from '@/lib/domain/types'
import { addDays, date, money, qty, todayAR } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Acepta "1.300,50" (es-AR) y "1300.50". */
const num = (s: string) => {
  const t = String(s).trim()
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? n : 0
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function QuoteFormPage() {
  const company = useCompany()
  const [params, setParams] = useSearchParams()
  const number = params.get('solicitud') ?? ''
  const rfqs = useQuery({
    queryKey: ['documents', company.companyId, 'RFQ'],
    queryFn: () => api.documents(company.companyId, 'RFQ'),
  })
  const rfq = useQuery({
    queryKey: ['document', company.companyId, 'RFQ', number],
    queryFn: () => api.document(company.companyId, 'RFQ', number),
    enabled: !!number,
  })
  const suppliers = useQuery({
    queryKey: ['suppliers', company.companyId],
    queryFn: () => api.suppliers(company.companyId),
  })
  if (!rfqs.data || !suppliers.data || (number && !rfq.data))
    return <Loading error={rfqs.error ?? suppliers.error ?? rfq.error} />
  const open = rfqs.data.filter((d) => d.status === 'ENVIADA')
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Compras' },
          { label: 'Cotizaciones', to: company.docPath('SUPPLIER_QUOTE') },
          { label: 'Cargar' },
        ]}
        title="Cargar cotización"
        description="Registrá lo que respondió un proveedor a una solicitud de cotización: sus precios, el plazo de entrega, la condición de pago y hasta cuándo vale la oferta."
      />
      <Section title="Solicitud que responde" className="mb-4">
        <Field label="Solicitud de cotización" required className="max-w-md">
          <SimpleSelect
            value={number}
            onChange={(v) => setParams({ solicitud: v })}
            options={open.map((d) => ({ value: d.display_number, label: `${d.display_number} · ${d.summary}` }))}
            placeholder={open.length ? 'Elegí la solicitud' : 'No hay solicitudes enviadas'}
          />
        </Field>
      </Section>
      {rfq.data && <QuoteForm key={rfq.data.doc.id} rfq={rfq.data} suppliers={suppliers.data} />}
    </>
  )
}

interface LineState {
  rfq_line_id: string
  quoted: boolean
  unit_price: string
  vat_rate: number
}

function QuoteForm({ rfq, suppliers }: { rfq: DocumentDetail; suppliers: Supplier[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  // Los invitados que todavía no respondieron.
  const waiting = rfq.rfq!.invited.filter((i) => !i.quote).map((i) => i.supplier.id)
  const options = suppliers.filter((s) => waiting.includes(s.id))
  // Si falta uno solo, ya queda elegido con su plazo de entrega y su condición de pago habituales.
  const only = options.length === 1 ? options[0] : undefined
  const [supplierId, setSupplierId] = useState(only?.id ?? '')
  const [reference, setReference] = useState('')
  const [valid, setValid] = useState(addDays(todayAR(), 15))
  const [delivery, setDelivery] = useState(only?.lead_time_days != null ? String(only.lead_time_days) : '')
  const [terms, setTerms] = useState(only ? String(only.payment_terms_days) : '')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineState[]>(() =>
    rfq.lines.map((l) => ({ rfq_line_id: l.id, quoted: true, unit_price: '', vat_rate: l.product.vat_rate })),
  )
  const supplier = suppliers.find((s) => s.id === supplierId)
  // Mientras no se elige el proveedor, se muestra el IVA (la mayoría son responsables inscriptos).
  const discriminates = !supplier || supplier.vat_condition === 'RESPONSABLE_INSCRIPTO'

  const pick = (id: string) => {
    setSupplierId(id)
    const s = suppliers.find((x) => x.id === id)
    if (s) {
      setTerms(String(s.payment_terms_days))
      setDelivery(s.lead_time_days != null ? String(s.lead_time_days) : '')
    }
  }
  const update = (id: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.rfq_line_id === id ? { ...l, ...patch } : l)))

  let subtotal = 0
  let tax = 0
  for (const [i, l] of lines.entries()) {
    if (!l.quoted) continue
    const s = round2(rfq.lines[i].quantity * num(l.unit_price))
    subtotal += s
    tax += discriminates ? round2((s * l.vat_rate) / 100) : 0
  }

  const input = (): SupplierQuoteInput => ({
    rfq_id: rfq.doc.id,
    supplier_id: supplierId,
    supplier_reference: reference,
    valid_until: valid,
    delivery_days: Number(delivery),
    payment_terms_days: Number(terms),
    notes,
    lines: lines
      .filter((l) => l.quoted)
      .map((l) => ({
        rfq_line_id: l.rfq_line_id,
        unit_price: num(l.unit_price),
        vat_rate: discriminates ? l.vat_rate : 0,
      })),
  })

  const save = useCommand(() => commands.createSupplierQuote(company.companyId, input()), {
    success: (r) => `${r.display_number} cargada: ya está en el cuadro comparativo.`,
    onSuccess: () => navigate(rfq.doc.path),
  })

  if (rfq.doc.status !== 'ENVIADA')
    return (
      <p className="text-sm text-muted-foreground">
        {rfq.doc.display_number} está en estado "{rfq.doc.status_info.label}": se cargan cotizaciones de una solicitud
        enviada.
      </p>
    )
  if (!options.length)
    return (
      <p className="text-sm text-muted-foreground">
        Ya respondieron todos los proveedores invitados a {rfq.doc.display_number}. Si uno cambió su oferta, anulá su
        cotización y cargá la nueva.
      </p>
    )

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Section title="Proveedor y condiciones">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Proveedor"
              required
              className="sm:col-span-2"
              hint={
                supplier
                  ? `${VAT_CONDITIONS[supplier.vat_condition]}${discriminates ? '' : ': no discrimina IVA, cargá el precio final.'}`
                  : `Invitados que todavía no respondieron (responden hasta el ${date(rfq.rfq!.response_due)}).`
              }
            >
              <SimpleSelect
                value={supplierId}
                onChange={pick}
                options={options.map((s) => ({ value: s.id, label: `${s.code} · ${s.legal_name}` }))}
                placeholder="Elegí el proveedor"
              />
            </Field>
            <Field label="Referencia del proveedor" hint="El número de su cotización (opcional).">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={40} />
            </Field>
            <Field label="Válida hasta" required>
              <Input type="date" value={valid} onChange={(e) => setValid(e.target.value)} />
            </Field>
            <Field label="Plazo de entrega (días)" required>
              <Input
                inputMode="numeric"
                value={delivery}
                onChange={(e) => setDelivery(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Field label="Condición de pago (días)" required hint="0 = contado">
              <Input inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="Observaciones" className="sm:col-span-2">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
            </Field>
          </div>
        </Section>

        <Section title="Precios" description="Destildá los ítems que el proveedor no cotiza.">
          <div className="flex flex-col gap-3">
            {rfq.lines.map((item, i) => {
              const l = lines[i]
              return (
                <div key={item.id} className="rounded-lg border p-3">
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <Checkbox
                      checked={l.quoted}
                      onCheckedChange={(v) => update(item.id, { quoted: v === true })}
                      aria-label={`Cotiza ${item.product.code}`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-mono text-xs font-semibold text-navy">{item.product.code}</span>{' '}
                      {item.product.name}
                      <span className="block text-xs text-muted-foreground">
                        {qty(item.quantity, item.product.uom_code)}
                        {item.notes ? ` · ${item.notes}` : ''}
                      </span>
                    </span>
                  </label>
                  {l.quoted && (
                    <div className="mt-2 grid items-end gap-2 sm:grid-cols-[1fr_110px_1fr]">
                      <Field label={discriminates ? 'Precio unit. (neto)' : 'Precio unit. (final)'}>
                        <Input
                          inputMode="decimal"
                          value={l.unit_price}
                          onChange={(e) => update(item.id, { unit_price: e.target.value })}
                          className="tabular text-right"
                        />
                      </Field>
                      <Field label="IVA">
                        {discriminates ? (
                          <SimpleSelect
                            value={String(l.vat_rate)}
                            onChange={(v) => update(item.id, { vat_rate: Number(v) })}
                            options={VAT_RATES.map((r) => ({
                              value: String(r),
                              label: `${String(r).replace('.', ',')} %`,
                            }))}
                          />
                        ) : (
                          <span className="flex h-9 items-center text-xs text-muted-foreground">No discrimina</span>
                        )}
                      </Field>
                      <div className="pb-2 text-right text-sm">
                        <span className="text-xs text-muted-foreground">Subtotal </span>
                        <span className="tabular font-medium">{money(item.quantity * num(l.unit_price))}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Section>
      </div>

      <aside className="flex flex-col gap-3">
        <Section title="Totales">
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Neto (costo para la empresa)</dt>
              <dd className="tabular">{money(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">IVA</dt>
              <dd className="tabular">{money(tax)}</dd>
            </div>
            <div className="flex justify-between border-t pt-1.5 text-base font-semibold text-navy">
              <dt>Total</dt>
              <dd className="tabular">{money(subtotal + tax)}</dd>
            </div>
          </dl>
        </Section>
        <Button
          size="lg"
          disabled={save.isPending || !supplierId || delivery === '' || terms === '' || !lines.some((l) => l.quoted)}
          onClick={() => save.mutate([])}
        >
          <Save /> Cargar cotización
        </Button>
        <Button variant="ghost" onClick={() => navigate(-1)}>
          Cancelar
        </Button>
      </aside>
    </div>
  )
}
