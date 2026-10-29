import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { HandCoins, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { ActionDialog } from '@/components/common/dialogs'
import { api, commands, type ReceivableRow, type TreasuryAccountRow } from '@/lib/api'
import { PAYMENT_METHODS } from '@/lib/domain/catalog'
import type { PaymentMethod } from '@/lib/domain/types'
import { date, money, parseAmount } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Importe escrito por el estudiante: "266200", "266.200,50" o "1.000.000"; si no es un número, 0. */
const amount = (s: string) => {
  const n = parseAmount(s)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const asInput = (n: number) => String(n).replace('.', ',')

/** Dónde suele ingresar cada medio (cuentas del plan básico): se propone y se puede cambiar. */
const METHOD_ACCOUNT: Record<PaymentMethod, string> = {
  TRANSFERENCIA: '1.1.01.03',
  CHEQUE: '1.1.01.04',
  EFECTIVO: '1.1.01.01',
}

export function CollectionFormPage() {
  const company = useCompany()
  const receivables = useQuery({
    queryKey: ['receivables', company.companyId],
    queryFn: () => api.receivables(company.companyId),
  })
  const treasury = useQuery({
    queryKey: ['treasury-accounts', company.companyId],
    queryFn: () => api.treasuryAccounts(company.companyId),
  })
  if (!receivables.data || !treasury.data) return <Loading error={receivables.error ?? treasury.error} />
  return <CollectionForm receivables={receivables.data} treasury={treasury.data} />
}

function CollectionForm({ receivables, treasury }: { receivables: ReceivableRow[]; treasury: TreasuryAccountRow[] }) {
  const company = useCompany()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const customers = receivables.filter((r) => r.balance > 0)
  const accounts = treasury.filter((t) => t.account.is_active)
  const accountFor = (method: PaymentMethod) =>
    accounts.find((a) => a.account.code === METHOD_ACCOUNT[method])?.account.id
  const [customerId, setCustomerId] = useState(
    () => customers.find((r) => r.customer.code === params.get('cliente'))?.customer.id ?? '',
  )
  const [method, setMethod] = useState<PaymentMethod>('TRANSFERENCIA')
  const [accountId, setAccountId] = useState(() => accountFor('TRANSFERENCIA') ?? accounts[0]?.account.id ?? '')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  // La retención de ingresos brutos que hace el cliente al pagar, si la hay (Fase 7b).
  const [retention, setRetention] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)

  const candidates = useQuery({
    enabled: !!customerId,
    queryKey: ['receipt-candidates', company.companyId, customerId],
    queryFn: () => api.receiptCandidates(company.companyId, customerId),
  })
  // Al elegir otro cliente se propone cobrar todo lo disponible de cada factura.
  const [loadedFor, setLoadedFor] = useState('')
  if (candidates.data && loadedFor !== customerId) {
    setLoadedFor(customerId)
    setValues(
      Object.fromEntries(candidates.data.map((c) => [c.invoice.id, c.available > 0 ? asInput(c.available) : ''])),
    )
  }

  const rows = (candidates.data ?? []).map((c) => ({ ...c, amount: amount(values[c.invoice.id] ?? '') }))
  const total = round2(rows.reduce((s, r) => s + r.amount, 0))
  const retained = retention.trim() ? amount(retention) : 0
  const retentionError = !(retained >= 0)
    ? 'Un importe de cero o más.'
    : retained && retained >= total
      ? 'Tiene que ser menor que lo que se cobra.'
      : undefined
  const cash = round2(total - (retained || 0))
  const account = accounts.find((a) => a.account.id === accountId)
  const customer = customers.find((r) => r.customer.id === customerId)
  const over = rows.some((r) => r.amount > r.available + 1e-9)
  const cheque = method === 'CHEQUE'
  const invalidCheque = cheque && !/^\d{1,8}$/.test(reference.trim())
  // Con el campo vacío alcanza la ayuda; el error aparece cuando lo escrito no es un número de cheque.
  const chequeError =
    invalidCheque && reference.trim() !== '' ? 'El número del cheque lleva sólo números (hasta 8).' : undefined
  const ready = !!customer && !!account && total > 0 && !over && !invalidCheque && !retentionError

  const changeMethod = (m: PaymentMethod) => {
    setMethod(m)
    const proposed = accountFor(m)
    if (proposed) setAccountId(proposed)
  }

  const save = useCommand(
    (confirm: boolean) =>
      commands.createCustomerReceipt(
        company.companyId,
        {
          customer_id: customerId,
          treasury_account_id: accountId,
          payment_method: method,
          reference: reference.trim(),
          notes,
          lines: rows.filter((r) => r.amount).map((r) => ({ invoice_id: r.invoice.id, amount: r.amount })),
          retention: retained,
        },
        confirm,
      ),
    {
      success: (r) => `${r.display_number} guardado.`,
      onSuccess: (r) => navigate(company.docPath('CUSTOMER_RECEIPT', r.display_number)),
    },
  )

  const crumbs = [
    { label: 'Inicio', to: company.to() },
    { label: 'Pagos y tesorería' },
    { label: 'Recibos de cobro', to: company.docPath('CUSTOMER_RECEIPT') },
    { label: 'Nuevo' },
  ]
  if (!customers.length) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Nuevo recibo de cobro" />
        <EmptyState icon={Wallet} title="No hay clientes con deuda para cobrar">
          Un recibo de cobro cancela facturas de venta ya registradas: cuando Ventas registre una, el cliente va a
          aparecer acá.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Nuevo recibo de cobro"
        description="Qué facturas de un cliente se cobran, cuánto de cada una, con qué medio y en qué caja o banco ingresa el dinero. Quien emitió una factura no registra su cobro."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Cliente y forma de cobro">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label="Cliente" required className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
                <SimpleSelect
                  value={customerId}
                  onChange={setCustomerId}
                  options={customers.map((r) => ({
                    value: r.customer.id,
                    label: `${r.customer.code} · ${r.customer.legal_name} (${money(r.balance)})`,
                  }))}
                  placeholder="Elegí el cliente que paga"
                />
              </Field>
              <Field label="Medio de cobro" required>
                <SimpleSelect
                  value={method}
                  onChange={changeMethod}
                  options={(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((m) => ({
                    value: m,
                    label: PAYMENT_METHODS[m],
                  }))}
                />
              </Field>
              <Field
                label={cheque ? 'Número del cheque' : 'Referencia'}
                required={cheque}
                hint={
                  cheque
                    ? 'Hasta 8 números: el del cheque que entrega el cliente.'
                    : 'Número de transferencia (opcional).'
                }
                error={chequeError}
              >
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  inputMode={cheque ? 'numeric' : undefined}
                  maxLength={cheque ? 8 : 60}
                />
              </Field>
              <Field
                label="Ingresa en"
                required
                hint={
                  cheque
                    ? 'Los cheques de terceros van a Valores a depositar hasta que se depositan en el banco.'
                    : account
                      ? `Saldo actual: ${money(account.balance)}`
                      : 'Una caja o un banco de la empresa.'
                }
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
              <Field label="Observaciones">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
              </Field>
            </div>
          </Section>
          {customer && (
            <Section
              title="Facturas que se cobran"
              description="Se propone cobrar el saldo de cada factura; el cliente puede pagar una parte. Lo que ya está en otro recibo en borrador queda reservado."
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
                          {r.committed > 0 && <> · reservado en otros recibos {money(r.committed)}</>}
                        </div>
                      </div>
                      <Field
                        label="Importe que cobra"
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
                    <p className="text-sm text-muted-foreground">Este cliente no tiene facturas para cobrar.</p>
                  )}
                </div>
              )}
              <div className="mt-4 ml-auto grid w-full max-w-xs gap-2 text-sm">
                <div className="flex justify-between border-t pt-2 font-semibold text-navy">
                  <span>Total del recibo</span>
                  <span className="tabular">{money(total)}</span>
                </div>
                <Field
                  label="Retención de ingresos brutos"
                  hint="Si el cliente la retiene: entrega el certificado en lugar de ese dinero."
                  error={retentionError}
                >
                  <Input
                    inputMode="decimal"
                    value={retention}
                    onChange={(e) => setRetention(e.target.value)}
                    placeholder="0,00"
                    className="tabular text-right"
                  />
                </Field>
                {retained > 0 && !retentionError && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Ingresa a {account?.account.name ?? 'la caja o el banco'}
                    </span>
                    <span className="tabular">{money(cash)}</span>
                  </div>
                )}
              </div>
            </Section>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="Después">
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
              <li>
                Se genera el asiento: {account?.account.name ?? 'la caja o el banco'} (y, si hay retención, Retenciones
                y percepciones sufridas) al debe y Deudores por ventas al haber.
              </li>
              <li>
                La deuda baja en la cuenta corriente del cliente y cada factura pasa a cobrada o cobrada en parte.
              </li>
              <li>Un cheque se deposita después en el banco con una transferencia entre cuentas.</li>
            </ul>
          </Section>
          <Button size="lg" disabled={!ready || save.isPending} onClick={() => setConfirming(true)}>
            <HandCoins /> Confirmar cobro
          </Button>
          <Button variant="outline" disabled={!ready || save.isPending} onClick={() => save.mutate([false])}>
            Guardar borrador
          </Button>
          <Button variant="ghost" asChild>
            <Link to={company.docPath('CUSTOMER_RECEIPT')}>Cancelar</Link>
          </Button>
        </aside>
      </div>
      {customer && (
        <ActionDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Confirmar cobro"
          description={`${money(total)} de ${customer.customer.legal_name} ${method === 'EFECTIVO' ? 'en efectivo' : method === 'CHEQUE' ? 'con cheque' : 'por transferencia'} en ${account?.account.name ?? ''}${retained > 0 ? `, con una retención de ingresos brutos de ${money(retained)} (ingresan ${money(cash)})` : ''}. Se genera el asiento y baja la deuda del cliente.`}
          confirmLabel="Confirmar cobro"
          busy={save.isPending}
          onConfirm={() => save.mutate([true])}
        />
      )}
    </>
  )
}
