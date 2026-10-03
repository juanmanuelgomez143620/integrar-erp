import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/common/data-table'
import { Mono } from '@/components/common/blocks'
import { ExportCsvButton } from '@/components/common/export-button'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type ProductRow } from '@/lib/api'
import { round2, type CsvColumn } from '@/lib/csv'
import { PRODUCT_TYPES } from '@/lib/domain/catalog'
import type { ProductType } from '@/lib/domain/types'
import { money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'
import { ProductSheet } from './product-form'

function csvColumns(withStock: boolean): CsvColumn<ProductRow>[] {
  return [
    { header: 'Código', value: (p) => p.code },
    { header: 'Descripción', value: (p) => p.name },
    { header: 'Tipo', value: (p) => PRODUCT_TYPES[p.product_type] },
    { header: 'Categoría', value: (p) => p.category },
    { header: 'Unidad', value: (p) => p.uom_code },
    ...(withStock
      ? [
          { header: 'Stock', value: (p: ProductRow) => (p.is_stockable ? p.stock : null) },
          { header: 'Stock mínimo', value: (p: ProductRow) => (p.is_stockable ? p.min_stock : null) },
          { header: 'Cantidad de reposición', value: (p: ProductRow) => p.reorder_qty },
          { header: 'Bajo mínimo', value: (p: ProductRow) => p.below_min },
        ]
      : []),
    { header: 'Costo estándar', value: (p) => round2(p.standard_cost) },
    { header: 'Costo promedio (PPP)', value: (p) => round2(p.avg_cost) },
    { header: 'Precio de venta', value: (p) => round2(p.sale_price) },
    { header: 'IVA (%)', value: (p) => p.vat_rate },
    { header: 'Proveedor habitual', value: (p) => (p.default_supplier_id ? p.supplier_name : '') },
    { header: 'Ubicación', value: (p) => p.location },
    { header: 'Activo', value: (p) => p.is_active },
  ]
}

export function ProductsPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { data = [], isLoading } = useQuery({
    queryKey: ['products', company.companyId],
    queryFn: () => api.products(company.companyId),
  })
  const [type, setType] = useState<ProductType | 'ALL'>('ALL')
  const [open, setOpen] = useState(false)
  const rows = type === 'ALL' ? data : data.filter((p) => p.product_type === type)
  const canStock = company.can('stock.read')

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Maestros' }, { label: 'Productos' }]}
        title="Productos e insumos"
        description="Materias primas, insumos, productos terminados, mercadería de reventa y servicios. El stock que se muestra surge de los movimientos registrados."
        actions={
          company.can('product.create') || company.can('product.export') ? (
            <>
              {company.can('product.export') && (
                <ExportCsvButton
                  dataset="productos"
                  companySlug={company.slug}
                  load={() => api.exportProducts(company.companyId)}
                  columns={csvColumns(canStock)}
                />
              )}
              {company.can('product.create') && (
                <Button onClick={() => setOpen(true)}>
                  <Plus /> Nuevo producto
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(['ALL', ...Object.keys(PRODUCT_TYPES)] as (ProductType | 'ALL')[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              type === t ? 'border-brand-blue bg-brand-blue text-white' : 'bg-card hover:border-brand-blue/40',
            )}
          >
            {t === 'ALL'
              ? `Todos (${data.length})`
              : `${PRODUCT_TYPES[t]} (${data.filter((p) => p.product_type === t).length})`}
          </button>
        ))}
      </div>
      <DataTable<ProductRow>
        rows={rows}
        loading={isLoading}
        rowKey={(p) => p.id}
        initialSearch={params.get('q') ?? ''}
        search={(p) => `${p.code} ${p.name} ${p.category} ${p.supplier_name}`}
        searchPlaceholder="Buscar por código, descripción, categoría…"
        onRowClick={(p) => navigate(company.to(`productos/${p.code}`))}
        rowClassName={(p) => (p.is_active ? undefined : 'opacity-50')}
        columns={[
          { key: 'code', header: 'Código', sort: (p) => p.code, cell: (p) => <Mono>{p.code}</Mono> },
          {
            key: 'name',
            header: 'Descripción',
            sort: (p) => p.name,
            cell: (p) => <span className="font-medium">{p.name}</span>,
          },
          {
            key: 'type',
            header: 'Tipo',
            cell: (p) => <span className="text-xs">{PRODUCT_TYPES[p.product_type]}</span>,
          },
          { key: 'uom', header: 'Unidad', cell: (p) => p.uom_code },
          ...(canStock
            ? [
                {
                  key: 'stock',
                  header: 'Stock',
                  align: 'right' as const,
                  sort: (p: ProductRow) => p.stock,
                  cell: (p: ProductRow) =>
                    p.is_stockable ? (
                      <span className={cn('tabular', p.below_min && 'font-semibold text-red-700')}>{qty(p.stock)}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">no aplica</span>
                    ),
                },
                {
                  key: 'min',
                  header: 'Mínimo',
                  align: 'right' as const,
                  cell: (p: ProductRow) =>
                    p.is_stockable ? <span className="tabular text-muted-foreground">{qty(p.min_stock)}</span> : '—',
                },
              ]
            : []),
          {
            key: 'cost',
            header: 'Costo (PPP)',
            align: 'right',
            sort: (p) => p.avg_cost,
            cell: (p) => <span className="tabular">{money(p.avg_cost)}</span>,
          },
          {
            key: 'supplier',
            header: 'Proveedor habitual',
            cell: (p) => <span className="text-xs">{p.supplier_name}</span>,
          },
          {
            key: 'alert',
            header: '',
            cell: (p) =>
              p.below_min ? (
                <StatusBadge label="Bajo mínimo" badge="danger" />
              ) : !p.is_active ? (
                <StatusBadge label="Inactivo" badge="neutral" />
              ) : null,
          },
        ]}
      />
      <ProductSheet open={open} onOpenChange={setOpen} product={null} />
    </>
  )
}
