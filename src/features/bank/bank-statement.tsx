import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, Loading, Mono, Section } from '@/components/common/blocks'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, type BankStatement } from '@/lib/api'
import { date, dateTime, money, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCompany } from '@/app/company'

const LEGEND = 'DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL'

/** El primer y el último día de un mes ("2027-05" → 2027-05-01 y 2027-05-31). */
export function monthRange(month: string) {
  const [year, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** El extracto: el saldo al empezar, lo procesado día por día con su transacción, los totales y el saldo final. */
export function StatementTable({ statement, compact = false }: { statement: BankStatement; compact?: boolean }) {
  const cell = compact ? 'py-1' : ''
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Fecha</TableHead>
          <TableHead>Transacción</TableHead>
          <TableHead>Concepto</TableHead>
          <TableHead className="text-right">Débito</TableHead>
          <TableHead className="text-right">Crédito</TableHead>
          <TableHead className="text-right">Saldo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className={cell}>{date(statement.from)}</TableCell>
          <TableCell className={cell} />
          <TableCell className={cn(cell, 'font-medium')}>Saldo al inicio del período</TableCell>
          <TableCell className={cell} />
          <TableCell className={cell} />
          <TableCell className={cn(cell, 'tabular text-right font-medium')}>
            {money(statement.opening_balance)}
          </TableCell>
        </TableRow>
        {statement.lines.map((l) => (
          <TableRow key={l.id}>
            <TableCell className={cell}>{date(l.date)}</TableCell>
            <TableCell className={cell}>{l.transaction_number ? <Mono>{l.transaction_number}</Mono> : '—'}</TableCell>
            <TableCell className={cn(cell, 'whitespace-normal')}>{l.concept}</TableCell>
            <TableCell className={cn(cell, 'tabular text-right')}>{l.debit ? money(l.debit) : ''}</TableCell>
            <TableCell className={cn(cell, 'tabular text-right')}>{l.credit ? money(l.credit) : ''}</TableCell>
            <TableCell className={cn(cell, 'tabular text-right', l.balance < 0 && 'text-red-700')}>
              {money(l.balance)}
            </TableCell>
          </TableRow>
        ))}
        {statement.lines.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
              El banco no procesó movimientos en el período.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3} className={cn(cell, 'font-semibold')}>
            Saldo al {date(statement.to)}
          </TableCell>
          <TableCell className={cn(cell, 'tabular text-right')}>{money(statement.debits)}</TableCell>
          <TableCell className={cn(cell, 'tabular text-right')}>{money(statement.credits)}</TableCell>
          <TableCell className={cn(cell, 'tabular text-right font-semibold')}>
            {money(statement.closing_balance)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}

/** El extracto de un mes en la pantalla del Banco Aula, con el enlace para imprimirlo. */
export function StatementSection() {
  const company = useCompany()
  const today = todayAR()
  const [month, setMonth] = useState(today.slice(0, 7))
  const range = monthRange(month)
  const from = range.from
  // El mes en curso llega hasta hoy: lo que viene todavía no pasó.
  const to = range.to > today ? today : range.to
  const { data, error, isLoading } = useQuery({
    queryKey: ['bank-statement', company.companyId, from, to],
    queryFn: () => api.bankStatement(company.companyId, from, to),
    enabled: /^\d{4}-\d{2}$/.test(month) && from <= to,
  })
  return (
    <Section
      title="Extracto"
      description="Lo que el banco procesó en el mes: es el resumen que se usa para conciliar."
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Mes" className="w-40">
            <Input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          <Button variant="outline" asChild>
            <Link to={company.to(`pagos/banco-aula/extracto/imprimir?desde=${from}&hasta=${to}`)}>
              <Printer /> Imprimir
            </Link>
          </Button>
        </div>
      }
      bodyClassName="p-0"
    >
      {isLoading || error || !data ? <Loading error={error} /> : <StatementTable statement={data} />}
    </Section>
  )
}

/** El extracto para imprimir: hoja A4 con la leyenda arriba de cada página. */
export function BankStatementPrintPage() {
  const [params] = useSearchParams()
  const company = useCompany()
  const navigate = useNavigate()
  const from = params.get('desde') ?? ''
  const to = params.get('hasta') ?? ''
  const { data, isLoading, error } = useQuery({
    queryKey: ['bank-statement', company.companyId, from, to],
    queryFn: () => api.bankStatement(company.companyId, from, to),
  })
  if (isLoading) return <Loading />
  if (error || !data) return <p className="p-10 text-center">No se pudo armar el extracto para imprimir.</p>
  return (
    <div className="min-h-svh bg-slate-200 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between gap-2 px-2">
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft /> Volver
        </Button>
        <span className="text-xs text-muted-foreground">
          Usá “Guardar como PDF” en el diálogo de impresión para exportarlo.
        </span>
        <Button onClick={() => window.print()}>
          <Printer /> Imprimir / PDF
        </Button>
      </div>
      <article className="print-book text-[12px] text-slate-900 shadow-lg">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <td>
                <p className="mb-3 border border-slate-400 py-1 text-center text-[10px] font-bold tracking-wide">
                  {LEGEND}
                </p>
              </td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <header className="mb-4 flex items-start justify-between gap-6 border-b-2 border-navy pb-3">
                  <div>
                    <div className="text-lg font-black text-navy">Banco Aula</div>
                    <div className="text-slate-600">Banco simulado del aula: no es un banco real</div>
                    <div className="mt-2 font-semibold">{data.holder.legal_name}</div>
                    <div className="text-slate-600">CUIT {data.holder.tax_id} (simulado)</div>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-bold text-navy">Extracto de cuenta corriente</div>
                    <div>
                      Cuenta <Mono>{data.account.number}</Mono> · Alias <Mono>{data.account.alias}</Mono>
                    </div>
                    <div>
                      Del {date(data.from)} al {date(data.to)}
                    </div>
                    <div className="text-[11px] text-slate-600">Emitido el {dateTime(new Date().toISOString())}</div>
                  </div>
                </header>
                <StatementTable statement={data} compact />
                <p className="mt-6 border-t border-slate-300 pt-1.5 text-center text-[9px] text-slate-500">
                  {LEGEND} · Generado por INTEGR-AR (familia GEST-AR) · Banco, empresa y datos ficticios con fines
                  exclusivamente educativos.
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  )
}
