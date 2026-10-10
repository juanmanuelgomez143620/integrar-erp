import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, ListPlus, Plus, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DataTable } from '@/components/common/data-table'
import { Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/pickers'
import { AuditTimeline } from '@/components/common/audit-timeline'
import { api, commands, type MemberView } from '@/lib/api'
import { MODULES, ROLES, ROLE_ORDER } from '@/lib/domain/catalog'
import type { ModuleCode, RoleCode } from '@/lib/domain/types'
import { relative } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { BulkStudentsDialog } from './bulk-students-dialog'

export function TeacherPage() {
  const company = useCompany()
  const members = useQuery({
    queryKey: ['members', company.companyId],
    queryFn: () => api.members(company.companyId),
    enabled: company.supervisor,
  })
  const audit = useQuery({
    queryKey: ['audit', company.companyId],
    queryFn: () => api.audit(company.companyId),
    enabled: company.supervisor,
  })
  const [assignFor, setAssignFor] = useState<MemberView | null>(null)
  const [resetPasswordFor, setResetPasswordFor] = useState<MemberView | null>(null)
  const [newStudent, setNewStudent] = useState(false)
  const [bulkStudents, setBulkStudents] = useState(false)
  const removeRole = useCommand((id: string) => commands.removeRole(company.companyId, id), { success: 'Rol quitado.' })
  const setModule = useCommand((m: ModuleCode, v: boolean) => commands.setModule(company.companyId, m, v), {
    success: 'Módulo actualizado.',
  })
  const setSettings = useCommand(
    (s: Parameters<typeof commands.updateCompanySettings>[1]) => commands.updateCompanySettings(company.companyId, s),
    { success: 'Configuración actualizada.' },
  )

  if (!company.supervisor) return <p className="py-20 text-center text-sm text-muted-foreground">Sólo docentes.</p>
  if (!members.data) return <Loading />

  const byIsland = new Map<number, number>()
  for (const e of audit.data ?? []) {
    const m = members.data.find((x) => x.user.id === e.actor_user_id)
    const island = m?.roles[0]?.island
    if (island) byIsland.set(island, (byIsland.get(island) ?? 0) + 1)
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Panel docente' }]}
        title="Panel docente"
        description="Organizá el aula: asigná puestos y sectores, habilitá módulos, configurá el control interno y seguí la actividad de cada isla."
      />
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Integrantes y roles</TabsTrigger>
          <TabsTrigger value="config">Módulos y control interno</TabsTrigger>
          <TabsTrigger value="activity">Actividad</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="mt-3">
          <DataTable<MemberView>
            rows={members.data}
            rowKey={(m) => m.user.id}
            search={(m) =>
              `${m.user.first_name} ${m.user.last_name} ${m.user.username} ${m.roles.map((r) => r.role_name).join(' ')}`
            }
            toolbar={
              <>
                <Button size="sm" onClick={() => setBulkStudents(true)}>
                  <ListPlus /> Alta masiva
                </Button>
                <Button size="sm" variant="outline" onClick={() => setNewStudent(true)}>
                  <UserPlus /> Agregar estudiante
                </Button>
              </>
            }
            columns={[
              {
                key: 'name',
                header: 'Integrante',
                sort: (m) => m.user.last_name,
                cell: (m) => (
                  <div>
                    <div className="font-medium">
                      {m.user.last_name}, {m.user.first_name}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{m.user.username}</div>
                  </div>
                ),
              },
              {
                key: 'roles',
                header: 'Roles · sector · isla',
                cell: (m) => (
                  <div className="flex flex-wrap gap-1">
                    {m.roles.map((r) => (
                      <span
                        key={r.id}
                        className="inline-flex items-center gap-1 rounded-full bg-brand-blue-soft px-2 py-0.5 text-xs text-navy"
                      >
                        {r.role_name}
                        {r.sector_name !== '—' ? ` · ${r.sector_name}` : ''}
                        {r.island ? ` · Isla ${r.island}` : ''}
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-red-600"
                          aria-label="Quitar rol"
                          disabled={removeRole.isPending}
                          onClick={() => removeRole.mutate([r.id])}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                    {!m.roles.length && <span className="text-xs text-amber-700">Sin rol asignado</span>}
                  </div>
                ),
              },
              {
                key: 'actions',
                header: 'Acciones registradas',
                align: 'right',
                sort: (m) => m.actions_count,
                cell: (m) => <span className="tabular">{m.actions_count}</span>,
              },
              {
                key: 'last',
                header: 'Última actividad',
                cell: (m) => (
                  <span className="text-xs text-muted-foreground">
                    {m.last_activity ? relative(m.last_activity) : '—'}
                  </span>
                ),
              },
              {
                key: 'add',
                header: '',
                align: 'right',
                cell: (m) => (
                  <div className="flex justify-end gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => setResetPasswordFor(m)}>
                      <KeyRound /> Contraseña
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => setAssignFor(m)}>
                      <Plus /> Rol
                    </Button>
                  </div>
                ),
              },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Rotá los roles entre clases para que cada estudiante recorra todo el circuito. Los cambios quedan en la
            auditoría.
          </p>
        </TabsContent>

        <TabsContent value="config" className="mt-3 grid gap-4 lg:grid-cols-2">
          <Section
            title="Módulos"
            description="Un módulo bloqueado deja de estar disponible para los estudiantes (no para el docente)."
          >
            <ul className="flex flex-col gap-3">
              {(Object.keys(MODULES) as ModuleCode[])
                .filter((m) => MODULES[m].lockable)
                .map((m) => {
                  const row = company.modules.find((x) => x.module_code === m)
                  return (
                    <li key={m} className="flex items-center justify-between gap-3 text-sm">
                      {MODULES[m].name}
                      <Switch
                        aria-label={MODULES[m].name}
                        checked={row?.is_enabled ?? true}
                        disabled={setModule.isPending}
                        onCheckedChange={(v) => setModule.mutate([m, v])}
                      />
                    </li>
                  )
                })}
            </ul>
          </Section>
          <Section title="Control interno">
            <ul className="flex flex-col gap-4 text-sm">
              <li className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">Separación de funciones</div>
                  <div className="text-xs text-muted-foreground">
                    Quien crea una orden no puede aprobarla; quien registra una recepción no puede anularla. Desactivala
                    sólo si una isla tiene un único estudiante.
                  </div>
                </div>
                <Switch
                  aria-label="Separación de funciones"
                  disabled={setSettings.isPending}
                  checked={company.company.settings.sod_enabled}
                  onCheckedChange={(v) => setSettings.mutate([{ sod_enabled: v }])}
                />
              </li>
              <li className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">Permitir stock negativo</div>
                  <div className="text-xs text-muted-foreground">
                    Desactivado, el sistema impide sacar más de lo que hay (recomendado).
                  </div>
                </div>
                <Switch
                  aria-label="Permitir stock negativo"
                  disabled={setSettings.isPending}
                  checked={company.company.settings.allow_negative_stock}
                  onCheckedChange={(v) => setSettings.mutate([{ allow_negative_stock: v }])}
                />
              </li>
            </ul>
          </Section>
        </TabsContent>

        <TabsContent value="activity" className="mt-3 grid gap-4 lg:grid-cols-[280px_1fr]">
          <Section title="Acciones por isla">
            <ul className="flex flex-col gap-2 text-sm">
              {[...company.islands]
                .sort((a, b) => a.number - b.number)
                .map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                      {i.number} · {i.name}
                    </span>
                    <span className="tabular font-semibold">{byIsland.get(i.number) ?? 0}</span>
                  </li>
                ))}
            </ul>
          </Section>
          <Section title="Últimos movimientos">
            <AuditTimeline events={(audit.data ?? []).slice(0, 25)} compact />
          </Section>
        </TabsContent>
      </Tabs>

      {assignFor && <AssignRoleDialog member={assignFor} onClose={() => setAssignFor(null)} />}
      {resetPasswordFor && <ResetPasswordDialog member={resetPasswordFor} onClose={() => setResetPasswordFor(null)} />}
      <NewStudentDialog open={newStudent} onOpenChange={setNewStudent} />
      <BulkStudentsDialog open={bulkStudents} onOpenChange={setBulkStudents} />
    </>
  )
}

function AssignRoleDialog({ member, onClose }: { member: MemberView; onClose: () => void }) {
  const company = useCompany()
  const [role, setRole] = useState<RoleCode | ''>('')
  const [sector, setSector] = useState('')
  const assign = useCommand(
    () => commands.assignRole(company.companyId, member.user.id, role as RoleCode, sector || null),
    { success: 'Rol asignado.', onSuccess: onClose },
  )
  const onRole = (r: RoleCode) => {
    setRole(r)
    const code = ROLES[r].defaultSector
    setSector(company.sectors.find((s) => s.code === code)?.id ?? '')
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Asignar rol a {member.user.first_name} {member.user.last_name}
          </DialogTitle>
          <DialogDescription>
            El rol define qué puede hacer; el sector, dónde trabaja (queda en la auditoría de cada acción).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Rol funcional">
            <SimpleSelect
              value={role}
              onChange={onRole}
              options={ROLE_ORDER.map((r) => ({ value: r, label: ROLES[r].name }))}
              placeholder="Elegí el rol"
            />
          </Field>
          {role && <p className="-mt-2 text-xs text-muted-foreground">{ROLES[role].description}</p>}
          <Field label="Sector">
            <SimpleSelect
              value={sector}
              onChange={setSector}
              options={company.sectors.map((s) => ({ value: s.id, label: s.name }))}
              placeholder="Sin sector"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!role || assign.isPending} onClick={() => assign.mutate([])}>
            Asignar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({ member, onClose }: { member: MemberView; onClose: () => void }) {
  const company = useCompany()
  const [password, setPassword] = useState('')
  const reset = useCommand(() => commands.resetPassword(company.companyId, member.user.id, password), {
    success: 'Contraseña restablecida.',
    onSuccess: onClose,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Restablecer la contraseña de {member.user.first_name} {member.user.last_name}
          </DialogTitle>
          <DialogDescription>
            La persona va a tener que cambiarla por una propia la próxima vez que ingrese.
          </DialogDescription>
        </DialogHeader>
        <Field label="Contraseña nueva" hint="Mínimo 6 caracteres.">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={password.length < 6 || reset.isPending} onClick={() => reset.mutate([])}>
            Restablecer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NewStudentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const company = useCompany()
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const create = useCommand(
    () => commands.createStudent(company.companyId, { first_name: first, last_name: last, username, password }),
    {
      success: 'Estudiante agregado. Ahora asignale un rol.',
      onSuccess: () => {
        onOpenChange(false)
        setFirst('')
        setLast('')
        setUsername('')
        setPassword('')
      },
    },
  )
  const suggest = (f: string, l: string) =>
    `${f.trim()[0] ?? ''}${l.trim().split(' ')[0] ?? ''}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agregar estudiante</DialogTitle>
          <DialogDescription>
            Sólo se registran nombre, apellido y usuario: no se piden datos personales ni email.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre">
            <Input
              value={first}
              onChange={(e) => {
                setFirst(e.target.value)
                setUsername(suggest(e.target.value, last))
              }}
            />
          </Field>
          <Field label="Apellido">
            <Input
              value={last}
              onChange={(e) => {
                setLast(e.target.value)
                setUsername(suggest(first, e.target.value))
              }}
            />
          </Field>
          <Field label="Usuario">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Contraseña inicial" hint="Mínimo 6 caracteres.">
            <Input value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={create.isPending} onClick={() => create.mutate([])}>
            Agregar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
