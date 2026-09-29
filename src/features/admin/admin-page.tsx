import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { GraduationCap, LogOut, Plus } from 'lucide-react'
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
import { EmptyState, Field, Loading } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { BrandMark } from '@/components/common/brand'
import { api, commands } from '@/lib/api'
import { useCommand } from '@/hooks/use-command'
import { useMe, useSession } from '@/app/session'

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
  const [newTeacher, setNewTeacher] = useState(false)
  const [newCourse, setNewCourse] = useState(false)
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
      <div className="flex items-center justify-between">
        <BrandMark />
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut /> Salir
        </Button>
      </div>
      <div className="mt-6">
        <PageHeader
          title="Administración de la escuela"
          description={`${me.school.official_name}. Alta de docentes y cursos del año lectivo, sin depender del proveedor.`}
        />
      </div>
      <Tabs defaultValue="teachers">
        <TabsList>
          <TabsTrigger value="teachers">Docentes</TabsTrigger>
          <TabsTrigger value="courses">Cursos</TabsTrigger>
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
            Asignar a un docente a una empresa y un curso se hace al crear la empresa simulada (todavía no
            implementado).
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
      </Tabs>

      <NewTeacherDialog open={newTeacher} onOpenChange={setNewTeacher} />
      <NewCourseDialog open={newCourse} onOpenChange={setNewCourse} />
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
