import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { api, commands, type FundsTransferInput, type TreasuryAccountRow } from '@/lib/api'
import { money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Acepta "1.300,50" (es-AR) y "1300.50". */
const num = (s: string) => {
  const t = String(s).trim()
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? n : 0
}

export function TransferFormPage() {
  const company = useCompany()
  const accounts = useQuery({
    queryKey: ['treasury-accounts', company.companyId],
    queryFn: () => api.treasuryAccounts(company.companyId),
  })
  if (!accounts.data) return <Loading error={accounts.error} />
  return <TransferForm accounts={accounts.data.filter((a) => a.account.is_active)} />
}

function TransferForm({ accounts }: { accounts: TreasuryAccountRow[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const from = accounts.find((a) => a.account.id === fromId)
  const to = accounts.find((a) => a.account.id === toId)
  const value = Math.round(num(amount) * 100) / 100
  const short = !!from && value > from.balance

  const label = (a: TreasuryAccountRow) => `${a.account.code} · ${a.account.name} (${money(a.balance)})`
  const input = (): FundsTransferInput => ({
    from_account_id: fromId,
    to_account_id: toId,
    amount: value,
    reference,
    notes,
  })
  const save = useCommand((confirm: boolean) => commands.createFundsTransfer(company.companyId, input(), confirm), {
    success: (r) => `${r.display_number} guardada.`,
    onSuccess: (r) => navigate(company.docPath('FUNDS_TRANSFER', r.display_number)),
  })
  const ready = !!fromId && !!toId && fromId !== toId && value > 0

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Pagos y tesorería' },
          { label: 'Transferencias entre cuentas', to: company.docPath('FUNDS_TRANSFER') },
          { label: 'Nueva' },
        ]}
        title="Nueva transferencia entre cuentas"
        description="Mové fondos entre dos cajas o bancos de la empresa: depositar el efectivo en el banco, extraer para la caja o reponer el fondo fijo. El total de los fondos no cambia."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Section title="Cuentas e importe">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Desde (origen)" required>
              <SimpleSelect
                value={fromId}
                onChange={(v) => {
                  setFromId(v)
                  if (v === toId) setToId('')
                }}
                options={accounts.map((a) => ({ value: a.account.id, label: label(a) }))}
                placeholder="Elegí la caja o el banco"
              />
            </Field>
            <Field label="Hacia (destino)" required>
              <SimpleSelect
                value={toId}
                onChange={setToId}
                options={accounts
                  .filter((a) => a.account.id !== fromId)
                  .map((a) => ({ value: a.account.id, label: label(a) }))}
                placeholder="Elegí la caja o el banco"
              />
            </Field>
            <Field label="Importe" required error={short ? 'No alcanza el saldo de la cuenta de origen' : undefined}>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular text-right"
              />
            </Field>
            <Field label="Referencia" hint="Número de la boleta de depósito o de la transferencia (opcional).">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Observaciones" className="sm:col-span-2">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
            </Field>
          </div>
        </Section>
        <aside className="flex flex-col gap-3">
          <Section title="Cómo quedan">
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{from ? from.account.name : 'Origen'}</dt>
                <dd className="tabular">{from ? money(from.balance - value) : '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{to ? to.account.name : 'Destino'}</dt>
                <dd className="tabular">{to ? money(to.balance + value) : '—'}</dd>
              </div>
            </dl>
            {short && (
              <p className="mt-3 flex gap-2 text-xs text-red-700">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                Hay {money(from!.balance)}: se puede guardar como borrador, pero no confirmar.
              </p>
            )}
          </Section>
          <Button size="lg" disabled={save.isPending || !ready || short} onClick={() => save.mutate([true])}>
            <ArrowLeftRight /> Transferir
          </Button>
          <Button variant="outline" disabled={save.isPending || !ready} onClick={() => save.mutate([false])}>
            Guardar borrador
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancelar
          </Button>
        </aside>
      </div>
    </>
  )
}
