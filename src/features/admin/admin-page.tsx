import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, GraduationCap, LogOut, Plus, RotateCcw, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { ActionDialog } from '@/components/common/dialogs'
import { PageHeader } from '@/components/common/page-header'
import { BrandMark } from '@/components/common/brand'
import { api, commands } from '@/lib/api'
import { useCommand } from '@/hooks/use-command'
import { useMe, useSession } from '@/app/session'
import { SchoolSettingsForm } from './school-settings-form'

/** Cada pestaña tiene su dirección, para poder enlazarla (por ejemplo, /admin/escuela). */
const TAB_PATHS = { teachers: '/admin', courses: '/admin/cursos', school: '/admin/escuela' } as const
type AdminTab = keyof typeof TAB_PATHS

/** Sugiere un nombre de usuario a partir del nombre y apellido (igual que en el alta de estudiantes). */
const suggestUsername = (first: string, last: string) =>
  `${first.trim()[0] ?? ''}${last.trim().split(' ')[0] ?? ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

export function AdminPage() {
  const { data: me, isLoading } = useMe()
  const { logout } = useSession()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const tab = (Object.keys(TAB_PATHS) as AdminTab[]).find((t) => TAB_PATHS[t] === pathname) ?? 'teachers'
  const [newTeacher, setNewTeacher] = useState(false)
  const [newCourse, setNewCourse] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const reset = useCommand(commands.resetDemoData, {
    success: 'Instancia local reiniciada. Ingresá con un usuario de demostración.',
    onSuccess: () => {
      logout()
      navigate('/login', { replace: true })
    },
  })
  const allowed = me?.user.app_role === 'ADMIN' || me?.user.app_role === 'SUPERADMIN'
  const teachers = useQuery({ queryKey: ['teachers'], queryFn: api.teachers, enabled: allowed })
  const courses = useQuery({ queryKey: ['courses'], queryFn: api.courses, enabled: allowed })

  if (isLoading || !me) return <Loading />
  if (!allowed) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-lg font-semibold text-navy">Sólo administración de la escuela</h1>
        <p className="mt-2 text-sm text-muted-foreground">Tu usuario no tiene ese permiso.</p>
        <Button asChild className="mt-6">
          <Link to="/">Volver</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BrandMark />
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/perfil">
              <UserRound /> Mi perfil
            </Link>
          </Button>
          {(me.user.app_role === 'SUPERADMIN' || me.memberships.length > 0) && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/empresas">
                <Building2 /> Empresas
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut /> Salir
          </Button>
        </div>
      </div>
      <div className="mt-6">
        <PageHeader
          title="Administración de la escuela"
          description={`${me.school.official_name}. Docentes, cursos del año lectivo y datos de la escuela, sin depender del proveedor.`}
        />
      </div>
      <Tabs value={tab} onValueChange={(v) => navigate(TAB_PATHS[v as AdminTab])}>
        <TabsList>
          <TabsTrigger value="teachers">Docentes</TabsTrigger>
          <TabsTrigger value="courses">Cursos</TabsTrigger>
          <TabsTrigger value="school">Datos de la escuela</TabsTrigger>
        </TabsList>

        <TabsContent value="teachers" className="mt-3">
          <DataTable
            rows={teachers.data ?? []}
            loading={teachers.isLoading}
            rowKey={(t) => t.id}
            search={(t) => `${t.first_name} ${t.last_name} ${t.username}`}
            empty={
              <EmptyState icon={GraduationCap} title="Todavía no hay docentes">
                Dá de alta al primero.
              </EmptyState>
            }
            toolbar={
              <Button size="sm" onClick={() => setNewTeacher(true)}>
                <Plus /> Agregar docente
              </Button>
            }
            columns={[
              {
                key: 'name',
                header: 'Docente',
                sort: (t) => t.last_name,
                cell: (t) => (
                  <div>
                    <div className="font-medium">
                      {t.last_name}, {t.first_name}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{t.username}</div>
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Estado',
                cell: (t) =>
                  t.is_active ? (
                    <span className="text-xs text-emerald-700">Activo</span>
                  ) : (
                    <span className="text-xs text-red-700">Desactivado</span>
                  ),
              },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Cada docente crea la empresa de su curso desde Mis empresas y queda asignado como supervisor. Primero cargá
            el curso en la pestaña Cursos.
          </p>
        </TabsContent>

        <TabsContent value="courses" className="mt-3">
          <DataTable
            rows={courses.data ?? []}
            loading={courses.isLoading}
            rowKey={(c) => c.id}
            search={(c) => `${c.name} ${c.orientation} ${c.academic_year}`}
            empty={
              <EmptyState icon={GraduationCap} title="Todavía no hay cursos">
                Dá de alta el primero.
              </EmptyState>
            }
            toolbar={
              <Button size="sm" onClick={() => setNewCourse(true)}>
                <Plus /> Agregar curso
              </Button>
            }
            columns={[
              { key: 'name', header: 'Curso', sort: (c) => c.name, cell: (c) => c.name },
              {
                key: 'year',
                header: 'Año lectivo',
                align: 'right',
                sort: (c) => c.academic_year,
                cell: (c) => <span className="tabular">{c.academic_year}</span>,
              },
              { key: 'orientation', header: 'Orientación', cell: (c) => c.orientation || '—' },
            ]}
          />
        </TabsContent>

        <TabsContent value="school" className="mt-3">
          <SchoolSettingsForm school={me.school} />
          <Section title="Reiniciar toda la demostración local" className="mt-6">
            <p className="text-sm text-muted-foreground">
              Reconstruye toda la instancia de este navegador: empresas, cursos, usuarios, contraseñas, datos de la
              escuela y operaciones vuelven a los datos de demostración. Antes se guarda una copia local recuperable por
              soporte. El reinicio cierra tu sesión; las demás pestañas también deben volver a ingresar.
            </p>
            <Button variant="destructive" className="mt-4" onClick={() => setResetOpen(true)}>
              <RotateCcw /> Reiniciar toda la demostración
            </Button>
          </Section>
        </TabsContent>
      </Tabs>

      <NewTeacherDialog open={newTeacher} onOpenChange={setNewTeacher} />
      <NewCourseDialog open={newCourse} onOpenChange={setNewCourse} />
      <ActionDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="¿Reiniciar toda la instancia local?"
        description="Afecta a todas las empresas y usuarios de este navegador. Los datos actuales quedan en una copia local para soporte y la aplicación vuelve a la demostración inicial. Vas a tener que ingresar otra vez."
        confirmLabel="Reiniciar toda la demostración"
        tone="destructive"
        busy={reset.isPending}
        onConfirm={() => reset.mutate([])}
      />
    </div>
  )
}

function NewTeacherDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const create = useCommand(() => commands.createTeacher({ first_name: first, last_name: last, username, password }), {
    success: 'Docente agregado.',
    onSuccess: () => {
      onOpenChange(false)
      setFirst('')
      setLast('')
      setUsername('')
      setPassword('')
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agregar docente</DialogTitle>
          <DialogDescription>
            Sólo se registran nombre, apellido y usuario. El docente va a tener que cambiar esta contraseña en su primer
            ingreso.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre">
            <Input
              value={first}
              onChange={(e) => {
                setFirst(e.target.value)
                setUsername(suggestUsername(e.target.value, last))
              }}
            />
          </Field>
          <Field label="Apellido">
            <Input
              value={last}
              onChange={(e) => {
                setLast(e.target.value)
                setUsername(suggestUsername(first, e.target.value))
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

function NewCourseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [name, setName] = useState('')
  const [orientation, setOrientation] = useState('Gestión y Administración de las Organizaciones')
  const create = useCommand(() => commands.createCourse({ academic_year: Number(year), name, orientation }), {
    success: 'Curso agregado.',
    onSuccess: () => {
      onOpenChange(false)
      setName('')
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agregar curso</DialogTitle>
          <DialogDescription>
            Un curso agrupa a los estudiantes de una división. Crear la empresa simulada para trabajar es un paso
            aparte.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Año lectivo">
            <Input inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          </Field>
          <Field label="Curso" hint='Por ejemplo, "5.º A".'>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Orientación" className="sm:col-span-2">
            <Input value={orientation} onChange={(e) => setOrientation(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={create.isPending || !name.trim()} onClick={() => create.mutate([])}>
            Agregar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
