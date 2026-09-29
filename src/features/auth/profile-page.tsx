import { Link } from 'react-router'
import { ArrowLeft, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/common/brand'
import { Loading } from '@/components/common/blocks'
import { initials } from '@/lib/format'
import { useMe } from '@/app/session'

export function ProfilePage() {
  const { data: me, isLoading } = useMe()
  if (isLoading || !me) return <Loading />

  const roleLine =
    me.memberships.flatMap((m) => m.roles.map((r) => `${r.role_name} · ${m.company.legal_name}`)).join(' / ') ||
    (me.user.app_role === 'ADMIN'
      ? 'Administración escolar'
      : me.user.app_role === 'DOCENTE'
        ? 'Docente (supervisor)'
        : me.user.app_role)

  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-4 py-10">
      <BrandMark />
      <Button variant="ghost" size="sm" className="mt-6 w-fit" asChild>
        <Link to="/">
          <ArrowLeft /> Volver
        </Link>
      </Button>
      <div className="mt-4 rounded-xl border bg-card p-6">
        <div className="flex items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-navy text-base font-semibold text-white">
            {initials(me.user.first_name, me.user.last_name)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-navy">
              {me.user.first_name} {me.user.last_name}
            </div>
            <div className="truncate text-sm text-muted-foreground">{roleLine}</div>
          </div>
        </div>
        <dl className="mt-5 grid gap-2 text-sm">
          <div className="flex justify-between border-t pt-2">
            <dt className="text-muted-foreground">Usuario</dt>
            <dd className="font-mono">{me.user.username}</dd>
          </div>
          <div className="flex justify-between border-t pt-2">
            <dt className="text-muted-foreground">Escuela</dt>
            <dd>{me.school.short_name}</dd>
          </div>
        </dl>
        <Button className="mt-5 w-full" variant="outline" asChild>
          <Link to="/cambiar-contrasena">
            <KeyRound /> Cambiar contraseña
          </Link>
        </Button>
      </div>
    </div>
  )
}
