import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type DeliveryView, type DocumentDetail } from '@/lib/api'
import { DELIVERY_STATUSES } from '@/lib/domain/catalog'
import { todayAR } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

type Mode = 'OWN' | 'CARRIER'

const MODES: { value: Mode; label: string }[] = [
  { value: 'OWN', label: 'Vehículo propio con su chofer' },
  { value: 'CARRIER', label: 'Transportista contratado' },
]

/** Logística arma la hoja de ruta: la fecha, con qué sale y los remitos en el orden de visita (Fase 7c.2). */
export function RouteSheetFormPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const [departure, setDeparture] = useState(todayAR())
  const [mode, setMode] = useState<Mode>('OWN')
  const [carrierId, setCarrierId] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const [driverId, setDriverId] = useState('')
  const [notes, setNotes] = useState('')
  const [stops, setStops] = useState<string[]>([])
  const candidates = useQuery({
    queryKey: ['route-candidates', company.companyId],
    queryFn: () => api.routeSheetCandidates(company.companyId),
  })
  const carriers = useQuery({
    queryKey: ['carriers', company.companyId],
    queryFn: () => api.carriers(company.companyId),
  })
  const vehicles = useQuery({
    queryKey: ['vehicles', company.companyId],
    queryFn: () => api.vehicles(company.companyId),
  })
  const drivers = useQuery({ queryKey: ['drivers', company.companyId], queryFn: () => api.drivers(company.companyId) })
  const byId = useMemo(() => new Map((candidates.data ?? []).map((c) => [c.id, c])), [candidates.data])
  const create = useCommand(
    () =>
      commands.createRouteSheet(company.companyId, {
        document_date: departure,
        carrier_id: mode === 'CARRIER' ? carrierId || null : null,
        vehicle_id: mode === 'OWN' ? vehicleId || null : null,
        driver_id: mode === 'OWN' ? driverId || null : null,
        notes,
        delivery_note_ids: stops,
      }),
    {
      success: (r) => `${r.display_number} armada: cuando salga el reparto, marcala como en camino.`,
      onSuccess: (r) => navigate(company.docPath('ROUTE_SHEET', r.display_number)),
    },
  )
  const toggle = (id: string) => setStops((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const move = (i: number, delta: number) =>
    setStops((s) => {
      const next = [...s]
      ;[next[i], next[i + delta]] = [next[i + delta], next[i]]
      return next
    })
  const ready = (mode === 'CARRIER' ? !!carrierId : !!vehicleId && !!driverId) && stops.length > 0 && !!departure
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Logística' },
          { label: 'Hojas de ruta', to: company.docPath('ROUTE_SHEET') },
          { label: 'Nueva' },
        ]}
        title="Nueva hoja de ruta"
        description="El reparto de un día: con qué sale (el camión propio con su chofer o un transportista) y qué remitos despachados lleva, en el orden en que se visitan los clientes. Al volver, se rinde: cada remito queda entregado o vuelve a estar pendiente."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Salida">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Fecha de salida" required hint="Hoy o un día posterior.">
                <Input type="date" value={departure} min={todayAR()} onChange={(e) => setDeparture(e.target.value)} />
              </Field>
              <Field label="Sale con" required>
                <SimpleSelect value={mode} onChange={setMode} options={MODES} aria-label="Sale con" />
              </Field>
              {mode === 'OWN' ? (
                <>
                  <Field label="Vehículo" required>
                    <SimpleSelect
                      value={vehicleId}
                      onChange={setVehicleId}
                      options={(vehicles.data ?? [])
                        .filter((v) => v.is_active)
                        .map((v) => ({ value: v.id, label: `${v.code} (${v.plate}) · ${v.description}` }))}
                      placeholder="Elegí el vehículo"
                      aria-label="Vehículo"
                    />
                  </Field>
                  <Field label="Chofer" required hint="Un empleado activo del legajo.">
                    <SimpleSelect
                      value={driverId}
                      onChange={setDriverId}
                      options={(drivers.data ?? []).map((d) => ({
                        value: d.id,
                        label: `${d.name} (legajo ${d.file_number})`,
                      }))}
                      placeholder="Elegí el chofer"
                      aria-label="Chofer"
                    />
                  </Field>
                </>
              ) : (
                <Field
                  label="Transportista"
                  required
                  className="sm:col-span-2"
                  hint="Su flete se registra con su factura."
                >
                  <SimpleSelect
                    value={carrierId}
                    onChange={setCarrierId}
                    options={(carriers.data ?? [])
                      .filter((c) => c.is_active)
                      .map((c) => ({ value: c.id, label: `${c.code} ${c.legal_name}` }))}
                    placeholder="Elegí el transportista"
                    aria-label="Transportista"
                  />
                </Field>
              )}
              <Field label="Observaciones" className="sm:col-span-2">
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                  placeholder="Opcional"
                />
              </Field>
            </div>
          </Section>
          <Section
            title="Remitos despachados pendientes de entrega"
            description="Los más viejos primero. Un remito que no se entregó en otra hoja vuelve a aparecer acá, con el motivo."
            bodyClassName="p-0"
          >
            {candidates.data && candidates.data.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No hay remitos despachados pendientes de entrega: Depósito tiene que despachar primero.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead className="w-10" />
                      <TableHead className="text-xs">Remito</TableHead>
                      <TableHead className="text-xs">Cliente</TableHead>
                      <TableHead className="text-xs">Entregar en</TableHead>
                      <TableHead className="text-xs">Pedido</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(candidates.data ?? []).map((c) => (
                      <TableRow key={c.id} className="cursor-pointer" onClick={() => toggle(c.id)}>
                        <TableCell>
                          <Checkbox
                            checked={stops.includes(c.id)}
                            onClick={(e) => e.stopPropagation()}
                            onCheckedChange={() => toggle(c.id)}
                            aria-label={`Llevar ${c.display_number}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Mono>{c.display_number}</Mono>
                          {c.last_attempt && (
                            <span className="block text-xs text-amber-700">
                              No se entregó con {c.last_attempt.display_number}: {c.last_attempt.reason}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>{c.customer.legal_name}</TableCell>
                        <TableCell className="text-xs">
                          {c.customer.address_line}, {c.customer.city}
                        </TableCell>
                        <TableCell>
                          <Mono>{c.sales_order}</Mono>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
        </div>
        <Section
          title="Orden de visita"
          description={
            stops.length ? 'Se visitan en este orden: movelos con las flechas.' : 'Elegí los remitos que lleva.'
          }
          className="self-start"
        >
          <ol className="flex flex-col gap-2">
            {stops.map((id, i) => {
              const c = byId.get(id)
              return (
                <li key={id} className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm">
                  <span className="w-5 text-center font-semibold text-navy tabular">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Mono>{c?.display_number}</Mono>
                    <span className="block truncate text-xs text-muted-foreground">
                      {c?.customer.legal_name} · {c?.customer.city}
                    </span>
                  </div>
                  <Button size="icon" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Antes">
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={i === stops.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label="Después"
                  >
                    <ArrowDown />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => toggle(id)} aria-label="Quitar">
                    <X />
                  </Button>
                </li>
              )
            })}
          </ol>
          <div className="mt-4 flex gap-2">
            <Button disabled={!ready || create.isPending} onClick={() => create.mutate([])}>
              {create.isPending ? 'Armando…' : 'Armar la hoja de ruta'}
            </Button>
            <Button variant="ghost" onClick={() => navigate(-1)}>
              Cancelar
            </Button>
          </div>
        </Section>
      </div>
    </>
  )
}

/** Cómo terminó (o en qué está) la visita de un remito de la hoja. */
function StopResult({
  status,
  stop,
}: {
  status: string
  stop: NonNullable<DocumentDetail['route_sheet']>['stops'][number]
}) {
  if (stop.outcome === 'ENTREGADO')
    return (
      <span>
        <StatusBadge label="Entregado" badge="success" />
        <span className="block text-xs text-muted-foreground">Recibió: {stop.received_by}</span>
      </span>
    )
  if (stop.outcome === 'NO_ENTREGADO')
    return (
      <span>
        <StatusBadge label="No se entregó" badge="warning" />
        <span className="block text-xs text-muted-foreground">{stop.reason}</span>
      </span>
    )
  if (status === 'BORRADOR') return <StatusBadge {...DELIVERY_STATUSES.PROGRAMADO} />
  if (status === 'EN_CAMINO') return <StatusBadge {...DELIVERY_STATUSES.EN_CAMINO} />
  return <span className="text-muted-foreground">—</span>
}

/** Los remitos de la hoja, en el orden de visita, con el resultado de cada uno. */
export function RouteSheetSection({ detail }: { detail: DocumentDetail }) {
  const rs = detail.route_sheet!
  return (
    <Section title="Remitos, en el orden de visita" bodyClassName="p-0">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="w-10 text-xs">#</TableHead>
              <TableHead className="text-xs">Remito</TableHead>
              <TableHead className="text-xs">Cliente</TableHead>
              <TableHead className="text-xs">Entregar en</TableHead>
              <TableHead className="text-xs">Pedido</TableHead>
              <TableHead className="text-xs">Resultado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rs.stops.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="tabular">{s.line_no}</TableCell>
                <TableCell>
                  <Link className="font-mono hover:underline" to={s.delivery_note.path}>
                    {s.delivery_note.display_number}
                  </Link>
                </TableCell>
                <TableCell>{s.customer.legal_name}</TableCell>
                <TableCell className="text-xs">
                  {s.customer.address_line}, {s.customer.city}
                  {s.customer.phone && <span className="block text-muted-foreground">Tel. {s.customer.phone}</span>}
                </TableCell>
                <TableCell>
                  <Mono>{s.sales_order}</Mono>
                </TableCell>
                <TableCell>
                  <StopResult status={detail.doc.status} stop={s} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}

/** El estado de entrega de un remito despachado, para los datos del remito. */
export function DeliveryStatusInfo({ delivery }: { delivery: DeliveryView }) {
  if (!delivery.delivery_status) return <>—</>
  return (
    <span>
      <StatusBadge {...DELIVERY_STATUSES[delivery.delivery_status]} />
      {delivery.route_sheet && (
        <span className="block text-xs font-normal text-muted-foreground">
          {delivery.outcome === 'NO_ENTREGADO' && delivery.delivery_status === 'PENDIENTE' ? 'No se entregó con ' : ''}
          <Link className="font-mono hover:underline" to={delivery.route_sheet.path}>
            {delivery.route_sheet.display_number}
          </Link>
          {delivery.outcome === 'ENTREGADO' && ` · lo recibió ${delivery.received_by}`}
          {delivery.outcome === 'NO_ENTREGADO' && `: ${delivery.delivery_reason}`}
        </span>
      )}
    </span>
  )
}

interface Outcome {
  delivered: boolean | null
  text: string
}

/** Rendir la hoja: el resultado de cada remito (Ventas recibe un aviso por cada uno). */
export function CloseRouteSheetDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: DocumentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const stops = detail.route_sheet!.stops
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>(() =>
    Object.fromEntries(stops.map((s) => [s.id, { delivered: null, text: '' }])),
  )
  const set = (id: string, patch: Partial<Outcome>) => setOutcomes((o) => ({ ...o, [id]: { ...o[id], ...patch } }))
  const close = useCommand(
    () =>
      commands.closeRouteSheet(
        detail.doc.id,
        stops.map((s) => ({
          line_id: s.id,
          delivered: outcomes[s.id].delivered === true,
          received_by: outcomes[s.id].delivered ? outcomes[s.id].text : '',
          reason: outcomes[s.id].delivered ? '' : outcomes[s.id].text,
        })),
      ),
    { success: 'Hoja rendida: Ventas recibió el aviso de cada entrega.', onSuccess: () => onOpenChange(false) },
  )
  const valid = stops.every((s) => {
    const o = outcomes[s.id]
    const length = o.text.trim().length
    return o.delivered !== null && length >= 3 && length <= (o.delivered ? 80 : 200)
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rendir {detail.doc.display_number}</DialogTitle>
          <DialogDescription>
            Por cada remito: si se entregó, quién lo recibió; si no, por qué. El que no se entregó vuelve a estar
            pendiente para otra hoja.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {stops.map((s) => {
            const o = outcomes[s.id]
            return (
              <div key={s.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="mr-2 font-semibold text-navy tabular">{s.line_no}.</span>
                    <Mono>{s.delivery_note.display_number}</Mono> · {s.customer.legal_name}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={o.delivered === true ? 'default' : 'outline'}
                      onClick={() => set(s.id, { delivered: true })}
                    >
                      Entregado
                    </Button>
                    <Button
                      size="sm"
                      variant={o.delivered === false ? 'default' : 'outline'}
                      onClick={() => set(s.id, { delivered: false })}
                    >
                      No se entregó
                    </Button>
                  </div>
                </div>
                {o.delivered !== null && (
                  <Field label={o.delivered ? 'Recibió (nombre y apellido)' : 'Motivo'} className="mt-2" required>
                    <Input
                      value={o.text}
                      onChange={(e) => set(s.id, { text: e.target.value })}
                      maxLength={o.delivered ? 80 : 200}
                      placeholder={o.delivered ? 'Quién firmó el remito' : 'Por ejemplo, el local estaba cerrado'}
                    />
                  </Field>
                )}
              </div>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={close.isPending}>
            Volver
          </Button>
          <Button disabled={!valid || close.isPending} onClick={() => close.mutate([])}>
            {close.isPending ? 'Rindiendo…' : 'Rendir la hoja'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
