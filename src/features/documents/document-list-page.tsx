import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/common/data-table'
import { Mono } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { DocStatus, StatusBadge } from '@/components/common/status-badge'
import { api, type DocumentListItem } from '@/lib/api'
import { ADJUSTMENT_REASONS, DOC_STATUSES, DOC_TYPES, PRIORITIES } from '@/lib/domain/catalog'
import type { DocType } from '@/lib/domain/types'
import { date, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

const SECTION: Record<DocType, { area: string; areaPath?: string; newLabel: string; createPerm: string }> = {
  PURCHASE_REQUISITION: { area: 'Compras', newLabel: 'Nueva solicitud', createPerm: 'purchase_requisition.create' },
  PURCHASE_ORDER: { area: 'Compras', newLabel: 'Nueva orden de compra', createPerm: 'purchase_order.create' },
  GOODS_RECEIPT: { area: 'Depósito', newLabel: 'Registrar recepción', createPerm: 'goods_receipt.create' },
  STOCK_ADJUSTMENT: { area: 'Depósito', newLabel: 'Nuevo ajuste', createPerm: 'stock_adjustment.create' },
}

const PRIORITY_BADGE = { BAJA: 'neutral', NORMAL: 'neutral', ALTA: 'warning', URGENTE: 'danger' } as const

export function DocumentListPage({ docType }: { docType: DocType }) {
  const company = useCompany()
  const navigate = useNavigate()
  const info = DOC_TYPES[docType]
  const section = SECTION[docType]
  const [status, setStatus] = useState<string>('ALL')
  const { data = [], isLoading } = useQuery({
    queryKey: ['documents', company.companyId, docType],
    queryFn: () => api.documents(company.companyId, docType),
  })

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of data) map.set(d.status, (map.get(d.status) ?? 0) + 1)
    return map
  }, [data])
  const rows = status === 'ALL' ? data : data.filter((d) => d.status === status)

  const columns: Column<DocumentListItem>[] = [
    { key: 'number', header: 'Número', sort: (d) => d.number, cell: (d) => <Mono>{d.display_number}</Mono> },
    { key: 'date', header: 'Fecha', sort: (d) => d.created_at, cell: (d) => date(d.document_date) },
    { key: 'status', header: 'Estado', sort: (d) => d.status, cell: (d) => <DocStatus info={d.status_info} /> },
  ]
  if (docType === 'PURCHASE_REQUISITION') {
    columns.push(
      { key: 'sector', header: 'Sector solicitante', sort: (d) => d.sector_name, cell: (d) => d.sector_name },
      { key: 'items', header: 'Productos', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'priority',
        header: 'Prioridad',
        cell: (d) => <StatusBadge label={PRIORITIES[d.pr!.priority]} badge={PRIORITY_BADGE[d.pr!.priority]} />,
      },
      { key: 'needed', header: 'Necesaria para', cell: (d) => date(d.pr?.needed_by) },
    )
  }
  if (docType === 'PURCHASE_ORDER') {
    columns.push(
      { key: 'supplier', header: 'Proveedor', sort: (d) => d.supplier_name, cell: (d) => d.supplier_name },
      {
        key: 'ref',
        header: 'Origen',
        cell: (d) => <span className="font-mono text-xs">{d.reference_label ?? '—'}</span>,
      },
      {
        key: 'approver',
        header: 'Espera a',
        cell: (d) =>
          d.pending_approver ? <span className="text-xs font-medium text-amber-700">{d.pending_approver}</span> : '—',
      },
      {
        key: 'total',
        header: 'Total',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'GOODS_RECEIPT') {
    columns.push(
      {
        key: 'ref',
        header: 'Orden de compra',
        cell: (d) => <span className="font-mono text-xs">{d.reference_label ?? '—'}</span>,
      },
      { key: 'supplier', header: 'Proveedor', sort: (d) => d.supplier_name, cell: (d) => d.supplier_name },
      {
        key: 'note',
        header: 'Remito proveedor',
        cell: (d) => <span className="font-mono text-xs">{d.gr?.supplier_delivery_note}</span>,
      },
      { key: 'items', header: 'Productos', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'total',
        header: 'Valor recibido',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'STOCK_ADJUSTMENT') {
    columns.push(
      { key: 'reason', header: 'Motivo', cell: (d) => ADJUSTMENT_REASONS[d.sa!.reason_code] },
      { key: 'items', header: 'Productos', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'total',
        header: 'Valor',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  columns.push({
    key: 'by',
    header: 'Creado por',
    sort: (d) => d.created_by_name,
    cell: (d) => <span className="text-xs">{d.created_by_name}</span>,
  })

  const newPath = company.docPath(docType, docType === 'STOCK_ADJUSTMENT' ? 'nuevo' : 'nueva')

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: section.area }, { label: info.plural }]}
        title={info.plural}
        description={info.description}
        actions={
          company.can(section.createPerm) ? (
            <Button asChild>
              <Link to={newPath}>
                <Plus /> {section.newLabel}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[
          ['ALL', `Todos (${data.length})`] as const,
          ...[...counts.keys()].map((s) => [s, `${DOC_STATUSES[docType][s]?.label ?? s} (${counts.get(s)})`] as const),
        ].map(([code, label]) => (
          <button
            key={code}
            type="button"
            onClick={() => setStatus(code)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              status === code ? 'border-brand-blue bg-brand-blue text-white' : 'bg-card hover:border-brand-blue/40',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <DataTable<DocumentListItem>
        rows={rows}
        loading={isLoading}
        columns={columns}
        rowKey={(d) => d.id}
        search={(d) =>
          `${d.display_number} ${d.supplier_name} ${d.summary} ${d.sector_name} ${d.created_by_name} ${d.reference_label ?? ''}`
        }
        searchPlaceholder="Buscar por número, proveedor, producto…"
        onRowClick={(d) => navigate(d.path)}
        empty={`Todavía no hay ${info.plural.toLowerCase()}.`}
      />
    </>
  )
}
