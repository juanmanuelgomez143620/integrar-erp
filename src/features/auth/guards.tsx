import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/common/brand'
import { Loading } from '@/components/common/blocks'
import { api } from '@/lib/api'
import { CompanyProvider } from '@/app/company'
import { useMe, useSession } from '@/app/session'

/** Rutas que no dependen de una empresa: hay que poder llegar a ellas sin quedar atrapado en el redireccionamiento. */
const ACCOUNT_ROUTES = ['/cambiar-contrasena', '/perfil']

export function RequireAuth() {
  const { userId } = useSession()
  const { data: me, isLoading } = useMe()
  const location = useLocation()
  if (!userId) return <Navigate to="/login" replace />
  if (isLoading || !me) return <Loading />
  if (me.user.must_change_password && !ACCOUNT_ROUTES.includes(location.pathname)) {
    return <Navigate to="/cambiar-contrasena" replace />
  }
  return <Outlet />
}

/** Redirige a la empresa del usuario, al panel de administración escolar, o al selector si participa en varias. */
export function HomeRedirect() {
  const { data, isLoading } = useMe()
  if (isLoading || !data) return <Loading />
  if (data.user.app_role === 'ADMIN' || data.user.app_role === 'SUPERADMIN') return <Navigate to="/admin" replace />
  if (data.memberships.length === 1) return <Navigate to={`/e/${data.memberships[0].company.slug}`} replace />
  return <Navigate to="/empresas" replace />
}

export function CompanySelectPage() {
  const { data, isLoading } = useMe()
  const { logout } = useSession()
  if (isLoading || !data) return <Loading />
  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col px-4 py-10">
      <BrandMark />
      <h1 className="mt-10 text-xl font-semibold text-navy">Hola, {data.user.first_name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Elegí la empresa simulada en la que vas a trabajar.</p>
      <div className="mt-6 grid gap-3">
        {data.memberships.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Todavía no participás en ninguna empresa. Pedile a tu docente que te asigne.
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
              <span className="block font-medium">{m.company.legal_name}</span>
              <span className="block text-xs text-muted-foreground">
                {m.roles.length
                  ? m.roles.map((r) => `${r.role_name} · ${r.sector_name}`).join(' / ')
                  : 'Acceso de administración'}
              </span>
            </span>
          </Link>
        ))}
      </div>
      <Button variant="ghost" className="mt-6 w-fit" onClick={logout}>
        <LogOut /> Salir
      </Button>
    </div>
  )
}

/** Carga el contexto de la empresa de la URL y verifica membresía. */
export function CompanyRoute() {
  const { slug = '' } = useParams()
  const { userId } = useSession()
  const { data, isLoading } = useQuery({
    queryKey: ['company-context', slug, userId],
    queryFn: () => api.companyContext(slug),
  })
  if (isLoading) return <Loading />
  if (!data) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="text-lg font-semibold text-navy">No tenés acceso a esta empresa</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          La empresa no existe o no participás en ella. Los datos de cada empresa están aislados.
        </p>
        <Button asChild className="mt-6">
          <Link to="/">Volver</Link>
        </Button>
      </div>
    )
  }
  return (
    <CompanyProvider context={data}>
      <Outlet />
    </CompanyProvider>
  )
}
