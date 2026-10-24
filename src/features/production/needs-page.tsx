import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { api, commands, type ProductionNeedRow } from '@/lib/api'
import { qty } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Los documentos de una celda (órdenes, solicitudes u órdenes de compra), con su cantidad. */
function DocLinks({
  docs,
  uom,
}: {
  docs: { id: string; display_number: string; path: string; quantity: number }[]
  uom: string
}) {
  if (!docs.length) return null
  return (
    <div className="mt-0.5 flex flex-col text-xs text-muted-foreground">
      {docs.map((d) => (
        <span key={d.id}>
          <Link to={d.path} className="font-mono hover:underline">
            {d.display_number}
          </Link>{' '}
          {qty(d.quantity, uom)}
        </span>
      ))}
    </div>
  )
}

/**
 * Las necesidades de materiales de las órdenes planificadas: lo necesario contra lo
 * disponible, lo que está en camino y lo ya pedido; lo que falta se le pide a Compras
 * (docs/FASE_5_PRODUCCION_Y_COSTOS.md §5).
 */
export function ProductionNeedsPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['production-needs', company.companyId],
    queryFn: () => api.productionNeeds(company.companyId),
  })
  const short = data.filter((r) => r.shortage > 0)
  // Las órdenes que necesitan algo que falta: a ellas queda vinculada la solicitud.
  const orders = [...new Set(short.flatMap((r) => r.orders.map((o) => o.id)))]
  const request = useCommand(() => commands.requestProductionMaterials(company.companyId, orders), {
    success: (r) => `Se generó ${r.display_number} en borrador: revisala y enviala a Compras.`,
    onSuccess: (r) => navigate(company.docPath('PURCHASE_REQUISITION', r.display_number)),
  })
  const canRequest = company.can('purchase_requisition.create')
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Producción' },
          { label: 'Necesidades de materiales' },
        ]}
        title="Necesidades de materiales"
        description="Lo que necesitan las órdenes planificadas contra lo disponible en el depósito (lo que hay menos lo reservado), lo que está en camino (órdenes de compra sin recibir) y lo ya pedido a Compras (solicitudes en curso). Lo que no alcanza es el faltante."
        actions={
          canRequest && short.length > 0 ? (
            <Button disabled={request.isPending} onClick={() => request.mutate([])}>
              <ShoppingCart /> Pedir a Compras lo que falta
            </Button>
          ) : undefined
        }
      />
      <DataTable<ProductionNeedRow>
        rows={data}
        loading={isLoading}
        error={error}
        rowKey={(r) => r.product.id}
        search={(r) => `${r.product.code} ${r.product.name}`}
        searchPlaceholder="Buscar material…"
        empty="No hay órdenes planificadas: las liberadas ya tienen sus materiales reservados."
        columns={[
          {
            key: 'product',
            header: 'Material',
            sort: (r) => r.product.code,
            cell: (r) => (
              <span className="text-sm">
                <span className="font-mono text-xs font-semibold text-navy">{r.product.code}</span> {r.product.name}
              </span>
            ),
          },
          {
            key: 'required',
            header: 'Necesario',
            align: 'right',
            sort: (r) => r.required,
            cell: (r) => (
              <span className="tabular">
                {qty(r.required, r.product.uom_code)}
                <DocLinks docs={r.orders} uom={r.product.uom_code} />
              </span>
            ),
          },
          {
            key: 'available',
            header: 'Disponible',
            align: 'right',
            sort: (r) => r.available,
            cell: (r) => (
              <span className="tabular">
                {qty(Math.max(r.available, 0), r.product.uom_code)}
                {r.reserved > 0 && (
                  <div className="text-xs text-muted-foreground">
                    hay {qty(r.on_hand)}, {qty(r.reserved)} reservados
                  </div>
                )}
              </span>
            ),
          },
          {
            key: 'on_order',
            header: 'En camino',
            align: 'right',
            sort: (r) => r.on_order,
            cell: (r) => (
              <span className="tabular">
                {r.on_order > 0 ? qty(r.on_order, r.product.uom_code) : '—'}
                <DocLinks docs={r.covered_by.filter((c) => c.doc_type === 'PURCHASE_ORDER')} uom={r.product.uom_code} />
              </span>
            ),
          },
          {
            key: 'requested',
            header: 'Ya pedido',
            align: 'right',
            sort: (r) => r.requested,
            cell: (r) => (
              <span className="tabular">
                {r.requested > 0 ? qty(r.requested, r.product.uom_code) : '—'}
                <DocLinks
                  docs={r.covered_by.filter((c) => c.doc_type === 'PURCHASE_REQUISITION')}
                  uom={r.product.uom_code}
                />
              </span>
            ),
          },
          {
            key: 'shortage',
            header: 'Falta',
            align: 'right',
            sort: (r) => r.shortage,
            cell: (r) =>
              r.shortage > 0 ? (
                <span className="tabular font-semibold text-red-700">{qty(r.shortage, r.product.uom_code)}</span>
              ) : r.required > Math.max(r.available, 0) ? (
                <span className="text-xs text-muted-foreground">Cubierto</span>
              ) : (
                <span className="text-xs text-green-700">Alcanza</span>
              ),
          },
        ]}
      />
      {data.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Falta = necesario − disponible − en camino − ya pedido. «Pedir a Compras» genera una solicitud de compra en
          borrador con los faltantes, vinculada a las órdenes; Producción la revisa y la envía. Cuando llega la
          mercadería, cada orden se puede liberar.
        </p>
      )}
    </>
  )
}
