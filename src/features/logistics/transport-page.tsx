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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable } from '@/components/common/data-table'
import { Field, Mono } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands } from '@/lib/api'
import type { Carrier, Vehicle } from '@/lib/domain/types'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const status = (active: boolean) =>
  active ? <StatusBadge label="Activo" badge="success" /> : <StatusBadge label="Inactivo" badge="neutral" />

/** Los transportistas (fletes contratados) y los vehículos propios (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §4). */
export function TransportPage() {
  const company = useCompany()
  const [carrier, setCarrier] = useState<Carrier | 'new' | null>(null)
  const [vehicle, setVehicle] = useState<Vehicle | 'new' | null>(null)
  const carriers = useQuery({
    queryKey: ['carriers', company.companyId],
    queryFn: () => api.carriers(company.companyId),
  })
  const vehicles = useQuery({
    queryKey: ['vehicles', company.companyId],
    queryFn: () => api.vehicles(company.companyId),
  })
  const canCreate = company.can('carrier.create')
  const canEdit = company.can('carrier.update')
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Logística' }, { label: 'Transporte' }]}
        title="Transporte"
        description="Con qué sale el reparto: los fletes contratados y los vehículos propios, que maneja un chofer del legajo. No se borran: se desactivan y una hoja de ruta nueva ya no los usa. Los datos son ficticios."
      />
      <Tabs defaultValue="carriers">
        <TabsList>
          <TabsTrigger value="carriers">Transportistas</TabsTrigger>
          <TabsTrigger value="vehicles">Vehículos propios</TabsTrigger>
        </TabsList>
        <TabsContent value="carriers" className="mt-3">
          <DataTable<Carrier>
            rows={carriers.data ?? []}
            loading={carriers.isLoading}
            error={carriers.error}
            rowKey={(r) => r.id}
            search={(r) => `${r.code} ${r.legal_name} ${r.tax_id}`}
            searchPlaceholder="Buscar transportista o CUIT…"
            onRowClick={canEdit ? (r) => setCarrier(r) : undefined}
            empty="Todavía no hay transportistas."
            toolbar={
              canCreate ? (
                <Button size="sm" onClick={() => setCarrier('new')}>
                  <Plus /> Nuevo transportista
                </Button>
              ) : undefined
            }
            columns={[
              { key: 'code', header: 'Código', sort: (r) => r.code, cell: (r) => <Mono>{r.code}</Mono> },
              { key: 'name', header: 'Razón social', sort: (r) => r.legal_name, cell: (r) => r.legal_name },
              { key: 'tax_id', header: 'CUIT', cell: (r) => <span className="tabular">{r.tax_id}</span> },
              { key: 'phone', header: 'Teléfono', cell: (r) => r.phone || '—' },
              { key: 'status', header: 'Estado', cell: (r) => status(r.is_active) },
            ]}
          />
        </TabsContent>
        <TabsContent value="vehicles" className="mt-3">
          <DataTable<Vehicle>
            rows={vehicles.data ?? []}
            loading={vehicles.isLoading}
            error={vehicles.error}
            rowKey={(r) => r.id}
            search={(r) => `${r.code} ${r.plate} ${r.description}`}
            searchPlaceholder="Buscar vehículo o dominio…"
            onRowClick={canEdit ? (r) => setVehicle(r) : undefined}
            empty="Todavía no hay vehículos propios: el reparto sale con transportistas."
            toolbar={
              canCreate ? (
                <Button size="sm" onClick={() => setVehicle('new')}>
                  <Plus /> Nuevo vehículo
                </Button>
              ) : undefined
            }
            columns={[
              { key: 'code', header: 'Código', sort: (r) => r.code, cell: (r) => <Mono>{r.code}</Mono> },
              { key: 'plate', header: 'Dominio', sort: (r) => r.plate, cell: (r) => <Mono>{r.plate}</Mono> },
              { key: 'description', header: 'Descripción', cell: (r) => r.description },
              { key: 'status', header: 'Estado', cell: (r) => status(r.is_active) },
            ]}
          />
        </TabsContent>
      </Tabs>
      {carrier && (
        <CarrierDialog
          carrier={carrier === 'new' ? null : carrier}
          open={!!carrier}
          onOpenChange={(o) => !o && setCarrier(null)}
        />
      )}
      {vehicle && (
        <VehicleDialog
          vehicle={vehicle === 'new' ? null : vehicle}
          open={!!vehicle}
          onOpenChange={(o) => !o && setVehicle(null)}
        />
      )}
    </>
  )
}

/** El pie de los dos diálogos: activar o desactivar a la izquierda, guardar a la derecha. */
function DialogActions({
  active,
  onToggle,
  onClose,
  onSave,
  valid,
  pending,
}: {
  /** Sin valor para un alta. */
  active?: boolean
  onToggle: () => void
  onClose: () => void
  onSave: () => void
  valid: boolean
  pending: boolean
}) {
  return (
    <DialogFooter className="gap-2 sm:justify-between">
      {active === undefined ? (
        <span />
      ) : (
        <Button variant="outline" disabled={pending} onClick={onToggle}>
          {active ? 'Desactivar' : 'Activar'}
        </Button>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Volver
        </Button>
        <Button disabled={!valid || pending} onClick={onSave}>
          {pending ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </DialogFooter>
  )
}

const TOGGLED = 'Listo. El cambio quedó registrado en la auditoría.'

function CarrierDialog({
  carrier,
  open,
  onOpenChange,
}: {
  carrier: Carrier | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const [code, setCode] = useState(carrier?.code ?? '')
  const [legalName, setLegalName] = useState(carrier?.legal_name ?? '')
  const [taxId, setTaxId] = useState(carrier?.tax_id ?? '')
  const [phone, setPhone] = useState(carrier?.phone ?? '')
  const save = useCommand(
    () =>
      commands.saveCarrier(company.companyId, {
        id: carrier?.id ?? '',
        code,
        legal_name: legalName,
        tax_id: taxId,
        phone,
      }),
    { success: 'Transportista guardado.', onSuccess: () => onOpenChange(false) },
  )
  const setActive = useCommand((active: boolean) => commands.setCarrierActive(company.companyId, carrier!.id, active), {
    success: TOGGLED,
    onSuccess: () => onOpenChange(false),
  })
  const taxIdError =
    taxId.trim() && !/^\d{2}-\d{8}-\d$/.test(taxId.trim()) ? 'Con el formato 30-12345678-9.' : undefined
  const valid = !!code.trim() && legalName.trim().length >= 2 && !!taxId.trim() && !taxIdError
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{carrier ? `Transportista ${carrier.code}` : 'Nuevo transportista'}</DialogTitle>
          <DialogDescription>
            Un flete contratado. Lo que cobra se registra con su factura de proveedor, como cualquier compra.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <Field label="Código" required hint="Por ejemplo, TR-003.">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
          <Field label="Razón social" required>
            <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={80} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="CUIT" required hint="Simulado." error={taxIdError}>
            <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={13} className="tabular" />
          </Field>
          <Field label="Teléfono">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
          </Field>
        </div>
        <DialogActions
          active={carrier?.is_active}
          onToggle={() => setActive.mutate([!carrier!.is_active])}
          onClose={() => onOpenChange(false)}
          onSave={() => save.mutate([])}
          valid={valid}
          pending={save.isPending || setActive.isPending}
        />
      </DialogContent>
    </Dialog>
  )
}

function VehicleDialog({
  vehicle,
  open,
  onOpenChange,
}: {
  vehicle: Vehicle | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const [code, setCode] = useState(vehicle?.code ?? '')
  const [plate, setPlate] = useState(vehicle?.plate ?? '')
  const [description, setDescription] = useState(vehicle?.description ?? '')
  const save = useCommand(
    () => commands.saveVehicle(company.companyId, { id: vehicle?.id ?? '', code, plate, description }),
    { success: 'Vehículo guardado.', onSuccess: () => onOpenChange(false) },
  )
  const setActive = useCommand((active: boolean) => commands.setVehicleActive(company.companyId, vehicle!.id, active), {
    success: TOGGLED,
    onSuccess: () => onOpenChange(false),
  })
  const valid = !!code.trim() && plate.trim().length >= 6 && description.trim().length >= 2
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{vehicle ? `Vehículo ${vehicle.code}` : 'Nuevo vehículo'}</DialogTitle>
          <DialogDescription>Un vehículo de la empresa. Lo maneja un chofer del legajo.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <Field label="Código" required hint="Por ejemplo, CAM-02.">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
          <Field label="Dominio" required hint="Ficticio: por ejemplo, AB 123 CD.">
            <Input
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              maxLength={12}
              className="font-mono"
            />
          </Field>
          <Field label="Descripción" required className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={80} />
          </Field>
        </div>
        <DialogActions
          active={vehicle?.is_active}
          onToggle={() => setActive.mutate([!vehicle!.is_active])}
          onClose={() => onOpenChange(false)}
          onSave={() => save.mutate([])}
          valid={valid}
          pending={save.isPending || setActive.isPending}
        />
      </DialogContent>
    </Dialog>
  )
}
