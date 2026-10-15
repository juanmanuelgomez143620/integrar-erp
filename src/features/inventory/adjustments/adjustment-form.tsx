import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { ProductSelect, SimpleSelect } from '@/components/common/pickers'
import { api, commands, type StockRow } from '@/lib/api'
import { ADJUSTMENT_REASONS } from '@/lib/domain/catalog'
import type { AdjustmentReason } from '@/lib/domain/types'
import { money, qty } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

interface LineState {
  key: string
  product_id: string
  delta: string
  unit_cost: string
}

const blank = (): LineState => ({ key: crypto.randomUUID(), product_id: '', delta: '', unit_cost: '' })

export function AdjustmentFormPage() {
  const company = useCompany()
  const products = useQuery({
    queryKey: ['products', company.companyId],
    queryFn: () => api.products(company.companyId),
  })
  const stock = useQuery({ queryKey: ['stock', company.companyId], queryFn: () => api.stock(company.companyId) })
  if (!products.data || !stock.data) return <Loading error={products.error ?? stock.error} />
  return <AdjustmentForm products={products.data.filter((p) => p.is_stockable && p.is_active)} stock={stock.data} />
}

function AdjustmentForm({
  products,
  stock,
}: {
  products: Awaited<ReturnType<typeof api.products>>
  stock: StockRow[]
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const [warehouseId, setWarehouseId] = useState(company.warehouses[0]?.id ?? '')
  const [reason, setReason] = useState<AdjustmentReason>('CONSUMO_INTERNO')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineState[]>([blank()])
  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const inWarehouse = (productId: string) =>
    stock.find((s) => s.product.id === productId && s.warehouse.id === warehouseId)

  const save = useCommand(
    (confirm: boolean) =>
      commands.createStockAdjustment(
        company.companyId,
        {
          warehouse_id: warehouseId,
          reason_code: reason,
          notes,
          lines: lines
            .filter((l) => l.product_id)
            .map((l) => ({
              product_id: l.product_id,
              quantity_delta: Number(l.delta.replace(',', '.')) || 0,
              unit_cost: l.unit_cost ? Number(l.unit_cost.replace(',', '.')) : undefined,
            })),
        },
        confirm,
      ),
    {
      success: (r) => `${r.display_number} registrado.`,
      onSuccess: (r) => navigate(company.docPath('STOCK_ADJUSTMENT', r.display_number)),
    },
  )

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Depósito' },
          { label: 'Ajustes de stock', to: company.docPath('STOCK_ADJUSTMENT') },
          { label: 'Nuevo' },
        ]}
        title="Nuevo ajuste de stock"
        description="El stock nunca se edita a mano: toda corrección se documenta con un motivo y queda en el kardex. Mientras no exista el módulo de Producción, usá “Consumo interno” para registrar el uso de materiales."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-4">
          <Section title="Datos del ajuste">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Depósito" required>
                <SimpleSelect
                  value={warehouseId}
                  onChange={setWarehouseId}
                  options={company.warehouses.map((w) => ({ value: w.id, label: w.name }))}
                />
              </Field>
              <Field label="Motivo" required>
                <SimpleSelect
                  value={reason}
                  onChange={setReason}
                  options={(Object.keys(ADJUSTMENT_REASONS) as AdjustmentReason[])
                    .filter((r) => r !== 'INVENTARIO_INICIAL')
                    .map((r) => ({ value: r, label: ADJUSTMENT_REASONS[r] }))}
                />
              </Field>
              <Field
                label="Observaciones"
                className="sm:col-span-2"
                hint="Ej.: consumo para la producción de 10 placares."
              >
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          </Section>
          <Section
            title="Productos"
            actions={
              <Button size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, blank()])}>
                <Plus /> Agregar
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {lines.map((l) => {
                const p = products.find((x) => x.id === l.product_id)
                const current = l.product_id ? inWarehouse(l.product_id) : undefined
                const delta = Number(l.delta.replace(',', '.')) || 0
                return (
                  <div
                    key={l.key}
                    className="grid items-start gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_130px_130px_auto]"
                  >
                    <div>
                      <ProductSelect
                        products={products}
                        value={l.product_id}
                        onChange={(id) => update(l.key, { product_id: id })}
                      />
                      {p && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          En este depósito: {qty(current?.qty ?? 0, p.uom_code)} · PPP{' '}
                          {money(current?.avg_cost ?? p.avg_cost)}
                          {delta ? ` → quedará ${qty((current?.qty ?? 0) + delta, p.uom_code)}` : ''}
                        </p>
                      )}
                    </div>
                    <Field label="Cantidad (+ entra / − sale)">
                      <Input
                        inputMode="decimal"
                        value={l.delta}
                        onChange={(e) => update(l.key, { delta: e.target.value })}
                        placeholder="-5"
                        className="tabular text-right"
                      />
                    </Field>
                    <Field label="Costo unit." hint={delta > 0 ? 'Vacío = PPP' : undefined}>
                      <Input
                        inputMode="decimal"
                        value={l.unit_cost}
                        onChange={(e) => update(l.key, { unit_cost: e.target.value })}
                        disabled={delta <= 0}
                        className="tabular text-right"
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="mt-6"
                      aria-label="Quitar"
                      disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )
              })}
            </div>
          </Section>
        </div>
        <aside className="flex flex-col gap-3">
          <Button size="lg" disabled={save.isPending} onClick={() => save.mutate([true])}>
            Confirmar ajuste
          </Button>
          <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate([false])}>
            Guardar borrador
          </Button>
          <Button variant="ghost" asChild>
            <Link to={company.docPath('STOCK_ADJUSTMENT')}>Cancelar</Link>
          </Button>
        </aside>
      </div>
    </>
  )
}
