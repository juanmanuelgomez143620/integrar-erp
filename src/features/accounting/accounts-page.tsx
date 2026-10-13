import { useState } from 'react'
import { Link } from 'react-router'
import { BookMarked, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, Loading } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { matchesSearch } from '@/components/common/data-table'
import { commands, type AccountRow } from '@/lib/api'
import { ACCOUNT_TYPES } from '@/lib/domain/catalog'
import { ACCOUNT_CODE_PATTERN, accountTypeOf, normalSideOf, parentCode } from '@/lib/domain/chart-of-accounts'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { ContraryBadge, balanceText, useAccounts } from './shared'

const LEVEL_STYLE = ['', 'font-semibold uppercase text-navy', 'font-semibold text-navy', 'font-medium', '']
const INDENT = ['', 'pl-0', 'pl-3', 'pl-6', 'pl-9']

export function AccountsPage() {
  const company = useCompany()
  const { data, isLoading } = useAccounts()
  const [term, setTerm] = useState('')
  const [withBalance, setWithBalance] = useState(false)
  const [editing, setEditing] = useState<AccountRow | 'new' | null>(null)
  const canCreate = company.can('account.create')
  const canUpdate = company.can('account.update')
  const canLedger = company.can('ledger.read')
  const toggle = useCommand((id: string, active: boolean) => commands.setAccountActive(company.companyId, id, active))
  if (isLoading || !data) return <Loading />

  const rows = data.filter(
    (a) => (!term.trim() || matchesSearch(`${a.code} ${a.name}`, term)) && (!withBalance || a.balance !== 0),
  )

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Contabilidad' }, { label: 'Plan de cuentas' }]}
        title="Plan de cuentas"
        description="La lista ordenada de las cuentas de la empresa. Los rubros agrupan; sólo las cuentas de nivel 4 se usan en los asientos. El saldo sale de los asientos del libro diario: D es deudor y A, acreedor."
        actions={
          canCreate ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Nueva cuenta
            </Button>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Buscar por código o nombre…"
          className="max-w-xs"
          aria-label="Buscar cuentas"
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={withBalance} onCheckedChange={setWithBalance} />
          Sólo con saldo
        </label>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="w-24 text-xs">Código</TableHead>
              <TableHead className="text-xs">Cuenta</TableHead>
              <TableHead className="hidden text-xs xl:table-cell">Tipo</TableHead>
              <TableHead className="text-right text-xs">Saldo</TableHead>
              <TableHead className="text-xs">
                <span className="sr-only">Acciones</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id} className={cn(!a.is_active && 'opacity-50', !a.is_imputable && 'bg-muted/20')}>
                <TableCell className="font-mono text-xs">{a.code}</TableCell>
                <TableCell className={cn('text-sm whitespace-normal', INDENT[a.level], LEVEL_STYLE[a.level])}>
                  {a.name}
                  {a.normal_side !== normalSideOf(a.account_type) && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground normal-case">(regularizadora)</span>
                  )}
                  {a.contrary && (
                    <div className="mt-1">
                      <ContraryBadge />
                    </div>
                  )}
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                  {ACCOUNT_TYPES[a.account_type]}
                </TableCell>
                <TableCell
                  className={cn(
                    'tabular text-right text-sm',
                    !a.is_imputable && 'font-semibold',
                    a.contrary && 'text-red-700',
                  )}
                >
                  {a.balance === 0 && !a.is_imputable ? '' : balanceText(a.balance)}
                </TableCell>
                <TableCell>
                  {a.is_imputable && (
                    <div className="flex items-center justify-end gap-1">
                      {canLedger && (
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={company.to(`contabilidad/mayor?cuenta=${a.id}`)} aria-label={`Mayor de ${a.name}`}>
                            <BookMarked /> <span className="hidden xl:inline">Mayor</span>
                          </Link>
                        </Button>
                      )}
                      {canUpdate && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Editar ${a.name}`}
                            onClick={() => setEditing(a)}
                          >
                            <Pencil />
                          </Button>
                          <Switch
                            checked={a.is_active}
                            onCheckedChange={(v) => toggle.mutate([a.id, v])}
                            aria-label={`${a.name} activa`}
                          />
                        </>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No hay cuentas que coincidan.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {editing && (
        <AccountDialog account={editing === 'new' ? null : editing} accounts={data} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

/** Próximo código libre dentro de un rubro: 1.1.01 → 1.1.01.05 si ya hay cuatro cuentas. */
function nextCode(accounts: AccountRow[], rubro: string) {
  const used = accounts
    .filter((a) => a.level === 4 && parentCode(a.code) === rubro)
    .map((a) => Number(a.code.slice(-2)))
  return `${rubro}.${String(Math.max(0, ...used) + 1).padStart(2, '0')}`
}

function AccountDialog({
  account,
  accounts,
  onClose,
}: {
  account: AccountRow | null
  accounts: AccountRow[]
  onClose: () => void
}) {
  const company = useCompany()
  const rubros = accounts.filter((a) => a.level === 3)
  const [rubro, setRubro] = useState(account ? parentCode(account.code) : '')
  const [code, setCode] = useState(account?.code ?? '')
  const [name, setName] = useState(account?.name ?? '')
  const [description, setDescription] = useState(account?.description ?? '')
  const [contra, setContra] = useState(account ? account.normal_side !== normalSideOf(account.account_type) : false)
  const save = useCommand(
    () =>
      commands.saveAccount(company.companyId, {
        id: account?.id,
        code: code.trim(),
        name,
        description,
        is_contra: contra,
      }),
    { success: account ? 'Cuenta modificada.' : 'Cuenta creada.', onSuccess: onClose },
  )
  const validCode = ACCOUNT_CODE_PATTERN.test(code.trim())
  const type = validCode ? accountTypeOf(code.trim()) : null

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{account ? `Editar ${account.code} ${account.name}` : 'Nueva cuenta'}</DialogTitle>
          <DialogDescription>
            {account
              ? 'El código y el rubro no cambian: si la cuenta va en otro lugar, creá una nueva y desactivá esta.'
              : 'Las cuentas nuevas van dentro de un rubro del plan. El tipo (activo, pasivo…) sale del rubro.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <Field label="Rubro" required className="sm:col-span-2">
            <SimpleSelect
              value={rubro}
              disabled={!!account}
              onChange={(r) => {
                setRubro(r)
                setCode(nextCode(accounts, r))
              }}
              options={rubros.map((r) => ({ value: r.code, label: `${r.code} ${r.name}` }))}
              placeholder="Elegí el rubro"
            />
          </Field>
          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Código" required>
            <Input value={code} disabled={!!account} onChange={(e) => setCode(e.target.value)} className="font-mono" />
          </Field>
          <Field
            label="Descripción"
            className="sm:col-span-2"
            hint="Qué se registra en esta cuenta, con palabras de estudiante."
          >
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <Switch checked={contra} onCheckedChange={setContra} className="mt-0.5" />
            <span>
              Regularizadora
              <span className="block text-xs text-muted-foreground">
                Corrige el valor de otra cuenta de su rubro y tiene el saldo al revés (por ejemplo, la amortización
                acumulada en el activo).
              </span>
            </span>
          </label>
          {type && (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Tipo: <span className="font-medium text-foreground">{ACCOUNT_TYPES[type]}</span> · saldo normal{' '}
              <span className="font-medium text-foreground">
                {normalSideOf(type, contra) === 'DEBE' ? 'deudor' : 'acreedor'}
              </span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={save.isPending || !name.trim() || !validCode} onClick={() => save.mutate([])}>
            {account ? 'Guardar' : 'Crear cuenta'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
