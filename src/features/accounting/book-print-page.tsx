import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Loading } from '@/components/common/blocks'
import { api } from '@/lib/api'
import { VAT_CONDITIONS } from '@/lib/domain/catalog'
import { date, dateTime } from '@/lib/format'
import { useCompany } from '@/app/company'
import { JournalTable, LedgerTable, TrialBalanceTable } from './books'

const LEGEND = 'DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL'

const TITLES: Record<string, string> = {
  diario: 'Libro diario',
  mayor: 'Libro mayor',
  'sumas-y-saldos': 'Balance de sumas y saldos',
}

/** Libros contables para imprimir: hoja A4 que sigue en varias páginas, con la leyenda arriba de cada una. */
export function BookPrintPage() {
  const { book = '' } = useParams()
  const [params] = useSearchParams()
  const company = useCompany()
  const navigate = useNavigate()
  const from = params.get('desde') ?? ''
  const to = params.get('hasta') ?? ''
  const accountId = params.get('cuenta') ?? ''
  const { data, isLoading, error } = useQuery({
    queryKey: ['book-print', company.companyId, book, from, to, accountId],
    queryFn: async () => {
      if (book === 'diario')
        return { kind: 'diario' as const, value: await api.journalBook(company.companyId, from, to) }
      if (book === 'mayor')
        return { kind: 'mayor' as const, value: await api.ledger(company.companyId, accountId, from, to) }
      return { kind: 'sumas' as const, value: await api.trialBalance(company.companyId, from, to) }
    },
  })
  if (isLoading) return <Loading />
  if (error || !data || !TITLES[book] || !data.value)
    return <p className="p-10 text-center">No se pudo armar el libro para imprimir.</p>
  const c = company.company
  const subtitle = data.kind === 'mayor' && data.value ? `${data.value.account.code} ${data.value.account.name}` : ''

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
                    <div className="text-lg font-black text-navy">{c.legal_name}</div>
                    <div className="text-slate-600">
                      CUIT {c.tax_id} (simulado) · {VAT_CONDITIONS[c.vat_condition]}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-bold text-navy">{TITLES[book]}</div>
                    {subtitle && <div className="font-semibold">{subtitle}</div>}
                    <div>
                      Del {date(from)} al {date(to)}
                    </div>
                    <div className="text-[11px] text-slate-600">Emitido el {dateTime(new Date().toISOString())}</div>
                  </div>
                </header>
                {data.kind === 'diario' && <JournalTable book={data.value} links={false} />}
                {data.kind === 'mayor' && data.value && <LedgerTable ledger={data.value} from={from} links={false} />}
                {data.kind === 'sumas' && <TrialBalanceTable balance={data.value} />}
                <p className="mt-6 border-t border-slate-300 pt-1.5 text-center text-[9px] text-slate-500">
                  {LEGEND} · Generado por INTEGR-AR (familia GEST-AR) · Empresa y datos ficticios con fines
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
