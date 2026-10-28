import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { api, commands, type JobCategoryRow, type LaborAgreementRow } from '@/lib/api'
import { money, parseAmount } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Las categorías del personal, cada una en un convenio, con su básico o su valor hora (docs/FASE_6D_CONVENIOS.md). */
export function JobCategoriesPage() {
  const company = useCompany()
  const [editing, setEditing] = useState<JobCategoryRow | 'new' | null>(null)
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['job-categories', company.companyId],
    queryFn: () => api.jobCategories(company.companyId),
  })
  const agreements = useQuery({
    queryKey: ['labor-agreements', company.companyId],
    queryFn: () => api.laborAgreements(company.companyId),
  })
  const canEdit = company.can('employee.update')
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'RRHH' }, { label: 'Categorías' }]}
        title="Categorías del personal"
        description="Cada categoría es de un convenio: en uno por mes tiene sueldo básico mensual; en uno por hora (jornalizados), valor hora. Las del taller son mano de obra directa: su gente trabaja en un centro de trabajo."
        actions={
          canEdit ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Nueva categoría
            </Button>
          ) : undefined
        }
      />
      <DataTable<JobCategoryRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.id}
        search={(r) => `${r.code} ${r.name} ${r.agreement.code}`}
        searchPlaceholder="Buscar categoría…"
        onRowClick={canEdit ? (r) => setEditing(r) : undefined}
        empty="Todavía no hay categorías: sin ellas no se dan de alta legajos."
        columns={[
          { key: 'code', header: 'Código', sort: (r) => r.code, cell: (r) => <Mono>{r.code}</Mono> },
          { key: 'name', header: 'Categoría', sort: (r) => r.name, cell: (r) => r.name },
          {
            key: 'agreement',
            header: 'Convenio',
            sort: (r) => r.agreement.code,
            cell: (r) => <span className="text-xs">{r.agreement.name}</span>,
          },
          {
            key: 'salary',
            header: 'Básico o valor hora',
            align: 'right',
            sort: (r) => r.basic_salary,
            cell: (r) => (
              <span className="tabular">
                {money(r.basic_salary)}
                <span className="text-xs text-muted-foreground">
                  {r.agreement.pay_basis === 'HOURLY' ? ' por hora' : ' por mes'}
                </span>
              </span>
            ),
          },
          {
            key: 'direct',
            header: 'Taller',
            sort: (r) => (r.is_direct_labor ? 1 : 0),
            cell: (r) => (r.is_direct_labor ? 'Mano de obra directa' : '—'),
          },
          { key: 'employees', header: 'Personal', align: 'right', sort: (r) => r.employees, cell: (r) => r.employees },
          {
            key: 'status',
            header: 'Estado',
            cell: (r) =>
              r.is_active ? (
                <StatusBadge label="Activa" badge="success" />
              ) : (
                <StatusBadge label="Inactiva" badge="neutral" />
              ),
          },
        ]}
      />
      {editing && (
        <CategoryDialog
          agreements={agreements.data ?? []}
          category={editing === 'new' ? null : editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </>
  )
}

function CategoryDialog({
  agreements,
  category,
  open,
  onOpenChange,
}: {
  agreements: LaborAgreementRow[]
  category: JobCategoryRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const [code, setCode] = useState(category?.code ?? '')
  const [name, setName] = useState(category?.name ?? '')
  const [salary, setSalary] = useState(category ? String(category.basic_salary).replace('.', ',') : '')
  const [direct, setDirect] = useState(category?.is_direct_labor ?? false)
  const [agreementId, setAgreementId] = useState(category?.agreement.id ?? '')
  const agreement = agreements.find((a) => a.id === agreementId)
  const hourly = agreement?.pay_basis === 'HOURLY'
  const basicSalary = parseAmount(salary)
  const save = useCommand(
    () =>
      commands.saveJobCategory(company.companyId, {
        id: category?.id ?? '',
        code,
        name,
        agreement_id: agreementId,
        basic_salary: basicSalary,
        is_direct_labor: direct,
      }),
    { success: 'Categoría guardada.', onSuccess: () => onOpenChange(false) },
  )
  const setActive = useCommand(
    (active: boolean) => commands.setJobCategoryActive(company.companyId, category!.id, active),
    { success: 'Listo. El cambio quedó registrado en la auditoría.', onSuccess: () => onOpenChange(false) },
  )
  const valid = !!code.trim() && name.trim().length >= 2 && !!agreementId && basicSalary > 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{category ? `Categoría ${category.code}` : 'Nueva categoría'}</DialogTitle>
          <DialogDescription>
            El convenio dice cómo cobra su gente: por mes, con un sueldo básico, o por hora, con un valor hora. Las
            escalas son ficticias (a validar).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <Field label="Código" required hint="Hasta 12 letras o números.">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Convenio" required className="sm:col-span-2">
            <SimpleSelect
              value={agreementId}
              onChange={setAgreementId}
              placeholder="Elegí el convenio"
              options={agreements
                .filter((a) => a.is_active || a.id === category?.agreement.id)
                .map((a) => ({
                  value: a.id,
                  label: `${a.name} (${a.pay_basis === 'HOURLY' ? 'por hora' : 'por mes'})`,
                }))}
              aria-label="Convenio"
            />
          </Field>
          <Field
            label={hourly ? 'Valor hora' : 'Sueldo básico mensual'}
            className="sm:col-span-2"
            error={
              salary && !(basicSalary > 0)
                ? `Escribí un importe, por ejemplo ${hourly ? '7.100' : '1.250.000'}.`
                : undefined
            }
          >
            <Input inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <Checkbox
              className="mt-0.5"
              checked={direct}
              onCheckedChange={(v) => setDirect(v === true)}
              disabled={!!category && category.employees > 0}
            />
            <span>
              Es del taller (mano de obra directa): su gente trabaja en un centro de trabajo.
              {!!category && category.employees > 0 && (
                <span className="block text-xs text-muted-foreground">
                  Tiene personal activo: para cambiarlo, primero pasalo a otra categoría.
                </span>
              )}
            </span>
          </label>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {category ? (
            <Button
              variant="outline"
              disabled={setActive.isPending || save.isPending}
              onClick={() => setActive.mutate([!category.is_active])}
            >
              {category.is_active ? 'Desactivar' : 'Activar'}
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
