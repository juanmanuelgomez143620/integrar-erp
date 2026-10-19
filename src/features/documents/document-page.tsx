import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowRight,
  Banknote,
  FilePlus2,
  FileSearch,
  Info,
  Lightbulb,
  Pencil,
  Printer,
  ReceiptText,
  ShoppingCart,
  PackageCheck,
  ShieldAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InfoRow, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { DocStatus, StatusBadge } from '@/components/common/status-badge'
import { DocumentFlow } from '@/components/common/document-flow'
import { AuditTimeline } from '@/components/common/audit-timeline'
import { ActionDialog } from '@/components/common/dialogs'
import { api, commands, type AvailableAction, type DocumentDetail } from '@/lib/api'
import {
  ADJUSTMENT_REASONS,
  DOC_TYPES,
  JOURNAL_ORIGINS,
  PAYMENT_METHODS,
  PRIORITIES,
  VAT_CONDITIONS,
} from '@/lib/domain/catalog'
import type { DocType, TransitionAction } from '@/lib/domain/types'
import { date, dateTime, money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { AwardDialog, ComparisonSection } from '@/features/purchasing/quotations/quotation-views'
import { PayDialog } from '@/features/payables/pay-dialog'
import { ReconciliationLines } from '@/features/payables/reconciliation-views'

type Runner = (docId: string, text: string) => Promise<unknown>

const RUNNERS: Record<DocType, Partial<Record<TransitionAction, Runner>>> = {
  PURCHASE_REQUISITION: {
    SUBMIT: (id) => commands.submitRequisition(id),
    REJECT: (id, t) => commands.rejectRequisition(id, t),
    CANCEL: (id, t) => commands.cancelRequisition(id, t),
    CLOSE: (id, t) => commands.closeRequisition(id, t),
  },
  PURCHASE_ORDER: {
    SUBMIT: (id) => commands.submitPurchaseOrder(id),
    APPROVE: (id, t) => commands.approvePurchaseOrder(id, t),
    REJECT: (id, t) => commands.rejectPurchaseOrder(id, t),
    WITHDRAW: (id) => commands.withdrawPurchaseOrder(id),
    REOPEN: (id) => commands.reopenPurchaseOrder(id),
    SEND: (id) => commands.sendPurchaseOrder(id),
    CANCEL: (id, t) => commands.cancelPurchaseOrder(id, t),
    CLOSE: (id, t) => commands.closePurchaseOrder(id, t),
  },
  GOODS_RECEIPT: {
    CONFIRM: (id) => commands.confirmGoodsReceipt(id),
    CANCEL: (id, t) => commands.cancelGoodsReceipt(id, t),
  },
  STOCK_ADJUSTMENT: {
    CONFIRM: (id) => commands.confirmStockAdjustment(id),
    CANCEL: (id, t) => commands.cancelStockAdjustment(id, t),
  },
  JOURNAL_ENTRY: {
    CONFIRM: (id) => commands.confirmJournalEntry(id),
    CANCEL: (id, t) => commands.cancelJournalEntry(id, t),
  },
  SUPPLIER_INVOICE: {
    CONFIRM: (id) => commands.confirmSupplierInvoice(id),
    CANCEL: (id, t) => commands.cancelSupplierInvoice(id, t),
  },
  PAYMENT_ORDER: {
    SUBMIT: (id) => commands.submitPaymentOrder(id),
    APPROVE: (id, t) => commands.approvePaymentOrder(id, t),
    REJECT: (id, t) => commands.rejectPaymentOrder(id, t),
    // Pagar tiene su propio diálogo (PayDialog): hay que elegir el medio de pago.
    CANCEL: (id, t) => commands.cancelPaymentOrder(id, t),
  },
  // Adjudicar tiene su propio diálogo (AwardDialog): hay que elegir la cotización.
  RFQ: {
    SUBMIT: (id) => commands.sendRfq(id),
    CANCEL: (id, t) => commands.cancelRfq(id, t),
  },
  SUPPLIER_QUOTE: {
    CANCEL: (id, t) => commands.cancelSupplierQuote(id, t),
  },
  FUNDS_TRANSFER: {
    CONFIRM: (id) => commands.confirmFundsTransfer(id),
    CANCEL: (id, t) => commands.cancelFundsTransfer(id, t),
  },
  BANK_RECONCILIATION: {
    CANCEL: (id, t) => commands.cancelBankReconciliation(id, t),
  },
}

const AREA: Record<DocType, string> = {
  PURCHASE_REQUISITION: 'Compras',
  PURCHASE_ORDER: 'Compras',
  GOODS_RECEIPT: 'Depósito',
  STOCK_ADJUSTMENT: 'Depósito',
  JOURNAL_ENTRY: 'Contabilidad',
  SUPPLIER_INVOICE: 'Compras',
  PAYMENT_ORDER: 'Pagos y tesorería',
  RFQ: 'Compras',
  SUPPLIER_QUOTE: 'Compras',
  FUNDS_TRANSFER: 'Pagos y tesorería',
  BANK_RECONCILIATION: 'Pagos y tesorería',
}

export function DocumentPage({ docType }: { docType: DocType }) {
  const { number = '' } = useParams()
  const company = useCompany()
  const { data, isLoading, error } = useQuery({
    queryKey: ['document', company.companyId, docType, number],
    queryFn: () => api.document(company.companyId, docType, number),
  })
  if (isLoading || error) return <Loading error={error} />
  if (!data) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-lg font-semibold text-navy">No se encontró {number}</h1>
        <Button asChild className="mt-4" variant="outline">
          <Link to={company.docPath(docType)}>Volver al listado</Link>
        </Button>
      </div>
    )
  }
  return <DocumentView detail={data} />
}

function DocumentView({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const { doc } = detail
  const info = DOC_TYPES[doc.doc_type]
  const [pending, setPending] = useState<AvailableAction | null>(null)
  const [awarding, setAwarding] = useState(false)
  const [paying, setPaying] = useState(false)
  const run = useCommand(
    (action: AvailableAction, text: string) => RUNNERS[doc.doc_type][action.action]!(doc.id, text),
    {
      success: 'Listo. El cambio quedó registrado en el historial.',
      onSuccess: () => setPending(null),
    },
  )

  const canEdit =
    doc.status === 'BORRADOR' &&
    ((doc.doc_type === 'PURCHASE_REQUISITION' && company.can('purchase_requisition.update')) ||
      (doc.doc_type === 'PURCHASE_ORDER' && company.can('purchase_order.update')) ||
      (doc.doc_type === 'JOURNAL_ENTRY' && company.can('journal_entry.update')))
  const canOrder =
    doc.doc_type === 'PURCHASE_REQUISITION' &&
    ['SOLICITADO', 'ORDENADO_PARCIAL'].includes(doc.status) &&
    company.can('purchase_order.create')
  const canReceive =
    doc.doc_type === 'PURCHASE_ORDER' &&
    ['ENVIADO', 'RECIBIDO_PARCIAL'].includes(doc.status) &&
    company.can('goods_receipt.create')
  const canInvoice =
    doc.doc_type === 'PURCHASE_ORDER' &&
    ['RECIBIDO_PARCIAL', 'RECIBIDO', 'CERRADO'].includes(doc.status) &&
    company.can('supplier_invoice.create')
  const canRequestQuotes =
    doc.doc_type === 'PURCHASE_REQUISITION' &&
    ['SOLICITADO', 'ORDENADO_PARCIAL'].includes(doc.status) &&
    company.can('rfq.create')
  const canLoadQuote = doc.doc_type === 'RFQ' && doc.status === 'ENVIADA' && company.can('supplier_quote.create')
  const canPay =
    doc.doc_type === 'SUPPLIER_INVOICE' &&
    ['REGISTRADA', 'PAGADA_PARCIAL'].includes(doc.status) &&
    !!detail.supplier &&
    company.can('payment_order.create')

  const primary = detail.actions.filter((a) => a.tone === 'default')
  const secondary = detail.actions.filter((a) => a.tone !== 'default')

  const actionButton = (a: AvailableAction) => {
    const button = (
      <Button
        key={a.action}
        variant={a.tone === 'destructive' ? 'destructive' : a.tone === 'outline' ? 'outline' : 'default'}
        disabled={!a.enabled}
        onClick={() =>
          a.action === 'AWARD' ? setAwarding(true) : a.action === 'PAY' ? setPaying(true) : setPending(a)
        }
      >
        {a.label}
      </Button>
    )
    if (a.enabled) return button
    return (
      <Tooltip key={a.action}>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{button}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{a.reason}</TooltipContent>
      </Tooltip>
    )
  }

  const blocked = detail.actions.filter((a) => !a.enabled)

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: AREA[doc.doc_type] },
          { label: info.plural, to: company.docPath(doc.doc_type) },
          { label: doc.display_number },
        ]}
        title={<span className="font-mono">{doc.display_number}</span>}
        meta={
          <>
            <DocStatus info={doc.status_info} />
            <span className="text-sm text-muted-foreground">{info.name}</span>
          </>
        }
        actions={
          <>
            {secondary.map(actionButton)}
            {canEdit && (
              <Button variant="outline" asChild>
                <Link to={`${doc.path}/editar`}>
                  <Pencil /> Editar
                </Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to={company.to(`documentos/${doc.id}/imprimir`)}>
                <Printer /> Imprimir
              </Link>
            </Button>
            {canRequestQuotes && (
              <Button variant="outline" asChild>
                <Link to={`${company.docPath('RFQ', 'nueva')}?sc=${doc.display_number}`}>
                  <FileSearch /> Pedir cotizaciones
                </Link>
              </Button>
            )}
            {canLoadQuote && (
              <Button variant="outline" asChild>
                <Link to={`${company.docPath('SUPPLIER_QUOTE', 'nueva')}?solicitud=${doc.display_number}`}>
                  <FilePlus2 /> Cargar cotización
                </Link>
              </Button>
            )}
            {canOrder && (
              <Button variant="outline" asChild>
                <Link to={`${company.docPath('PURCHASE_ORDER', 'nueva')}?sc=${doc.display_number}`}>
                  <ShoppingCart /> Crear orden de compra
                </Link>
              </Button>
            )}
            {canReceive && (
              <Button asChild>
                <Link to={`${company.docPath('GOODS_RECEIPT', 'nueva')}?oc=${doc.display_number}`}>
                  <PackageCheck /> Registrar recepción
                </Link>
              </Button>
            )}
            {canInvoice && (
              <Button variant="outline" asChild>
                <Link to={`${company.docPath('SUPPLIER_INVOICE', 'nueva')}?oc=${doc.display_number}`}>
                  <ReceiptText /> Registrar factura
                </Link>
              </Button>
            )}
            {canPay && (
              <Button variant="outline" asChild>
                <Link to={`${company.docPath('PAYMENT_ORDER', 'nueva')}?proveedor=${detail.supplier!.code}`}>
                  <Banknote /> Preparar orden de pago
                </Link>
              </Button>
            )}
            {primary.map(actionButton)}
          </>
        }
      />

      {blocked.length > 0 && (
        <div className="mb-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            {blocked.map((a) => (
              <div key={a.action}>
                <span className="font-medium">{a.label}:</span> {a.reason}
              </div>
            ))}
          </div>
        </div>
      )}
      {doc.status_reason && ['RECHAZADO', 'RECHAZADA', 'ANULADO', 'ANULADA', 'CERRADO'].includes(doc.status) && (
        <div className="mb-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            <span className="font-medium">Motivo ({doc.status_info.label.toLowerCase()}):</span> {doc.status_reason}
          </div>
        </div>
      )}

      {/* El cuadro comparativo va a todo el ancho: una columna por cotización. */}
      {detail.rfq && (
        <div className="mb-4">
          <ComparisonSection detail={detail} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Datos del documento">
            <HeaderInfo detail={detail} />
          </Section>
          <Tabs defaultValue="detail">
            <TabsList>
              <TabsTrigger value="detail">Detalle</TabsTrigger>
              <TabsTrigger value="flow">Flujo documental</TabsTrigger>
              <TabsTrigger value="history">Historial ({detail.history.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="detail" className="mt-3">
              <Lines detail={detail} />
            </TabsContent>
            <TabsContent value="flow" className="mt-3">
              <Section
                title="Flujo documental"
                description="La misma operación, vista a través de los documentos de cada sector."
              >
                <DocumentFlow nodes={detail.flow} />
              </Section>
            </TabsContent>
            <TabsContent value="history" className="mt-3">
              <Section
                title="Historial"
                description="Registro inmutable: quién hizo cada cambio, con qué rol y cuándo."
              >
                <AuditTimeline events={detail.history} />
              </Section>
            </TabsContent>
          </Tabs>
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-xl border border-brand-blue/30 bg-brand-blue-soft/60 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-navy">
              <Lightbulb className="size-4 text-brand-blue" /> ¿Qué sigue?
            </div>
            <div className="mt-2 text-xs font-medium tracking-wide text-brand-blue uppercase">
              {detail.next_step.who}
            </div>
            <p className="mt-1 text-sm text-slate-700">{detail.next_step.text}</p>
          </section>

          {detail.approvals.length > 0 && (
            <Section title="Aprobaciones" bodyClassName="flex flex-col gap-3">
              {detail.approvals.map((a) => (
                <div key={a.id} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{a.approver_role_name}</span>
                    <StatusBadge
                      label={
                        a.status === 'PENDIENTE'
                          ? 'Pendiente'
                          : a.status === 'APROBADO'
                            ? 'Aprobada'
                            : a.status === 'RECHAZADO'
                              ? 'Rechazada'
                              : 'Retirada'
                      }
                      badge={
                        a.status === 'PENDIENTE'
                          ? 'warning'
                          : a.status === 'APROBADO'
                            ? 'success'
                            : a.status === 'RECHAZADO'
                              ? 'danger'
                              : 'neutral'
                      }
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Monto evaluado: {money(a.amount)} · pedida por {a.requested_by_name}
                  </div>
                  {a.decided_by_name && (
                    <div className="text-xs text-muted-foreground">
                      {a.decided_by_name} · {dateTime(a.decided_at)}
                    </div>
                  )}
                  {a.comment && <div className="mt-1 rounded bg-muted px-2 py-1 text-xs">“{a.comment}”</div>}
                </div>
              ))}
            </Section>
          )}

          {detail.related_order && (
            <Section title="Orden de compra">
              <Link
                to={detail.related_order.path}
                className="flex items-center justify-between gap-2 text-sm hover:underline"
              >
                <span className="font-mono font-semibold">{detail.related_order.display_number}</span>
                <DocStatus info={detail.related_order.status_info} />
              </Link>
              <p className="mt-1 text-xs text-muted-foreground">
                {detail.related_order.supplier_name} · {money(detail.related_order.total)}
              </p>
            </Section>
          )}

          <section className="rounded-xl border bg-card p-4 text-sm">
            <div className="flex items-center gap-2 font-semibold text-navy">
              <Info className="size-4 text-muted-foreground" /> {info.name}
            </div>
            <p className="mt-1 text-muted-foreground">{info.description}</p>
            <p className="mt-2 text-muted-foreground">
              <span className="font-medium text-foreground">Estado actual:</span> {doc.status_info.description}
            </p>
          </section>
        </aside>
      </div>

      {awarding && <AwardDialog detail={detail} open={awarding} onOpenChange={setAwarding} />}
      {paying && <PayDialog detail={detail} open={paying} onOpenChange={setPaying} />}
      {pending && (
        <ActionDialog
          open={!!pending}
          onOpenChange={(o) => !o && setPending(null)}
          title={`${pending.label} · ${doc.display_number}`}
          description={pending.help}
          confirmLabel={pending.label}
          tone={pending.tone === 'destructive' ? 'destructive' : 'default'}
          reason={pending.requires_comment || pending.action === 'APPROVE'}
          reasonRequired={pending.requires_comment}
          reasonLabel={pending.action === 'APPROVE' ? 'Comentario' : 'Motivo'}
          busy={run.isPending}
          onConfirm={(text) => run.mutate([pending, text])}
        />
      )}
    </>
  )
}

function HeaderInfo({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const { doc, supplier, warehouse, journal } = detail
  // A 1024 px la columna principal queda angosta (la ayuda va al costado): una sola columna de datos.
  const grid = 'grid gap-x-8 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2'
  if (doc.doc_type === 'JOURNAL_ENTRY' && journal) {
    return (
      <>
        <dl className={grid}>
          <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
          <InfoRow label="N.º de asiento">
            {journal.entry_number
              ? `${journal.entry_number} · ${journal.fiscal_year_name}`
              : 'Se asigna al registrarlo'}
          </InfoRow>
          <InfoRow label="Origen">{JOURNAL_ORIGINS[journal.origin]}</InfoRow>
          <InfoRow label="Creó">
            {doc.created_by_name}
            {doc.sector_name !== '—' ? ` · ${doc.sector_name}` : ''}
          </InfoRow>
          {journal.reverses && (
            <InfoRow label="Anula a">
              <Link className="font-mono hover:underline" to={journal.reverses.path}>
                {journal.reverses.display_number}
              </Link>
            </InfoRow>
          )}
          {journal.reversed_by && (
            <InfoRow label="Contraasiento">
              <Link className="font-mono hover:underline" to={journal.reversed_by.path}>
                {journal.reversed_by.display_number}
              </Link>
            </InfoRow>
          )}
        </dl>
        <div className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Leyenda: </span>
          {journal.description}
        </div>
      </>
    )
  }
  if (doc.doc_type === 'PAYMENT_ORDER' && detail.payment) {
    const { payment } = detail
    return (
      <dl className={grid}>
        <InfoRow label="Proveedor">
          {supplier && company.can('payable.read') ? (
            <Link className="hover:underline" to={company.to(`pagos/proveedores/${supplier.code}`)}>
              {supplier.legal_name}
            </Link>
          ) : (
            supplier?.legal_name
          )}
        </InfoRow>
        <InfoRow label="CUIT (simulado)">
          {supplier?.tax_id} · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Paga desde">
          {company.can('ledger.read') ? (
            <Link
              className="hover:underline"
              to={company.to(`contabilidad/mayor?cuenta=${payment.treasury_account.id}`)}
            >
              {payment.treasury_account.name}
            </Link>
          ) : (
            payment.treasury_account.name
          )}{' '}
          <span className="font-mono text-xs text-muted-foreground">{payment.treasury_account.code}</span>
        </InfoRow>
        <InfoRow label="Importe">{money(doc.total)}</InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Pago">
          {payment.paid_on
            ? `${date(payment.paid_on)}${payment.payment_method ? ` · ${PAYMENT_METHODS[payment.payment_method]}` : ''}${payment.payment_reference ? ` N.º ${payment.payment_reference}` : ''}`
            : 'Todavía no se pagó'}
        </InfoRow>
        <InfoRow label="Preparó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'BANK_RECONCILIATION' && detail.reconciliation) {
    const r = detail.reconciliation
    return (
      <dl className={grid}>
        <InfoRow label="Banco">
          {company.can('ledger.read') ? (
            <Link className="hover:underline" to={company.to(`contabilidad/mayor?cuenta=${r.account.id}`)}>
              {r.account.name}
            </Link>
          ) : (
            r.account.name
          )}{' '}
          <span className="font-mono text-xs text-muted-foreground">{r.account.code}</span>
        </InfoRow>
        <InfoRow label="Extracto al">{date(r.statement_date)}</InfoRow>
        <InfoRow label="Saldo según extracto">{money(r.statement_balance)}</InfoRow>
        <InfoRow label="Saldo según libros">{money(r.book_balance)}</InfoRow>
        <InfoRow label="Entradas sin acreditar">{money(r.pending_debits)}</InfoRow>
        <InfoRow label="Pagos sin debitar">{money(r.pending_credits)}</InfoRow>
        <InfoRow label="Concilió">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'FUNDS_TRANSFER' && detail.transfer) {
    const { transfer } = detail
    const account = (a: typeof transfer.from_account) =>
      company.can('ledger.read') ? (
        <Link className="hover:underline" to={company.to(`contabilidad/mayor?cuenta=${a.id}`)}>
          {a.name}
        </Link>
      ) : (
        a.name
      )
    return (
      <dl className={grid}>
        <InfoRow label="Desde">
          {account(transfer.from_account)}{' '}
          <span className="font-mono text-xs text-muted-foreground">{transfer.from_account.code}</span>
        </InfoRow>
        <InfoRow label="Hacia">
          {account(transfer.to_account)}{' '}
          <span className="font-mono text-xs text-muted-foreground">{transfer.to_account.code}</span>
        </InfoRow>
        <InfoRow label="Importe">{money(doc.total)}</InfoRow>
        <InfoRow label="Referencia">{transfer.reference || '—'}</InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Transferida">
          {transfer.transferred_on ? date(transfer.transferred_on) : 'Todavía no (borrador)'}
        </InfoRow>
        <InfoRow label="Preparó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'RFQ' && detail.rfq) {
    const { rfq } = detail
    return (
      <dl className={grid}>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Responden hasta">{date(rfq.response_due)}</InfoRow>
        <InfoRow label="Depósito de entrega">{warehouse?.name}</InfoRow>
        <InfoRow label="Proveedores invitados">{rfq.invited.length}</InfoRow>
        <InfoRow label="Preparó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.reference_label && <InfoRow label="Atiende">{doc.reference_label}</InfoRow>}
        {rfq.order && (
          <InfoRow label="Orden de compra">
            <Link className="font-mono hover:underline" to={rfq.order.path}>
              {rfq.order.display_number}
            </Link>{' '}
            <DocStatus info={rfq.order.status_info} />
          </InfoRow>
        )}
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'SUPPLIER_QUOTE' && detail.quote) {
    const { quote } = detail
    return (
      <dl className={grid}>
        <InfoRow label="Proveedor">{supplier?.legal_name}</InfoRow>
        <InfoRow label="CUIT (simulado)">
          {supplier?.tax_id} · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Solicitud de cotización">
          <Link className="font-mono hover:underline" to={quote.rfq.path}>
            {quote.rfq.display_number}
          </Link>{' '}
          <DocStatus info={quote.rfq.status_info} />
        </InfoRow>
        <InfoRow label="Referencia del proveedor">{quote.supplier_reference || '—'}</InfoRow>
        <InfoRow label="Recibida">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Válida hasta">
          {date(quote.valid_until)}
          {quote.expired && <span className="text-red-700"> · vencida</span>}
        </InfoRow>
        <InfoRow label="Plazo de entrega">{quote.delivery_days} días</InfoRow>
        <InfoRow label="Condición de pago">
          {quote.payment_terms_days ? `${quote.payment_terms_days} días` : 'Contado'}
        </InfoRow>
        {quote.best && <InfoRow label="En el cuadro">La más conveniente por precio</InfoRow>}
        {quote.order && (
          <InfoRow label="Orden de compra">
            <Link className="font-mono hover:underline" to={quote.order.path}>
              {quote.order.display_number}
            </Link>{' '}
            <DocStatus info={quote.order.status_info} />
          </InfoRow>
        )}
        <InfoRow label="Cargó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'PURCHASE_REQUISITION' && doc.pr) {
    return (
      <>
        <dl className={grid}>
          <InfoRow label="Sector solicitante">{doc.sector_name}</InfoRow>
          <InfoRow label="Solicitó">{doc.created_by_name}</InfoRow>
          <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
          <InfoRow label="Necesaria para">{date(doc.pr.needed_by)}</InfoRow>
          <InfoRow label="Prioridad">{PRIORITIES[doc.pr.priority]}</InfoRow>
        </dl>
        <div className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Motivo: </span>
          {doc.pr.reason}
        </div>
        {doc.notes && <p className="mt-2 text-sm text-muted-foreground">Observaciones: {doc.notes}</p>}
      </>
    )
  }
  if (doc.doc_type === 'SUPPLIER_INVOICE' && doc.si) {
    return (
      <dl className={grid}>
        <InfoRow label="Proveedor">{supplier?.legal_name}</InfoRow>
        <InfoRow label="CUIT (simulado)">
          {supplier?.tax_id} · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Comprobante">
          Factura {doc.si.letter} {doc.si.point_of_sale}-{doc.si.invoice_number}
        </InfoRow>
        <InfoRow label="Fecha de emisión">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Vencimiento">{date(doc.si.due_date)}</InfoRow>
        <InfoRow label="Orden de compra">
          {detail.related_order ? (
            <Link className="font-mono hover:underline" to={detail.related_order.path}>
              {detail.related_order.display_number}
            </Link>
          ) : (
            '—'
          )}
        </InfoRow>
        <InfoRow label="Cargó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'PURCHASE_ORDER' && doc.po) {
    return (
      <dl className={grid}>
        <InfoRow label="Proveedor">{supplier?.legal_name}</InfoRow>
        <InfoRow label="CUIT (simulado)">
          {supplier?.tax_id} · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Entrega comprometida">{date(doc.po.expected_date)}</InfoRow>
        <InfoRow label="Depósito de destino">{warehouse?.name}</InfoRow>
        <InfoRow label="Condición de pago">
          {doc.po.payment_terms_days ? `${doc.po.payment_terms_days} días` : 'Contado'}
        </InfoRow>
        <InfoRow label="Condiciones de entrega">{doc.po.delivery_terms || '—'}</InfoRow>
        <InfoRow label="Emitió">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.reference_label && <InfoRow label="Origen">{doc.reference_label}</InfoRow>}
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'GOODS_RECEIPT' && doc.gr) {
    return (
      <dl className={grid}>
        <InfoRow label="Orden de compra">
          {detail.related_order ? (
            <Link className="font-mono hover:underline" to={detail.related_order.path}>
              {detail.related_order.display_number}
            </Link>
          ) : (
            '—'
          )}
        </InfoRow>
        <InfoRow label="Proveedor">{supplier?.legal_name}</InfoRow>
        <InfoRow label="Remito del proveedor">{doc.gr.supplier_delivery_note}</InfoRow>
        <InfoRow label="Transportista">{doc.gr.carrier_name || '—'}</InfoRow>
        <InfoRow label="Depósito">{warehouse?.name}</InfoRow>
        <InfoRow label="Ingresó al stock">
          {doc.gr.received_at ? dateTime(doc.gr.received_at) : 'Todavía no (borrador)'}
        </InfoRow>
        <InfoRow label="Registró">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  return (
    <dl className={grid}>
      <InfoRow label="Depósito">{warehouse?.name}</InfoRow>
      <InfoRow label="Motivo">{doc.sa ? ADJUSTMENT_REASONS[doc.sa.reason_code] : ''}</InfoRow>
      <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
      <InfoRow label="Registró">
        {doc.created_by_name}
        {doc.sector_name !== '—' ? ` · ${doc.sector_name}` : ''}
      </InfoRow>
      {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      <InfoRow label="Ver stock">
        <Link className="text-brand-blue hover:underline" to={company.to('stock')}>
          Existencias <ArrowRight className="inline size-3" />
        </Link>
      </InfoRow>
    </dl>
  )
}

function JournalLines({ journal }: { journal: NonNullable<DocumentDetail['journal']> }) {
  const company = useCompany()
  const head = 'h-9 text-xs font-semibold text-slate-600'
  const difference = Math.round((journal.total_debit - journal.total_credit) * 100) / 100
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className={cn(head, 'w-10')}>#</TableHead>
            <TableHead className={head}>Cuenta</TableHead>
            <TableHead className={cn(head, 'text-right')}>Debe</TableHead>
            <TableHead className={cn(head, 'text-right')}>Haber</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {journal.lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="text-xs text-muted-foreground">{l.line_no}</TableCell>
              <TableCell className={cn('text-sm', l.credit > 0 && 'pl-8')}>
                {l.credit > 0 && <span className="text-muted-foreground">a </span>}
                {company.can('ledger.read') ? (
                  <Link to={company.to(`contabilidad/mayor?cuenta=${l.account.id}`)} className="hover:underline">
                    {l.account.name}
                  </Link>
                ) : (
                  l.account.name
                )}{' '}
                <span className="font-mono text-xs text-muted-foreground">{l.account.code}</span>
                {l.notes && <div className="text-xs text-muted-foreground">{l.notes}</div>}
              </TableCell>
              <TableCell className="tabular text-right">{l.debit ? money(l.debit) : ''}</TableCell>
              <TableCell className="tabular text-right">{l.credit ? money(l.credit) : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2} className="text-right text-sm font-semibold text-navy">
              {difference ? `Totales (diferencia ${money(Math.abs(difference))})` : 'Totales'}
            </TableCell>
            <TableCell className="tabular text-right font-semibold text-navy">{money(journal.total_debit)}</TableCell>
            <TableCell className="tabular text-right font-semibold text-navy">{money(journal.total_credit)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}

function PaymentLines({ payment, total }: { payment: NonNullable<DocumentDetail['payment']>; total: number }) {
  const head = 'h-9 text-xs font-semibold text-slate-600'
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className={cn(head, 'w-10')}>#</TableHead>
            <TableHead className={head}>Factura</TableHead>
            <TableHead className={head}>Vence</TableHead>
            <TableHead className={cn(head, 'text-right')}>Total de la factura</TableHead>
            <TableHead className={cn(head, 'text-right')}>Paga esta orden</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payment.lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="text-xs text-muted-foreground">{l.line_no}</TableCell>
              <TableCell className="text-sm">
                <Link to={l.invoice.path} className="hover:underline">
                  <span className="font-mono text-xs font-semibold text-navy">{l.invoice.display_number}</span> Factura{' '}
                  {l.invoice.invoice_label}
                </Link>
                <div className="mt-1">
                  <DocStatus info={l.invoice.status_info} />
                </div>
              </TableCell>
              <TableCell className="text-sm">{date(l.invoice.due_date)}</TableCell>
              <TableCell className="tabular text-right">{money(l.invoice.total)}</TableCell>
              <TableCell className="tabular text-right font-semibold">{money(l.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TotalRow label="Total de la orden" value={total} span={4} strong />
        </TableFooter>
      </Table>
    </div>
  )
}

/** Los dos lados de una transferencia: lo que entra a una cuenta sale de la otra. */
function TransferLines({ transfer, total }: { transfer: NonNullable<DocumentDetail['transfer']>; total: number }) {
  const head = 'h-9 text-xs font-semibold text-slate-600'
  const rows = [
    ['Entra a', transfer.to_account],
    ['Sale de', transfer.from_account],
  ] as const
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className={head}>Movimiento</TableHead>
            <TableHead className={head}>Caja o banco</TableHead>
            <TableHead className={cn(head, 'text-right')}>Importe</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([label, a]) => (
            <TableRow key={label}>
              <TableCell className="text-sm text-muted-foreground">{label}</TableCell>
              <TableCell className="text-sm">
                {a.name} <span className="font-mono text-xs text-muted-foreground">{a.code}</span>
              </TableCell>
              <TableCell className="tabular text-right">{money(total)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Lines({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const { doc, lines } = detail
  if (detail.journal) return <JournalLines journal={detail.journal} />
  if (detail.payment) return <PaymentLines payment={detail.payment} total={doc.total} />
  if (detail.transfer) return <TransferLines transfer={detail.transfer} total={doc.total} />
  if (detail.reconciliation) return <ReconciliationLines view={detail.reconciliation} />
  const product = (l: (typeof lines)[number]) => (
    <Link to={company.to(`productos/${l.product.code}`)} className="hover:underline">
      <span className="font-mono text-xs font-semibold text-navy">{l.product.code}</span> {l.product.name}
    </Link>
  )
  const head = 'h-9 text-xs font-semibold text-slate-600'
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className={cn(head, 'w-10')}>#</TableHead>
            <TableHead className={head}>Producto</TableHead>
            {doc.doc_type === 'PURCHASE_REQUISITION' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Cantidad</TableHead>
                <TableHead className={cn(head, 'text-right')}>Ordenado</TableHead>
                <TableHead className={cn(head, 'text-right')}>Pendiente</TableHead>
                <TableHead className={head}>Observaciones</TableHead>
              </>
            )}
            {doc.doc_type === 'PURCHASE_ORDER' && (
              <>
                <TableHead className={head}>Solicitud</TableHead>
                <TableHead className={cn(head, 'text-right')}>Cantidad</TableHead>
                <TableHead className={cn(head, 'text-right')}>Precio unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
                <TableHead className={cn(head, 'text-right')}>Subtotal</TableHead>
                <TableHead className={cn(head, 'text-right')}>Recibido</TableHead>
              </>
            )}
            {doc.doc_type === 'GOODS_RECEIPT' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Ordenado (OC)</TableHead>
                <TableHead className={cn(head, 'text-right')}>Recibido acá</TableHead>
                <TableHead className={cn(head, 'text-right')}>Costo unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>Importe</TableHead>
              </>
            )}
            {doc.doc_type === 'STOCK_ADJUSTMENT' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Ajuste</TableHead>
                <TableHead className={cn(head, 'text-right')}>Costo unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>Importe</TableHead>
              </>
            )}
            {doc.doc_type === 'RFQ' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Cantidad</TableHead>
                <TableHead className={head}>Solicitud</TableHead>
                <TableHead className={head}>Observaciones</TableHead>
              </>
            )}
            {doc.doc_type === 'SUPPLIER_QUOTE' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Cantidad</TableHead>
                <TableHead className={cn(head, 'text-right')}>Precio unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
                <TableHead className={cn(head, 'text-right')}>Subtotal</TableHead>
              </>
            )}
            {doc.doc_type === 'SUPPLIER_INVOICE' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Recibido (OC)</TableHead>
                <TableHead className={cn(head, 'text-right')}>Facturado</TableHead>
                <TableHead className={cn(head, 'text-right')}>Precio unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
                <TableHead className={cn(head, 'text-right')}>Subtotal</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="text-xs text-muted-foreground">{l.line_no}</TableCell>
              <TableCell className="text-sm">{product(l)}</TableCell>
              {doc.doc_type === 'PURCHASE_REQUISITION' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.quantity, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right">{qty(l.qty_ordered)}</TableCell>
                  <TableCell className="tabular text-right">
                    {qty(Math.max(0, l.quantity - (l.qty_ordered ?? 0)))}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{l.notes || '—'}</TableCell>
                </>
              )}
              {doc.doc_type === 'PURCHASE_ORDER' && (
                <>
                  <TableCell className="font-mono text-xs">{l.requisition_label ?? '—'}</TableCell>
                  <TableCell className="tabular text-right">{qty(l.quantity, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right">{money(l.unit_price)}</TableCell>
                  <TableCell className="tabular text-right">{l.vat_rate}%</TableCell>
                  <TableCell className="tabular text-right">{money(l.line_subtotal)}</TableCell>
                  <TableCell
                    className={cn(
                      'tabular text-right',
                      (l.qty_received ?? 0) >= l.quantity
                        ? 'text-green-700'
                        : (l.qty_received ?? 0) > 0
                          ? 'text-amber-700'
                          : '',
                    )}
                  >
                    {qty(l.qty_received)}
                  </TableCell>
                </>
              )}
              {doc.doc_type === 'GOODS_RECEIPT' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.qty_ordered_po, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right font-semibold">
                    {qty(l.quantity, l.product.uom_code)}
                  </TableCell>
                  <TableCell className="tabular text-right">{money(l.unit_cost)}</TableCell>
                  <TableCell className="tabular text-right">{money(l.quantity * (l.unit_cost ?? 0))}</TableCell>
                </>
              )}
              {doc.doc_type === 'STOCK_ADJUSTMENT' && (
                <>
                  <TableCell
                    className={cn(
                      'tabular text-right font-semibold',
                      l.quantity < 0 ? 'text-red-700' : 'text-green-700',
                    )}
                  >
                    {l.quantity > 0 ? '+' : ''}
                    {qty(l.quantity, l.product.uom_code)}
                  </TableCell>
                  <TableCell className="tabular text-right">{money(l.unit_cost)}</TableCell>
                  <TableCell className="tabular text-right">{money(l.quantity * (l.unit_cost ?? 0))}</TableCell>
                </>
              )}
              {doc.doc_type === 'RFQ' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.quantity, l.product.uom_code)}</TableCell>
                  <TableCell className="font-mono text-xs">{l.requisition_label ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{l.notes || '—'}</TableCell>
                </>
              )}
              {doc.doc_type === 'SUPPLIER_QUOTE' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.quantity, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right">{money(l.unit_price)}</TableCell>
                  <TableCell className="tabular text-right">{l.vat_rate ? `${l.vat_rate}%` : '—'}</TableCell>
                  <TableCell className="tabular text-right">{money(l.line_subtotal)}</TableCell>
                </>
              )}
              {doc.doc_type === 'SUPPLIER_INVOICE' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.qty_received, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right font-semibold">
                    {qty(l.quantity, l.product.uom_code)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {money(l.unit_price)}
                    {l.order_unit_price != null && l.order_unit_price !== l.unit_price && (
                      <div className="text-xs text-amber-700">OC: {money(l.order_unit_price)}</div>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {doc.si?.letter === 'A' ? `${l.vat_rate}%` : '—'}
                  </TableCell>
                  <TableCell className="tabular text-right">{money(l.line_subtotal)}</TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
        {(doc.doc_type === 'PURCHASE_ORDER' || doc.doc_type === 'SUPPLIER_INVOICE') && (
          <TableFooter>
            {/* En la OC queda una columna más a la derecha (lo recibido). */}
            <TotalRow
              label="Subtotal neto"
              value={doc.subtotal}
              span={6}
              trailing={doc.doc_type === 'PURCHASE_ORDER'}
            />
            <TotalRow label="IVA" value={doc.tax_total} span={6} trailing={doc.doc_type === 'PURCHASE_ORDER'} />
            <TotalRow label="Total" value={doc.total} span={6} strong trailing={doc.doc_type === 'PURCHASE_ORDER'} />
          </TableFooter>
        )}
        {doc.doc_type === 'SUPPLIER_QUOTE' && (
          <TableFooter>
            <TotalRow label="Subtotal neto (costo para la empresa)" value={doc.subtotal} span={5} />
            <TotalRow label="IVA" value={doc.tax_total} span={5} />
            <TotalRow label="Total" value={doc.total} span={5} strong />
          </TableFooter>
        )}
        {(doc.doc_type === 'GOODS_RECEIPT' || doc.doc_type === 'STOCK_ADJUSTMENT') && (
          <TableFooter>
            <TotalRow
              label="Valor total (a costo)"
              value={doc.total}
              span={doc.doc_type === 'GOODS_RECEIPT' ? 5 : 4}
              strong
            />
          </TableFooter>
        )}
      </Table>
    </div>
  )
}

function TotalRow({
  label,
  value,
  span,
  strong,
  trailing,
}: {
  label: string
  value: number
  span: number
  strong?: boolean
  trailing?: boolean
}) {
  return (
    <TableRow>
      <TableCell
        colSpan={span}
        className={cn('text-right text-sm', strong ? 'font-semibold text-navy' : 'text-muted-foreground')}
      >
        {label}
      </TableCell>
      <TableCell className={cn('tabular text-right', strong && 'font-semibold text-navy')}>{money(value)}</TableCell>
      {trailing && <TableCell />}
    </TableRow>
  )
}
