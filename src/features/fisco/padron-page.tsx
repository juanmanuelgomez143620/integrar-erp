import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, FileBadge, Plus, Printer, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Field, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type TaxpayerRow } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import type { VatCondition } from '@/lib/domain/types'
import { dateTime } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const LEGEND = 'DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL'

/** El padrón del fisco de la empresa (sólo si quien mira lo puede leer). */
export function usePadron() {
  const company = useCompany()
  return useQuery({
    queryKey: ['padron', company.companyId],
    queryFn: () => api.padron(company.companyId),
    enabled: company.can('fisco.read'),
  })
}

/**
 * Lo que dice el padrón de un CUIT, para las fichas de clientes y proveedores: si está, con qué
 * condición (y si es otra que la de la ficha), si está dado de baja o si no está.
 */
export function padronStatus(padron: TaxpayerRow[] | undefined, cuit: string, condition?: VatCondition) {
  const value = cuit.trim()
  if (!padron || !value) return null
  const entry = padron.find((t) => t.cuit === value)
  if (!entry)
    return {
      badge: 'neutral' as const,
      label: 'No está en el padrón',
      text: 'No está en el padrón del fisco: la letra de las facturas sale de la ficha.',
    }
  if (!entry.is_active)
    return {
      badge: 'warning' as const,
      label: 'De baja en el padrón',
      text: 'Está dado de baja del padrón del fisco: la letra de las facturas sale de la ficha.',
    }
  const condition_ = VAT_CONDITIONS[entry.vat_condition].toLowerCase()
  if (condition && condition !== entry.vat_condition)
    return {
      badge: 'warning' as const,
      label: 'Otra condición en el padrón',
      text: `En el padrón figura como ${condition_}: las facturas usan la condición del padrón.`,
    }
  return { badge: 'success' as const, label: 'En el padrón', text: `En el padrón: ${entry.legal_name}, ${condition_}.` }
}

const EMPTY = {
  id: '',
  cuit: '',
  legal_name: '',
  vat_condition: 'RESPONSABLE_INSCRIPTO' as VatCondition,
  activity: '',
  province: '',
}

/** El fisco da de alta o modifica un contribuyente: el CUIT no cambia después del alta. */
function TaxpayerDialog({
  open,
  onOpenChange,
  taxpayer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  taxpayer: TaxpayerRow | null
}) {
  const company = useCompany()
  const [values, setValues] = useState(() => (taxpayer ? { ...taxpayer } : EMPTY))
  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }))
  const save = useCommand(
    () =>
      commands.saveTaxpayer(company.companyId, {
        id: values.id,
        cuit: values.cuit,
        legal_name: values.legal_name,
        vat_condition: values.vat_condition,
        activity: values.activity,
        province: values.province,
      }),
    {
      success: taxpayer ? 'Se modificó el contribuyente.' : 'Se dio de alta el contribuyente en el padrón.',
      onSuccess: () => onOpenChange(false),
    },
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{taxpayer ? `Modificar ${taxpayer.legal_name}` : 'Alta en el padrón'}</DialogTitle>
          <DialogDescription>
            Datos ficticios del fisco simulado. El CUIT lleva el dígito verificador y no cambia después del alta; si
            cambia la condición frente al IVA, cambia la letra de las facturas que se le emitan.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CUIT" required>
            <Input
              value={values.cuit}
              onChange={(e) => set({ cuit: e.target.value })}
              placeholder="30-00000000-0"
              disabled={!!taxpayer}
            />
          </Field>
          <Field label="Condición frente al IVA" required>
            <SimpleSelect
              value={values.vat_condition}
              onChange={(v: VatCondition) => set({ vat_condition: v })}
              options={(Object.keys(VAT_CONDITIONS) as VatCondition[]).map((v) => ({
                value: v,
                label: VAT_CONDITIONS[v],
              }))}
              aria-label="Condición frente al IVA"
            />
          </Field>
          <Field label="Razón social" required className="sm:col-span-2">
            <Input value={values.legal_name} onChange={(e) => set({ legal_name: e.target.value })} maxLength={80} />
          </Field>
          <Field label="Actividad" className="sm:col-span-2">
            <Input value={values.activity} onChange={(e) => set({ activity: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Provincia">
            <Input value={values.province} onChange={(e) => set({ province: e.target.value })} maxLength={60} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Volver
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate([])}>
            {taxpayer ? 'Guardar' : 'Dar de alta'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Fisco simulado → Padrón: los contribuyentes del entorno de la empresa. Impuestos, que opera el
 * fisco, los da de alta, los modifica y los da de baja; quien lee el fisco consulta y saca la
 * constancia de inscripción.
 */
export function PadronPage() {
  const company = useCompany()
  const { data, isLoading, error } = usePadron()
  const [editing, setEditing] = useState<TaxpayerRow | null | undefined>(undefined)
  const operate = company.can('fisco.operate')
  const toggle = useCommand(
    (row: TaxpayerRow) => commands.setTaxpayerActive(company.companyId, row.id, !row.is_active),
    { success: 'Se actualizó el padrón.' },
  )
  const crumbs = [{ label: 'Inicio', to: company.to() }, { label: 'Fisco simulado' }, { label: 'Padrón' }]
  if (isLoading || error || !data) return <Loading error={error} />
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Padrón de contribuyentes"
        description="El padrón del fisco simulado de la empresa: el CUIT, la razón social, la condición frente al IVA y la actividad de cada contribuyente. La letra de las facturas de venta sale de acá. Lo opera Impuestos."
        actions={
          operate && (
            <Button onClick={() => setEditing(null)}>
              <Plus /> Alta en el padrón
            </Button>
          )
        }
      />
      {data.length ? (
        <Section title={`${data.length} contribuyentes`} bodyClassName="p-0">
          <DataTable<TaxpayerRow>
            rows={data}
            rowKey={(r) => r.id}
            search={(r) => `${r.cuit} ${r.legal_name} ${r.activity} ${r.province}`}
            columns={[
              { key: 'cuit', header: 'CUIT', cell: (r) => <Mono>{r.cuit}</Mono> },
              {
                key: 'name',
                header: 'Razón social',
                sort: (r) => r.legal_name,
                cell: (r) => (
                  <span className="whitespace-normal">
                    {r.legal_name}
                    {r.is_company && (
                      <>
                        {' '}
                        <StatusBadge label="La empresa" badge="info" />
                      </>
                    )}
                  </span>
                ),
              },
              { key: 'vat', header: 'Condición', cell: (r) => VAT_CONDITIONS[r.vat_condition] },
              { key: 'activity', header: 'Actividad', cell: (r) => r.activity || '—' },
              { key: 'province', header: 'Provincia', cell: (r) => r.province || '—' },
              {
                key: 'status',
                header: 'Estado',
                cell: (r) =>
                  r.is_active ? (
                    <StatusBadge label="Activo" badge="success" />
                  ) : (
                    <StatusBadge label="De baja" badge="warning" />
                  ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Acciones</span>,
                align: 'right',
                cell: (r) => (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" asChild>
                      <Link to={company.to(`fisco/constancia/${r.cuit}/imprimir`)}>
                        <FileBadge /> Constancia
                      </Link>
                    </Button>
                    {operate && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                          Modificar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate([r])}
                        >
                          {r.is_active ? 'Dar de baja' : 'Volver a dar de alta'}
                        </Button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Section>
      ) : (
        <EmptyState icon={ScrollText} title="El padrón está vacío" />
      )}
      {editing !== undefined && (
        <TaxpayerDialog
          key={editing?.id ?? 'nuevo'}
          open
          onOpenChange={(open) => !open && setEditing(undefined)}
          taxpayer={editing}
        />
      )}
    </>
  )
}

/** La constancia de inscripción de un CUIT, para imprimir: formato propio y la leyenda de simulación. */
export function ConstanciaPrintPage() {
  const { cuit = '' } = useParams()
  const navigate = useNavigate()
  const { data, isLoading, error } = usePadron()
  if (isLoading) return <Loading />
  const entry = data?.find((t) => t.cuit === cuit)
  if (error || !entry) return <p className="p-10 text-center">Ese CUIT no está en el padrón del fisco simulado.</p>
  return (
    <div className="min-h-svh bg-slate-200 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between gap-2 px-2">
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft /> Volver
        </Button>
        <span className="text-xs text-muted-foreground">
          Usá “Guardar como PDF” en el diálogo de impresión para exportarla.
        </span>
        <Button onClick={() => window.print()}>
          <Printer /> Imprimir / PDF
        </Button>
      </div>
      <article className="mx-auto w-[210mm] max-w-full bg-white p-10 text-[13px] text-slate-900 shadow-lg print:shadow-none">
        <p className="mb-6 border border-slate-400 py-1 text-center text-[10px] font-bold tracking-wide">{LEGEND}</p>
        <header className="mb-6 border-b-2 border-navy pb-3">
          <div className="text-lg font-black text-navy">Fisco simulado</div>
          <div className="text-slate-600">Organismo fiscal del aula: no es un organismo real</div>
          <div className="mt-3 text-base font-bold">Constancia de inscripción en el padrón</div>
          <div className="text-[11px] text-slate-600">Consultada el {dateTime(new Date().toISOString())}</div>
        </header>
        <dl className="grid grid-cols-[180px_1fr] gap-y-2">
          <dt className="text-slate-600">CUIT (simulado)</dt>
          <dd className="font-mono font-semibold">{entry.cuit}</dd>
          <dt className="text-slate-600">Razón social</dt>
          <dd className="font-semibold">{entry.legal_name}</dd>
          <dt className="text-slate-600">Condición frente al IVA</dt>
          <dd>{VAT_CONDITIONS[entry.vat_condition]}</dd>
          <dt className="text-slate-600">Actividad</dt>
          <dd>{entry.activity || '—'}</dd>
          <dt className="text-slate-600">Provincia</dt>
          <dd>{entry.province || '—'}</dd>
          <dt className="text-slate-600">Estado</dt>
          <dd>{entry.is_active ? 'Activo' : 'Dado de baja'}</dd>
        </dl>
        <p className="mt-10 border-t border-slate-300 pt-1.5 text-center text-[9px] text-slate-500">
          {LEGEND} · Generado por INTEGR-AR (familia GEST-AR) · Fisco, empresa y datos ficticios con fines
          exclusivamente educativos.
        </p>
      </article>
    </div>
  )
}
