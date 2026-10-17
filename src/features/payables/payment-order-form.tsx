import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Banknote, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { ActionDialog } from '@/components/common/dialogs'
import { api, commands, type PayableRow, type TreasuryAccountRow } from '@/lib/api'
import { date, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Importe escrito por el estudiante: "266200", "266.200,50" o "266200,5". */
const amount = (s: string) => {
  const t = s.trim()
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const asInput = (n: number) => String(n).replace('.', ',')

export function PaymentOrderFormPage() {
  const company = useCompany()
  const payables = useQuery({
    queryKey: ['payables', company.companyId],
    queryFn: () => api.payables(company.companyId),
  })
  const treasury = useQuery({
    queryKey: ['treasury-accounts', company.companyId],
    queryFn: () => api.treasuryAccounts(company.companyId),
  })
  if (!payables.data || !treasury.data) return <Loading error={payables.error ?? treasury.error} />
  return <PaymentOrderForm payables={payables.data} treasury={treasury.data} />
}

function PaymentOrderForm({ payables, treasury }: { payables: PayableRow[]; treasury: TreasuryAccountRow[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const suppliers = payables.filter((p) => p.balance > 0)
  const accounts = treasury.filter((t) => t.account.is_active)
  const [supplierId, setSupplierId] = useState(
    () => suppliers.find((p) => p.supplier.code === params.get('proveedor'))?.supplier.id ?? '',
  )
  // Por defecto, el banco: los pagos a proveedores suelen hacerse por transferencia.
  const [accountId, setAccountId] = useState(
    () => (accounts.find((a) => a.account.code === '1.1.01.03') ?? accounts[0])?.account.id ?? '',
  )
  const [notes, setNotes] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)

  const candidates = useQuery({
    enabled: !!supplierId,
    queryKey: ['payment-candidates', company.companyId, supplierId],
    queryFn: () => api.paymentCandidates(company.companyId, supplierId),
  })
  // Al elegir otro proveedor se propone pagar todo lo disponible de cada factura.
  const [loadedFor, setLoadedFor] = useState('')
  if (candidates.data && loadedFor !== supplierId) {
    setLoadedFor(supplierId)
    setValues(
      Object.fromEntries(candidates.data.map((c) => [c.invoice.id, c.available > 0 ? asInput(c.available) : ''])),
    )
  }

  const rows = (candidates.data ?? []).map((c) => ({ ...c, amount: amount(values[c.invoice.id] ?? '') }))
  const total = round2(rows.reduce((s, r) => s + r.amount, 0))
  const account = accounts.find((a) => a.account.id === accountId)
  const supplier = suppliers.find((p) => p.supplier.id === supplierId)
  const over = rows.some((r) => r.amount > r.available + 1e-9)
  const short = !!account && total > account.balance + 1e-9

  const save = useCommand(
    (submit: boolean) =>
      commands.createPaymentOrder(
        company.companyId,
        {
          supplier_id: supplierId,
          treasury_account_id: accountId,
          notes,
          lines: rows.filter((r) => r.amount).map((r) => ({ invoice_id: r.invoice.id, amount: r.amount })),
        },
        submit,
      ),
    {
      success: (r) => `${r.display_number} guardada.`,
      onSuccess: (r) => navigate(company.docPath('PAYMENT_ORDER', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Pagos y tesorería' },
    { label: 'Órdenes de pago', to: company.docPath('PAYMENT_ORDER') },
    { label: 'Nueva' },
  ]
  if (!suppliers.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Nueva orden de pago" />
        <EmptyState icon={Wallet} title="No hay deudas con proveedores para pagar">
          Una orden de pago cancela facturas de proveedores ya registradas: cuando Compras registre una, el proveedor va
          a aparecer acá.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Nueva orden de pago"
        description="Qué facturas de un proveedor se pagan, cuánto de cada una y desde qué caja o banco. Gerencia la autoriza y Tesorería la paga: quien la prepara no la aprueba."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Proveedor y forma de pago">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label="Proveedor" required>
                <SimpleSelect
                  value={supplierId}
                  onChange={setSupplierId}
                  options={suppliers.map((p) => ({
                    value: p.supplier.id,
                    label: `${p.supplier.code} · ${p.supplier.legal_name} (${money(p.balance)})`,
                  }))}
                  placeholder="Elegí a quién se le paga"
                />
              </Field>
              <Field
                label="Paga desde"
                required
                hint={account ? `Saldo actual: ${money(account.balance)}` : 'Una caja o un banco de la empresa.'}
              >
                <SimpleSelect
                  value={accountId}
                  onChange={setAccountId}
                  options={accounts.map((a) => ({
                    value: a.account.id,
                    label: `${a.account.code} · ${a.account.name}`,
                  }))}
                  placeholder="Elegí la caja o el banco"
                />
              </Field>
              <Field label="Observaciones" className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
              </Field>
            </div>
          </Section>
          {supplier && (
            <Section
              title="Facturas que se pagan"
              description="Se propone pagar el saldo de cada factura; se puede pagar una parte. Lo que ya está en otra orden de pago en curso queda reservado."
            >
              {candidates.isLoading ? (
                <Loading />
              ) : (
                <div className="flex flex-col gap-2">
                  {rows.map((r) => (
                    <div
                      key={r.invoice.id}
                      className="grid items-start gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_160px] lg:grid-cols-1 xl:grid-cols-[1fr_160px]"
                    >
                      <div className="text-sm">
                        <Link to={r.invoice.path} className="font-mono text-xs font-semibold text-navy hover:underline">
                          {r.invoice.display_number}
                        </Link>{' '}
                        Factura {r.invoice.invoice_label}
                        <div className={cn('mt-1 text-xs text-muted-foreground', r.invoice.overdue && 'text-red-700')}>
                          Vence {date(r.invoice.due_date)}
                          {r.invoice.overdue ? ' (vencida)' : ''} · saldo{' '}
                          <span className="font-semibold">{money(r.invoice.pending)}</span>
                          {r.committed > 0 && <> · reservado en otras órdenes {money(r.committed)}</>}
                        </div>
                      </div>
                      <Field
                        label="Importe a pagar"
                        error={r.amount > r.available + 1e-9 ? `Como mucho ${money(r.available)}` : undefined}
                      >
                        <Input
                          inputMode="decimal"
                          value={values[r.invoice.id] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [r.invoice.id]: e.target.value }))}
                          className="tabular text-right"
                          disabled={r.available <= 0}
                        />
                      </Field>
                    </div>
                  ))}
                  {!rows.length && (
                    <p className="text-sm text-muted-foreground">Este proveedor no tiene facturas para pagar.</p>
                  )}
                </div>
              )}
              <div className="mt-4 ml-auto flex w-full max-w-xs justify-between border-t pt-2 font-semibold text-navy">
                <span>Total de la orden</span>
                <span className="tabular">{money(total)}</span>
              </div>
            </Section>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="Después">
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
              <li>Gerencia recibe una tarea para autorizar el pago.</li>
              <li>Tesorería paga: se controla que alcance el saldo de la caja o el banco.</li>
              <li>El asiento del pago se genera solo y la deuda baja en la cuenta corriente.</li>
            </ul>
          </Section>
          {short && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Hoy no alcanza el saldo de {account!.account.name} ({money(account!.balance)}): se va a poder pagar cuando
              haya fondos.
            </p>
          )}
          <Button
            size="lg"
            disabled={!supplier || !total || over || save.isPending}
            onClick={() => setConfirming(true)}
          >
            <Banknote /> Enviar a aprobación
          </Button>
          <Button
            variant="outline"
            disabled={!supplier || !total || over || save.isPending}
            onClick={() => save.mutate([false])}
          >
            Guardar borrador
          </Button>
          <Button variant="ghost" asChild>
            <Link to={company.docPath('PAYMENT_ORDER')}>Cancelar</Link>
          </Button>
        </aside>
      </div>
      {supplier && (
        <ActionDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Enviar a aprobación"
          description={`Pago a ${supplier.supplier.legal_name} por ${money(total)} desde ${account?.account.name ?? ''}. Gerencia tiene que autorizarlo.`}
          confirmLabel="Enviar"
          busy={save.isPending}
          onConfirm={() => save.mutate([true])}
        />
      )}
    </>
  )
}
