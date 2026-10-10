import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BrandMark } from '@/components/common/brand'
import { Field, Loading } from '@/components/common/blocks'
import { commands } from '@/lib/api'
import { useCommand } from '@/hooks/use-command'
import { useMe, useSession } from '@/app/session'

/**
 * Sirve para dos casos: cambio obligatorio en el primer ingreso (después de
 * una contraseña inicial dada por el docente o de un restablecimiento) y
 * cambio voluntario desde el perfil. El motor exige siempre la contraseña
 * actual, aunque se acabe de usar para ingresar: no hay atajo por sesión.
 */
export function ChangePasswordPage() {
  const { data: me, isLoading } = useMe()
  const { logout } = useSession()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  // El formulario sólo se muestra una vez que `me` cargó (ver el `return` de
  // abajo), así que acá `forced` ya es un booleano real cuando se usa.
  const forced = !!me?.user.must_change_password
  const change = useCommand(() => commands.changePassword({ current_password: current, new_password: next }), {
    success: 'Contraseña actualizada.',
    onSuccess: () => navigate(forced ? '/' : '/perfil', { replace: forced }),
  })

  if (isLoading || !me) return <Loading />
  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit = current.length > 0 && next.length >= 6 && next === confirm

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (canSubmit) change.mutate([])
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-4 py-10">
      <BrandMark />
      <div className="mt-8">
        {forced ? (
          <>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-navy">
              <ShieldAlert className="size-5 text-amber-600" /> Elegí tu contraseña
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Ingresaste con una contraseña inicial. Por seguridad, antes de seguir tenés que cambiarla por una que sólo
              vos conozcas.
            </p>
          </>
        ) : (
          <>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-navy">
              <KeyRound className="size-5" /> Cambiar contraseña
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Ingresá tu contraseña actual y la nueva.</p>
          </>
        )}
        <form onSubmit={onSubmit} className="mt-6 grid gap-4">
          <Field label="Contraseña actual">
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </Field>
          <Field label="Contraseña nueva" hint="Mínimo 6 caracteres.">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Repetir contraseña nueva" error={mismatch ? 'No coincide con la anterior.' : undefined}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <div className="mt-2 flex items-center gap-2">
            <Button type="submit" disabled={!canSubmit || change.isPending}>
              Guardar
            </Button>
            {forced ? (
              <Button type="button" variant="ghost" onClick={logout}>
                Salir
              </Button>
            ) : (
              <Button type="button" variant="ghost" onClick={() => navigate('/perfil')}>
                Cancelar
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
