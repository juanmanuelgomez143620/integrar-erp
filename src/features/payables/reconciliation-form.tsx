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
import { date, money, parseAmount, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { StatementTable } from '@/features/bank/bank-statement'
import { MovementTable } from './reconciliation-views'

/** Acepta "1.300,50" (es-AR), "1.000.000" y "1300.50"; vacío o inválido → null. */
const amount = (s: string) => {
  const n = parseAmount(String(s))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** El saldo del extracto antes de su primera línea: el de esa línea sin su movimiento. */
const openingOf = (data: ReconciliationCandidates) => {
  const first = data.bank?.lines[0]
  return first ? round2(first.balance - first.credit + first.debit) : (data.bank?.balance ?? 0)
}

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
        description="Con el extracto del banco, marcá qué movimientos del mayor figuran en él. Lo que no figura (cheques sin debitar, depósitos sin acreditar, órdenes que el banco todavía no procesó) explica la diferencia: la conciliación se confirma cuando cierra. En la cuenta del Banco Aula, el extracto sale del banco."
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
  // En la cuenta del Banco Aula el saldo del extracto no se escribe: es el del banco a esa fecha.
  const statement = data.bank ? data.bank.balance : amount(balance)
  const difference = statement == null ? null : round2(statement - expected)
  const register = useCommand(
    () =>
      commands.registerBankCharges(
        company.companyId,
        (data.bank?.charges ?? []).map((c) => c.id),
      ),
    { success: (r) => `Movimientos del banco registrados en ${r.display_number}.` },
  )
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
      {data.bank && data.bank.charges.length > 0 && (
        <Section
          className="lg:col-start-1"
          title={`Movimientos del banco sin registrar (${data.bank.charges.length})`}
          description="El banco los hizo por su cuenta (cargos, la acreditación o las cuotas de un préstamo) y no están en los libros: registralos (con la fecha de hoy) para que la conciliación cierre."
          actions={
            <Button size="sm" disabled={register.isPending} onClick={() => register.mutate([])}>
              Registrar en los libros
            </Button>
          }
          bodyClassName="p-0"
        >
          <ul className="divide-y text-sm">
            {data.bank.charges.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span>
                  {date(c.date)} · {c.transaction_number} · {c.concept}
                </span>
                <span className="tabular">
                  {c.direction === 'CREDITO' ? 'Crédito' : 'Débito'} {money(c.amount)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {data.bank && (
        <Section
          className="lg:col-start-1"
          title={`Extracto del Banco Aula al ${date(statementDate)}`}
          description={
            data.last
              ? `Lo que el banco procesó después de la conciliación anterior (${date(data.last.statement_date)}): puntealo contra el mayor.`
              : 'Lo que el banco procesó desde la apertura de la cuenta: puntealo contra el mayor.'
          }
          bodyClassName="p-0"
        >
          <StatementTable
            compact
            statement={{
              holder: { legal_name: '', tax_id: '' },
              account: { number: '', bank_key: '', alias: '' },
              from: data.bank.lines[0]?.date ?? statementDate,
              to: statementDate,
              opening_balance: openingOf(data),
              lines: data.bank.lines,
              debits: round2(data.bank.lines.reduce((s, l) => s + l.debit, 0)),
              credits: round2(data.bank.lines.reduce((s, l) => s + l.credit, 0)),
              closing_balance: data.bank.balance,
            }}
          />
        </Section>
      )}
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
          {data.bank ? (
            <div className="mt-3 flex justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Saldo según el extracto del Banco Aula</span>
              <span className="tabular font-semibold">{money(data.bank.balance)}</span>
            </div>
          ) : (
            <Field label="Saldo según el extracto" required className="mt-3">
              <Input
                inputMode="decimal"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                className="tabular text-right"
              />
            </Field>
          )}
          {difference != null && (
            <p className={cn('mt-3 flex gap-2 text-sm', difference === 0 ? 'text-green-800' : 'text-red-700')}>
              {difference === 0 ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
              )}
              {difference === 0
                ? 'Cierra: libros y extracto coinciden.'
                : `No cierra: diferencia de ${money(difference)}. ${
                    data.bank
                      ? 'Marcá lo que figura en el extracto; lo que el banco hizo por su cuenta se registra desde «Movimientos del banco sin registrar».'
                      : 'Revisá qué figura en el extracto; si el banco registró comisiones o intereses, Contabilidad los registra con un asiento.'
                  }`}
            </p>
          )}
          <Field label="Observaciones" className="mt-3">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
          </Field>
        </Section>
        <Button size="lg" disabled={save.isPending || difference !== 0} onClick={() => save.mutate([])}>
          Confirmar conciliación
        </Button>
        {/* En el Banco Aula, un asiento manual le mandaría al banco otra orden: los cargos se registran arriba. */}
        {!data.bank && company.can('journal_entry.create') && (
          <Button variant="outline" asChild>
            <Link to={company.docPath('JOURNAL_ENTRY', 'nuevo')}>Registrar un gasto bancario</Link>
          </Button>
        )}
      </aside>
    </div>
  )
}
