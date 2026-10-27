import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field } from '@/components/common/blocks'
import { SimpleSelect } from '@/components/common/pickers'
import { api, commands, type DocumentDetail } from '@/lib/api'
import { date, money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
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
  const company = useCompany()
  const view = detail.payroll!
  const salaries = detail.doc.status === 'CONFIRMADA'
  const amount = salaries ? view.net : view.charges
  const accounts = useQuery({
    queryKey: ['treasury-accounts', company.companyId],
    queryFn: () => api.treasuryAccounts(company.companyId),
  })
  const active = (accounts.data ?? []).filter((a) => a.account.is_active)
  // Se propone la primera cuenta en la que alcanza el saldo (en la demo, el banco) o, si en
  // ninguna alcanza, la de más saldo.
  const [chosen, setChosen] = useState('')
  const richest = active.reduce<(typeof active)[number] | undefined>(
    (a, b) => (!a || b.balance > a.balance ? b : a),
    undefined,
  )
  const accountId = chosen || (active.find((a) => a.balance >= amount) ?? richest)?.account.id || ''
  const account = active.find((a) => a.account.id === accountId)
  const short = !!account && amount > account.balance
  const pay = useCommand(
    () =>
      salaries
        ? commands.payPayrollSalaries(detail.doc.id, accountId)
        : commands.payPayrollCharges(detail.doc.id, accountId),
    {
      success: salaries
        ? 'Sueldos pagados: falta pagar las cargas sociales.'
        : 'Cargas sociales pagadas: la liquidación quedó pagada.',
      onSuccess: () => onOpenChange(false),
    },
  )
  const month = periodLabel(view.period)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {salaries ? 'Pagar los sueldos' : 'Pagar las cargas sociales'} · {detail.doc.display_number}
          </DialogTitle>
          <DialogDescription>
            {salaries
              ? `Los netos de los ${view.lines.length} empleados de ${month}: ${money(view.net)}, con fecha de pago el ${date(view.payment_date)}.`
              : `Los aportes retenidos (${money(view.deductions)}) y las contribuciones de la empresa (${money(view.employer)}) de ${month}: ${money(view.charges)}, que vencen el ${date(view.charges_due)}.`}{' '}
            Se genera el asiento del pago.
          </DialogDescription>
        </DialogHeader>
        <Field
          label="Desde"
          required
          hint={account ? `Después del pago quedan ${money(account.balance - amount)}.` : undefined}
          error={short ? `No alcanza el saldo: hay ${money(account!.balance)}.` : undefined}
        >
          <SimpleSelect
            value={accountId}
            onChange={setChosen}
            placeholder={accounts.isLoading ? 'Cargando las cajas y los bancos…' : 'Elegí la caja o el banco'}
            options={active.map((a) => ({
              value: a.account.id,
              label: `${a.account.code} · ${a.account.name} (${money(a.balance)})`,
            }))}
            aria-label="Caja o banco"
          />
        </Field>
        {short && (
          <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            Primero hay que conseguir los fondos: transferirlos desde otra cuenta o cobrar a los clientes. El flujo de
            fondos proyectado muestra cuánto falta.
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pay.isPending}>
            Volver
          </Button>
          <Button disabled={pay.isPending || !accountId || short} onClick={() => pay.mutate([])}>
            {pay.isPending ? 'Procesando…' : `Pagar ${money(amount)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
