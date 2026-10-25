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
import { api, commands, type EmployeeRow } from '@/lib/api'
import { date, money, todayAR } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const years = (n: number) => (n === 1 ? '1 año' : `${n} años`)

/** Los legajos del personal de la empresa simulada (docs/FASE_6_RRHH_Y_SUELDOS.md §2). */
export function EmployeesPage() {
  const company = useCompany()
  const [editing, setEditing] = useState<EmployeeRow | 'new' | null>(null)
  const [withTerminated, setWithTerminated] = useState(false)
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['employees', company.companyId],
    queryFn: () => api.employees(company.companyId),
  })
  const rows = withTerminated ? data : data.filter((e) => e.status === 'ACTIVO')
  const terminated = data.length - data.filter((e) => e.status === 'ACTIVO').length
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'RRHH' }, { label: 'Legajos' }]}
        title="Legajos del personal"
        description="Los empleados de la empresa simulada: personajes con nombre y apellido inventados, sin documento ni otros datos personales. El personal del taller trabaja en un centro de trabajo."
        actions={
          company.can('employee.create') ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Nuevo legajo
            </Button>
          ) : undefined
        }
      />
      {terminated > 0 && (
        <label className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={withTerminated} onCheckedChange={(v) => setWithTerminated(v === true)} />
          Ver también las bajas ({terminated})
        </label>
      )}
      <DataTable<EmployeeRow>
        rows={rows}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.id}
        search={(r) => `${r.file_number} ${r.last_name} ${r.first_name} ${r.category.name} ${r.sector.name}`}
        searchPlaceholder="Buscar por legajo, apellido, categoría o sector…"
        onRowClick={(r) => setEditing(r)}
        empty="Todavía no hay legajos."
        columns={[
          {
            key: 'file',
            header: 'Legajo',
            align: 'right',
            sort: (r) => r.file_number,
            cell: (r) => <Mono>{r.file_number}</Mono>,
          },
          {
            key: 'name',
            header: 'Apellido y nombre',
            sort: (r) => `${r.last_name} ${r.first_name}`,
            cell: (r) => (
              <span className="font-medium">
                {r.last_name}, {r.first_name}
              </span>
            ),
          },
          {
            key: 'category',
            header: 'Categoría',
            sort: (r) => r.category.name,
            cell: (r) => (
              <span>
                {r.category.name}
                <div className="text-xs text-muted-foreground tabular">{money(r.category.basic_salary)}</div>
              </span>
            ),
          },
          { key: 'sector', header: 'Sector', sort: (r) => r.sector.name, cell: (r) => r.sector.name },
          {
            key: 'center',
            header: 'Centro de trabajo',
            sort: (r) => r.work_center?.code ?? '',
            cell: (r) => (r.work_center ? <Mono>{r.work_center.code}</Mono> : '—'),
          },
          {
            key: 'hire',
            header: 'Ingreso',
            sort: (r) => r.hire_date,
            cell: (r) => (
              <span>
                {date(r.hire_date)}
                <div className="text-xs text-muted-foreground">{years(r.seniority_years)}</div>
              </span>
            ),
          },
          {
            key: 'status',
            header: 'Estado',
            sort: (r) => r.status,
            cell: (r) =>
              r.status === 'ACTIVO' ? (
                <StatusBadge label="Activo" badge="success" />
              ) : (
                <span>
                  <StatusBadge label="Baja" badge="neutral" />
                  <div className="text-xs text-muted-foreground">{date(r.termination_date)}</div>
                </span>
              ),
          },
        ]}
      />
      {editing && (
        <EmployeeDialog
          employee={editing === 'new' ? null : editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </>
  )
}

function EmployeeDialog({
  employee,
  open,
  onOpenChange,
}: {
  employee: EmployeeRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const today = todayAR()
  const { data: categories = [] } = useQuery({
    queryKey: ['job-categories', company.companyId],
    queryFn: () => api.jobCategories(company.companyId),
  })
  const { data: centers = [] } = useQuery({
    queryKey: ['work-centers', company.companyId],
    queryFn: () => api.workCenters(company.companyId),
    enabled: company.can('work_center.read'),
  })
  const [firstName, setFirstName] = useState(employee?.first_name ?? '')
  const [lastName, setLastName] = useState(employee?.last_name ?? '')
  const [hireDate, setHireDate] = useState(employee?.hire_date ?? today)
  const [categoryId, setCategoryId] = useState(employee?.category.id ?? '')
  const [sectorId, setSectorId] = useState(employee?.sector.id ?? '')
  const [centerId, setCenterId] = useState(employee?.work_center?.id ?? '')
  const [terminating, setTerminating] = useState(false)
  const [terminationDate, setTerminationDate] = useState(today)
  const [reason, setReason] = useState('')
  const category = categories.find((c) => c.id === categoryId)
  const direct = category?.is_direct_labor ?? false
  const active = employee?.status !== 'BAJA'
  const canSave = employee ? company.can('employee.update') : company.can('employee.create')
  const save = useCommand(
    () =>
      commands.saveEmployee(company.companyId, {
        id: employee?.id ?? '',
        first_name: firstName,
        last_name: lastName,
        hire_date: hireDate,
        category_id: categoryId,
        sector_id: sectorId,
        work_center_id: direct ? centerId || null : null,
      }),
    {
      success: employee ? 'Legajo actualizado.' : 'Legajo dado de alta.',
      onSuccess: () => onOpenChange(false),
    },
  )
  const terminate = useCommand(
    () => commands.terminateEmployee(company.companyId, employee!.id, terminationDate, reason),
    { success: 'Baja registrada en el legajo.', onSuccess: () => onOpenChange(false) },
  )
  const valid =
    firstName.trim().length >= 2 &&
    lastName.trim().length >= 2 &&
    !!hireDate &&
    !!categoryId &&
    !!sectorId &&
    (!direct || !!centerId)
  const editable = active && canSave
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {employee
              ? `Legajo ${employee.file_number}: ${employee.last_name}, ${employee.first_name}`
              : 'Nuevo legajo'}
          </DialogTitle>
          <DialogDescription>
            {employee && !active
              ? `Dado de baja el ${date(employee.termination_date)}: ${employee.termination_reason}. El legajo ya no se modifica.`
              : 'Un personaje de la empresa simulada: con nombre y apellido alcanza, sin documento ni datos personales.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" required>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              maxLength={60}
              disabled={!editable}
            />
          </Field>
          <Field label="Apellido" required>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={60} disabled={!editable} />
          </Field>
          <Field
            label="Fecha de ingreso"
            required
            hint={employee ? `Antigüedad: ${years(employee.seniority_years)}.` : undefined}
          >
            <Input
              type="date"
              value={hireDate}
              max={today}
              onChange={(e) => setHireDate(e.target.value)}
              disabled={!editable}
            />
          </Field>
          <Field label="Categoría" required>
            <SimpleSelect
              value={categoryId}
              onChange={(id) => {
                setCategoryId(id)
                if (!categories.find((c) => c.id === id)?.is_direct_labor) setCenterId('')
              }}
              options={categories
                .filter((c) => c.is_active || c.id === employee?.category.id)
                .map((c) => ({ value: c.id, label: `${c.name} · ${money(c.basic_salary)}` }))}
              placeholder="Elegí la categoría"
              disabled={!editable}
            />
          </Field>
          <Field label="Sector" required>
            <SimpleSelect
              value={sectorId}
              onChange={setSectorId}
              options={company.sectors.map((s) => ({ value: s.id, label: s.name }))}
              placeholder="Elegí el sector"
              disabled={!editable}
            />
          </Field>
          {direct && (
            <Field label="Centro de trabajo" required hint="Es del taller: mano de obra directa.">
              <SimpleSelect
                value={centerId}
                onChange={setCenterId}
                options={centers
                  .filter((w) => w.is_active || w.id === employee?.work_center?.id)
                  .map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
                placeholder="Elegí el centro"
                disabled={!editable}
              />
            </Field>
          )}
        </div>
        {terminating && (
          <div className="grid gap-4 rounded-lg border border-amber-200 bg-amber-50 p-3 sm:grid-cols-[160px_1fr]">
            <Field label="Fecha de baja" required>
              <Input
                type="date"
                value={terminationDate}
                min={employee?.hire_date}
                max={today}
                onChange={(e) => setTerminationDate(e.target.value)}
              />
            </Field>
            <Field label="Motivo" required hint="Queda en el legajo: renuncia, fin del contrato, jubilación…">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
            </Field>
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          {employee && active && company.can('employee.update') ? (
            terminating ? (
              <Button
                variant="destructive"
                disabled={reason.trim().length < 3 || terminate.isPending}
                onClick={() => terminate.mutate([])}
              >
                {terminate.isPending ? 'Registrando…' : 'Confirmar la baja'}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setTerminating(true)}>
                Dar de baja
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Volver
            </Button>
            {editable && !terminating && (
              <Button disabled={!valid || save.isPending} onClick={() => save.mutate([])}>
                {save.isPending ? 'Guardando…' : employee ? 'Guardar' : 'Dar de alta'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
