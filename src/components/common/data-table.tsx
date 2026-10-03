import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  sort?: (row: T) => string | number
  className?: string
  align?: 'left' | 'right' | 'center'
}

interface DataTableProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  search?: (row: T) => string
  searchPlaceholder?: string
  initialSearch?: string
  toolbar?: ReactNode
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string | undefined
  empty?: ReactNode
  pageSize?: number
  loading?: boolean
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  search,
  searchPlaceholder = 'Buscar…',
  initialSearch = '',
  toolbar,
  onRowClick,
  rowClassName,
  empty,
  pageSize = 25,
  loading,
}: DataTableProps<T>) {
  const [term, setTerm] = useState(initialSearch)
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    let result = rows
    if (search && term.trim()) {
      const needle = normalize(term.trim())
      result = result.filter((r) => normalize(search(r)).includes(needle))
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key)
      if (col?.sort) {
        const get = col.sort
        result = [...result].sort((a, b) => {
          const va = get(a)
          const vb = get(b)
          return (
            (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) *
            sort.dir
          )
        })
      }
    }
    return result
  }, [rows, term, sort, columns, search])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = Math.min(page, pages - 1)
  const visible = filtered.slice(current * pageSize, current * pageSize + pageSize)
  const alignClass = (a?: Column<T>['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : '')

  return (
    <div className="rounded-xl border bg-card">
      {(search || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          {search && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={term}
                onChange={(e) => {
                  setTerm(e.target.value)
                  setPage(0)
                }}
                placeholder={searchPlaceholder}
                className="h-8 pl-8"
              />
            </div>
          )}
          {toolbar}
          <div className="ml-auto text-xs text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? 'registro' : 'registros'}
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              {columns.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn('h-9 text-xs font-semibold text-slate-600', alignClass(c.align), c.className)}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-foreground',
                        c.align === 'right' && 'flex-row-reverse',
                      )}
                      onClick={() =>
                        setSort((s) =>
                          s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 },
                        )
                      }
                    >
                      {c.header}
                      {sort?.key === c.key &&
                        (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">
                  Cargando…
                </TableCell>
              </TableRow>
            )}
            {!loading && visible.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-10 text-center text-sm whitespace-normal text-muted-foreground"
                >
                  {empty ?? 'No hay registros.'}
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              visible.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  className={cn(onRowClick && 'cursor-pointer', rowClassName?.(row))}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => (
                    <TableCell key={c.key} className={cn('py-2.5 text-sm', alignClass(c.align), c.className)}>
                      {c.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t p-2 text-xs text-muted-foreground">
          Página {current + 1} de {pages}
          <Button
            variant="outline"
            size="icon-sm"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            aria-label="Anterior"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
            aria-label="Siguiente"
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  )
}
