import { useNavigate } from 'react-router'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DocumentDetail } from '@/lib/api'
import type { Company } from '@/lib/domain/types'
import { date, money, qty } from '@/lib/format'
import { periodLabel, rate } from './payroll'

const LEGEND = 'DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL NI LEGAL'

/**
 * Los recibos simulados de una liquidación: una hoja por empleado, con sus conceptos,
 * el neto a cobrar y la leyenda de simulación (no imita el formato de un recibo oficial).
 */
export function PayrollReceipts({ detail, company }: { detail: DocumentDetail; company: Company }) {
  const navigate = useNavigate()
  const { doc } = detail
  const view = detail.payroll!
  const th = 'border-b border-slate-300 px-2 py-1.5 text-left text-[11px] font-semibold uppercase text-slate-600'
  const td = 'border-b border-slate-200 px-2 py-1.5 align-top'
  const signer = detail.signatures.find((s) => s.label === 'Liquidó')
  return (
    <div className="min-h-svh bg-slate-200 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between gap-2 px-2">
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft /> Volver
        </Button>
        <span className="text-xs text-muted-foreground">
          {view.lines.length} recibos, uno por hoja. Usá “Guardar como PDF” para exportarlos.
        </span>
        <Button onClick={() => window.print()}>
          <Printer /> Imprimir / PDF
        </Button>
      </div>
      {view.lines.map((l) => {
        const rows: { concept: string; amount: string; earning?: number; deduction?: number }[] = [
          { concept: 'Sueldo básico', amount: `${l.days_worked} días`, earning: l.basic },
          { concept: 'Antigüedad', amount: `${l.seniority_years} años`, earning: l.seniority },
          {
            concept: 'Presentismo',
            amount: l.absence_days ? `${l.absence_days} ausencias` : '',
            earning: l.attendance,
          },
          ...(l.overtime_50 || l.overtime_100
            ? [
                {
                  concept: 'Horas extra',
                  amount: [
                    l.overtime_50 ? `${qty(l.overtime_50)} h al 50 %` : '',
                    l.overtime_100 ? `${qty(l.overtime_100)} h al 100 %` : '',
                  ]
                    .filter(Boolean)
                    .join(' y '),
                  earning: l.overtime,
                },
              ]
            : []),
          { concept: 'Jubilación', amount: rate(view.rates.retirement_pct), deduction: l.retirement },
          { concept: 'Ley 19.032', amount: rate(view.rates.pami_pct), deduction: l.pami },
          { concept: 'Obra social', amount: rate(view.rates.health_pct), deduction: l.health },
        ]
        return (
          <article
            key={l.id}
            className="print-sheet mb-6 text-[12px] text-slate-900 shadow-lg break-after-page print:mb-0"
          >
            <div className="print-watermark">SIMULACIÓN EDUCATIVA</div>
            <p className="mb-3 border border-slate-400 py-1 text-center text-[10px] font-bold tracking-wide">
              {LEGEND}
            </p>
            <header className="flex items-start justify-between gap-6 border-b-2 border-navy pb-3">
              <div>
                <div className="text-lg font-black text-navy">{company.legal_name}</div>
                <div className="text-slate-600">
                  {company.address_line} · {company.city}, {company.province}
                </div>
                <div className="text-slate-600">CUIT {company.tax_id} (simulado)</div>
              </div>
              <div className="min-w-56 rounded border-2 border-navy p-2 text-right">
                <div className="text-[11px] font-semibold text-slate-600 uppercase">Recibo de sueldo (simulado)</div>
                <div className="font-mono text-xl font-bold text-navy">{periodLabel(view.period)}</div>
                <div>
                  {doc.display_number} · pago: {date(view.payment_date)}
                </div>
              </div>
            </header>
            <section className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1">
              <div>
                <b>Empleado:</b> {l.employee.last_name}, {l.employee.first_name}
              </div>
              <div>
                <b>Legajo:</b> {l.employee.file_number}
              </div>
              <div>
                <b>Categoría:</b> {l.category.name} (básico {money(l.basic_salary)})
              </div>
              <div>
                <b>Ingreso:</b> {date(l.employee.hire_date)} ({l.seniority_years} años)
              </div>
              <div>
                <b>Sector:</b> {l.sector.name}
                {l.work_center ? ` · ${l.work_center.code} ${l.work_center.name}` : ''}
              </div>
            </section>
            <table className="mt-4 w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>Concepto</th>
                  <th className={th}>Cantidad</th>
                  <th className={`${th} text-right`}>Remunerativo</th>
                  <th className={`${th} text-right`}>Descuentos</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.concept}>
                    <td className={td}>{r.concept}</td>
                    <td className={td}>{r.amount}</td>
                    <td className={`${td} text-right`}>{r.earning !== undefined ? money(r.earning) : ''}</td>
                    <td className={`${td} text-right`}>{r.deduction !== undefined ? money(r.deduction) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className={`${td} font-semibold`} colSpan={2}>
                    Totales
                  </td>
                  <td className={`${td} text-right font-semibold`}>{money(l.gross)}</td>
                  <td className={`${td} text-right font-semibold`}>{money(l.deductions)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="mt-3 ml-auto w-72">
              <div className="flex justify-between border-t-2 border-navy pt-1 text-sm font-bold">
                <span>NETO A COBRAR</span>
                <span>{money(l.net)}</span>
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-slate-600">
                <span>Contribuciones de la empresa (informativo)</span>
                <span>{money(l.employer)}</span>
              </div>
            </div>
            <section className="mt-16 grid grid-cols-2 gap-10">
              <div className="text-center">
                <div className="h-10 text-[11px] text-slate-600">
                  {signer?.name ? `${signer.name} · ${signer.sector}` : ''}
                </div>
                <div className="border-t border-slate-500 pt-1 text-[11px] font-semibold uppercase">Liquidó</div>
              </div>
              <div className="text-center">
                <div className="h-10" />
                <div className="border-t border-slate-500 pt-1 text-[11px] font-semibold uppercase">
                  Recibí conforme (empleado)
                </div>
              </div>
            </section>
            <footer className="absolute right-[15mm] bottom-[12mm] left-[15mm] border-t border-slate-300 pt-1.5 text-center text-[9px] text-slate-500">
              {LEGEND} · Generado por INTEGR-AR (familia GEST-AR) · Empresa, personas y datos ficticios con fines
              exclusivamente educativos.
            </footer>
          </article>
        )
      })}
    </div>
  )
}
