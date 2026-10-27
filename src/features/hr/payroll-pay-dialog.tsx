import { commands, type DocumentDetail } from '@/lib/api'
import { date, money } from '@/lib/format'
import { TreasuryPayDialog } from '@/features/payables/treasury-pay-dialog'
import { periodLabel } from './payroll'

/**
 * Tesorería paga la liquidación desde una caja o un banco: primero los sueldos (los
 * netos) y después las cargas sociales (los aportes retenidos y las contribuciones).
 */
export function PayrollPayDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: DocumentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const view = detail.payroll!
  const salaries = detail.doc.status === 'CONFIRMADA'
  const month = periodLabel(view.period)
  return (
    <TreasuryPayDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${salaries ? 'Pagar los sueldos' : 'Pagar las cargas sociales'} · ${detail.doc.display_number}`}
      description={
        salaries
          ? `Los netos de los ${view.lines.length} empleados de ${month}: ${money(view.net)}, con fecha de pago el ${date(view.payment_date)}.`
          : `Los aportes retenidos (${money(view.deductions)}) y las contribuciones de la empresa (${money(view.employer)}) de ${month}: ${money(view.charges)}, que vencen el ${date(view.charges_due)}.`
      }
      amount={salaries ? view.net : view.charges}
      pay={(accountId) =>
        salaries
          ? commands.payPayrollSalaries(detail.doc.id, accountId)
          : commands.payPayrollCharges(detail.doc.id, accountId)
      }
      success={
        salaries
          ? 'Sueldos pagados: falta pagar las cargas sociales.'
          : 'Cargas sociales pagadas: la liquidación quedó pagada.'
      }
    />
  )
}
