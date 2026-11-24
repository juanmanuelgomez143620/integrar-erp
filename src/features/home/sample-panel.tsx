// La muestra de la página pública (D18, docs/PAGINA_DE_INICIO.md): la empresa de demostración en sólo
// lectura, armada en el navegador con el simulador (sample.ts). Sin enlaces a la aplicación ni acciones.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Handshake, ListChecks } from 'lucide-react'
import { InfoRow, KpiCard, Loading, Mono, Section } from '@/components/common/blocks'
import { DocStatus } from '@/components/common/status-badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { DocumentDetail, DocumentListItem, TaskItem } from '@/lib/api'
import { DOC_TYPES } from '@/lib/domain/catalog'
import { date, money } from '@/lib/format'
import { AlertsSection } from '@/features/control/control-panel-page'
import { CircuitBoard, FlowLegend } from '@/features/flow/circuit-board'
import { buildNodeStats, documentNode, NODES, taskNode, type NodeId, type NodeStats } from '@/features/flow/flow-model'
import { buildSample, type Sample } from './sample'

export function SamplePanel() {
  const { data, error } = useQuery({
    queryKey: ['public-sample'],
    // Una vez por visita, después de mostrar que se está armando (tarda una fracción de segundo).
    queryFn: () =>
      new Promise<Sample>((resolve, reject) =>
        setTimeout(() => {
          try {
            resolve(buildSample())
          } catch (error) {
            reject(error as Error)
          }
        }, 0),
      ),
    staleTime: Infinity,
    retry: false,
  })
  if (!data) return <Loading label="Armando la muestra…" error={error} />
  return (
    <Tabs defaultValue="today">
      <TabsList>
        <TabsTrigger value="today">Hoy en la empresa</TabsTrigger>
        <TabsTrigger value="circuit">El circuito</TabsTrigger>
        <TabsTrigger value="order">Un pedido</TabsTrigger>
        <TabsTrigger value="purchase">Una compra</TabsTrigger>
      </TabsList>
      <TabsContent value="today" className="mt-3">
        <Today sample={data} />
      </TabsContent>
      <TabsContent value="circuit" className="mt-3">
        <Circuit sample={data} />
      </TabsContent>
      <TabsContent value="order" className="mt-3">
        <OrderExample detail={data.order} />
      </TabsContent>
      <TabsContent value="purchase" className="mt-3">
        <PurchaseExample purchase={data.purchase} journal={data.journal} />
      </TabsContent>
    </Tabs>
  )
}

/** Las tareas pendientes de cada sector, la más vieja primero; los sectores con más trabajo arriba. */
function tasksBySector(tasks: TaskItem[]): [NodeId, TaskItem[]][] {
  const sectors = new Map<NodeId, TaskItem[]>()
  for (const task of tasks) {
    const node = taskNode(task)
    if (node) sectors.set(node, [...(sectors.get(node) ?? []), task])
  }
  for (const list of sectors.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at))
  return [...sectors.entries()].sort((a, b) => b[1].length - a[1].length)
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Today({ sample }: { sample: Sample }) {
  const { orders, size, figures, tasks } = sample
  const sectors = useMemo(() => tasksBySector(tasks), [tasks])
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-navy">{sample.company}</span>, una fábrica de muebles de Misiones:{' '}
        {size.people} personas, {size.customers} clientes, {size.suppliers} proveedores y {size.products} productos.
        Semana {sample.week}.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Pedidos de clientes de la semana"
          value={orders.total}
          icon={Handshake}
          hint={`${plural(orders.confirmed, 'confirmado', 'confirmados')}, ${plural(orders.waiting, 'espera', 'esperan')} a Gerencia por el crédito y ${orders.toReview} por revisar.`}
        />
        <KpiCard
          label="Tareas pendientes"
          value={tasks.length}
          icon={ListChecks}
          hint={`En ${sectors.length} sectores: cada uno ve las suyas en "Mi trabajo".`}
        />
        {figures.map((f) => (
          <KpiCard key={f.key} label={f.label} value={money(f.value)} hint={f.hint} />
        ))}
      </div>
      <AlertsSection alerts={sample.alerts} linked={false} />
      <Section title="El trabajo de cada sector" description="Lo que espera en cada sector, con la tarea más vieja.">
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {sectors.map(([node, list]) => (
            <li key={node} className="min-w-0 rounded-lg border px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-navy">{NODES[node].label}</span>
                <span className="text-xs text-amber-700">{plural(list.length, 'tarea', 'tareas')}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">{list[0].title}</div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

function Circuit({ sample }: { sample: Sample }) {
  const nodes = useMemo(() => buildNodeStats(sample.docs, sample.tasks), [sample])
  const [focus, setFocus] = useState<NodeId>('VEN')
  const [selected, setSelected] = useState<DocumentListItem | null>(null)
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-muted-foreground">
        Cada tarjeta es un sector, con la cantidad de documentos en curso (en azul) y sus tareas pendientes. Tocá un
        sector o un documento para ver qué tiene: es lo mismo que muestra el Mapa vivo de la aplicación.
      </p>
      <Section bodyClassName="p-3">
        <CircuitBoard
          nodes={nodes}
          focus={focus}
          activeNode={null}
          selectedDocId={selected?.id ?? null}
          onFocus={(id) => {
            setFocus(id)
            setSelected(null)
          }}
          onSelectDoc={(doc) => {
            setSelected(doc)
            setFocus(documentNode(doc))
          }}
        />
        <FlowLegend />
      </Section>
      {selected && <DocumentCard doc={selected} />}
      <SectorCard id={focus} stats={nodes[focus]} />
    </div>
  )
}

function DocumentCard({ doc }: { doc: DocumentListItem }) {
  const counterpart = doc.customer_name || doc.supplier_name
  return (
    <Section
      title={
        <>
          {DOC_TYPES[doc.doc_type].name} <Mono>{doc.display_number}</Mono>
        </>
      }
      description={DOC_TYPES[doc.doc_type].description}
      actions={<DocStatus info={doc.status_info} />}
    >
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        {counterpart && <InfoRow label="Con">{counterpart}</InfoRow>}
        {doc.summary && <InfoRow label="Qué lleva">{doc.summary}</InfoRow>}
        {doc.total > 0 && <InfoRow label="Total">{money(doc.total)}</InfoRow>}
        <InfoRow label="Estado">{doc.status_info.description}</InfoRow>
      </dl>
    </Section>
  )
}

function SectorCard({ id, stats }: { id: NodeId; stats: NodeStats }) {
  return (
    <Section title={NODES[id].label} description={NODES[id].description}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
            {plural(stats.docs.length, 'documento en curso', 'documentos en curso')}
          </h3>
          <ul className="grid gap-1 text-sm">
            {stats.docs.slice(0, 8).map((d) => (
              <li key={d.id} className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <Mono>{d.display_number}</Mono> {d.customer_name || d.supplier_name || d.summary}
                </span>
                <DocStatus info={d.status_info} />
              </li>
            ))}
            {stats.docs.length > 8 && <li className="text-xs text-muted-foreground">y {stats.docs.length - 8} más</li>}
          </ul>
        </div>
        <div className="min-w-0">
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
            {plural(stats.tasks.length, 'tarea pendiente', 'tareas pendientes')}
          </h3>
          <ul className="grid gap-1 text-sm">
            {stats.tasks.slice(0, 6).map((t) => (
              <li key={t.id} className="truncate">
                {t.title}
              </li>
            ))}
            {stats.tasks.length > 6 && (
              <li className="text-xs text-muted-foreground">y {stats.tasks.length - 6} más</li>
            )}
          </ul>
        </div>
      </div>
    </Section>
  )
}

function OrderExample({ detail }: { detail: DocumentDetail | null }) {
  if (!detail) return <p className="text-sm text-muted-foreground">Esta semana no quedaron pedidos por revisar.</p>
  const { doc, lines, sales_order: so, customer, next_step, actions } = detail
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Section
        title={
          <>
            Pedido de venta <Mono>{doc.display_number}</Mono>
          </>
        }
        description="Lo mandó un cliente esta semana. Así lo ve Ventas antes de confirmarlo."
        actions={<DocStatus info={doc.status_info} />}
      >
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <InfoRow label="Cliente">{customer?.legal_name}</InfoRow>
          <InfoRow label="Referencia del cliente">{so?.customer_reference || '—'}</InfoRow>
          <InfoRow label="Entrega pedida">{so?.delivery_date ? date(so.delivery_date) : 'Sin fecha'}</InfoRow>
          <InfoRow label="Condición de pago">
            {so?.payment_terms_days ? `${so.payment_terms_days} días` : 'Contado'}
          </InfoRow>
        </dl>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[460px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 font-medium">Producto</th>
                <th className="py-1.5 text-right font-medium">Cantidad</th>
                <th className="py-1.5 text-right font-medium">Precio unit.</th>
                <th className="py-1.5 text-right font-medium">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="py-1.5">
                    <Mono>{l.product.code}</Mono> {l.product.name}
                  </td>
                  <td className="tabular py-1.5 text-right">
                    {l.quantity} {l.product.uom_code}
                  </td>
                  <td className="tabular py-1.5 text-right">{money(l.unit_price ?? 0)}</td>
                  <td className="tabular py-1.5 text-right">{money(l.line_subtotal ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="mt-3 ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Subtotal neto</dt>
          <dd className="tabular text-right">{money(doc.subtotal)}</dd>
          <dt className="text-muted-foreground">IVA</dt>
          <dd className="tabular text-right">{money(doc.tax_total)}</dd>
          <dt className="font-medium">Total</dt>
          <dd className="tabular text-right font-semibold">{money(doc.total)}</dd>
        </dl>
      </Section>
      <div className="grid content-start gap-4">
        <NextStep who={next_step.who} text={next_step.text} />
        {actions.length > 0 && (
          <Section title="Lo que puede hacer Ventas">
            <ul className="grid gap-2 text-sm">
              {actions.map((a) => (
                <li key={`${a.action}-${a.label}`}>
                  <span className="font-medium">{a.label}</span>
                  <span className="block text-xs text-muted-foreground">{a.enabled ? a.help : a.reason}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  )
}

function NextStep({ who, text }: { who: string; text: string }) {
  return (
    <Section title="¿Qué sigue?">
      <p className="text-xs font-semibold tracking-wide text-brand-blue uppercase">{who}</p>
      <p className="mt-1 text-sm">{text}</p>
    </Section>
  )
}

function PurchaseExample({ purchase, journal }: { purchase: DocumentDetail | null; journal: DocumentDetail | null }) {
  if (!purchase) return <p className="text-sm text-muted-foreground">La demo no tiene una compra completa.</p>
  const entry = journal?.journal
  return (
    <div className="grid grid-cols-1 gap-4">
      <Section
        title="Una compra de punta a punta"
        description="Producción pidió materiales, Compras los ordenó, Depósito los recibió y llegó la factura del proveedor. Cada documento nació del anterior."
      >
        <ol className="flex flex-wrap items-center gap-1.5 text-sm">
          {purchase.flow.map((f, i) => (
            <li key={f.id} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="size-3.5 text-slate-400" aria-hidden />}
              <span className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1">
                <span>
                  <Mono>{f.display_number}</Mono>
                  <span className="block text-[11px] text-muted-foreground">{DOC_TYPES[f.doc_type].name}</span>
                </span>
                <DocStatus info={f.status_info} />
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {entry && journal ? (
          <Section
            title={
              <>
                El asiento de la factura <Mono>{journal.doc.display_number}</Mono>
              </>
            }
            description="Nadie lo cargó a mano: lo generó la factura con las reglas de imputación de la empresa."
          >
            <p className="mb-2 text-sm">{entry.description}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 font-medium">Cuenta</th>
                    <th className="py-1.5 text-right font-medium">Debe</th>
                    <th className="py-1.5 text-right font-medium">Haber</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((l) => (
                    <tr key={l.id} className="border-b">
                      <td className="py-1.5">
                        <Mono>{l.account.code}</Mono> {l.account.name}
                      </td>
                      <td className="tabular py-1.5 text-right">{l.debit ? money(l.debit) : ''}</td>
                      <td className="tabular py-1.5 text-right">{l.credit ? money(l.credit) : ''}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="py-1.5">Totales</td>
                    <td className="tabular py-1.5 text-right">{money(entry.total_debit)}</td>
                    <td className="tabular py-1.5 text-right">{money(entry.total_credit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>
        ) : (
          <div />
        )}
        <NextStep who={purchase.next_step.who} text={purchase.next_step.text} />
      </div>
    </div>
  )
}
