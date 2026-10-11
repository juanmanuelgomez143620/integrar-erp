import { useMemo, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Clock, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BrandMark } from '@/components/common/brand'
import { Field } from '@/components/common/blocks'
import { auth } from '@/lib/api'
import { showError } from '@/hooks/use-command'
import { useIdleLogoutNotice } from '@/app/idle-logout'
import { useSession } from '@/app/session'
import { ROLES } from '@/lib/domain/catalog'

const ISLANDS: Record<number, string> = {
  1: 'Gerencia y Control',
  2: 'Compras',
  3: 'Ventas',
  4: 'Contabilidad e Impuestos',
  5: 'Tesorería',
  6: 'RRHH',
  7: 'Producción y Costos',
  8: 'Depósito y Logística',
}

export function LoginPage() {
  const { userId, login, loginAs } = useSession()
  const navigate = useNavigate()
  const idleMinutes = useIdleLogoutNotice()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const demo = useMemo(() => auth.demoUsers(), [])
  // El nombre de la escuela sale de school_settings, nunca del código (CA-15).
  const { data: school } = useQuery({ queryKey: ['school-info'], queryFn: auth.schoolInfo })

  if (userId) return <Navigate to="/" replace />

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      navigate('/', { replace: true })
    } catch (e) {
      showError(e)
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    run(() => login(username, password))
  }

  const schoolLogo = school?.logo_path
    ? school.logo_path.startsWith('data:')
      ? school.logo_path
      : `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${school.logo_path}`
    : null

  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(380px,44%)_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-navy p-10 text-white lg:flex">
        <BrandMark tone="dark" />
        <div className="relative z-10 max-w-md">
          {schoolLogo && (
            <div className="mb-6 flex justify-center">
              <img
                src={schoolLogo}
                alt={`${school?.official_name} - Logo`}
                className="max-w-xs max-h-20 object-contain"
              />
            </div>
          )}
          <h1 className="text-3xl leading-tight font-bold tracking-tight">
            Una empresa, muchas áreas, <span className="text-sky-300">una sola base de datos.</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Cada operación nace en un sector y continúa en otro: Producción solicita, Compras ordena, Gerencia autoriza,
            Depósito recibe y el stock se actualiza. Todo queda documentado y auditado.
          </p>
          <div className="mt-8 grid grid-cols-5 gap-2 text-center text-[11px] text-slate-300">
            {['Solicitud', 'Orden', 'Aprobación', 'Recepción', 'Stock'].map((s, i) => (
              <div key={s} className="rounded-lg bg-white/5 px-1 py-2">
                <div className="text-base font-semibold text-sky-300">{i + 1}</div>
                {s}
              </div>
            ))}
          </div>
        </div>
        <p className="relative z-10 text-xs text-slate-400">
          {school ? `${school.official_name} · ` : ''}Aula empresarial
          <br />
          Documentos de simulación educativa — sin validez fiscal.
        </p>
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full bg-brand-blue/25 blur-3xl" />
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full min-w-0 max-w-xl">
          <div className="mb-8 lg:hidden">
            <BrandMark />
          </div>
          {schoolLogo && (
            <div className="mb-6 lg:hidden flex justify-center">
              <img
                src={schoolLogo}
                alt={`${school?.official_name} - Logo`}
                className="max-w-xs max-h-16 object-contain"
              />
            </div>
          )}
          <h2 className="text-xl font-semibold text-navy">Ingresar</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ingresá con el usuario y la contraseña que te dio tu docente.
          </p>
          {idleMinutes !== null && (
            <p
              role="status"
              className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
            >
              <Clock className="mt-0.5 size-4 shrink-0" />
              Cerramos tu sesión después de {idleMinutes} minutos sin actividad, para que nadie pueda usar tu usuario en
              una computadora compartida. Volvé a ingresar para seguir.
            </p>
          )}
          <form onSubmit={onSubmit} className="mt-6 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Usuario">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                placeholder="p. ej. compras1"
              />
            </Field>
            <Field label="Contraseña">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Button type="submit" size="lg" disabled={busy || !username || !password}>
              Ingresar <ArrowRight />
            </Button>
          </form>

          {demo.length > 0 && (
            <div className="mt-10">
              <div className="flex items-center gap-2 text-sm font-semibold text-navy">Accesos de demostración</div>
              <p className="mt-1 flex gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Tocá un usuario para entrar con su rol. Para ver la integración en vivo, abrí otra pestaña y entrá con
                otro sector: los cambios aparecen al instante. Los datos se guardan sólo en este navegador.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {demo.map((u) => (
                  <button
                    key={u.username}
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => loginAs(u.username))}
                    className="group flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-brand-blue/50 hover:bg-brand-blue-soft/50 disabled:opacity-60"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-blue-soft text-xs font-bold text-brand-blue">
                      {u.island ?? (u.app_role === 'DOCENTE' ? 'D' : 'A')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{u.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {u.role_label in ROLES ? ROLES[u.role_label as keyof typeof ROLES].name : u.role_label}
                        {u.island ? ` · Isla ${u.island} ${ISLANDS[u.island]}` : ''}
                      </span>
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground group-hover:text-brand-blue">
                      {u.username}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
