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
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type WorkCenterRow } from '@/lib/api'
import { money, parseAmount } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Los centros de trabajo del taller, con sus tarifas por hora (docs/FASE_5_PRODUCCION_Y_COSTOS.md §4). */
export function WorkCentersPage() {
  const company = useCompany()
  const [editing, setEditing] = useState<WorkCenterRow | 'new' | null>(null)
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['work-centers', company.companyId],
    queryFn: () => api.workCenters(company.companyId),
  })
  const canEdit = company.can('work_center.update')
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Producción' }, { label: 'Centros de trabajo' }]}
        title="Centros de trabajo"
        description="Los sectores del taller, con su tarifa de mano de obra directa y su tasa de carga fabril por hora (predeterminadas). Las listas de materiales dicen cuántas horas lleva cada unidad en cada centro; las órdenes guardan las tarifas con que se planificaron."
        actions={
          canEdit ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Nuevo centro
            </Button>
          ) : undefined
        }
      />
      <DataTable<WorkCenterRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.id}
        search={(r) => `${r.code} ${r.name}`}
        searchPlaceholder="Buscar centro…"
        onRowClick={canEdit ? (r) => setEditing(r) : undefined}
        empty="Todavía no hay centros de trabajo: sin ellos, el costo de los productos es sólo el de sus materiales."
        columns={[
          { key: 'code', header: 'Código', sort: (r) => r.code, cell: (r) => <Mono>{r.code}</Mono> },
          { key: 'name', header: 'Centro', sort: (r) => r.name, cell: (r) => r.name },
          {
            key: 'labor',
            header: 'Mano de obra / h',
            align: 'right',
            sort: (r) => r.labor_rate,
            cell: (r) => <span className="tabular">{money(r.labor_rate)}</span>,
          },
          {
            key: 'overhead',
            header: 'Carga fabril / h',
            align: 'right',
            sort: (r) => r.overhead_rate,
            cell: (r) => <span className="tabular">{money(r.overhead_rate)}</span>,
          },
          {
            key: 'total',
            header: 'Total / h',
            align: 'right',
            sort: (r) => r.labor_rate + r.overhead_rate,
            cell: (r) => <span className="tabular font-medium">{money(r.labor_rate + r.overhead_rate)}</span>,
          },
          { key: 'boms', header: 'Listas', align: 'right', sort: (r) => r.boms, cell: (r) => r.boms },
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
        <CenterDialog
          center={editing === 'new' ? null : editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </>
  )
}

function CenterDialog({
  center,
  open,
  onOpenChange,
}: {
  center: WorkCenterRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const [code, setCode] = useState(center?.code ?? '')
  const [name, setName] = useState(center?.name ?? '')
  const [labor, setLabor] = useState(center ? String(center.labor_rate).replace('.', ',') : '')
  const [overhead, setOverhead] = useState(center ? String(center.overhead_rate).replace('.', ',') : '')
  const laborRate = parseAmount(labor)
  const overheadRate = parseAmount(overhead)
  const save = useCommand(
    () =>
      commands.saveWorkCenter(company.companyId, {
        id: center?.id ?? '',
        code,
        name,
        labor_rate: laborRate,
        overhead_rate: overheadRate,
      }),
    { success: 'Centro de trabajo guardado.', onSuccess: () => onOpenChange(false) },
  )
  const setActive = useCommand(
    (active: boolean) => commands.setWorkCenterActive(company.companyId, center!.id, active),
    { success: 'Listo. El cambio quedó registrado en la auditoría.', onSuccess: () => onOpenChange(false) },
  )
  const valid = !!code.trim() && name.trim().length >= 2 && laborRate >= 0 && overheadRate >= 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{center ? `Centro ${center.code}` : 'Nuevo centro de trabajo'}</DialogTitle>
          <DialogDescription>
            Las tarifas son predeterminadas: con ellas se calcula la conversión de cada orden. Si cambian, las órdenes
            ya planificadas conservan las suyas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <Field label="Código" required hint="Hasta 12 letras o números.">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field
            label="Mano de obra directa por hora"
            className="sm:col-span-2"
            error={labor && !(laborRate >= 0) ? 'Escribí un importe, por ejemplo 9.000.' : undefined}
          >
            <Input inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value)} />
          </Field>
          <Field
            label="Carga fabril por hora"
            className="sm:col-span-2"
            hint="Energía, mantenimiento, amortización de las máquinas y demás costos indirectos del centro."
            error={overhead && !(overheadRate >= 0) ? 'Escribí un importe, por ejemplo 7.000.' : undefined}
          >
            <Input inputMode="decimal" value={overhead} onChange={(e) => setOverhead(e.target.value)} />
          </Field>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {center ? (
            <Button
              variant="outline"
              disabled={setActive.isPending || save.isPending}
              onClick={() => setActive.mutate([!center.is_active])}
            >
              {center.is_active ? 'Desactivar' : 'Activar'}
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
