import { Suspense } from 'react'
import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Loading } from '@/components/common/blocks'
import { api } from '@/lib/api'
import { CompanyProvider } from '@/app/company'
import { IdleLogout } from '@/app/idle-logout'
import { useMe, useSession } from '@/app/session'

/** Rutas que no dependen de una empresa: hay que poder llegar a ellas sin quedar atrapado en el redireccionamiento. */
const ACCOUNT_ROUTES = ['/cambiar-contrasena', '/perfil']

export function RequireAuth() {
  const { userId, logout } = useSession()
  const { data: me, isLoading, error, refetch } = useMe()
  const location = useLocation()
  if (!userId) return <Navigate to="/login" replace />
  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="text-lg font-semibold text-navy">No pudimos validar tu sesión</h1>
        <p role="alert" className="mt-2 text-sm text-muted-foreground">
          {error.message}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="outline" onClick={() => refetch()}>
            Reintentar
          </Button>
          <Button onClick={logout}>Volver a ingresar</Button>
        </div>
      </div>
    )
  }
  if (isLoading || !me) return <Loading />
  if (me.user.must_change_password && !ACCOUNT_ROUTES.includes(location.pathname)) {
    return <Navigate to="/cambiar-contrasena" replace />
  }
  return (
    <>
      <IdleLogout minutes={me.school.session_timeout_minutes} />
      {/* Las pantallas se cargan bajo demanda (router.tsx): mientras llega su código, "Cargando…". */}
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
    </>
  )
}

/** Redirige a la empresa del usuario, al panel de administración escolar, o al selector si participa en varias. */
export function HomeRedirect() {
  const { data, isLoading } = useMe()
  if (isLoading || !data) return <Loading />
  if (data.user.app_role === 'ADMIN' || data.user.app_role === 'SUPERADMIN') return <Navigate to="/admin" replace />
  if (data.memberships.length === 1) return <Navigate to={`/e/${data.memberships[0].company.slug}`} replace />
  return <Navigate to="/empresas" replace />
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
