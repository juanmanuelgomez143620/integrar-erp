import { useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Loading } from '@/components/common/blocks'
import { api, type ComparisonQuote } from '@/lib/api'
import { ADJUSTMENT_REASONS, DOC_TYPES, JOURNAL_ORIGINS, PRIORITIES, VAT_CONDITIONS } from '@/lib/domain/catalog'
import { date, dateTime, money, qty } from '@/lib/format'
import { useCompany } from '@/app/company'

const LEGEND = 'DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL'

export function PrintPage() {
  const { docId = '' } = useParams()
  const company = useCompany()
  const navigate = useNavigate()
  const { data, isLoading, error } = useQuery({
    queryKey: ['document-by-id', docId],
    queryFn: () => api.documentById(docId),
  })
  if (isLoading || error) return <Loading error={error} />
  if (!data) return <p className="p-10 text-center">Documento no encontrado.</p>
  const { doc, lines, supplier, warehouse, journal, payment, rfq, quote } = data
  const c = company.company
  const info = DOC_TYPES[doc.doc_type]
  const priced =
    doc.doc_type === 'PURCHASE_ORDER' || doc.doc_type === 'SUPPLIER_INVOICE' || doc.doc_type === 'SUPPLIER_QUOTE'
  const th = 'border-b border-slate-300 px-2 py-1.5 text-left text-[11px] font-semibold uppercase text-slate-600'
  const td = 'border-b border-slate-200 px-2 py-1.5 align-top'

  return (
    <div className="min-h-svh bg-slate-200 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between gap-2 px-2">
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft /> Volver
        </Button>
        <span className="text-xs text-muted-foreground">
          Usá “Guardar como PDF” en el diálogo de impresión para exportarlo.
        </span>
        <Button onClick={() => window.print()}>
          <Printer /> Imprimir / PDF
        </Button>
      </div>

      <article className="print-sheet text-[12px] text-slate-900 shadow-lg">
        <div className="print-watermark">SIMULACIÓN EDUCATIVA</div>
        <p className="mb-3 border border-slate-400 py-1 text-center text-[10px] font-bold tracking-wide">{LEGEND}</p>

        <header className="flex items-start justify-between gap-6 border-b-2 border-navy pb-3">
          <div>
            <div className="text-lg font-black text-navy">{c.legal_name}</div>
            <div className="text-slate-600">
              {c.address_line} · {c.city}, {c.province}
            </div>
            <div className="text-slate-600">
              CUIT {c.tax_id} (simulado) · {VAT_CONDITIONS[c.vat_condition]}
            </div>
            <div className="text-slate-600">Inicio de actividades: {date(c.start_date)}</div>
          </div>
          <div className="min-w-56 rounded border-2 border-navy p-2 text-right">
            <div className="text-[11px] font-semibold text-slate-600 uppercase">{info.name}</div>
            <div className="font-mono text-xl font-bold text-navy">{doc.display_number}</div>
            <div>Fecha: {date(doc.document_date)}</div>
            <div className="text-[11px] text-slate-600">Estado: {doc.status_info.label}</div>
          </div>
        </header>

        <section className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1">
          {doc.doc_type === 'PURCHASE_REQUISITION' && doc.pr && (
            <>
              <div>
                <b>Sector solicitante:</b> {doc.sector_name}
              </div>
              <div>
                <b>Prioridad:</b> {PRIORITIES[doc.pr.priority]}
              </div>
              <div>
                <b>Necesaria para:</b> {date(doc.pr.needed_by)}
              </div>
              <div>
                <b>Solicitó:</b> {doc.created_by_name}
              </div>
              <div className="col-span-2">
                <b>Motivo:</b> {doc.pr.reason}
              </div>
            </>
          )}
          {doc.doc_type === 'PURCHASE_ORDER' && doc.po && (
            <>
              <div className="col-span-2 rounded border border-slate-300 p-2">
                <div className="text-[11px] font-semibold text-slate-600 uppercase">Proveedor</div>
                <div className="font-semibold">{supplier?.legal_name}</div>
                <div>
                  CUIT {supplier?.tax_id} (simulado) · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''} ·{' '}
                  {supplier?.city}
                </div>
              </div>
              <div>
                <b>Entrega:</b> {date(doc.po.expected_date)} en {warehouse?.name}
              </div>
              <div>
                <b>Condición de pago:</b> {doc.po.payment_terms_days ? `${doc.po.payment_terms_days} días` : 'Contado'}
              </div>
              <div className="col-span-2">
                <b>Condiciones de entrega:</b> {doc.po.delivery_terms || '—'}
              </div>
            </>
          )}
          {doc.doc_type === 'GOODS_RECEIPT' && doc.gr && (
            <>
              <div>
                <b>Orden de compra:</b> {data.related_order?.display_number}
              </div>
              <div>
                <b>Proveedor:</b> {supplier?.legal_name}
              </div>
              <div>
                <b>Remito del proveedor:</b> {doc.gr.supplier_delivery_note}
              </div>
              <div>
                <b>Transportista:</b> {doc.gr.carrier_name || '—'}
              </div>
              <div>
                <b>Depósito:</b> {warehouse?.name}
              </div>
              <div>
                <b>Ingreso al stock:</b> {dateTime(doc.gr.received_at)}
              </div>
            </>
          )}
          {doc.doc_type === 'SUPPLIER_INVOICE' && doc.si && (
            <>
              <div className="col-span-2 rounded border border-slate-300 p-2">
                <div className="text-[11px] font-semibold text-slate-600 uppercase">Proveedor</div>
                <div className="font-semibold">{supplier?.legal_name}</div>
                <div>
                  CUIT {supplier?.tax_id} (simulado) · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''}
                </div>
              </div>
              <div>
                <b>Comprobante del proveedor:</b> Factura {doc.si.letter} {doc.si.point_of_sale}-{doc.si.invoice_number}
              </div>
              <div>
                <b>Vencimiento:</b> {date(doc.si.due_date)}
              </div>
              <div>
                <b>Orden de compra:</b> {data.related_order?.display_number}
              </div>
            </>
          )}
          {payment && (
            <>
              <div className="col-span-2 rounded border border-slate-300 p-2">
                <div className="text-[11px] font-semibold text-slate-600 uppercase">Se paga a</div>
                <div className="font-semibold">{supplier?.legal_name}</div>
                <div>
                  CUIT {supplier?.tax_id} (simulado) · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''}
                </div>
              </div>
              <div>
                <b>Paga desde:</b> {payment.treasury_account.code} {payment.treasury_account.name}
              </div>
              <div>
                <b>Pago:</b>{' '}
                {payment.paid_on
                  ? `${date(payment.paid_on)}${payment.payment_reference ? ` · ${payment.payment_reference}` : ''}`
                  : 'pendiente'}
              </div>
            </>
          )}
          {rfq && (
            <>
              <div className="col-span-2">
                Pedimos cotización por los ítems siguientes, con su precio unitario, el plazo de entrega, la condición
                de pago y la validez de la oferta.
              </div>
              <div>
                <b>Responder hasta:</b> {date(rfq.response_due)}
              </div>
              <div>
                <b>Entrega en:</b> {warehouse?.name}
              </div>
              <div className="col-span-2">
                <b>Proveedores consultados:</b> {rfq.invited.map((i) => i.supplier.legal_name).join(', ')}
              </div>
              {doc.reference_label && (
                <div>
                  <b>Atiende:</b> {doc.reference_label}
                </div>
              )}
            </>
          )}
          {quote && (
            <>
              <div className="col-span-2 rounded border border-slate-300 p-2">
                <div className="text-[11px] font-semibold text-slate-600 uppercase">Cotiza</div>
                <div className="font-semibold">{supplier?.legal_name}</div>
                <div>
                  CUIT {supplier?.tax_id} (simulado) · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''}
                </div>
              </div>
              <div>
                <b>Responde a:</b> {quote.rfq.display_number}
              </div>
              <div>
                <b>Referencia del proveedor:</b> {quote.supplier_reference || '—'}
              </div>
              <div>
                <b>Válida hasta:</b> {date(quote.valid_until)}
              </div>
              <div>
                <b>Plazo de entrega:</b> {quote.delivery_days} días
              </div>
              <div>
                <b>Condición de pago:</b> {quote.payment_terms_days ? `${quote.payment_terms_days} días` : 'Contado'}
              </div>
            </>
          )}
          {doc.doc_type === 'STOCK_ADJUSTMENT' && doc.sa && (
            <>
              <div>
                <b>Depósito:</b> {warehouse?.name}
              </div>
              <div>
                <b>Motivo:</b> {ADJUSTMENT_REASONS[doc.sa.reason_code]}
              </div>
            </>
          )}
          {journal && (
            <>
              <div>
                <b>Asiento N.º:</b> {journal.entry_number ?? 'sin registrar (borrador)'}
              </div>
              <div>
                <b>Ejercicio:</b> {journal.fiscal_year_name ?? '—'}
              </div>
              <div>
                <b>Origen:</b> {JOURNAL_ORIGINS[journal.origin]}
              </div>
              {journal.reverses && (
                <div>
                  <b>Anula a:</b> {journal.reverses.display_number}
                </div>
              )}
              <div className="col-span-2">
                <b>Leyenda:</b> {journal.description}
              </div>
            </>
          )}
          {doc.notes && (
            <div className="col-span-2">
              <b>Observaciones:</b> {doc.notes}
            </div>
          )}
        </section>

        {journal && (
          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Código</th>
                <th className={th}>Cuenta</th>
                <th className={`${th} text-right`}>Debe</th>
                <th className={`${th} text-right`}>Haber</th>
              </tr>
            </thead>
            <tbody>
              {journal.lines.map((l) => (
                <tr key={l.id}>
                  <td className={`${td} font-mono`}>{l.account.code}</td>
                  <td className={`${td} ${l.credit > 0 ? 'pl-8' : ''}`}>
                    {l.credit > 0 ? 'a ' : ''}
                    {l.account.name}
                    {l.notes && <div className="text-[11px] text-slate-600">{l.notes}</div>}
                  </td>
                  <td className={`${td} text-right`}>{l.debit ? money(l.debit) : ''}</td>
                  <td className={`${td} text-right`}>{l.credit ? money(l.credit) : ''}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className={td} colSpan={2}>
                  Totales
                </td>
                <td className={`${td} text-right`}>{money(journal.total_debit)}</td>
                <td className={`${td} text-right`}>{money(journal.total_credit)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {payment && (
          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Factura</th>
                <th className={th}>Comprobante del proveedor</th>
                <th className={th}>Vence</th>
                <th className={`${th} text-right`}>Total de la factura</th>
                <th className={`${th} text-right`}>Se paga</th>
              </tr>
            </thead>
            <tbody>
              {payment.lines.map((l) => (
                <tr key={l.id}>
                  <td className={td}>{l.line_no}</td>
                  <td className={`${td} font-mono`}>{l.invoice.display_number}</td>
                  <td className={td}>Factura {l.invoice.invoice_label}</td>
                  <td className={td}>{date(l.invoice.due_date)}</td>
                  <td className={`${td} text-right`}>{money(l.invoice.total)}</td>
                  <td className={`${td} text-right`}>{money(l.amount)}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className={td} colSpan={5}>
                  TOTAL A PAGAR
                </td>
                <td className={`${td} text-right`}>{money(doc.total)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {!journal && !payment && (
          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Código</th>
                <th className={th}>Descripción</th>
                {doc.doc_type === 'GOODS_RECEIPT' && <th className={`${th} text-right`}>Ordenado</th>}
                <th className={`${th} text-right`}>
                  {doc.doc_type === 'GOODS_RECEIPT'
                    ? 'Recibido'
                    : doc.doc_type === 'STOCK_ADJUSTMENT'
                      ? 'Ajuste'
                      : 'Cantidad'}
                </th>
                {priced && (
                  <>
                    <th className={`${th} text-right`}>Precio unit.</th>
                    <th className={`${th} text-right`}>IVA</th>
                    <th className={`${th} text-right`}>Subtotal</th>
                  </>
                )}
                {rfq && <th className={th}>Especificación</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className={td}>{l.line_no}</td>
                  <td className={`${td} font-mono`}>{l.product.code}</td>
                  <td className={td}>{l.product.name}</td>
                  {doc.doc_type === 'GOODS_RECEIPT' && (
                    <td className={`${td} text-right`}>{qty(l.qty_ordered_po, l.product.uom_code)}</td>
                  )}
                  <td className={`${td} text-right`}>{qty(l.quantity, l.product.uom_code)}</td>
                  {priced && (
                    <>
                      <td className={`${td} text-right`}>{money(l.unit_price)}</td>
                      <td className={`${td} text-right`}>{String(l.vat_rate).replace('.', ',')} %</td>
                      <td className={`${td} text-right`}>{money(l.line_subtotal)}</td>
                    </>
                  )}
                  {rfq && <td className={td}>{l.notes || '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rfq && rfq.quotes.length > 0 && (
          <>
            <h2 className="mt-5 text-[11px] font-semibold text-slate-600 uppercase">
              Cuadro comparativo (costo para la empresa: neto sin IVA)
            </h2>
            <table className="mt-1 w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>Ítem</th>
                  {rfq.quotes.map((q) => (
                    <th key={q.id} className={`${th.replace(' uppercase', '')} text-right`}>
                      {q.supplier.legal_name}
                      <div className="font-mono font-normal">
                        {q.display_number}
                        {q.id === rfq.awarded_quote_id ? ' · ADJUDICADA' : ''}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.id}>
                    <td className={td}>
                      {l.product.code} · {qty(l.quantity, l.product.uom_code)}
                    </td>
                    {rfq.quotes.map((q) => {
                      const p = q.prices[i]
                      return (
                        <td key={q.id} className={`${td} text-right ${p?.lowest ? 'font-bold' : ''}`}>
                          {p ? `${money(p.unit_price)}${p.lowest ? ' (más bajo)' : ''}` : 'no cotiza'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {(
                  [
                    ['Costo (neto)', (q) => money(q.subtotal)],
                    ['Total con IVA', (q) => money(q.total)],
                    ['Plazo de entrega', (q) => `${q.delivery_days} días`],
                    ['Condición de pago', (q) => (q.payment_terms_days ? `${q.payment_terms_days} días` : 'Contado')],
                    ['Válida hasta', (q) => date(q.valid_until)],
                  ] as [string, (q: ComparisonQuote) => string][]
                ).map(([label, value]) => (
                  <tr key={label}>
                    <td className={`${td} font-semibold`}>{label}</td>
                    {rfq.quotes.map((q) => (
                      <td key={q.id} className={`${td} text-right`}>
                        {value(q)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rfq.award_reason && (
              <p className="mt-2">
                <b>Justificación de la adjudicación:</b> {rfq.award_reason}
              </p>
            )}
          </>
        )}

        {priced && (
          <div className="mt-3 ml-auto w-64">
            <div className="flex justify-between">
              <span>Subtotal neto</span>
              <span>{money(doc.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>IVA</span>
              <span>{money(doc.tax_total)}</span>
            </div>
            <div className="mt-1 flex justify-between border-t-2 border-navy pt-1 text-sm font-bold">
              <span>TOTAL</span>
              <span>{money(doc.total)}</span>
            </div>
          </div>
        )}

        <section className={`mt-12 grid gap-10 ${data.signatures.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {data.signatures.map((s) => (
            <div key={s.label} className="text-center">
              <div className="h-10 text-[11px] text-slate-600">
                {s.name ? `${s.name} · ${s.sector}` : ''}
                <br />
                {s.at ? dateTime(s.at) : ''}
              </div>
              <div className="border-t border-slate-500 pt-1 text-[11px] font-semibold uppercase">{s.label}</div>
            </div>
          ))}
        </section>

        <footer className="absolute right-[15mm] bottom-[12mm] left-[15mm] border-t border-slate-300 pt-1.5 text-center text-[9px] text-slate-500">
          {LEGEND} · Generado por INTEGR-AR (familia GEST-AR) · Empresa y datos ficticios con fines exclusivamente
          educativos.
        </footer>
      </article>
    </div>
  )
}
