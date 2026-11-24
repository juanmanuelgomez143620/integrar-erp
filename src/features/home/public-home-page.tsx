// La página pública de INTEGR-AR (D18, docs/PAGINA_DE_INICIO.md): qué es, cómo funciona, qué se aprende y
// una muestra con datos ficticios. El acceso es restringido: sin registro ni prueba libre; para entrar, el
// usuario que da la escuela o el docente. No lee la base real (sólo el nombre y el logo públicos de la
// escuela, como el ingreso) y la muestra se arma en el navegador con el simulador.

import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  BookOpen,
  Calculator,
  ChevronDown,
  ClipboardCheck,
  Eye,
  Factory,
  Gauge,
  GraduationCap,
  Handshake,
  Landmark,
  Scale,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  Workflow,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/common/brand'
import { Loading } from '@/components/common/blocks'
import { auth } from '@/lib/api'
import { cn } from '@/lib/utils'
import { schoolLogoUrl } from '@/features/auth/school-logo'

const SamplePanel = lazy(() => import('./sample-panel').then((m) => ({ default: m.SamplePanel })))

type Icon = ComponentType<{ className?: string }>

const ISLANDS: { name: string; icon: Icon; text: string }[] = [
  {
    name: 'Gerencia y Control de Gestión',
    icon: Gauge,
    text: 'Autoriza lo que supera los límites (compras grandes, créditos, sueldos), pide préstamos y sigue el tablero de control.',
  },
  {
    name: 'Compras',
    icon: ShoppingCart,
    text: 'Atiende las solicitudes, pide cotizaciones, compara y emite las órdenes de compra.',
  },
  {
    name: 'Ventas y Clientes',
    icon: Handshake,
    text: 'Revisa los pedidos de los clientes, controla su crédito, presupuesta y factura.',
  },
  {
    name: 'Contabilidad e Impuestos',
    icon: Calculator,
    text: 'Controla los asientos, cierra los meses y presenta el IVA y los ingresos brutos ante el fisco simulado.',
  },
  {
    name: 'Tesorería y Finanzas',
    icon: Landmark,
    text: 'Cobra, paga, opera el Banco Aula, concilia y proyecta el flujo de fondos.',
  },
  {
    name: 'RRHH y Sueldos',
    icon: Users,
    text: 'Lleva los legajos, carga las novedades del mes y liquida los sueldos según los convenios.',
  },
  {
    name: 'Producción y Costos',
    icon: Factory,
    text: 'Fabrica con listas de materiales y horas de taller, y compara el costo previsto con el real.',
  },
  {
    name: 'Depósito y Logística',
    icon: Truck,
    text: 'Recibe la mercadería, cuida el stock, despacha los pedidos y arma las hojas de ruta.',
  },
]

const PILLARS: { title: string; icon: Icon; text: string }[] = [
  {
    title: 'Cada uno en su puesto',
    icon: ClipboardCheck,
    text: 'Cada estudiante entra con su usuario y encuentra en "Mi trabajo" lo que le toca. Cuando lo resuelve, la tarea pasa sola al sector siguiente.',
  },
  {
    title: 'Los controles de una empresa',
    icon: ShieldCheck,
    text: 'Montos que necesitan autorización, separación de funciones (quien carga no aprueba) y el historial de cada paso: quién lo hizo, cuándo y qué cambió.',
  },
  {
    title: 'Un entorno que responde',
    icon: Workflow,
    text: 'Cada semana llegan pedidos de clientes, y el Banco Aula y el fisco simulado procesan lo que se les manda: los operan Tesorería e Impuestos o el sistema.',
  },
]

interface Step {
  doc: string
  who: string
  text: string
}

const SALES_FLOW: Step[] = [
  { doc: 'Pedido del cliente', who: 'Ventas', text: 'Controla el stock y el crédito, y reserva la mercadería.' },
  { doc: 'Remito', who: 'Depósito', text: 'Despacha: baja el stock y se registra el costo de lo vendido.' },
  { doc: 'Hoja de ruta', who: 'Logística', text: 'Reparte por zona y rinde lo que se entregó.' },
  { doc: 'Factura', who: 'Ventas', text: 'La autoriza el fisco simulado y nace la deuda del cliente.' },
  { doc: 'Cobro', who: 'Tesorería', text: 'Cancela la factura y el dinero entra a la caja o al banco.' },
  { doc: 'Asientos', who: 'Contabilidad', text: 'Cada paso ya dejó su asiento: se revisa y se cierra el mes.' },
]

const PURCHASE_FLOW: Step[] = [
  { doc: 'Solicitud de compra', who: 'Producción', text: 'Pide los materiales que faltan para fabricar.' },
  { doc: 'Cotizaciones', who: 'Compras', text: 'Pide precios a varios proveedores y los compara.' },
  { doc: 'Orden de compra', who: 'Compras', text: 'Se la manda al proveedor elegido.' },
  { doc: 'Aprobación', who: 'Gerencia', text: 'Según el monto; quien cargó la orden no puede aprobarla.' },
  { doc: 'Recepción', who: 'Depósito', text: 'Controla lo que llegó y lo suma al stock.' },
  {
    doc: 'Factura y pago',
    who: 'Contabilidad y Tesorería',
    text: 'Se registra la deuda y se paga con una orden de pago.',
  },
]

const LEARNING: { title: string; icon: Icon; text: string }[] = [
  {
    title: 'Cómo funciona una organización',
    icon: Users,
    text: 'Qué hace cada área, qué documentos usa, quién inicia cada proceso, quién lo autoriza y a qué sector sigue.',
  },
  {
    title: 'Control interno',
    icon: ShieldCheck,
    text: 'Niveles de autorización, separación de funciones y trazabilidad: por qué una empresa no deja que una sola persona haga todo.',
  },
  {
    title: 'Contabilidad desde la operación',
    icon: BookOpen,
    text: 'Cada compra, venta, cobro o pago genera su asiento; de ahí salen el libro diario, el mayor y el balance de sumas y saldos.',
  },
  {
    title: 'Impuestos',
    icon: Scale,
    text: 'IVA, ingresos brutos, percepciones y retenciones, declaraciones, vencimientos, intereses y multas.',
  },
  {
    title: 'Costos y sueldos',
    icon: Factory,
    text: 'El costo de fabricar con materiales y horas de taller, y la liquidación de sueldos con convenios y cargas sociales.',
  },
  {
    title: 'Decidir en equipo',
    icon: Gauge,
    text: 'Leer el tablero de control, anticipar la falta de fondos o de stock y coordinar con los otros sectores: nadie completa un circuito solo.',
  },
]

const TEACHER = [
  'Crea la empresa del curso desde la plantilla: plan de cuentas, clientes, proveedores, productos y personal listos para empezar.',
  'Da de alta a los estudiantes (también todos juntos), asigna los puestos y los rota entre clases para que cada uno recorra todo el circuito.',
  'Hace llegar la actividad de cada semana: los pedidos de los clientes, siempre los mismos para la misma semana.',
  'Configura el control interno: la separación de funciones, el stock negativo y si el banco y el fisco los operan los estudiantes o el sistema.',
  'Sigue la actividad de cada isla y la auditoría: quién hizo qué, cuándo y con qué resultado.',
]

const FAQ: { q: string; a: string }[] = [
  {
    q: '¿Quién puede entrar?',
    a: 'Sólo quien tiene un usuario: lo crea la escuela o el docente del curso. No hay registro libre ni prueba abierta; para conocerlo sin usuario está la muestra de esta página.',
  },
  {
    q: '¿Es un sistema real?',
    a: 'Es una simulación educativa con las reglas de una empresa real. Los documentos no tienen validez fiscal, y la empresa, sus clientes, sus proveedores, su personal, el banco y el fisco son ficticios.',
  },
  {
    q: '¿Qué datos guarda de los estudiantes?',
    a: 'Lo mínimo para entrar y para saber quién hizo cada operación: nombre, apellido y un usuario. No pide un correo personal.',
  },
  {
    q: '¿Hay que instalar algo?',
    a: 'No: funciona en el navegador, en la computadora y en el celular.',
  },
  {
    q: '¿Qué pasa si alguien se equivoca?',
    a: 'Lo mismo que en una empresa: un documento confirmado no se borra, se anula con su motivo y queda en el historial. Equivocarse y corregir también es parte de aprender.',
  },
]

const NAV = [
  ['como-funciona', 'Cómo funciona'],
  ['circuitos', 'Circuitos'],
  ['aprendizajes', 'Qué se aprende'],
  ['muestra', 'Muestra'],
  ['preguntas', 'Preguntas'],
] as const

/** Lleva a una sección de la página (sin animación si quien mira pidió menos movimiento). */
function scrollToSection(id: string) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

export function PublicHomePage() {
  // El nombre y el logo de la escuela salen de su configuración, nunca del código (CA-15).
  const { data: school } = useQuery({ queryKey: ['school-info'], queryFn: auth.schoolInfo })
  const logo = schoolLogoUrl(school?.logo_path)
  const [sampleOpen, setSampleOpen] = useState(false)
  const openSample = () => {
    setSampleOpen(true)
    scrollToSection('muestra')
  }

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <BrandMark />
          <nav aria-label="Secciones" className="hidden items-center gap-5 text-sm text-muted-foreground lg:flex">
            {NAV.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="hover:text-navy">
                {label}
              </a>
            ))}
          </nav>
          <Button asChild size="sm">
            <Link to="/login">
              Ingresar <ArrowRight />
            </Link>
          </Button>
        </div>
      </header>

      <main>
        {/* Portada */}
        <section className="relative overflow-hidden bg-navy text-white">
          <div className="relative z-10 mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_380px] lg:py-20">
            <div className="min-w-0">
              <div className="flex items-center gap-3 text-sm text-sky-200">
                {logo && (
                  <img
                    src={logo}
                    alt={`${school?.official_name ?? 'Escuela'} - Logo`}
                    className="max-h-10 max-w-28 rounded bg-white/90 object-contain p-1"
                  />
                )}
                <span>{school?.official_name ? `${school.official_name} · Aula Empresarial` : 'Aula Empresarial'}</span>
              </div>
              <h1 className="mt-5 text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
                Aprender gestión trabajando en <span className="text-sky-300">una empresa que funciona.</span>
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-300">
                INTEGR-AR es el sistema de gestión del Aula Empresarial. Cada estudiante ocupa un puesto en un sector, y
                los pedidos, las compras, la producción, los cobros, los pagos y los impuestos pasan de uno a otro como
                en una empresa real: con sus documentos, sus controles y su contabilidad.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg" className="bg-white text-navy hover:bg-sky-50">
                  <Link to="/login">
                    Ingresar <ArrowRight />
                  </Link>
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white"
                  onClick={openSample}
                >
                  Ver la muestra <ChevronDown />
                </Button>
              </div>
              <p className="mt-4 text-xs text-slate-400">
                Se entra con el usuario que da la escuela o el docente. Simulación educativa: sin validez fiscal.
              </p>
            </div>
            <JourneyCard />
          </div>
          <div className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full bg-brand-blue/25 blur-3xl" />
        </section>

        {/* Cómo funciona */}
        <PageSection
          id="como-funciona"
          title="El aula es una empresa"
          lead="La demostración es Forestal del Norte, una fábrica de muebles ficticia de Misiones. El curso se organiza en ocho islas, como los sectores de una empresa, y todos trabajan sobre la misma información."
        >
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ISLANDS.map((island, i) => (
              <li key={island.name} className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-blue-soft text-xs font-bold text-brand-blue">
                    {i + 1}
                  </span>
                  <island.icon className="size-4 text-brand-blue" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-navy">{island.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{island.text}</p>
              </li>
            ))}
          </ul>
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            {PILLARS.map((p) => (
              <div key={p.title} className="flex gap-3">
                <p.icon className="mt-0.5 size-5 shrink-0 text-brand-blue" />
                <div>
                  <h3 className="text-sm font-semibold text-navy">{p.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{p.text}</p>
                </div>
              </div>
            ))}
          </div>
        </PageSection>

        {/* Circuitos */}
        <PageSection
          id="circuitos"
          muted
          title="Un circuito completo, de punta a punta"
          lead="Cada paso genera su documento, la tarea para el sector siguiente y, cuando corresponde, su asiento contable. Nada se carga dos veces."
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <FlowCard title="De la venta al cobro" steps={SALES_FLOW} />
            <FlowCard title="De la necesidad a la compra" steps={PURCHASE_FLOW} />
          </div>
        </PageSection>

        {/* Qué se aprende */}
        <PageSection
          id="aprendizajes"
          title="Qué se aprende"
          lead="No se aprende a usar un programa: se aprende cómo funciona una empresa, haciendo el trabajo de cada sector."
        >
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {LEARNING.map((l) => (
              <li key={l.title} className="rounded-xl border bg-card p-4">
                <l.icon className="size-5 text-brand-blue" />
                <h3 className="mt-2 text-sm font-semibold text-navy">{l.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{l.text}</p>
              </li>
            ))}
          </ul>
        </PageSection>

        {/* Para el docente */}
        <PageSection
          id="docente"
          muted
          title="Para el docente"
          lead="El docente arma el escenario y acompaña: no carga las operaciones por los estudiantes."
        >
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {TEACHER.map((t) => (
              <li key={t} className="flex gap-3 rounded-xl border bg-card p-4 text-sm">
                <GraduationCap className="mt-0.5 size-4 shrink-0 text-brand-blue" />
                {t}
              </li>
            ))}
          </ul>
        </PageSection>

        {/* La muestra */}
        <PageSection
          id="muestra"
          title="Mirá una empresa en marcha"
          lead="Una muestra de sólo lectura de Forestal del Norte con datos ficticios, armada en tu navegador con una semana de pedidos de clientes. No se conecta con la base de la escuela ni muestra datos de estudiantes."
        >
          {sampleOpen ? (
            <Suspense fallback={<Loading label="Armando la muestra…" />}>
              <SamplePanel />
            </Suspense>
          ) : (
            <div className="rounded-xl border bg-card p-5">
              <ul className="grid grid-cols-1 gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                <li>
                  <span className="font-medium text-navy">Hoy en la empresa:</span> los pedidos de la semana, las tareas
                  de cada sector y las alertas del tablero.
                </li>
                <li>
                  <span className="font-medium text-navy">El circuito:</span> dónde está cada documento y qué sector
                  tiene trabajo pendiente.
                </li>
                <li>
                  <span className="font-medium text-navy">Un pedido:</span> lo que mandó un cliente, como lo ve Ventas,
                  con lo que sigue.
                </li>
                <li>
                  <span className="font-medium text-navy">Una compra:</span> de la solicitud a la factura, con el
                  asiento que generó.
                </li>
              </ul>
              <Button className="mt-4" onClick={() => setSampleOpen(true)}>
                <Eye /> Abrir la muestra
              </Button>
            </div>
          )}
        </PageSection>

        {/* Preguntas frecuentes */}
        <PageSection id="preguntas" muted title="Preguntas frecuentes">
          <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {FAQ.map((f) => (
              <div key={f.q} className="rounded-xl border bg-card p-4">
                <dt className="text-sm font-semibold text-navy">{f.q}</dt>
                <dd className="mt-1 text-sm text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </PageSection>
      </main>

      <footer className="bg-navy text-slate-300">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-end md:justify-between">
          <div>
            <BrandMark tone="dark" />
            <p className="mt-3 max-w-md text-xs leading-relaxed text-slate-400">
              {school?.official_name ? `${school.official_name} · ` : ''}Sistema de gestión educativo para el Aula
              Empresarial. Documentos de simulación educativa, sin validez fiscal: la empresa, las personas, el banco y
              el fisco son ficticios.
            </p>
          </div>
          <Button asChild className="bg-white text-navy hover:bg-sky-50 md:self-auto">
            <Link to="/login">
              Ingresar <ArrowRight />
            </Link>
          </Button>
        </div>
      </footer>
    </div>
  )
}

function PageSection({
  id,
  title,
  lead,
  muted = false,
  children,
}: {
  id: string
  title: string
  lead?: string
  muted?: boolean
  children: ReactNode
}) {
  return (
    <section id={id} className={cn('scroll-mt-16 border-b', muted && 'bg-muted/40')}>
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
        <h2 className="text-2xl font-bold tracking-tight text-navy">{title}</h2>
        {lead && <p className="mt-2 max-w-3xl text-base text-muted-foreground">{lead}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </section>
  )
}

/** Un circuito en pasos numerados: el documento, el sector que lo hace y qué pasa. */
function FlowCard({ title, steps }: { title: string; steps: Step[] }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <h3 className="text-base font-semibold text-navy">{title}</h3>
      <ol className="mt-4 grid gap-3">
        {steps.map((s, i) => (
          <li key={s.doc} className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-blue-soft text-xs font-bold text-brand-blue">
              {i + 1}
            </span>
            <div className="min-w-0 text-sm">
              <span className="font-semibold text-navy">{s.doc}</span>{' '}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{s.who}</span>
              <p className="mt-0.5 text-muted-foreground">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** En la portada: un pedido recorre seis sectores, cada uno con su documento. */
function JourneyCard() {
  return (
    <div className="self-center rounded-2xl bg-white p-5 text-foreground shadow-xl shadow-black/20">
      <p className="text-xs font-semibold tracking-wider text-brand-blue uppercase">Un pedido, seis sectores</p>
      <ol className="mt-4 grid gap-0">
        {SALES_FLOW.map((s, i) => (
          <li key={s.doc} className="relative flex gap-3 pb-3 last:pb-0">
            {i < SALES_FLOW.length - 1 && (
              <span className="absolute top-7 bottom-0 left-[13px] w-px bg-slate-200" aria-hidden />
            )}
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-navy text-[11px] font-bold text-white">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 items-center justify-between gap-2 pt-0.5 text-sm">
              <span className="font-medium text-navy">{s.doc}</span>
              <span className="shrink-0 rounded bg-brand-blue-soft px-1.5 py-0.5 text-[11px] font-medium text-brand-blue">
                {s.who}
              </span>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        Lo que hace un sector le aparece al siguiente, y cada paso deja su registro.
      </p>
    </div>
  )
}
