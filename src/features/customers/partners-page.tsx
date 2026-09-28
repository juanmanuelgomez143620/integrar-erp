import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { DataTable } from '@/components/common/data-table'
import { Mono } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import type { Customer, Supplier } from '@/lib/domain/types'
import { money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { PartnerSheet } from './partner-form'

type Row = Customer & Supplier

export function PartnersPage({ kind }: { kind: 'customer' | 'supplier' }) {
  const company = useCompany()
  const isCustomer = kind === 'customer'
  const { data = [], isLoading } = useQuery<Row[]>({
    queryKey: [isCustomer ? 'customers' : 'suppliers', company.companyId],
    queryFn: async () =>
      (isCustomer ? await api.customers(company.companyId) : await api.suppliers(company.companyId)) as Row[],
  })
  const rows = data
  const canCreate = company.can(`${kind}.create`)
  const canUpdate = company.can(`${kind}.update`)
  const [editing, setEditing] = useState<Row | null>(null)
  const [open, setOpen] = useState(false)
  const toggle = useCommand((id: string, active: boolean) =>
    commands.setMasterActive(kind, company.companyId, id, active),
  )
  const prefix = isCustomer ? 'CLI' : 'PRV'
  const nextCode = `${prefix}-${String(rows.length + 1).padStart(3, '0')}`

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Maestros' },
          { label: isCustomer ? 'Clientes' : 'Proveedores' },
        ]}
        title={isCustomer ? 'Clientes' : 'Proveedores'}
        description={
          isCustomer
            ? 'Cartera de clientes de la empresa. La condición frente al IVA determinará el tipo de factura simulada en el módulo de Ventas.'
            : 'Proveedores habilitados para recibir órdenes de compra. Compras mantiene sus datos; el resto de los sectores los consulta.'
        }
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                setEditing(null)
                setOpen(true)
              }}
            >
              <Plus /> Nuevo {isCustomer ? 'cliente' : 'proveedor'}
            </Button>
          ) : undefined
        }
      />
      <DataTable<Row>
        rows={rows}
        loading={isLoading}
        rowKey={(r) => r.id}
        search={(r) => `${r.code} ${r.legal_name} ${r.tax_id} ${r.city} ${r.category ?? ''}`}
        searchPlaceholder="Buscar por código, razón social, CUIT, localidad…"
        onRowClick={
          canUpdate
            ? (r) => {
                setEditing(r)
                setOpen(true)
              }
            : undefined
        }
        rowClassName={(r) => (r.is_active ? undefined : 'opacity-50')}
        columns={[
          { key: 'code', header: 'Código', sort: (r) => r.code, cell: (r) => <Mono>{r.code}</Mono> },
          {
            key: 'name',
            header: 'Razón social',
            sort: (r) => r.legal_name,
            cell: (r) => <span className="font-medium">{r.legal_name}</span>,
          },
          { key: 'tax', header: 'CUIT', cell: (r) => <span className="font-mono text-xs">{r.tax_id || '—'}</span> },
          {
            key: 'vat',
            header: 'Condición IVA',
            cell: (r) => <span className="text-xs">{VAT_CONDITIONS[r.vat_condition]}</span>,
          },
          ...(isCustomer
            ? [
                {
                  key: 'credit',
                  header: 'Límite de crédito',
                  align: 'right' as const,
                  cell: (r: Row) => <span className="tabular">{r.credit_limit ? money(r.credit_limit) : '—'}</span>,
                },
              ]
            : [{ key: 'cat', header: 'Rubro', cell: (r: Row) => r.category }]),
          { key: 'city', header: 'Localidad', sort: (r) => r.city, cell: (r) => r.city },
          {
            key: 'terms',
            header: 'Plazo',
            cell: (r) => (r.payment_terms_days ? `${r.payment_terms_days} d` : 'Contado'),
          },
          {
            key: 'active',
            header: 'Estado',
            cell: (r) =>
              canUpdate ? (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <Switch checked={r.is_active} onCheckedChange={(v) => toggle.mutate([r.id, v])} aria-label="Activo" />
                  <span className="text-xs text-muted-foreground">{r.is_active ? 'Activo' : 'Inactivo'}</span>
                </div>
              ) : (
                <StatusBadge label={r.is_active ? 'Activo' : 'Inactivo'} badge={r.is_active ? 'success' : 'neutral'} />
              ),
          },
        ]}
      />
      <PartnerSheet kind={kind} open={open} onOpenChange={setOpen} partner={editing} nextCode={nextCode} />
    </>
  )
}
