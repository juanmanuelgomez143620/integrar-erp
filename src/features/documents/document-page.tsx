import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowRight,
  Banknote,
  FilePlus2,
  FileSearch,
  HandCoins,
  Info,
  Lightbulb,
  Pencil,
  Printer,
  ReceiptText,
  ShoppingCart,
  PackageCheck,
  ShieldAlert,
  Truck,
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
import { date, dateTime, money, percent, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { AwardDialog, ComparisonSection } from '@/features/purchasing/quotations/quotation-views'
import { PayDialog } from '@/features/payables/pay-dialog'
import { ReconciliationLines } from '@/features/payables/reconciliation-views'
import { PayrollSection, periodLabel } from '@/features/hr/payroll'
import { PayrollPayDialog } from '@/features/hr/payroll-pay-dialog'
import { TaxReturnPayDialog, TaxReturnSection, taxTitle } from '@/features/tax/tax-return'
import {
  FinishDialog,
  IssueDialog,
  OperationsSection,
  ShortagesNotice,
  VariancesSection,
} from '@/features/production/production-dialogs'

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
  SALES_ORDER: {
    CONFIRM: (id) => commands.confirmSalesOrder(id),
    APPROVE: (id, t) => commands.approveSalesOrder(id, t),
    REJECT: (id, t) => commands.rejectSalesOrder(id, t),
    CANCEL: (id, t) => commands.cancelSalesOrder(id, t),
    CLOSE: (id, t) => commands.closeSalesOrder(id, t),
  },
  DELIVERY_NOTE: {
    CONFIRM: (id) => commands.confirmDeliveryNote(id),
    CANCEL: (id, t) => commands.cancelDeliveryNote(id, t),
  },
  SALES_INVOICE: {
    CONFIRM: (id) => commands.confirmSalesInvoice(id),
    CANCEL: (id, t) => commands.cancelSalesInvoice(id, t),
  },
  CUSTOMER_RECEIPT: {
    CONFIRM: (id) => commands.confirmCustomerReceipt(id),
    CANCEL: (id, t) => commands.cancelCustomerReceipt(id, t),
  },
  SALES_QUOTE: {
    SEND: (id) => commands.sendSalesQuote(id),
    // Aceptar genera el pedido de venta: la página lo abre.
    CONFIRM: (id) => commands.acceptSalesQuote(id),
    REJECT: (id, t) => commands.rejectSalesQuote(id, t),
    CLOSE: (id) => commands.expireSalesQuote(id),
    CANCEL: (id, t) => commands.cancelSalesQuote(id, t),
  },
  // Entregar los materiales y terminar tienen su propio diálogo: hay que indicar las cantidades.
  PRODUCTION_ORDER: {
    RELEASE: (id) => commands.releaseProductionOrder(id),
    CANCEL: (id, t) => commands.cancelProductionOrder(id, t),
  },
  PAYROLL: {
    CONFIRM: (id) => commands.confirmPayroll(id),
    CANCEL: (id, t) => commands.cancelPayroll(id, t),
  },
  // Pagar tiene su propio diálogo: hay que elegir la caja o el banco.
  TAX_RETURN: {
    CONFIRM: (id) => commands.presentTaxReturn(id),
    CANCEL: (id, t) => commands.cancelTaxReturn(id, t),
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
  SALES_ORDER: 'Ventas',
  DELIVERY_NOTE: 'Depósito',
  SALES_INVOICE: 'Ventas',
  CUSTOMER_RECEIPT: 'Pagos y tesorería',
  SALES_QUOTE: 'Ventas',
  PRODUCTION_ORDER: 'Producción',
  PAYROLL: 'RRHH',
  TAX_RETURN: 'Impuestos',
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

/** Un documento creado por una acción (aceptar un presupuesto genera el pedido). */
const isCreated = (r: unknown): r is { id: string; display_number: string } =>
  !!r && typeof r === 'object' && 'display_number' in r

function DocumentView({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const navigate = useNavigate()
  const { doc } = detail
  const info = DOC_TYPES[doc.doc_type]
  const [pending, setPending] = useState<AvailableAction | null>(null)
  const [awarding, setAwarding] = useState(false)
  const [paying, setPaying] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const run = useCommand(
    (action: AvailableAction, text: string) => RUNNERS[doc.doc_type][action.action]!(doc.id, text),
    {
      success: (r) =>
        isCreated(r)
          ? `Se generó ${r.display_number} en borrador: revisalo y confirmalo.`
          : 'Listo. El cambio quedó registrado en el historial.',
      onSuccess: (r) => {
        setPending(null)
        if (doc.doc_type === 'SALES_QUOTE' && isCreated(r)) navigate(company.docPath('SALES_ORDER', r.display_number))
      },
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
  const canDispatch =
    doc.doc_type === 'SALES_ORDER' &&
    ['CONFIRMADO', 'ENTREGADO_PARCIAL'].includes(doc.status) &&
    company.can('delivery_note.create')
  const canCollect =
    doc.doc_type === 'SALES_INVOICE' &&
    ['REGISTRADA', 'COBRADA_PARCIAL'].includes(doc.status) &&
    !!detail.customer &&
    company.can('customer_receipt.create')
  const canInvoiceSale =
    doc.doc_type === 'SALES_ORDER' &&
    ['ENTREGADO_PARCIAL', 'ENTREGADO', 'CERRADO'].includes(doc.status) &&
    company.can('sales_invoice.create') &&
    detail.lines.some((l) => (l.qty_delivered ?? 0) - (l.qty_invoiced ?? 0) > 1e-9)

  const primary = detail.actions.filter((a) => a.tone === 'default')
  const secondary = detail.actions.filter((a) => a.tone !== 'default')

  const actionButton = (a: AvailableAction) => {
    const button = (
      <Button
        key={a.action}
        variant={a.tone === 'destructive' ? 'destructive' : a.tone === 'outline' ? 'outline' : 'default'}
        disabled={!a.enabled}
        onClick={() =>
          a.action === 'AWARD'
            ? setAwarding(true)
            : a.action === 'PAY'
              ? setPaying(true)
              : a.action === 'ISSUE'
                ? setIssuing(true)
                : a.action === 'FINISH'
                  ? setFinishing(true)
                  : setPending(a)
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

  // A la orden planificada que no se puede liberar la explica el aviso de faltantes.
  const blocked = detail.actions.filter(
    (a) => !a.enabled && !(doc.doc_type === 'PRODUCTION_ORDER' && a.action === 'RELEASE'),
  )

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
            {canDispatch && (
              <Button asChild>
                <Link to={`${company.docPath('DELIVERY_NOTE', 'nuevo')}?pv=${doc.display_number}`}>
                  <Truck /> Preparar remito
                </Link>
              </Button>
            )}
            {canCollect && (
              <Button variant="outline" asChild>
                <Link to={`${company.docPath('CUSTOMER_RECEIPT', 'nuevo')}?cliente=${detail.customer!.code}`}>
                  <HandCoins /> Registrar cobro
                </Link>
              </Button>
            )}
            {canInvoiceSale && (
              <Button variant={canDispatch ? 'outline' : 'default'} asChild>
                <Link to={`${company.docPath('SALES_INVOICE', 'nueva')}?pv=${doc.display_number}`}>
                  <ReceiptText /> Facturar lo entregado
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
      {doc.doc_type === 'PRODUCTION_ORDER' && doc.status === 'BORRADOR' && <ShortagesNotice detail={detail} />}
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
            <TabsContent value="detail" className="mt-3 flex flex-col gap-4">
              {detail.payroll ? (
                <PayrollSection detail={detail} />
              ) : detail.tax_return ? (
                <TaxReturnSection detail={detail} />
              ) : (
                <Lines detail={detail} />
              )}
              {detail.production_order && detail.production_order.operations.length > 0 && (
                <OperationsSection view={detail.production_order} />
              )}
              {detail.production_order?.issued_at && doc.status !== 'ANULADA' && <VariancesSection detail={detail} />}
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

          {detail.sales_order && <CreditSection detail={detail} />}

          {detail.related_order && (
            <Section title={DOC_TYPES[detail.related_order.doc_type].name}>
              <Link
                to={detail.related_order.path}
                className="flex items-center justify-between gap-2 text-sm hover:underline"
              >
                <span className="font-mono font-semibold">{detail.related_order.display_number}</span>
                <DocStatus info={detail.related_order.status_info} />
              </Link>
              <p className="mt-1 text-xs text-muted-foreground">
                {detail.related_order.supplier_name || detail.related_order.customer_name} ·{' '}
                {money(detail.related_order.total)}
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
      {paying &&
        (detail.payroll ? (
          <PayrollPayDialog detail={detail} open={paying} onOpenChange={setPaying} />
        ) : detail.tax_return ? (
          <TaxReturnPayDialog detail={detail} open={paying} onOpenChange={setPaying} />
        ) : (
          <PayDialog detail={detail} open={paying} onOpenChange={setPaying} />
        ))}
      {issuing && <IssueDialog detail={detail} open={issuing} onOpenChange={setIssuing} />}
      {finishing && <FinishDialog detail={detail} open={finishing} onOpenChange={setFinishing} />}
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

/** El crédito del cliente al lado del pedido: lo que Gerencia mira para autorizarlo. */
function CreditSection({ detail }: { detail: DocumentDetail }) {
  const so = detail.sales_order!
  const { doc } = detail
  const counts = !['BORRADOR', 'RECHAZADO', 'ANULADO'].includes(doc.status)
  const withOrder = so.credit_used + doc.total
  const over = so.credit_limit != null && withOrder > so.credit_limit + 1e-9
  return (
    <Section title="Crédito del cliente">
      <dl className="flex flex-col gap-1.5 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Límite</dt>
          <dd className="tabular">{so.credit_limit == null ? 'Sin límite' : money(so.credit_limit)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Usado por otros pedidos y deudas</dt>
          <dd className="tabular">{money(so.credit_used)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{counts ? 'Con este pedido' : 'Con este pedido (si se confirma)'}</dt>
          <dd className={cn('tabular font-semibold', over ? 'text-red-700' : 'text-navy')}>{money(withOrder)}</dd>
        </div>
      </dl>
      {/* Mientras espera a Gerencia, el motivo ya está en "¿Qué sigue?". */}
      {so.credit_reason && doc.status !== 'PENDIENTE_APROBACION' && (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          Necesitó la autorización de Gerencia. {so.credit_reason}
        </p>
      )}
    </Section>
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
  if (doc.doc_type === 'CUSTOMER_RECEIPT' && detail.receipt) {
    const { receipt, customer } = detail
    return (
      <dl className={grid}>
        <InfoRow label="Cliente">
          {customer && company.can('receivable.read') ? (
            <Link className="hover:underline" to={company.to(`ventas/clientes/${customer.code}`)}>
              {customer.legal_name}
            </Link>
          ) : (
            customer?.legal_name
          )}
        </InfoRow>
        <InfoRow label="CUIT (simulado)">
          {customer?.tax_id || 'Sin CUIT'} · {customer ? VAT_CONDITIONS[customer.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Ingresa en">
          {company.can('ledger.read') ? (
            <Link
              className="hover:underline"
              to={company.to(`contabilidad/mayor?cuenta=${receipt.treasury_account.id}`)}
            >
              {receipt.treasury_account.name}
            </Link>
          ) : (
            receipt.treasury_account.name
          )}{' '}
          <span className="font-mono text-xs text-muted-foreground">{receipt.treasury_account.code}</span>
        </InfoRow>
        <InfoRow label="Medio">
          {PAYMENT_METHODS[receipt.payment_method]}
          {receipt.reference ? ` N.º ${receipt.reference}` : ''}
        </InfoRow>
        <InfoRow label="Importe">{money(doc.total)}</InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Cobro">{receipt.received_on ? date(receipt.received_on) : 'Todavía no se cobró'}</InfoRow>
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
  if (doc.doc_type === 'SALES_ORDER' && detail.sales_order) {
    const so = detail.sales_order
    const customer = detail.customer
    return (
      <dl className={grid}>
        <InfoRow label="Cliente">{customer?.legal_name}</InfoRow>
        <InfoRow label="CUIT (simulado)">
          {customer?.tax_id || 'Sin CUIT'} · {customer ? VAT_CONDITIONS[customer.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Entrega pedida">{so.delivery_date ? date(so.delivery_date) : 'Sin fecha'}</InfoRow>
        <InfoRow label="Entrega desde">{warehouse?.name}</InfoRow>
        <InfoRow label="Condición de pago">
          {so.payment_terms_days ? `${so.payment_terms_days} días` : 'Contado'}
        </InfoRow>
        <InfoRow label="Referencia del cliente">{so.customer_reference || '—'}</InfoRow>
        {doc.reference_label && <InfoRow label="Presupuesto">{doc.reference_label}</InfoRow>}
        <InfoRow label="Vendió">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'TAX_RETURN' && detail.tax_return) {
    const tr = detail.tax_return
    return (
      <dl className={grid}>
        <InfoRow label="Declaración">{taxTitle(tr.tax, tr.period)}</InfoRow>
        <InfoRow label="Vence">{date(tr.due_date)}</InfoRow>
        <InfoRow label={tr.amount_due > 0 ? 'Saldo a pagar' : 'Saldo a favor'}>
          <span className="font-semibold">{money(tr.amount_due > 0 ? tr.amount_due : tr.balance_in_favor)}</span>
          {tr.amount_due > 0 && (
            <span className="text-xs text-muted-foreground">
              {tr.paid_on ? ` · pagado el ${date(tr.paid_on)} desde ${tr.paid_account?.name}` : ' · sin pagar'}
            </span>
          )}
          {tr.amount_due === 0 && <span className="text-xs text-muted-foreground"> · para el mes siguiente</span>}
        </InfoRow>
        <InfoRow label="Presentada">{tr.presented_at ? dateTime(tr.presented_at) : 'Todavía no'}</InfoRow>
        <InfoRow label="Preparó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'PAYROLL' && detail.payroll) {
    const py = detail.payroll
    return (
      <dl className={grid}>
        <InfoRow label="Mes liquidado">{periodLabel(py.period)}</InfoRow>
        <InfoRow label="Fecha de pago">{date(py.payment_date)}</InfoRow>
        <InfoRow label="Empleados">{py.lines.length}</InfoRow>
        <InfoRow label="Remunerativo">{money(py.gross)}</InfoRow>
        <InfoRow label="Aportes retenidos">{money(py.deductions)}</InfoRow>
        <InfoRow label="Netos a pagar">
          <span className="font-semibold">{money(py.net)}</span>
          <span className="text-xs text-muted-foreground">
            {py.salaries_paid_on
              ? ` · pagados el ${date(py.salaries_paid_on)} desde ${py.salaries_account?.name}`
              : ' · sin pagar'}
          </span>
        </InfoRow>
        <InfoRow label="Contribuciones de la empresa">{money(py.employer)}</InfoRow>
        <InfoRow label="Cargas sociales">
          {money(py.charges)}
          <span className="text-xs text-muted-foreground">
            {py.charges_paid_on
              ? ` · pagadas el ${date(py.charges_paid_on)} desde ${py.charges_account?.name}`
              : ` · aportes y contribuciones, vencen el ${date(py.charges_due)}`}
          </span>
        </InfoRow>
        <InfoRow label="Costo para la empresa">
          {money(py.cost)}
          <span className="text-xs text-muted-foreground">
            {' '}
            (taller, mano de obra directa: {money(py.direct_labor)})
          </span>
        </InfoRow>
        <InfoRow label="Liquidó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'PRODUCTION_ORDER' && detail.production_order) {
    const po = detail.production_order
    return (
      <dl className={grid}>
        <InfoRow label="Producto">
          <Link to={company.to(`productos/${po.product.code}`)} className="hover:underline">
            <span className="font-mono">{po.product.code}</span> {po.product.name}
          </Link>
        </InfoRow>
        <InfoRow label="Cantidad">
          {qty(po.quantity, po.product.uom_code)}
          {po.quantity_produced != null && ` · salieron bien ${qty(po.quantity_produced, po.product.uom_code)}`}
        </InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Prevista para">{po.due_date ? date(po.due_date) : 'Sin fecha'}</InfoRow>
        <InfoRow label="Materiales desde">{po.materials_warehouse.name}</InfoRow>
        <InfoRow label="El producto entra a">{po.output_warehouse.name}</InfoRow>
        <InfoRow label="Costo previsto">
          {money(po.planned_cost)}
          <span className="text-xs text-muted-foreground">
            {' '}
            (materiales {money(po.planned_material_cost)} y conversión {money(po.planned_conversion_cost)})
          </span>
        </InfoRow>
        <InfoRow label="Costo real">
          {po.labor_cost != null && po.overhead_cost != null ? (
            <>
              {money(po.material_cost + po.labor_cost + po.overhead_cost)}
              <span className="text-xs text-muted-foreground">
                {' '}
                (materiales {money(po.material_cost)}, mano de obra {money(po.labor_cost)} y carga fabril{' '}
                {money(po.overhead_cost)})
              </span>
            </>
          ) : po.issued_at ? (
            `Materiales entregados: ${money(po.material_cost)}`
          ) : (
            'Todavía no se entregaron los materiales'
          )}
        </InfoRow>
        {po.unit_cost != null && (
          <InfoRow label="Costo de cada unidad">
            {money(po.unit_cost)}
            <span className="text-xs text-muted-foreground">
              {' '}
              (estándar {money(po.standard_cost)}
              {po.standard_cost > 0 && `, ${percent((po.unit_cost / po.standard_cost - 1) * 100, true)}`})
            </span>
          </InfoRow>
        )}
        <InfoRow label="Planificó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'SALES_QUOTE' && detail.sales_quote) {
    const quote = detail.sales_quote
    const { customer } = detail
    return (
      <dl className={grid}>
        <InfoRow label="Cliente">{customer?.legal_name}</InfoRow>
        <InfoRow label="CUIT (simulado)">
          {customer?.tax_id || 'Sin CUIT'} · {customer ? VAT_CONDITIONS[customer.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Válido hasta">
          {date(quote.valid_until)}
          {quote.expired && <span className="text-red-700"> · vencido</span>}
        </InfoRow>
        <InfoRow label="Entrega desde">{warehouse?.name}</InfoRow>
        <InfoRow label="Condición de pago">
          {quote.payment_terms_days ? `${quote.payment_terms_days} días` : 'Contado'}
        </InfoRow>
        <InfoRow label="Referencia del cliente">{quote.customer_reference || '—'}</InfoRow>
        {quote.order && (
          <InfoRow label="Pedido de venta">
            <Link className="font-mono hover:underline" to={quote.order.path}>
              {quote.order.display_number}
            </Link>{' '}
            <DocStatus info={quote.order.status_info} />
          </InfoRow>
        )}
        <InfoRow label="Preparó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'SALES_INVOICE' && doc.fv) {
    const { customer } = detail
    return (
      <dl className={grid}>
        <InfoRow label="Cliente">
          {customer && company.can('receivable.read') ? (
            <Link className="hover:underline" to={company.to(`ventas/clientes/${customer.code}`)}>
              {customer.legal_name}
            </Link>
          ) : (
            customer?.legal_name
          )}
        </InfoRow>
        <InfoRow label="CUIT (simulado)">
          {customer?.tax_id || 'Sin CUIT'} · {customer ? VAT_CONDITIONS[customer.vat_condition] : ''}
        </InfoRow>
        <InfoRow label="Comprobante">
          Factura {doc.fv.letter} {doc.fv.point_of_sale}-
          {doc.fv.invoice_number || (
            <span className="text-muted-foreground">sin número (se asigna al registrarla)</span>
          )}
        </InfoRow>
        <InfoRow label="Fecha">{date(doc.document_date)}</InfoRow>
        <InfoRow label="Vencimiento">{date(doc.fv.due_date)}</InfoRow>
        <InfoRow label="Pedido de venta">
          {detail.related_order ? (
            <Link className="font-mono hover:underline" to={detail.related_order.path}>
              {detail.related_order.display_number}
            </Link>
          ) : (
            '—'
          )}
        </InfoRow>
        {doc.fv.letter === 'B' && <InfoRow label="IVA">Incluido en los precios: el cliente no lo discrimina</InfoRow>}
        <InfoRow label="Emitió">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
        {doc.notes && <InfoRow label="Observaciones">{doc.notes}</InfoRow>}
      </dl>
    )
  }
  if (doc.doc_type === 'DELIVERY_NOTE' && detail.delivery) {
    const { delivery, customer } = detail
    return (
      <dl className={grid}>
        <InfoRow label="Pedido de venta">
          {detail.related_order ? (
            <Link className="font-mono hover:underline" to={detail.related_order.path}>
              {detail.related_order.display_number}
            </Link>
          ) : (
            '—'
          )}
        </InfoRow>
        <InfoRow label="Cliente">{customer?.legal_name}</InfoRow>
        <InfoRow label="Entregar en">
          {customer ? `${customer.address_line}, ${customer.city} (${customer.province})` : '—'}
        </InfoRow>
        <InfoRow label="Transportista">{delivery.carrier_name || '—'}</InfoRow>
        <InfoRow label="Sale de">{warehouse?.name}</InfoRow>
        <InfoRow label="Despachado">
          {delivery.dispatched_at ? dateTime(delivery.dispatched_at) : 'Todavía no (en preparación)'}
        </InfoRow>
        {delivery.dispatched_at && company.can('ledger.read') && (
          <InfoRow label="Costo de lo vendido">{money(delivery.cost_total)}</InfoRow>
        )}
        <InfoRow label="Preparó">
          {doc.created_by_name} · {doc.sector_name}
        </InfoRow>
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

/** Las facturas que cancela una orden de pago o un recibo de cobro, y cuánto de cada una. */
function SettledInvoices({
  lines,
  total,
  amountLabel,
  totalLabel,
}: {
  lines: NonNullable<DocumentDetail['payment']>['lines']
  total: number
  amountLabel: string
  totalLabel: string
}) {
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
            <TableHead className={cn(head, 'text-right')}>{amountLabel}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
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
          <TotalRow label={totalLabel} value={total} span={4} strong />
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
  if (detail.payment)
    return (
      <SettledInvoices
        lines={detail.payment.lines}
        total={doc.total}
        amountLabel="Paga esta orden"
        totalLabel="Total de la orden"
      />
    )
  if (detail.receipt)
    return (
      <SettledInvoices
        lines={detail.receipt.lines}
        total={doc.total}
        amountLabel="Cobra este recibo"
        totalLabel="Total del recibo"
      />
    )
  if (detail.transfer) return <TransferLines transfer={detail.transfer} total={doc.total} />
  if (detail.reconciliation) return <ReconciliationLines view={detail.reconciliation} />
  const product = (l: (typeof lines)[number]) => (
    <Link to={company.to(`productos/${l.product.code}`)} className="hover:underline">
      <span className="font-mono text-xs font-semibold text-navy">{l.product.code}</span> {l.product.name}
    </Link>
  )
  const head = 'h-9 text-xs font-semibold text-slate-600'
  // Totales: cuántas columnas van antes del importe y cuántas quedan a su derecha (lo recibido en la OC; lo
  // entregado y lo facturado en el pedido de venta).
  const totals =
    doc.doc_type === 'PURCHASE_ORDER'
      ? { span: 6, trailing: 1 }
      : doc.doc_type === 'SUPPLIER_INVOICE' || doc.doc_type === 'SALES_INVOICE'
        ? { span: 6, trailing: 0 }
        : doc.doc_type === 'SALES_ORDER'
          ? { span: 5, trailing: 2 }
          : doc.doc_type === 'SALES_QUOTE'
            ? { span: 5, trailing: 0 }
            : null
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className={cn(head, 'w-10')}>#</TableHead>
            <TableHead className={head}>{doc.doc_type === 'PRODUCTION_ORDER' ? 'Material' : 'Producto'}</TableHead>
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
            {doc.doc_type === 'SALES_ORDER' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Cantidad</TableHead>
                <TableHead className={cn(head, 'text-right')}>Precio unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
                <TableHead className={cn(head, 'text-right')}>Subtotal</TableHead>
                <TableHead className={cn(head, 'text-right')}>Entregado</TableHead>
                <TableHead className={cn(head, 'text-right')}>Facturado</TableHead>
              </>
            )}
            {doc.doc_type === 'SALES_QUOTE' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Cantidad</TableHead>
                <TableHead className={cn(head, 'text-right')}>Precio unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
                <TableHead className={cn(head, 'text-right')}>Subtotal</TableHead>
              </>
            )}
            {doc.doc_type === 'SALES_INVOICE' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Entregado (PV)</TableHead>
                <TableHead className={cn(head, 'text-right')}>Facturado</TableHead>
                <TableHead className={cn(head, 'text-right')}>Precio unit.</TableHead>
                <TableHead className={cn(head, 'text-right')}>IVA</TableHead>
                <TableHead className={cn(head, 'text-right')}>Subtotal</TableHead>
              </>
            )}
            {doc.doc_type === 'PRODUCTION_ORDER' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Previsto</TableHead>
                <TableHead className={cn(head, 'text-right')}>Costo previsto</TableHead>
                <TableHead className={cn(head, 'text-right')}>Entregado</TableHead>
                <TableHead className={cn(head, 'text-right')}>Costo real</TableHead>
              </>
            )}
            {doc.doc_type === 'DELIVERY_NOTE' && (
              <>
                <TableHead className={cn(head, 'text-right')}>Pedido</TableHead>
                <TableHead className={cn(head, 'text-right')}>Sale en este remito</TableHead>
                <TableHead className={head}>Observaciones</TableHead>
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
                  <TableCell className="tabular text-right">{percent(l.vat_rate)}</TableCell>
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
                  <TableCell className="tabular text-right">{l.vat_rate ? percent(l.vat_rate) : '—'}</TableCell>
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
                    {doc.si?.letter === 'A' ? percent(l.vat_rate) : '—'}
                  </TableCell>
                  <TableCell className="tabular text-right">{money(l.line_subtotal)}</TableCell>
                </>
              )}
              {doc.doc_type === 'SALES_ORDER' && (
                <>
                  <TableCell className="tabular text-right">
                    {qty(l.quantity, l.product.uom_code)}
                    {doc.status === 'BORRADOR' && l.qty_available != null && (
                      <div
                        className={cn(
                          'text-xs',
                          l.qty_available < l.quantity ? 'font-medium text-red-700' : 'text-muted-foreground',
                        )}
                      >
                        Disponible: {qty(Math.max(l.qty_available, 0))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {money(l.unit_price)}
                    {!!l.list_price && (l.unit_price ?? 0) < l.list_price && (
                      <div className="text-xs text-amber-700">
                        Bonif. {percent((1 - (l.unit_price ?? 0) / l.list_price) * 100)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">{l.vat_rate ? percent(l.vat_rate) : '—'}</TableCell>
                  <TableCell className="tabular text-right">{money(l.line_subtotal)}</TableCell>
                  <TableCell
                    className={cn(
                      'tabular text-right',
                      (l.qty_delivered ?? 0) >= l.quantity
                        ? 'text-green-700'
                        : (l.qty_delivered ?? 0) > 0
                          ? 'text-amber-700'
                          : '',
                    )}
                  >
                    {qty(l.qty_delivered)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'tabular text-right',
                      (l.qty_invoiced ?? 0) >= (l.qty_delivered ?? 0) && (l.qty_invoiced ?? 0) > 0
                        ? 'text-green-700'
                        : (l.qty_delivered ?? 0) > (l.qty_invoiced ?? 0)
                          ? 'text-amber-700'
                          : '',
                    )}
                  >
                    {qty(l.qty_invoiced)}
                  </TableCell>
                </>
              )}
              {doc.doc_type === 'SALES_QUOTE' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.quantity, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right">
                    {money(l.unit_price)}
                    {!!l.list_price && (l.unit_price ?? 0) < l.list_price && (
                      <div className="text-xs text-amber-700">
                        Bonif. {percent((1 - (l.unit_price ?? 0) / l.list_price) * 100)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">{l.vat_rate ? percent(l.vat_rate) : '—'}</TableCell>
                  <TableCell className="tabular text-right">{money(l.line_subtotal)}</TableCell>
                </>
              )}
              {doc.doc_type === 'SALES_INVOICE' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.qty_delivered, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right font-semibold">
                    {qty(l.quantity, l.product.uom_code)}
                  </TableCell>
                  <TableCell className="tabular text-right">{money(l.unit_price)}</TableCell>
                  <TableCell className="tabular text-right">{l.vat_rate ? percent(l.vat_rate) : '—'}</TableCell>
                  <TableCell className="tabular text-right">{money(l.line_subtotal)}</TableCell>
                </>
              )}
              {doc.doc_type === 'PRODUCTION_ORDER' && (
                <>
                  <TableCell className="tabular text-right">
                    {qty(l.quantity, l.product.uom_code)}
                    {l.qty_available != null && (
                      <div
                        className={cn(
                          'text-xs',
                          l.qty_available < l.quantity ? 'font-medium text-red-700' : 'text-muted-foreground',
                        )}
                      >
                        Disponible: {qty(Math.max(l.qty_available, 0))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">{money(l.quantity * (l.planned_unit_cost ?? 0))}</TableCell>
                  <TableCell
                    className={cn(
                      'tabular text-right',
                      doc.pd?.issued_at && (l.qty_issued ?? 0) > l.quantity && 'text-amber-700',
                    )}
                  >
                    {doc.pd?.issued_at ? qty(l.qty_issued, l.product.uom_code) : '—'}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {doc.pd?.issued_at ? money((l.qty_issued ?? 0) * (l.unit_cost ?? 0)) : '—'}
                  </TableCell>
                </>
              )}
              {doc.doc_type === 'DELIVERY_NOTE' && (
                <>
                  <TableCell className="tabular text-right">{qty(l.qty_ordered_so, l.product.uom_code)}</TableCell>
                  <TableCell className="tabular text-right font-semibold">
                    {qty(l.quantity, l.product.uom_code)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{l.notes || '—'}</TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
        {totals && (
          <TableFooter>
            <TotalRow label="Subtotal neto" value={doc.subtotal} span={totals.span} trailing={totals.trailing} />
            <TotalRow label="IVA" value={doc.tax_total} span={totals.span} trailing={totals.trailing} />
            <TotalRow label="Total" value={doc.total} span={totals.span} strong trailing={totals.trailing} />
          </TableFooter>
        )}
        {doc.doc_type === 'SUPPLIER_QUOTE' && (
          <TableFooter>
            <TotalRow label="Subtotal neto (costo para la empresa)" value={doc.subtotal} span={5} />
            <TotalRow label="IVA" value={doc.tax_total} span={5} />
            <TotalRow label="Total" value={doc.total} span={5} strong />
          </TableFooter>
        )}
        {doc.doc_type === 'PRODUCTION_ORDER' && detail.production_order && (
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3} className="text-right text-sm font-semibold">
                Materiales
              </TableCell>
              <TableCell className="tabular text-right font-semibold">
                {money(detail.production_order.planned_material_cost)}
              </TableCell>
              <TableCell />
              <TableCell className="tabular text-right font-semibold">
                {detail.production_order.issued_at ? money(detail.production_order.material_cost) : '—'}
              </TableCell>
            </TableRow>
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
  /** Columnas que quedan a la derecha del importe (lo recibido, entregado o facturado). */
  trailing?: number
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
      {!!trailing && <TableCell colSpan={trailing} />}
    </TableRow>
  )
}
