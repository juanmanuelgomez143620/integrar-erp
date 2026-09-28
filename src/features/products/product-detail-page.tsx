import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { InfoRow, KpiCard, Loading, Section } from '@/components/common/blocks'
import { DataTable } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands } from '@/lib/api'
import { MOVEMENT_TYPES, PRODUCT_TYPES, UNITS } from '@/lib/domain/catalog'
import { date, dateTime, money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { ProductSheet } from './product-form'

export function ProductDetailPage() {
  const { code = '' } = useParams()
  const company = useCompany()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['product', company.companyId, code],
    queryFn: () => api.product(company.companyId, code),
  })
  const toggle = useCommand((id: string, active: boolean) =>
    commands.setMasterActive('product', company.companyId, id, active),
  )
  if (isLoading) return <Loading />
  if (!data)
    return <p className="py-20 text-center text-sm text-muted-foreground">No se encontró el producto {code}.</p>
  const p = data.product
  const canRequest = p.is_stockable && company.can('purchase_requisition.create')

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Productos', to: company.to('productos') },
          { label: p.code },
        ]}
        title={
          <>
            <span className="font-mono">{p.code}</span> · {p.name}
          </>
        }
        meta={
          p.below_min ? (
            <StatusBadge label="Bajo stock mínimo" badge="danger" />
          ) : !p.is_active ? (
            <StatusBadge label="Inactivo" badge="neutral" />
          ) : undefined
        }
        actions={
          <>
            {company.can('product.update') && (
              <>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch checked={p.is_active} onCheckedChange={(v) => toggle.mutate([p.id, v])} /> Activo
                </label>
                <Button variant="outline" onClick={() => setOpen(true)}>
                  <Pencil /> Editar
                </Button>
              </>
            )}
            {canRequest && (
              <Button asChild>
                <Link to={`${company.docPath('PURCHASE_REQUISITION', 'nueva')}?producto=${p.code}`}>
                  <ClipboardList /> Solicitar compra
                </Link>
              </Button>
            )}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Stock total"
          value={p.is_stockable ? qty(p.stock, p.uom_code) : 'No aplica'}
          tone={p.below_min ? 'danger' : 'default'}
          hint={p.is_stockable ? `Mínimo ${qty(p.min_stock, p.uom_code)}` : 'Los servicios no llevan stock'}
        />
        <KpiCard
          label="Costo promedio (PPP)"
          value={money(p.avg_cost)}
          hint={`Costo de referencia ${money(p.standard_cost)}`}
        />
        <KpiCard label="Valor en stock" value={money(p.stock * p.avg_cost)} />
        <KpiCard
          label="Precio de venta"
          value={p.sale_price != null ? money(p.sale_price) : '—'}
          hint={`IVA ${String(p.vat_rate).replace('.', ',')} %`}
        />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
        <Section
          title="Kardex"
          description="Historial de movimientos: cada entrada y salida con su documento de origen y el saldo resultante."
          className="min-w-0"
          bodyClassName="p-0"
        >
          <div className="p-3">
            <DataTable
              rows={data.kardex}
              rowKey={(m) => String(m.id)}
              empty="Sin movimientos."
              columns={[
                {
                  key: 'date',
                  header: 'Fecha',
                  cell: (m) => (
                    <span className="text-xs" title={dateTime(m.created_at)}>
                      {date(m.movement_date)}
                    </span>
                  ),
                },
                {
                  key: 'type',
                  header: 'Movimiento',
                  cell: (m) => <span className="text-xs">{MOVEMENT_TYPES[m.movement_type]}</span>,
                },
                {
                  key: 'doc',
                  header: 'Documento',
                  cell: (m) =>
                    m.document_path ? (
                      <Link className="font-mono text-xs hover:underline" to={m.document_path}>
                        {m.document_label}
                      </Link>
                    ) : (
                      '—'
                    ),
                },
                { key: 'wh', header: 'Depósito', cell: (m) => <span className="text-xs">{m.warehouse_name}</span> },
                {
                  key: 'qty',
                  header: 'Cantidad',
                  align: 'right',
                  cell: (m) => (
                    <span className={cn('tabular font-medium', m.quantity < 0 ? 'text-red-700' : 'text-green-700')}>
                      {m.quantity > 0 ? '+' : ''}
                      {qty(m.quantity)}
                    </span>
                  ),
                },
                {
                  key: 'cost',
                  header: 'Costo unit.',
                  align: 'right',
                  cell: (m) => <span className="tabular">{money(m.unit_cost)}</span>,
                },
                {
                  key: 'bal',
                  header: 'Saldo',
                  align: 'right',
                  cell: (m) => <span className="tabular font-semibold">{qty(m.balance_qty)}</span>,
                },
                {
                  key: 'ppp',
                  header: 'PPP',
                  align: 'right',
                  cell: (m) => <span className="tabular text-xs">{money(m.balance_avg_cost)}</span>,
                },
                { key: 'user', header: 'Usuario', cell: (m) => <span className="text-xs">{m.user_name}</span> },
              ]}
            />
          </div>
        </Section>
        <div className="flex flex-col gap-4">
          <Section title="Ficha">
            <dl>
              <InfoRow label="Tipo">{PRODUCT_TYPES[p.product_type]}</InfoRow>
              <InfoRow label="Categoría">{p.category || '—'}</InfoRow>
              <InfoRow label="Unidad">
                {p.uom_code} · {UNITS[p.uom_code]?.name}
              </InfoRow>
              <InfoRow label="Proveedor habitual">{p.supplier_name}</InfoRow>
              <InfoRow label="Reposición sugerida">
                {p.reorder_qty != null ? qty(p.reorder_qty, p.uom_code) : '—'}
              </InfoRow>
              <InfoRow label="Ubicación">{p.location || '—'}</InfoRow>
            </dl>
          </Section>
          {data.balances.length > 0 && (
            <Section title="Stock por depósito">
              <ul className="flex flex-col gap-2 text-sm">
                {data.balances.map((b) => (
                  <li key={b.warehouse_id} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{b.warehouse_name}</span>
                    <span className="tabular font-medium">{qty(b.qty_on_hand, p.uom_code)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
      <ProductSheet open={open} onOpenChange={setOpen} product={p} />
    </>
  )
}
