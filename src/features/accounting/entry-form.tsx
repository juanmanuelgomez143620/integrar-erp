import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api, commands, type AccountRow, type DocumentDetail } from '@/lib/api'
import { money, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { AccountSelect, DoubleEntryHelp, useAccounts } from './shared'

interface LineState {
  key: string
  account_id: string
  debit: string
  credit: string
  notes: string
}

const blank = (): LineState => ({ key: crypto.randomUUID(), account_id: '', debit: '', credit: '', notes: '' })

/** Importe escrito por el estudiante: acepta coma o punto decimal. */
const amount = (s: string) => Number(s.trim().replace(',', '.')) || 0
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function EntryFormPage() {
  const { number } = useParams()
  const company = useCompany()
  const accounts = useAccounts()
  const existing = useQuery({
    enabled: !!number,
    queryKey: ['document', company.companyId, 'JOURNAL_ENTRY', number],
    queryFn: () => api.document(company.companyId, 'JOURNAL_ENTRY', number!),
  })
  if (!accounts.data || (number && existing.isLoading)) return <Loading error={accounts.error} />
  if (number && (!existing.data || existing.data.doc.status !== 'BORRADOR')) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-lg font-semibold text-navy">{number} no se puede modificar</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sólo se corrigen los asientos en borrador.</p>
        <Button asChild className="mt-4" variant="outline">
          <Link to={company.docPath('JOURNAL_ENTRY', number)}>Ver el asiento</Link>
        </Button>
      </div>
    )
  }
  return <EntryForm accounts={accounts.data} detail={existing.data ?? null} />
}

function EntryForm({ accounts, detail }: { accounts: AccountRow[]; detail: DocumentDetail | null }) {
  const company = useCompany()
  const navigate = useNavigate()
  const editing = detail?.doc ?? null
  const today = todayAR()
  const [date, setDate] = useState(editing?.document_date ?? today)
  const [description, setDescription] = useState(detail?.journal?.description ?? '')
  const [lines, setLines] = useState<LineState[]>(
    detail?.journal?.lines.map((l) => ({
      key: l.id,
      account_id: l.account.id,
      debit: l.debit ? String(l.debit) : '',
      credit: l.credit ? String(l.credit) : '',
      notes: l.notes,
    })) ?? [blank(), blank()],
  )
  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const debit = round2(lines.reduce((s, l) => s + amount(l.debit), 0))
  const credit = round2(lines.reduce((s, l) => s + amount(l.credit), 0))
  const difference = round2(debit - credit)

  const input = () => ({
    document_date: date,
    description,
    lines: lines
      .filter((l) => l.account_id || amount(l.debit) || amount(l.credit))
      .map((l) => ({ account_id: l.account_id, debit: amount(l.debit), credit: amount(l.credit), notes: l.notes })),
  })
  const save = useCommand(
    async (post: boolean) => {
      if (!editing) return commands.createJournalEntry(company.companyId, input(), post)
      await commands.updateJournalEntry(editing.id, input())
      if (post) await commands.confirmJournalEntry(editing.id)
      return { id: editing.id, display_number: editing.display_number }
    },
    {
      success: (r) => `${r.display_number} guardado.`,
      onSuccess: (r) => navigate(company.docPath('JOURNAL_ENTRY', r.display_number)),
    },
  )

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Contabilidad' },
          { label: 'Asientos', to: company.docPath('JOURNAL_ENTRY') },
          ...(editing
            ? [{ label: editing.display_number, to: editing.path }, { label: 'Editar' }]
            : [{ label: 'Nuevo' }]),
        ]}
        title={editing ? `Editar ${editing.display_number}` : 'Nuevo asiento'}
        description="Cada hecho económico se registra por partida doble: una o más cuentas al debe y una o más al haber, por el mismo importe. El borrador se puede guardar incompleto; al registrarlo en el libro diario se controla todo."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Datos del asiento">
            <div className="grid gap-4 sm:grid-cols-[180px_1fr] lg:grid-cols-1 xl:grid-cols-[180px_1fr]">
              <Field label="Fecha" required hint="No puede ser posterior a hoy.">
                <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field
                label="Leyenda"
                required
                hint="Qué hecho económico registra. Ej.: «Pago de la factura de luz con transferencia bancaria»."
              >
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </Field>
            </div>
          </Section>
          <Section
            title="Cuentas"
            description="Por costumbre, primero las cuentas del debe y después las del haber."
            actions={
              <Button size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, blank()])}>
                <Plus /> Agregar línea
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {lines.map((l, i) => (
                <div
                  key={l.key}
                  className="grid grid-cols-[1fr_1fr_auto] items-start gap-2 rounded-lg border p-3 xl:grid-cols-[1fr_130px_130px_auto]"
                >
                  <div className="col-span-3 flex min-w-0 flex-col gap-1.5 xl:col-span-1">
                    <Field label={`Cuenta ${i + 1}`}>
                      <AccountSelect
                        accounts={accounts}
                        value={l.account_id}
                        onChange={(id) => update(l.key, { account_id: id })}
                      />
                    </Field>
                    <Input
                      value={l.notes}
                      onChange={(e) => update(l.key, { notes: e.target.value })}
                      placeholder="Detalle de la línea (opcional)"
                      className="h-8 text-xs"
                      aria-label={`Detalle de la línea ${i + 1}`}
                    />
                  </div>
                  <Field label="Debe">
                    <Input
                      inputMode="decimal"
                      value={l.debit}
                      onChange={(e) => update(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
                      className="tabular text-right"
                    />
                  </Field>
                  <Field label="Haber">
                    <Input
                      inputMode="decimal"
                      value={l.credit}
                      onChange={(e) => update(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
                      className="tabular text-right"
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mt-6"
                    aria-label={`Quitar la línea ${i + 1}`}
                    disabled={lines.length <= 2}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-2 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">Total debe</div>
                <div className="tabular font-semibold">{money(debit)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Total haber</div>
                <div className="tabular font-semibold">{money(credit)}</div>
              </div>
              <div
                className={cn(
                  'flex items-center gap-2',
                  difference ? 'text-red-700' : debit ? 'text-green-700' : 'text-muted-foreground',
                )}
              >
                {difference ? <TriangleAlert className="size-4" /> : <CircleCheck className="size-4" />}
                <div>
                  <div className="text-xs">{difference ? 'Diferencia' : 'Balancea'}</div>
                  <div className="tabular font-semibold">{money(Math.abs(difference))}</div>
                </div>
              </div>
            </div>
          </Section>
        </div>
        <aside className="flex flex-col gap-3">
          <Button size="lg" disabled={save.isPending} onClick={() => save.mutate([true])}>
            Registrar en el libro diario
          </Button>
          <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate([false])}>
            Guardar borrador
          </Button>
          <Button variant="ghost" asChild>
            <Link to={editing ? editing.path : company.docPath('JOURNAL_ENTRY')}>Cancelar</Link>
          </Button>
          <DoubleEntryHelp />
        </aside>
      </div>
    </>
  )
}
