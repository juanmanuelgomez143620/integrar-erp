// Tablas de los libros contables. Las usan las pantallas y su versión para
// imprimir (book-print-page.tsx), así lo impreso es igual a lo que se ve.

import { Link } from 'react-router'
import type { JournalBook, Ledger, TrialBalance } from '@/lib/api'
import { JOURNAL_ORIGINS } from '@/lib/domain/catalog'
import { date, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ContraryBadge, balanceText } from './shared'

const th = 'border-b px-2 py-2 text-left text-xs font-semibold text-slate-600'
const td = 'px-2 py-1.5 align-top'
const num = 'tabular text-right whitespace-nowrap'

/** Libro diario como en los manuales: el número, la fecha, las cuentas del debe, "a" las del haber y la leyenda. */
export function JournalTable({ book, links = true }: { book: JournalBook; links?: boolean }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th className={cn(th, 'w-24')}>Fecha</th>
          <th className={th}>Cuentas</th>
          <th className={cn(th, 'w-36 text-right')}>Debe</th>
          <th className={cn(th, 'w-36 text-right')}>Haber</th>
        </tr>
      </thead>
      {book.entries.map((e) => (
        <tbody key={e.id} className="break-inside-avoid border-b">
          <tr>
            <td className={cn(td, 'pt-3 whitespace-nowrap')}>{date(e.date)}</td>
            <td className={cn(td, 'pt-3')} colSpan={3}>
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-navy">
                <span className="border-y border-slate-300 px-2">Asiento N.º {e.entry_number}</span>
                {links ? (
                  <Link to={e.path} className="font-mono font-normal text-brand-blue hover:underline">
                    {e.display_number}
                  </Link>
                ) : (
                  <span className="font-mono font-normal text-slate-500">{e.display_number}</span>
                )}
                {e.origin !== 'MANUAL' && (
                  <span className="font-normal text-slate-500">{JOURNAL_ORIGINS[e.origin]}</span>
                )}
                {e.status === 'ANULADO' && <span className="font-normal text-red-700">Anulado con contraasiento</span>}
              </div>
            </td>
          </tr>
          {e.lines.map((l, i) => (
            <tr key={i}>
              <td className={td} />
              <td className={cn(td, l.credit > 0 && 'pl-10')}>
                {l.credit > 0 && <span className="text-slate-500">a </span>}
                {l.account_name} <span className="font-mono text-xs text-slate-500">{l.account_code}</span>
                {l.notes && <span className="block text-xs text-slate-500">{l.notes}</span>}
              </td>
              <td className={cn(td, num)}>{l.debit ? money(l.debit) : ''}</td>
              <td className={cn(td, num)}>{l.credit ? money(l.credit) : ''}</td>
            </tr>
          ))}
          <tr>
            <td className={td} />
            <td className={cn(td, 'pb-3 text-xs text-slate-600 italic')} colSpan={3}>
              {e.description}
            </td>
          </tr>
        </tbody>
      ))}
      <tfoot>
        <tr className="border-t-2 border-navy font-semibold">
          <td className={td} colSpan={2}>
            Totales ({book.entries.length} {book.entries.length === 1 ? 'asiento' : 'asientos'})
          </td>
          <td className={cn(td, num)}>{money(book.total_debit)}</td>
          <td className={cn(td, num)}>{money(book.total_credit)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

/** Libro mayor de una cuenta: saldo anterior, movimientos con saldo acumulado y saldo final. */
export function LedgerTable({ ledger, from, links = true }: { ledger: Ledger; from: string; links?: boolean }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th className={cn(th, 'w-24')}>Fecha</th>
          <th className={cn(th, 'w-20')}>Asiento</th>
          <th className={th}>Leyenda</th>
          <th className={cn(th, 'w-32 text-right')}>Debe</th>
          <th className={cn(th, 'w-32 text-right')}>Haber</th>
          <th className={cn(th, 'w-36 text-right')}>Saldo</th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-b bg-muted/30">
          <td className={td} colSpan={5}>
            Saldo anterior al {date(from)}
          </td>
          <td className={cn(td, num)}>{balanceText(ledger.opening_balance)}</td>
        </tr>
        {ledger.rows.map((r, i) => (
          <tr key={i} className="border-b">
            <td className={cn(td, 'whitespace-nowrap')}>{date(r.date)}</td>
            <td className={td}>
              {links ? (
                <Link to={r.path} className="text-brand-blue hover:underline">
                  N.º {r.entry_number}
                </Link>
              ) : (
                `N.º ${r.entry_number}`
              )}
            </td>
            <td className={cn(td, 'text-xs')}>{r.description}</td>
            <td className={cn(td, num)}>{r.debit ? money(r.debit) : ''}</td>
            <td className={cn(td, num)}>{r.credit ? money(r.credit) : ''}</td>
            <td className={cn(td, num)}>{balanceText(r.balance)}</td>
          </tr>
        ))}
        {!ledger.rows.length && (
          <tr>
            <td className={cn(td, 'py-6 text-center text-muted-foreground')} colSpan={6}>
              La cuenta no tuvo movimientos en estas fechas.
            </td>
          </tr>
        )}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-navy font-semibold">
          <td className={td} colSpan={3}>
            Totales del período y saldo final
          </td>
          <td className={cn(td, num)}>{money(ledger.total_debit)}</td>
          <td className={cn(td, num)}>{money(ledger.total_credit)}</td>
          <td className={cn(td, num)}>{balanceText(ledger.closing_balance)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

/** Balance de sumas y saldos: las sumas del debe y del haber, y el saldo deudor o acreedor de cada cuenta. */
export function TrialBalanceTable({ balance }: { balance: TrialBalance }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th className={th} rowSpan={2}>
            Cuenta
          </th>
          <th className={cn(th, 'border-l text-center')} colSpan={2}>
            Sumas
          </th>
          <th className={cn(th, 'border-l text-center')} colSpan={2}>
            Saldos
          </th>
        </tr>
        <tr>
          <th className={cn(th, 'w-32 border-l text-right')}>Debe</th>
          <th className={cn(th, 'w-32 text-right')}>Haber</th>
          <th className={cn(th, 'w-32 border-l text-right')}>Deudor</th>
          <th className={cn(th, 'w-32 text-right')}>Acreedor</th>
        </tr>
      </thead>
      <tbody>
        {balance.rows.map((r) => (
          <tr key={r.account_id} className={cn('border-b', r.contrary && 'bg-red-50/60')}>
            <td className={td}>
              <span className="font-mono text-xs text-slate-500">{r.code}</span> {r.name}
              {r.contrary && (
                <div className="mt-1 print:hidden">
                  <ContraryBadge />
                </div>
              )}
            </td>
            <td className={cn(td, num, 'border-l')}>{r.debit ? money(r.debit) : ''}</td>
            <td className={cn(td, num)}>{r.credit ? money(r.credit) : ''}</td>
            <td className={cn(td, num, 'border-l')}>{r.debit_balance ? money(r.debit_balance) : ''}</td>
            <td className={cn(td, num)}>{r.credit_balance ? money(r.credit_balance) : ''}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-navy font-semibold">
          <td className={td}>Totales</td>
          <td className={cn(td, num, 'border-l')}>{money(balance.totals.debit)}</td>
          <td className={cn(td, num)}>{money(balance.totals.credit)}</td>
          <td className={cn(td, num, 'border-l')}>{money(balance.totals.debit_balance)}</td>
          <td className={cn(td, num)}>{money(balance.totals.credit_balance)}</td>
        </tr>
      </tfoot>
    </table>
  )
}
