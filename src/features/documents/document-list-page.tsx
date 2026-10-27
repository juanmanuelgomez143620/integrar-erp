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
import {
  ADJUSTMENT_REASONS,
  DOC_STATUSES,
  DOC_TYPES,
  JOURNAL_ORIGINS,
  PAYMENT_METHODS,
  PRIORITIES,
} from '@/lib/domain/catalog'
import type { DocType } from '@/lib/domain/types'
import { date, money, qty, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

const SECTION: Record<DocType, { area: string; areaPath?: string; newLabel: string; createPerm: string }> = {
  PURCHASE_REQUISITION: { area: 'Compras', newLabel: 'Nueva solicitud', createPerm: 'purchase_requisition.create' },
  PURCHASE_ORDER: { area: 'Compras', newLabel: 'Nueva orden de compra', createPerm: 'purchase_order.create' },
  GOODS_RECEIPT: { area: 'Depósito', newLabel: 'Registrar recepción', createPerm: 'goods_receipt.create' },
  STOCK_ADJUSTMENT: { area: 'Depósito', newLabel: 'Nuevo ajuste', createPerm: 'stock_adjustment.create' },
  JOURNAL_ENTRY: { area: 'Contabilidad', newLabel: 'Nuevo asiento', createPerm: 'journal_entry.create' },
  SUPPLIER_INVOICE: { area: 'Compras', newLabel: 'Registrar factura', createPerm: 'supplier_invoice.create' },
  PAYMENT_ORDER: { area: 'Pagos y tesorería', newLabel: 'Nueva orden de pago', createPerm: 'payment_order.create' },
  RFQ: { area: 'Compras', newLabel: 'Nueva solicitud de cotización', createPerm: 'rfq.create' },
  SUPPLIER_QUOTE: { area: 'Compras', newLabel: 'Cargar cotización', createPerm: 'supplier_quote.create' },
  FUNDS_TRANSFER: { area: 'Pagos y tesorería', newLabel: 'Nueva transferencia', createPerm: 'funds_transfer.create' },
  BANK_RECONCILIATION: {
    area: 'Pagos y tesorería',
    newLabel: 'Nueva conciliación',
    createPerm: 'bank_reconciliation.create',
  },
  SALES_ORDER: { area: 'Ventas', newLabel: 'Nuevo pedido', createPerm: 'sales_order.create' },
  DELIVERY_NOTE: { area: 'Depósito', newLabel: 'Preparar remito', createPerm: 'delivery_note.create' },
  SALES_INVOICE: { area: 'Ventas', newLabel: 'Nueva factura', createPerm: 'sales_invoice.create' },
  CUSTOMER_RECEIPT: {
    area: 'Pagos y tesorería',
    newLabel: 'Nuevo recibo de cobro',
    createPerm: 'customer_receipt.create',
  },
  SALES_QUOTE: { area: 'Ventas', newLabel: 'Nuevo presupuesto', createPerm: 'sales_quote.create' },
  PRODUCTION_ORDER: {
    area: 'Producción',
    newLabel: 'Nueva orden de producción',
    createPerm: 'production_order.create',
  },
  PAYROLL: { area: 'RRHH', newLabel: 'Nueva liquidación', createPerm: 'payroll.create' },
  TAX_RETURN: { area: 'Impuestos', newLabel: 'Nueva declaración', createPerm: 'tax_return.create' },
}

const PRIORITY_BADGE = { BAJA: 'neutral', NORMAL: 'neutral', ALTA: 'warning', URGENTE: 'danger' } as const

export function DocumentListPage({ docType }: { docType: DocType }) {
  const company = useCompany()
  const navigate = useNavigate()
  const info = DOC_TYPES[docType]
  const section = SECTION[docType]
  const [status, setStatus] = useState<string>('ALL')
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
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
  if (docType === 'SUPPLIER_INVOICE') {
    columns.push(
      { key: 'supplier', header: 'Proveedor', sort: (d) => d.supplier_name, cell: (d) => d.supplier_name },
      {
        key: 'voucher',
        header: 'Comprobante',
        cell: (d) => (
          <span className="font-mono text-xs">
            {d.si!.letter} {d.si!.point_of_sale}-{d.si!.invoice_number}
          </span>
        ),
      },
      {
        key: 'ref',
        header: 'Orden de compra',
        cell: (d) => <span className="font-mono text-xs">{d.reference_label ?? '—'}</span>,
      },
      { key: 'due', header: 'Vence', sort: (d) => d.si!.due_date, cell: (d) => date(d.si!.due_date) },
      {
        key: 'total',
        header: 'Total',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'PAYMENT_ORDER') {
    columns.push(
      { key: 'supplier', header: 'Proveedor', sort: (d) => d.supplier_name, cell: (d) => d.supplier_name },
      { key: 'invoices', header: 'Facturas', cell: (d) => <span className="font-mono text-xs">{d.summary}</span> },
      {
        key: 'total',
        header: 'Importe',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'RFQ') {
    columns.push(
      { key: 'items', header: 'Productos', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'ref',
        header: 'Origen',
        cell: (d) => <span className="font-mono text-xs">{d.reference_label ?? '—'}</span>,
      },
      { key: 'due', header: 'Responden hasta', sort: (d) => d.rq!.response_due, cell: (d) => date(d.rq!.response_due) },
    )
  }
  if (docType === 'SUPPLIER_QUOTE') {
    columns.push(
      { key: 'supplier', header: 'Proveedor', sort: (d) => d.supplier_name, cell: (d) => d.supplier_name },
      {
        key: 'ref',
        header: 'Solicitud',
        cell: (d) => <span className="font-mono text-xs">{d.reference_label ?? '—'}</span>,
      },
      { key: 'valid', header: 'Válida hasta', sort: (d) => d.sq!.valid_until, cell: (d) => date(d.sq!.valid_until) },
      {
        key: 'delivery',
        header: 'Entrega',
        align: 'right',
        sort: (d) => d.sq!.delivery_days,
        cell: (d) => <span className="tabular">{d.sq!.delivery_days} días</span>,
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
  if (docType === 'FUNDS_TRANSFER') {
    columns.push(
      { key: 'accounts', header: 'Cuentas', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'reference',
        header: 'Referencia',
        cell: (d) => <span className="text-xs">{d.ft?.reference || '—'}</span>,
      },
      {
        key: 'total',
        header: 'Importe',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'BANK_RECONCILIATION') {
    columns.push(
      { key: 'bank', header: 'Banco y extracto', cell: (d) => <span className="text-xs">{d.summary}</span> },
      { key: 'moves', header: 'Conciliados', align: 'right', cell: (d) => d.line_count },
      {
        key: 'statement',
        header: 'Saldo del extracto',
        align: 'right',
        cell: (d) => <span className="tabular">{money(d.br!.statement_balance)}</span>,
      },
      {
        key: 'pending',
        header: 'Pagos sin debitar',
        align: 'right',
        cell: (d) => <span className="tabular">{money(d.br!.pending_credits)}</span>,
      },
    )
  }
  if (docType === 'SALES_ORDER') {
    columns.push(
      { key: 'customer', header: 'Cliente', sort: (d) => d.customer_name, cell: (d) => d.customer_name },
      { key: 'items', header: 'Productos', cell: (d) => <span className="text-xs">{d.summary}</span> },
      { key: 'delivery', header: 'Entrega pedida', cell: (d) => date(d.so?.delivery_date) },
      {
        key: 'total',
        header: 'Total',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'DELIVERY_NOTE') {
    columns.push(
      {
        key: 'ref',
        header: 'Pedido',
        cell: (d) => <span className="font-mono text-xs">{d.reference_label ?? '—'}</span>,
      },
      { key: 'customer', header: 'Cliente', sort: (d) => d.customer_name, cell: (d) => d.customer_name },
      { key: 'items', header: 'Productos', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'carrier',
        header: 'Transportista',
        cell: (d) => <span className="text-xs">{d.dn?.carrier_name || '—'}</span>,
      },
    )
  }
  if (docType === 'SALES_INVOICE') {
    columns.push(
      { key: 'customer', header: 'Cliente', sort: (d) => d.customer_name, cell: (d) => d.customer_name },
      {
        key: 'voucher',
        header: 'Comprobante',
        cell: (d) => (
          <span className="font-mono text-xs">
            {d.fv!.letter} {d.fv!.point_of_sale}-{d.fv!.invoice_number || 'sin número'}
          </span>
        ),
      },
      {
        key: 'ref',
        header: 'Pedido',
        cell: (d) => <span className="font-mono text-xs">{d.reference_label ?? '—'}</span>,
      },
      { key: 'due', header: 'Vence', sort: (d) => d.fv!.due_date, cell: (d) => date(d.fv!.due_date) },
      {
        key: 'total',
        header: 'Total',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'SALES_QUOTE') {
    columns.push(
      { key: 'customer', header: 'Cliente', sort: (d) => d.customer_name, cell: (d) => d.customer_name },
      { key: 'items', header: 'Productos', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'valid',
        header: 'Válido hasta',
        sort: (d) => d.qt!.valid_until,
        cell: (d) => (
          <span
            className={cn(
              ['BORRADOR', 'ENVIADO'].includes(d.status) && d.qt!.valid_until < todayAR() && 'font-medium text-red-700',
            )}
          >
            {date(d.qt!.valid_until)}
          </span>
        ),
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
  if (docType === 'PAYROLL') {
    columns.push(
      { key: 'period', header: 'Mes', sort: (d) => d.py!.period, cell: (d) => d.summary },
      { key: 'employees', header: 'Empleados', align: 'right', sort: (d) => d.line_count, cell: (d) => d.line_count },
      {
        key: 'gross',
        header: 'Remunerativo',
        align: 'right',
        sort: (d) => d.subtotal,
        cell: (d) => <span className="tabular">{money(d.subtotal)}</span>,
      },
      {
        key: 'net',
        header: 'Netos a pagar',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular font-medium">{money(d.total)}</span>,
      },
      {
        key: 'payment',
        header: 'Fecha de pago',
        sort: (d) => d.py!.payment_date,
        cell: (d) => date(d.py!.payment_date),
      },
    )
  }
  if (docType === 'TAX_RETURN') {
    columns.push(
      { key: 'period', header: 'Impuesto y mes', sort: (d) => d.tr!.period, cell: (d) => d.summary },
      { key: 'due', header: 'Vence', sort: (d) => d.tr!.due_date, cell: (d) => date(d.tr!.due_date) },
      {
        key: 'tax',
        header: 'Débito fiscal',
        align: 'right',
        sort: (d) => d.subtotal,
        cell: (d) => <span className="tabular">{money(d.subtotal)}</span>,
      },
      {
        key: 'due_amount',
        header: 'A pagar (a favor)',
        align: 'right',
        sort: (d) => d.total - d.tr!.balance_in_favor,
        cell: (d) => (
          <span className="tabular font-medium">
            {d.total > 0 ? money(d.total) : d.tr!.balance_in_favor ? `(${money(d.tr!.balance_in_favor)})` : money(0)}
          </span>
        ),
      },
    )
  }
  if (docType === 'PRODUCTION_ORDER') {
    columns.push(
      {
        key: 'product',
        header: 'Producto',
        sort: (d) => d.summary,
        cell: (d) => <span className="text-xs">{d.summary}</span>,
      },
      {
        key: 'quantity',
        header: 'Cantidad',
        align: 'right',
        sort: (d) => d.pd!.quantity,
        cell: (d) => (
          <span className="tabular">
            {qty(d.pd!.quantity)}
            {d.pd!.quantity_produced != null && d.pd!.quantity_produced !== d.pd!.quantity && (
              <span className="text-xs text-amber-700"> (salieron {qty(d.pd!.quantity_produced)})</span>
            )}
          </span>
        ),
      },
      {
        key: 'due',
        header: 'Prevista para',
        sort: (d) => d.pd!.due_date ?? '',
        cell: (d) => (
          <span
            className={cn(
              ['BORRADOR', 'LIBERADA', 'EN_PROCESO'].includes(d.status) &&
                !!d.pd!.due_date &&
                d.pd!.due_date < todayAR() &&
                'font-medium text-red-700',
            )}
          >
            {date(d.pd!.due_date)}
          </span>
        ),
      },
      {
        key: 'total',
        header: 'Materiales (previsto)',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'CUSTOMER_RECEIPT') {
    columns.push(
      { key: 'customer', header: 'Cliente', sort: (d) => d.customer_name, cell: (d) => d.customer_name },
      { key: 'invoices', header: 'Facturas', cell: (d) => <span className="font-mono text-xs">{d.summary}</span> },
      {
        key: 'method',
        header: 'Medio',
        cell: (d) => (
          <span className="text-xs">
            {PAYMENT_METHODS[d.rc!.payment_method]}
            {d.rc!.reference ? ` ${d.rc!.reference}` : ''}
          </span>
        ),
      },
      {
        key: 'total',
        header: 'Importe',
        align: 'right',
        sort: (d) => d.total,
        cell: (d) => <span className="tabular">{money(d.total)}</span>,
      },
    )
  }
  if (docType === 'JOURNAL_ENTRY') {
    columns.push(
      {
        key: 'entry',
        header: 'N.º de asiento',
        align: 'right',
        sort: (d) => d.je?.entry_number ?? 0,
        cell: (d) => <span className="tabular">{d.je?.entry_number ?? '—'}</span>,
      },
      {
        key: 'origin',
        header: 'Origen',
        cell: (d) => <span className="text-xs">{JOURNAL_ORIGINS[d.je!.origin]}</span>,
      },
      { key: 'summary', header: 'Leyenda', cell: (d) => <span className="text-xs">{d.summary}</span> },
      {
        key: 'total',
        header: 'Importe',
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

  const newPath = company.docPath(
    docType,
    ['STOCK_ADJUSTMENT', 'JOURNAL_ENTRY', 'SALES_ORDER', 'DELIVERY_NOTE', 'CUSTOMER_RECEIPT', 'SALES_QUOTE'].includes(
      docType,
    )
      ? 'nuevo'
      : 'nueva',
  )

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
        error={error}
        columns={columns}
        rowKey={(d) => d.id}
        search={(d) =>
          `${d.display_number} ${d.supplier_name} ${d.customer_name} ${d.summary} ${d.sector_name} ${d.created_by_name} ${d.reference_label ?? ''}`
        }
        searchPlaceholder={
          docType === 'JOURNAL_ENTRY'
            ? 'Buscar por número o leyenda…'
            : docType === 'PRODUCTION_ORDER'
              ? 'Buscar por número o producto…'
              : docType === 'PAYROLL' || docType === 'TAX_RETURN'
                ? 'Buscar por número o mes…'
                : ['SALES_ORDER', 'DELIVERY_NOTE', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'SALES_QUOTE'].includes(docType)
                  ? 'Buscar por número, cliente, producto…'
                  : 'Buscar por número, proveedor, producto…'
        }
        onRowClick={(d) => navigate(d.path)}
        empty={`Todavía no hay ${info.plural.toLowerCase()}.`}
      />
    </>
  )
}
