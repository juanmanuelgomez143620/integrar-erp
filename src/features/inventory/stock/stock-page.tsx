import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { DataTable } from '@/components/common/data-table'
import { KpiCard, Mono } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type StockRow } from '@/lib/api'
import { PRODUCT_TYPES } from '@/lib/domain/catalog'
import { money, moneyShort, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

export function StockPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const { data = [], isLoading } = useQuery({
    queryKey: ['stock', company.companyId],
    queryFn: () => api.stock(company.companyId),
  })
  const [onlyLow, setOnlyLow] = useState(false)
  const [warehouse, setWarehouse] = useState('ALL')
  const rows = data.filter((r) => (!onlyLow || r.below_min) && (warehouse === 'ALL' || r.warehouse.id === warehouse))
  const canRequest = company.can('purchase_requisition.create')
  const lowProducts = new Set(data.filter((r) => r.below_min).map((r) => r.product.id))
  const total = data.reduce((s, r) => s + r.value, 0)

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Depósito' }, { label: 'Stock' }]}
        title="Existencias"
        description="Saldo de cada producto por depósito, valuado a costo promedio ponderado (PPP). El stock sólo cambia con documentos: recepciones y ajustes."
        actions={
          company.can('stock_adjustment.create') ? (
            <Button variant="outline" asChild>
              <Link to={company.docPath('STOCK_ADJUSTMENT', 'nuevo')}>
                <SlidersHorizontal /> Ajuste de stock
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Valor del inventario" value={moneyShort(total)} hint={money(total)} />
        <KpiCard
          label="Productos bajo mínimo"
          value={lowProducts.size}
          tone={lowProducts.size ? 'danger' : 'default'}
          hint="Requieren reposición"
        />
        {company.warehouses.map((w) => (
          <KpiCard
            key={w.id}
            label={w.name}
            value={moneyShort(data.filter((r) => r.warehouse.id === w.id).reduce((s, r) => s + r.value, 0))}
            hint={`${data.filter((r) => r.warehouse.id === w.id && r.qty > 0).length} productos con stock`}
          />
        ))}
      </div>
      <DataTable<StockRow>
        rows={rows}
        loading={isLoading}
        rowKey={(r) => `${r.product.id}-${r.warehouse.id}`}
        search={(r) => `${r.product.code} ${r.product.name}`}
        searchPlaceholder="Buscar producto…"
        onRowClick={(r) => navigate(company.to(`productos/${r.product.code}`))}
        rowClassName={(r) => (r.below_min ? 'bg-red-50/60' : undefined)}
        toolbar={
          <>
            <select
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              <option value="ALL">Todos los depósitos</option>
              {company.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={onlyLow} onCheckedChange={setOnlyLow} /> Sólo bajo mínimo
            </label>
          </>
        }
        columns={[
          { key: 'code', header: 'Código', sort: (r) => r.product.code, cell: (r) => <Mono>{r.product.code}</Mono> },
          { key: 'name', header: 'Producto', sort: (r) => r.product.name, cell: (r) => r.product.name },
          {
            key: 'type',
            header: 'Tipo',
            cell: (r) => <span className="text-xs">{PRODUCT_TYPES[r.product.product_type]}</span>,
          },
          { key: 'wh', header: 'Depósito', cell: (r) => <span className="text-xs">{r.warehouse.code}</span> },
          {
            key: 'qty',
            header: 'Stock',
            align: 'right',
            sort: (r) => r.qty,
            cell: (r) => (
              <span className={cn('tabular font-semibold', r.below_min && 'text-red-700')}>
                {qty(r.qty, r.product.uom_code)}
              </span>
            ),
          },
          {
            key: 'min',
            header: 'Mínimo',
            align: 'right',
            cell: (r) => <span className="tabular text-muted-foreground">{qty(r.product.min_stock)}</span>,
          },
          {
            key: 'ppp',
            header: 'PPP',
            align: 'right',
            cell: (r) => <span className="tabular">{money(r.avg_cost)}</span>,
          },
          {
            key: 'value',
            header: 'Valor',
            align: 'right',
            sort: (r) => r.value,
            cell: (r) => <span className="tabular">{money(r.value)}</span>,
          },
          {
            key: 'action',
            header: '',
            align: 'right',
            cell: (r) =>
              r.below_min ? (
                <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  <StatusBadge label="Bajo mínimo" badge="danger" />
                  {canRequest && (
                    <Button size="xs" asChild>
                      <Link to={`${company.docPath('PURCHASE_REQUISITION', 'nueva')}?producto=${r.product.code}`}>
                        <ClipboardList /> Solicitar
                      </Link>
                    </Button>
                  )}
                </div>
              ) : null,
          },
        ]}
      />
    </>
  )
}
