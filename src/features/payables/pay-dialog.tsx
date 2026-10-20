import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/common/blocks'
import { SimpleSelect } from '@/components/common/pickers'
import { commands, type DocumentDetail } from '@/lib/api'
import { PAYMENT_METHODS } from '@/lib/domain/catalog'
import type { PaymentMethod } from '@/lib/domain/types'
import { money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'

/** Tesorería paga la orden: elige el medio y anota la referencia (con cheque, su número). */
export function PayDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: DocumentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [method, setMethod] = useState<PaymentMethod>('TRANSFERENCIA')
  const [reference, setReference] = useState('')
  const cheque = method === 'CHEQUE'
  const pay = useCommand(() => commands.payPaymentOrder(detail.doc.id, reference.trim(), method), {
    success: 'Listo. El pago quedó registrado con su asiento.',
    onSuccess: () => onOpenChange(false),
  })
  const invalid = cheque && !/^\d{1,8}$/.test(reference.trim())
  // Con el campo vacío alcanza la ayuda; el error aparece cuando lo escrito no es un número de cheque.
  const chequeError =
    invalid && reference.trim() !== '' ? 'El número del cheque lleva sólo números (hasta 8).' : undefined
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pagar {detail.doc.display_number}</DialogTitle>
          <DialogDescription>
            {money(detail.doc.total)} a {detail.supplier?.legal_name} desde {detail.payment?.treasury_account.name}. Se
            genera el asiento y baja la deuda con el proveedor.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Medio de pago" required>
            <SimpleSelect
              value={method}
              onChange={setMethod}
              options={(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((m) => ({
                value: m,
                label: PAYMENT_METHODS[m],
              }))}
            />
          </Field>
          <Field
            label={cheque ? 'Número del cheque' : 'Referencia'}
            required={cheque}
            hint={cheque ? 'Hasta 8 números: queda en los cheques emitidos.' : 'Número de transferencia (opcional).'}
            error={chequeError}
          >
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              inputMode={cheque ? 'numeric' : undefined}
              maxLength={cheque ? 8 : 60}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pay.isPending}>
            Volver
          </Button>
          <Button disabled={pay.isPending || invalid} onClick={() => pay.mutate([])}>
            {pay.isPending ? 'Procesando…' : 'Pagar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
