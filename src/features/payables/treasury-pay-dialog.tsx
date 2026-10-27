import { useState, type ReactNode } from 'react'
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
import { api } from '@/lib/api'
import { money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/**
 * Tesorería paga un importe desde una caja o un banco (los sueldos, las cargas sociales,
 * un impuesto): elige la cuenta y ve si alcanza el saldo antes de pagar.
 */
export function TreasuryPayDialog({
  open,
  onOpenChange,
  title,
  description,
  amount,
  pay,
  success,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  amount: number
  pay: (accountId: string) => Promise<unknown>
  success: string
}) {
  const company = useCompany()
  const accounts = useQuery({
    queryKey: ['treasury-accounts', company.companyId],
    queryFn: () => api.treasuryAccounts(company.companyId),
  })
  const active = (accounts.data ?? []).filter((a) => a.account.is_active)
  // Se propone la cuenta con más saldo (en la demo, el banco): ahí suelen pagarse los sueldos y los impuestos.
  const [chosen, setChosen] = useState('')
  const richest = active.reduce<(typeof active)[number] | undefined>(
    (a, b) => (!a || b.balance > a.balance ? b : a),
    undefined,
  )
  const accountId = chosen || richest?.account.id || ''
  const account = active.find((a) => a.account.id === accountId)
  const short = !!account && amount > account.balance
  const run = useCommand(() => pay(accountId), { success, onSuccess: () => onOpenChange(false) })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description} Se genera el asiento del pago.</DialogDescription>
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            Volver
          </Button>
          <Button disabled={run.isPending || !accountId || short} onClick={() => run.mutate([])}>
            {run.isPending ? 'Procesando…' : `Pagar ${money(amount)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
