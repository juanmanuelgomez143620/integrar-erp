import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DataTable } from '@/components/common/data-table'
import { Field, Mono } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type LaborAgreementRow } from '@/lib/api'
import { PAY_BASES } from '@/lib/domain/catalog'
import type { PayBasis } from '@/lib/domain/types'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { rate } from './payroll'

const RATES: [
  keyof Pick<LaborAgreementRow, 'seniority_pct' | 'attendance_pct' | 'union_pct' | 'union_employer_pct'>,
  string,
  string,
][] = [
  ['seniority_pct', 'Antigüedad (%)', 'Del básico, por año cumplido.'],
  ['attendance_pct', 'Presentismo (%)', 'Del básico más la antigüedad, si no faltó sin aviso.'],
  ['union_pct', 'Aporte sindical (%)', 'Se le retiene al empleado.'],
  ['union_employer_pct', 'Contribución de la empresa (%)', 'Seguro de vida, fondo social: a cargo de la empresa.'],
]

/** Los convenios colectivos: cómo cobra su gente y sus adicionales y aportes (docs/FASE_6D_CONVENIOS.md). */
export function LaborAgreementsPage() {
  const company = useCompany()
  const [editing, setEditing] = useState<LaborAgreementRow | 'new' | null>(null)
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['labor-agreements', company.companyId],
    queryFn: () => api.laborAgreements(company.companyId),
  })
  const canEdit = company.can('employee.update')
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'RRHH' }, { label: 'Convenios' }]}
        title="Convenios colectivos"
        description="Cada empleado está en un convenio según su tarea: el convenio dice si cobra por mes o por hora, y sus adicionales (antigüedad, presentismo) y aportes sindicales. Las escalas y los porcentajes son ficticios: se ajustan con los textos vigentes (a validar)."
        actions={
          canEdit ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Nuevo convenio
            </Button>
          ) : undefined
        }
      />
      <DataTable<LaborAgreementRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.id}
        search={(r) => `${r.code} ${r.name} ${r.union_name}`}
        searchPlaceholder="Buscar convenio o sindicato…"
        onRowClick={canEdit ? (r) => setEditing(r) : undefined}
        empty="Todavía no hay convenios: sin ellos no se crean categorías."
        columns={[
          { key: 'code', header: 'Código', sort: (r) => r.code, cell: (r) => <Mono>{r.code}</Mono> },
          {
            key: 'name',
            header: 'Convenio',
            sort: (r) => r.name,
            cell: (r) => (
              <span>
                {r.name}
                {r.union_name && <span className="block text-xs text-muted-foreground">{r.union_name}</span>}
              </span>
            ),
          },
          { key: 'basis', header: 'Cómo cobran', sort: (r) => r.pay_basis, cell: (r) => PAY_BASES[r.pay_basis] },
          {
            key: 'extras',
            header: 'Antigüedad · presentismo',
            cell: (r) => (
              <span className="tabular text-xs">
                {rate(r.seniority_pct)} por año · {rate(r.attendance_pct)}
              </span>
            ),
          },
          {
            key: 'union',
            header: 'Aporte · contribución',
            cell: (r) => (
              <span className="tabular text-xs">
                {rate(r.union_pct)} · {rate(r.union_employer_pct)}
              </span>
            ),
          },
          {
            key: 'people',
            header: 'Categorías · personal',
            align: 'right',
            sort: (r) => r.employees,
            cell: (r) => `${r.categories} · ${r.employees}`,
          },
          {
            key: 'status',
            header: 'Estado',
            cell: (r) =>
              r.is_active ? (
                <StatusBadge label="Activo" badge="success" />
              ) : (
                <StatusBadge label="Inactivo" badge="neutral" />
              ),
          },
        ]}
      />
      {editing && (
        <AgreementDialog
          agreement={editing === 'new' ? null : editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </>
  )
}

const percent = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : Number.NaN
}

function AgreementDialog({
  agreement,
  open,
  onOpenChange,
}: {
  agreement: LaborAgreementRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const [code, setCode] = useState(agreement?.code ?? '')
  const [name, setName] = useState(agreement?.name ?? '')
  const [unionName, setUnionName] = useState(agreement?.union_name ?? '')
  const [basis, setBasis] = useState<PayBasis>(agreement?.pay_basis ?? 'MONTHLY')
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(RATES.map(([key]) => [key, String(agreement?.[key] ?? 0).replace('.', ',')])),
  )
  const parsed = Object.fromEntries(RATES.map(([key]) => [key, percent(values[key])])) as Record<
    (typeof RATES)[number][0],
    number
  >
  const save = useCommand(
    () =>
      commands.saveLaborAgreement(company.companyId, {
        id: agreement?.id ?? '',
        code,
        name,
        union_name: unionName,
        pay_basis: basis,
        ...parsed,
      }),
    { success: 'Convenio guardado.', onSuccess: () => onOpenChange(false) },
  )
  const setActive = useCommand(
    (active: boolean) => commands.setLaborAgreementActive(company.companyId, agreement!.id, active),
    { success: 'Listo. El cambio quedó registrado en la auditoría.', onSuccess: () => onOpenChange(false) },
  )
  const ratesValid = RATES.every(([key]) => parsed[key] >= 0 && parsed[key] <= 100)
  const valid = !!code.trim() && name.trim().length >= 2 && ratesValid
  const locked = !!agreement && agreement.categories > 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{agreement ? `Convenio ${agreement.code}` : 'Nuevo convenio'}</DialogTitle>
          <DialogDescription>
            Los porcentajes se copian en cada liquidación: cambiarlos no altera las ya hechas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <Field label="Código" required hint="Hasta 12 letras o números.">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Sindicato" className="sm:col-span-2" hint="Vacío si es fuera de convenio.">
            <Input value={unionName} onChange={(e) => setUnionName(e.target.value)} maxLength={60} />
          </Field>
          <Field
            label="Cómo cobra su gente"
            className="sm:col-span-2"
            hint={locked ? 'Tiene categorías: para pagar de otra forma, creá otro convenio.' : undefined}
          >
            <SimpleSelect
              value={basis}
              onChange={setBasis}
              disabled={locked}
              options={(Object.keys(PAY_BASES) as PayBasis[]).map((b) => ({ value: b, label: PAY_BASES[b] }))}
              aria-label="Cómo cobra su gente"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {RATES.map(([key, label, hint]) => (
            <Field
              key={key}
              label={label}
              hint={hint}
              error={!(parsed[key] >= 0 && parsed[key] <= 100) ? 'De 0 a 100.' : undefined}
            >
              <Input
                inputMode="decimal"
                value={values[key]}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                className="tabular text-right"
              />
            </Field>
          ))}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {agreement ? (
            <Button
              variant="outline"
              disabled={setActive.isPending || save.isPending}
              onClick={() => setActive.mutate([!agreement.is_active])}
            >
              {agreement.is_active ? 'Desactivar' : 'Activar'}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Volver
            </Button>
            <Button disabled={!valid || save.isPending} onClick={() => save.mutate([])}>
              {save.isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
