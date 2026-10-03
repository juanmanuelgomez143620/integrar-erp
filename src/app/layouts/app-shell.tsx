import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bell, CheckCheck, Inbox, LogOut, Menu, Search, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { BrandMark } from '@/components/common/brand'
import { Loading } from '@/components/common/blocks'
import { api, commands } from '@/lib/api'
import { DOC_TYPES, ROLES } from '@/lib/domain/catalog'
import { initials, relative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '../company'
import { useMe, useSession } from '../session'
import { NAV } from '../modules'

function useMyTaskCount(companyId: string) {
  const { data } = useQuery({
    queryKey: ['tasks', companyId, 'mine'],
    queryFn: () => api.tasks(companyId, 'mine'),
    refetchInterval: 45_000,
  })
  return data?.length ?? 0
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const company = useCompany()
  const taskCount = useMyTaskCount(company.companyId)
  const { data: me } = useMe()
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-4 pt-4 pb-3">
        <BrandMark tone="dark" />
      </div>
      <div className="mx-3 mb-3 rounded-lg bg-white/5 px-3 py-2.5">
        <div className="truncate text-sm font-semibold text-white">{company.company.legal_name}</div>
        <div className="truncate text-xs text-slate-400">
          Empresa simulada{company.course ? ` · ${company.course.name} ${company.course.academic_year}` : ''}
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV.map((group) => {
          const items = group.items.filter((i) =>
            i.supervisorOnly ? company.supervisor : !i.permission || company.can(i.permission),
          )
          if (!items.length) return null
          return (
            <div key={group.label} className="mb-3">
              <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">
                {group.label}
              </div>
              {items.map((item) => (
                <NavLink
                  key={item.path}
                  to={company.to(item.path)}
                  end={item.path === '' || item.path === 'stock'}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-sidebar-primary font-medium text-white'
                        : 'text-slate-300 hover:bg-sidebar-accent hover:text-white',
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.badge === 'tasks' && taskCount > 0 && (
                    <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-navy">
                      {taskCount}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          )
        })}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3 text-[11px] leading-relaxed text-slate-400">
        <div className="font-medium text-slate-300">{me?.school.short_name}</div>
        Modo demostración · datos simulados sin validez fiscal
      </div>
    </div>
  )
}

function GlobalSearch() {
  const company = useCompany()
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const term = value.trim().toUpperCase()
    if (!term) return
    const match = term.match(/^(SC|OC|REC|AJS)[-\s]?(\d+)$/)
    if (match) {
      const docType = Object.values(DOC_TYPES).find((d) => d.prefix === match[1])!
      navigate(company.docPath(docType.code, `${match[1]}-${match[2].padStart(5, '0')}`))
    } else {
      navigate(`${company.to('productos')}?q=${encodeURIComponent(value.trim())}`)
    }
    setValue('')
  }
  return (
    <form onSubmit={onSubmit} className="relative hidden w-full max-w-sm md:block">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ir a SC-1, OC-2, REC-1… o buscar producto"
        className="h-8 bg-background pl-8"
      />
    </form>
  )
}

function NotificationsBell() {
  const company = useCompany()
  const navigate = useNavigate()
  const { data = [], isFetched } = useQuery({
    queryKey: ['notifications', company.companyId],
    queryFn: () => api.notifications(company.companyId),
    refetchInterval: 30_000,
  })
  const unread = data.filter((n) => !n.read_at)
  const markRead = useCommand(commands.markNotificationsRead)
  const seen = useRef<Set<string> | null>(null)
  const [open, setOpen] = useState(false)
  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }

  // Aviso emergente sólo para notificaciones que llegan mientras se usa la app
  // (por ejemplo, desde otra pestaña); las ya existentes al ingresar no se repiten.
  useEffect(() => {
    if (!isFetched) return
    const pending = data.filter((n) => !n.read_at)
    if (seen.current) {
      for (const n of pending) if (!seen.current.has(n.id)) toast.info(n.title, { description: n.body })
    }
    seen.current = new Set(pending.map((n) => n.id))
  }, [data, isFetched])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread.length ? `Notificaciones: ${unread.length} sin leer` : 'Notificaciones'}
        >
          <Bell />
          {unread.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
              {unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold text-navy">Notificaciones</span>
          {unread.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => markRead.mutate([company.companyId, 'all'])}>
              <CheckCheck /> Marcar leídas
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {data.length === 0 && <p className="p-4 text-sm text-muted-foreground">Sin notificaciones.</p>}
          {data.slice(0, 15).map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                if (!n.read_at) markRead.mutate([company.companyId, [n.id]])
                go(n.link_path)
              }}
              className={cn(
                'flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60',
                !n.read_at && 'bg-brand-blue-soft/50',
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {!n.read_at && <span className="size-1.5 shrink-0 rounded-full bg-brand-blue" />}
                {n.title}
              </span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>
              <span className="text-[11px] text-muted-foreground">{relative(n.created_at)}</span>
            </button>
          ))}
        </div>
        <div className="border-t p-1">
          <Button variant="ghost" size="sm" className="w-full" onClick={() => go(company.to('notificaciones'))}>
            Ver todas las notificaciones
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function UserMenu() {
  const { data: me } = useMe()
  const { logout } = useSession()
  const company = useCompany()
  const navigate = useNavigate()
  if (!me) return null
  const roleLine = company.roles.length
    ? company.roles
        .map(
          (r) =>
            `${ROLES[r.role_code].name}${r.sector_name !== '—' && r.sector_name !== ROLES[r.role_code].name ? ` · ${r.sector_name}` : ''}`,
        )
        .join(' / ')
    : me.user.app_role === 'ADMIN'
      ? 'Administración escolar'
      : me.user.app_role
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5">
          <span className="flex size-7 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white">
            {initials(me.user.first_name, me.user.last_name)}
          </span>
          <span className="hidden text-left leading-tight lg:block">
            <span className="block text-sm font-medium">
              {me.user.first_name} {me.user.last_name}
            </span>
            <span className="block max-w-52 truncate text-[11px] text-muted-foreground">{roleLine}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">
            {me.user.first_name} {me.user.last_name}
          </div>
          <div className="text-xs text-muted-foreground">Usuario: {me.user.username}</div>
          <div className="mt-1 text-xs text-muted-foreground">{roleLine}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate('/perfil')}>
          <UserRound /> Mi perfil
        </DropdownMenuItem>
        {me.memberships.length > 1 && (
          <DropdownMenuItem onClick={() => navigate('/empresas')}>
            <UserRound /> Cambiar de empresa
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => {
            logout()
            navigate('/login')
          }}
        >
          <LogOut /> Salir / cambiar de usuario
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppShell() {
  const company = useCompany()
  const [mobileOpen, setMobileOpen] = useState(false)
  const taskCount = useMyTaskCount(company.companyId)
  return (
    <div className="flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-64 shrink-0 lg:block">
        <SidebarNav />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-none p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Menú</SheetTitle>
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-white/95 px-3 backdrop-blur sm:px-5">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menú"
          >
            <Menu />
          </Button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <Link to={company.to('mi-trabajo')} className="gap-1.5">
                <Inbox />
                <span className="hidden sm:inline">Mi trabajo</span>
                {taskCount > 0 && (
                  <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-navy">
                    {taskCount}
                  </span>
                )}
              </Link>
            </Button>
            <NotificationsBell />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-3 py-5 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-7xl">
            {/* El menú y la barra superior quedan visibles mientras llega el código de la pantalla. */}
            <Suspense fallback={<Loading />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  )
}
