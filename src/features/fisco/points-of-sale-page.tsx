import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Store } from 'lucide-react'
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
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type PointOfSaleRow } from '@/lib/api'
import { FISCO_MODES, POINT_OF_SALE_STATUSES } from '@/lib/domain/catalog'
import { date } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/**
 * Los puntos de venta de la empresa ante el fisco simulado (8d.2). Los leen quien lee el fisco y
 * quien factura: así, con el módulo del fisco bloqueado, la factura sigue eligiendo su punto de venta.
 */
export function usePointsOfSale() {
  const company = useCompany()
  return useQuery({
    queryKey: ['points-of-sale', company.companyId],
    queryFn: () => api.pointsOfSale(company.companyId),
    enabled: company.can('fisco.read') || company.can('sales_invoice.create'),
  })
}

/** Quien factura pide un punto de venta: el número lo da el fisco (el que sigue). */
function RequestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const company = useCompany()
  const [description, setDescription] = useState('')
  const request = useCommand(() => commands.requestPointOfSale(company.companyId, { description }), {
    success: (r) =>
      r.status === 'HABILITADO'
        ? `El fisco habilitó el punto de venta ${r.number}.`
        : `Se pidió el punto de venta ${r.number}: lo habilita Impuestos.`,
    onSuccess: () => onOpenChange(false),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pedir un punto de venta</DialogTitle>
          <DialogDescription>
            El fisco le da el número que sigue a los que ya tiene la empresa. Mientras espera, la factura de venta no lo
            puede usar; lo habilita o lo rechaza un integrante de Impuestos que no lo pidió.
          </DialogDescription>
        </DialogHeader>
        <Field label="Para qué es" required hint="Por ejemplo: local de ventas, feria, depósito del puerto.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={60} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={request.isPending}>
            Volver
          </Button>
          <Button disabled={request.isPending || description.trim().length < 3} onClick={() => request.mutate([])}>
            Pedir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Quien opera el fisco rechaza un pedido con el motivo, que recibe Ventas. */
function RejectDialog({ pos, onClose }: { pos: PointOfSaleRow; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const reject = useCommand(() => commands.decidePointOfSale(pos.id, { approve: false, reason }), {
    success: `Se rechazó el punto de venta ${pos.number}.`,
    onSuccess: onClose,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rechazar el punto de venta {pos.number}</DialogTitle>
          <DialogDescription>{pos.description}</DialogDescription>
        </DialogHeader>
        <Field label="Motivo" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lo recibe Ventas" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={reject.isPending}>
            Volver
          </Button>
          <Button
            variant="destructive"
            disabled={reject.isPending || reason.trim().length < 3}
            onClick={() => reject.mutate([])}
          >
            Rechazar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Fisco simulado → Puntos de venta: los que tiene la empresa ante el fisco. Ventas pide uno nuevo;
 * Impuestos, que opera el fisco, lo habilita o lo rechaza (no quien lo pidió).
 */
export function PointsOfSalePage() {
  const company = useCompany()
  const { data, isLoading, error } = usePointsOfSale()
  const [requesting, setRequesting] = useState(false)
  const [rejecting, setRejecting] = useState<PointOfSaleRow | null>(null)
  const operate = company.can('fisco.operate')
  const mode = FISCO_MODES[company.company.settings.fisco_mode ?? 'ESTUDIANTES']
  const approve = useCommand((pos: PointOfSaleRow) => commands.decidePointOfSale(pos.id, { approve: true }), {
    success: 'Se habilitó el punto de venta.',
  })
  const crumbs = [{ label: 'Inicio', to: company.to() }, { label: 'Fisco simulado' }, { label: 'Puntos de venta' }]
  if (isLoading || error || !data) return <Loading error={error} />
  const waiting = data.some((p) => p.status === 'SOLICITADO')
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Puntos de venta"
        description={`Los puntos de venta de la empresa ante el fisco simulado: la factura de venta se emite sólo desde uno habilitado, y al registrarla el fisco le da su código de autorización. Los pide Ventas. ${mode.label}. ${mode.description}`}
        actions={
          company.can('sales_invoice.create') && (
            <Button
              onClick={() => setRequesting(true)}
              disabled={waiting}
              title={waiting ? 'Se pide de a uno.' : undefined}
            >
              <Plus /> Pedir un punto de venta
            </Button>
          )
        }
      />
      {data.length ? (
        <Section title={data.length === 1 ? '1 punto de venta' : `${data.length} puntos de venta`} bodyClassName="p-0">
          <DataTable<PointOfSaleRow>
            rows={data}
            rowKey={(r) => r.id}
            columns={[
              { key: 'number', header: 'Número', cell: (r) => <Mono>{r.number}</Mono> },
              { key: 'description', header: 'Para qué es', cell: (r) => r.description },
              {
                key: 'status',
                header: 'Estado',
                cell: (r) => (
                  <StatusBadge
                    label={POINT_OF_SALE_STATUSES[r.status].label}
                    badge={POINT_OF_SALE_STATUSES[r.status].badge}
                  />
                ),
              },
              {
                key: 'requested',
                header: 'Pedido',
                cell: (r) => (
                  <span className="whitespace-normal">
                    {date(r.requested_on)} · {r.requested_by_name ?? 'Apertura de la empresa'}
                  </span>
                ),
              },
              {
                key: 'decided',
                header: 'Respuesta del fisco',
                cell: (r) =>
                  r.decided_on ? (
                    <span className="whitespace-normal">
                      {date(r.decided_on)} · {r.decided_by_name ?? 'el sistema'}
                      {r.rejection_reason && <span className="block text-xs">Motivo: {r.rejection_reason}</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Espera</span>
                  ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Acciones</span>,
                align: 'right',
                cell: (r) =>
                  operate &&
                  r.status === 'SOLICITADO' && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate([r])}>
                        Habilitar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejecting(r)}>
                        Rechazar
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
        </Section>
      ) : (
        <EmptyState icon={Store} title="La empresa no tiene puntos de venta" />
      )}
      {requesting && <RequestDialog open onOpenChange={setRequesting} />}
      {rejecting && <RejectDialog pos={rejecting} onClose={() => setRejecting(null)} />}
    </>
  )
}
