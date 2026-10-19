import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { CheckCheck, CircleAlert, CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { api, commands, type ReconciliationCandidates, type TreasuryAccountRow } from '@/lib/api'
import { date, money, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { MovementTable } from './reconciliation-views'

/** Acepta "1.300,50" (es-AR) y "1300.50"; vacío o inválido → null. */
const amount = (s: string) => {
  const t = String(s).trim()
  if (!t) return null
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function ReconciliationFormPage() {
  const company = useCompany()
  const accounts = useQuery({
    queryKey: ['treasury-accounts', company.companyId],
    queryFn: () => api.treasuryAccounts(company.companyId),
  })
  if (!accounts.data) return <Loading error={accounts.error} />
  return <ReconciliationForm accounts={accounts.data} />
}

function ReconciliationForm({ accounts }: { accounts: TreasuryAccountRow[] }) {
  const company = useCompany()
  const [accountId, setAccountId] = useState('')
  const [statementDate, setStatementDate] = useState(todayAR())
  const candidates = useQuery({
    queryKey: ['reconciliation-candidates', company.companyId, accountId, statementDate],
    queryFn: () => api.reconciliationCandidates(company.companyId, accountId, statementDate),
    enabled: !!accountId && !!statementDate,
  })
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Pagos y tesorería' },
          { label: 'Conciliaciones bancarias', to: company.docPath('BANK_RECONCILIATION') },
          { label: 'Nueva' },
        ]}
        title="Nueva conciliación bancaria"
        description="Con el extracto del banco, marcá qué movimientos del mayor figuran en él. Lo que no figura (cheques sin debitar, depósitos sin acreditar) explica la diferencia: la conciliación se confirma cuando cierra."
      />
      <Section title="Extracto" className="mb-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Banco" required>
            <SimpleSelect
              value={accountId}
              onChange={setAccountId}
              options={accounts.map((a) => ({ value: a.account.id, label: `${a.account.code} · ${a.account.name}` }))}
              placeholder="Elegí el banco que se concilia"
            />
          </Field>
          <Field label="Fecha del extracto" required>
            <Input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
          </Field>
        </div>
      </Section>
      {accountId &&
        (candidates.data ? (
          <ReconciliationWork
            key={`${accountId}|${statementDate}`}
            data={candidates.data}
            statementDate={statementDate}
          />
        ) : (
          <Loading error={candidates.error} />
        ))}
    </>
  )
}

function ReconciliationWork({ data, statementDate }: { data: ReconciliationCandidates; statementDate: string }) {
  const company = useCompany()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [balance, setBalance] = useState('')
  const [notes, setNotes] = useState('')
  const toggle = (id: string, checked: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  const pending = data.lines.filter((l) => !selected.has(l.line_id))
  const pendingDebits = round2(pending.reduce((s, l) => s + l.debit, 0))
  const pendingCredits = round2(pending.reduce((s, l) => s + l.credit, 0))
  const expected = round2(data.book_balance - pendingDebits + pendingCredits)
  const statement = amount(balance)
  const difference = statement == null ? null : round2(statement - expected)
  const save = useCommand(
    () =>
      commands.createBankReconciliation(company.companyId, {
        account_id: data.account.id,
        statement_date: statementDate,
        statement_balance: statement ?? 0,
        journal_line_ids: data.lines.filter((l) => selected.has(l.line_id)).map((l) => l.line_id),
        notes,
      }),
    {
      success: (r) => `${r.display_number} confirmada: cierra con el extracto.`,
      onSuccess: (r) => navigate(company.docPath('BANK_RECONCILIATION', r.display_number)),
    },
  )
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Section
        title={`Movimientos sin conciliar hasta el ${date(statementDate)} (${data.lines.length})`}
        description={
          data.last
            ? `La última conciliación de ${data.account.name} es ${data.last.display_number}, al ${date(data.last.statement_date)}: lo que concilió ya no aparece.`
            : `Es la primera conciliación de ${data.account.name}: también hay que marcar la apertura si figura en el extracto.`
        }
        actions={
          data.lines.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setSelected(new Set(data.lines.map((l) => l.line_id)))}>
              <CheckCheck /> Marcar todos
            </Button>
          )
        }
        bodyClassName="p-0"
      >
        <MovementTable
          lines={data.lines}
          selected={selected}
          onToggle={toggle}
          empty="No hay movimientos sin conciliar hasta esa fecha."
        />
      </Section>
      <aside className="flex flex-col gap-3">
        <Section title="Conciliación">
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Saldo según libros</dt>
              <dd className="tabular">{money(data.book_balance)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">− Entradas sin acreditar</dt>
              <dd className="tabular">{money(pendingDebits)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">+ Pagos sin debitar</dt>
              <dd className="tabular">{money(pendingCredits)}</dd>
            </div>
            <div className="flex justify-between gap-2 border-t pt-1.5 font-semibold text-navy">
              <dt>El extracto debería decir</dt>
              <dd className="tabular">{money(expected)}</dd>
            </div>
          </dl>
          <Field label="Saldo según el extracto" required className="mt-3">
            <Input
              inputMode="decimal"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="tabular text-right"
            />
          </Field>
          {difference != null && (
            <p className={cn('mt-3 flex gap-2 text-sm', difference === 0 ? 'text-green-800' : 'text-red-700')}>
              {difference === 0 ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
              )}
              {difference === 0
                ? 'Cierra: libros y extracto coinciden.'
                : `No cierra: diferencia de ${money(difference)}. Revisá qué figura en el extracto; si el banco registró comisiones o intereses, Contabilidad los registra con un asiento.`}
            </p>
          )}
          <Field label="Observaciones" className="mt-3">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
          </Field>
        </Section>
        <Button size="lg" disabled={save.isPending || difference !== 0} onClick={() => save.mutate([])}>
          Confirmar conciliación
        </Button>
        {company.can('journal_entry.create') && (
          <Button variant="outline" asChild>
            <Link to={company.docPath('JOURNAL_ENTRY', 'nuevo')}>Registrar un gasto bancario</Link>
          </Button>
        )}
      </aside>
    </div>
  )
}
