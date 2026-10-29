import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { X } from 'lucide-react'
import type { StockRow } from '@/lib/api'
import { Section } from '@/components/common/blocks'
import { StatusBadge } from '@/components/common/status-badge'
import { money, qty } from '@/lib/format'
import { coverageTone, type CoverageTone } from './flow-model'

const TONE_COLORS: Record<CoverageTone, { top: string; left: string; right: string }> = {
  danger: { top: '#dc2626', left: '#b91c1c', right: '#991b1b' },
  warning: { top: '#d97706', left: '#b45309', right: '#92400e' },
  ok: { top: '#185FA5', left: '#134e7a', right: '#0f3d5f' },
}

const TONE_LABEL: Record<CoverageTone, { text: string; badge: 'danger' | 'warning' | 'success' }> = {
  danger: { text: 'Bajo mínimo', badge: 'danger' },
  warning: { text: 'Cerca del mínimo', badge: 'warning' },
  ok: { text: 'Cobertura suficiente', badge: 'success' },
}

interface WarehouseGroup {
  id: string
  code: string
  name: string
  rows: StockRow[]
}

function rowKey(row: StockRow) {
  return `${row.warehouse.id}:${row.product.id}`
}

function groupByWarehouse(rows: StockRow[]): WarehouseGroup[] {
  const groups = new Map<string, WarehouseGroup>()
  for (const row of rows) {
    const group = groups.get(row.warehouse.id) ?? {
      id: row.warehouse.id,
      code: row.warehouse.code,
      name: row.warehouse.name,
      rows: [],
    }
    group.rows.push(row)
    groups.set(row.warehouse.id, group)
  }
  return [...groups.values()].sort((a, b) => a.code.localeCompare(b.code))
}

/**
 * Vista 2.5D del depósito: dos naves isométricas, una caja por producto.
 * La altura es la cantidad y el color, la cobertura sobre el mínimo de la
 * empresa. No usa WebGL ni librerías: es SVG, se ve en cualquier equipo.
 */
export function WarehouseView({ rows, productHref }: { rows: StockRow[]; productHref: (code: string) => string }) {
  const [selected, setSelected] = useState<string | null>(null)
  const groups = useMemo(() => groupByWarehouse(rows), [rows])
  const selectedRow = rows.find((row) => rowKey(row) === selected) ?? null

  if (!rows.length) return null

  return (
    <Section
      title="Depósito en 2.5D"
      description="Cada caja es un producto: la altura es la cantidad y el color, la cobertura sobre el mínimo. Hacé clic para ver el detalle."
      bodyClassName="p-3 sm:p-4"
    >
      {selectedRow && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <div className="font-mono text-xs font-semibold text-navy">{selectedRow.product.code}</div>
            <div className="truncate text-sm font-medium">{selectedRow.product.name}</div>
            <div className="text-[11px] text-muted-foreground">{selectedRow.warehouse.name}</div>
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <Metric label="Cantidad" value={qty(selectedRow.qty, selectedRow.product.uom_code)} />
            <Metric label="Reservado" value={qty(selectedRow.reserved, selectedRow.product.uom_code)} />
            <Metric label="Disponible" value={qty(selectedRow.available, selectedRow.product.uom_code)} />
            <Metric
              label="Mínimo"
              value={selectedRow.product.min_stock > 0 ? qty(selectedRow.product.min_stock) : '—'}
            />
            <Metric label="Valor" value={money(selectedRow.value)} />
          </dl>
          <StatusBadge
            label={TONE_LABEL[coverageTone(selectedRow)].text}
            badge={TONE_LABEL[coverageTone(selectedRow)].badge}
          />
          <Link
            to={productHref(selectedRow.product.code)}
            className="text-xs font-medium text-brand-blue hover:underline"
          >
            Ver ficha
          </Link>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="ml-auto rounded-md p-1 text-slate-400 hover:bg-muted hover:text-foreground"
            aria-label="Cerrar el detalle del producto"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <IsoWarehouse
            key={group.id}
            group={group}
            selected={selected}
            onSelect={(row) => setSelected(rowKey(row) === selected ? null : rowKey(row))}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t pt-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[#185FA5]" aria-hidden /> Cobertura suficiente
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-amber-600" aria-hidden /> Cerca del mínimo
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-red-600" aria-hidden /> Bajo mínimo
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-dashed border-[#1C2B4A]" aria-hidden /> Reservado
        </span>
        <span className="ml-auto hidden sm:inline">
          Altura = cantidad relativa al máximo de la nave · La cobertura se mide contra el mínimo de la empresa
        </span>
      </div>
    </Section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function IsoWarehouse({
  group,
  selected,
  onSelect,
}: {
  group: WarehouseGroup
  selected: string | null
  onSelect: (row: StockRow) => void
}) {
  const totalValue = group.rows.reduce((sum, row) => sum + row.value, 0)
  const below = group.rows.filter((row) => coverageTone(row) === 'danger').length
  const maxQty = Math.max(1, ...group.rows.map((row) => row.qty))
  const cols = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(group.rows.length))))

  const boxes = group.rows
    .map((row, index) => {
      const r = Math.floor(index / cols)
      const c = index % cols
      return {
        row,
        c,
        r,
        cx: 210 + (c - r) * 26,
        cy: 84 + (c + r) * 13,
        height: row.qty > 0 ? 6 + Math.round(24 * Math.sqrt(row.qty / maxQty)) : 4,
      }
    })
    // De atrás hacia adelante: las cajas del fondo se dibujan primero.
    .sort((a, b) => a.c + a.r - (b.c + b.r) || a.c - b.c)

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-end justify-between gap-1">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-navy">{group.name}</h3>
          <p className="text-[11px] text-muted-foreground">
            {group.code} · {group.rows.length} productos · {money(totalValue)}
          </p>
        </div>
        {below > 0 && <span className="text-[11px] font-medium text-red-600">{below} bajo mínimo</span>}
      </div>

      {group.rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
          Sin stock en esta nave.
        </div>
      ) : (
        <svg
          viewBox="0 0 420 250"
          role="group"
          aria-label={`Depósito ${group.name}: ${group.rows.length} productos`}
          className="h-auto w-full"
        >
          <polygon points="210,26 402,122 210,218 18,122" fill="#f8fafc" stroke="#e2e8f0" strokeWidth="1.5" />
          {Array.from({ length: 5 }, (_, i) => {
            const t = (i + 1) / 6
            return (
              <g key={i} stroke="#e2e8f0" strokeWidth="0.7">
                <line x1={lerp(210, 18, t)} y1={lerp(26, 122, t)} x2={lerp(402, 210, t)} y2={lerp(122, 218, t)} />
                <line x1={lerp(210, 402, t)} y1={lerp(26, 122, t)} x2={lerp(18, 210, t)} y2={lerp(122, 218, t)} />
              </g>
            )
          })}
          {boxes.map(({ row, cx, cy, height }) => (
            <IsoBox
              key={rowKey(row)}
              row={row}
              cx={cx}
              cy={cy}
              height={height}
              selected={selected === rowKey(row)}
              onSelect={() => onSelect(row)}
            />
          ))}
          <text x="210" y="243" textAnchor="middle" fontSize="9" letterSpacing="1.5" fill="#64748b">
            {group.code}
          </text>
        </svg>
      )}
    </div>
  )
}

function IsoBox({
  row,
  cx,
  cy,
  height,
  selected,
  onSelect,
}: {
  row: StockRow
  cx: number
  cy: number
  height: number
  selected: boolean
  onSelect: () => void
}) {
  const tone = TONE_COLORS[coverageTone(row)]
  const halfW = 13
  const halfD = 6.5
  const topY = cy - height
  const reserved = row.reserved > 0
  const label = `${row.product.code} ${row.product.name}: ${qty(row.qty, row.product.uom_code)} en ${row.warehouse.code}`
  const reservedLabel = reserved ? `, ${qty(row.reserved, row.product.uom_code)} reservado` : ''

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${label}${reservedLabel}`}
      className="cursor-pointer outline-none focus-visible:opacity-70"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <title>{`${label}${reservedLabel}. Mínimo: ${row.product.min_stock}`}</title>
      <polygon
        points={`${cx - halfW},${topY} ${cx},${topY + halfD} ${cx},${cy + halfD} ${cx - halfW},${cy}`}
        fill={tone.left}
        stroke="#ffffff"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <polygon
        points={`${cx + halfW},${topY} ${cx},${topY + halfD} ${cx},${cy + halfD} ${cx + halfW},${cy}`}
        fill={tone.right}
        stroke="#ffffff"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <polygon
        points={`${cx},${topY - halfD} ${cx + halfW},${topY} ${cx},${topY + halfD} ${cx - halfW},${topY}`}
        fill={tone.top}
        stroke={selected || reserved ? '#1C2B4A' : '#ffffff'}
        strokeOpacity={selected ? 1 : reserved ? 0.55 : 1}
        strokeWidth={selected ? 2 : 0.8}
        strokeDasharray={reserved && !selected ? '2 2' : undefined}
        strokeLinejoin="round"
      />
    </g>
  )
}

function lerp(from: number, to: number, t: number) {
  return from + (to - from) * t
}
