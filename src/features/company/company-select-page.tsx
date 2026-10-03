import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, LogOut, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { BrandMark } from '@/components/common/brand'
import { Field, Loading } from '@/components/common/blocks'
import { SimpleSelect } from '@/components/common/pickers'
import { api, commands } from '@/lib/api'
import { useCommand } from '@/hooks/use-command'
import { useMe, useSession } from '@/app/session'

/** Empresas simuladas del usuario. El docente, además, crea la de cada curso a partir de la plantilla (H-20). */
export function CompanySelectPage() {
  const { data, isLoading } = useMe()
  const { logout } = useSession()
  const [creating, setCreating] = useState(false)
  if (isLoading || !data) return <Loading />
  const canCreate = data.user.app_role === 'DOCENTE' || data.user.app_role === 'SUPERADMIN'
  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col px-4 py-10">
      <BrandMark />
      <h1 className="mt-10 text-xl font-semibold text-navy">Hola, {data.user.first_name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Elegí la empresa simulada en la que vas a trabajar.</p>
      <div className="mt-6 grid gap-3">
        {data.memberships.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            {canCreate
              ? 'Todavía no tenés empresas. Creá la de tu curso a partir de la plantilla y después sumá a tus estudiantes.'
              : 'Todavía no participás en ninguna empresa. Pedile a tu docente que te asigne.'}
          </p>
        )}
        {data.memberships.map((m) => (
          <Link
            key={m.company.id}
            to={`/e/${m.company.slug}`}
            className="flex items-center gap-4 rounded-xl border bg-card p-4 hover:border-brand-blue/50"
          >
            <span className="flex size-10 items-center justify-center rounded-lg bg-brand-blue-soft text-brand-blue">
              <Building2 className="size-5" />
            </span>
            <span className="flex-1">
              <span className="block font-medium">
                {m.company.legal_name}
                {m.course && (
                  <span className="font-normal text-muted-foreground">
                    {' '}
                    · {m.course.name} {m.course.academic_year}
                  </span>
                )}
              </span>
              <span className="block text-xs text-muted-foreground">
                {m.roles.length
                  ? m.roles
                      .map((r) => (r.sector_name === '—' ? r.role_name : `${r.role_name} · ${r.sector_name}`))
                      .join(' / ')
                  : 'Acceso de administración'}
              </span>
            </span>
          </Link>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {canCreate && (
          <Button onClick={() => setCreating(true)}>
            <Plus /> Crear empresa para un curso
          </Button>
        )}
        <Button variant="ghost" onClick={logout}>
          <LogOut /> Salir
        </Button>
      </div>
      {canCreate && <NewCompanyDialog open={creating} onOpenChange={setCreating} />}
    </div>
  )
}

function NewCompanyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const courses = useQuery({ queryKey: ['courses'], queryFn: api.courses, enabled: open })
  const [courseId, setCourseId] = useState('')
  const create = useCommand(() => commands.createCompanyFromTemplate(courseId), {
    success: 'Empresa creada. Ahora sumá a tus estudiantes.',
    onSuccess: (company) => {
      onOpenChange(false)
      navigate(`/e/${company.slug}/docente`)
    },
  })
  const options = (courses.data ?? []).map((c) => ({ value: c.id, label: `${c.name} · ${c.academic_year}` }))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Crear empresa para un curso</DialogTitle>
          <DialogDescription>
            Se crea a partir de la plantilla, con sus sectores, depósitos, proveedores, clientes, productos e inventario
            inicial, y sin operaciones previas. Vos quedás como supervisor; después sumás a tus estudiantes desde el
            panel docente.
          </DialogDescription>
        </DialogHeader>
        <Field
          label="Curso"
          hint={
            courses.data && !courses.data.length
              ? 'La administración de la escuela todavía no cargó cursos.'
              : 'Los cursos los carga la administración de la escuela.'
          }
        >
          <SimpleSelect value={courseId} onChange={setCourseId} options={options} placeholder="Elegí el curso" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!courseId || create.isPending} onClick={() => create.mutate([])}>
            {create.isPending ? 'Creando…' : 'Crear empresa'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
