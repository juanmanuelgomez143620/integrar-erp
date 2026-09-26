import { useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Loading } from '@/components/common/blocks'
import { api } from '@/lib/api'
import { ADJUSTMENT_REASONS, DOC_TYPES, PRIORITIES, VAT_CONDITIONS } from '@/lib/domain/catalog'
import { date, dateTime, money, qty } from '@/lib/format'
import { useCompany } from '@/app/company'

const LEGEND = 'DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL'

export function PrintPage() {
  const { docId = '' } = useParams()
  const company = useCompany()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['document-by-id', docId], queryFn: () => api.documentById(docId) })
  if (isLoading) return <Loading />
  if (!data) return <p className="p-10 text-center">Documento no encontrado.</p>
  const { doc, lines, supplier, warehouse } = data
  const c = company.company
  const info = DOC_TYPES[doc.doc_type]
  const th = 'border-b border-slate-300 px-2 py-1.5 text-left text-[11px] font-semibold uppercase text-slate-600'
  const td = 'border-b border-slate-200 px-2 py-1.5 align-top'

  return (
    <div className="min-h-svh bg-slate-200 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between gap-2 px-2">
        <Button variant="outline" onClick={() => navigate(-1)}><ArrowLeft /> Volver</Button>
        <span className="text-xs text-muted-foreground">Usá “Guardar como PDF” en el diálogo de impresión para exportarlo.</span>
        <Button onClick={() => window.print()}><Printer /> Imprimir / PDF</Button>
      </div>

      <article className="print-sheet text-[12px] text-slate-900 shadow-lg">
        <div className="print-watermark">SIMULACIÓN EDUCATIVA</div>
        <p className="mb-3 border border-slate-400 py-1 text-center text-[10px] font-bold tracking-wide">{LEGEND}</p>

        <header className="flex items-start justify-between gap-6 border-b-2 border-navy pb-3">
          <div>
            <div className="text-lg font-black text-navy">{c.legal_name}</div>
            <div className="text-slate-600">{c.address_line} · {c.city}, {c.province}</div>
            <div className="text-slate-600">CUIT {c.tax_id} (simulado) · {VAT_CONDITIONS[c.vat_condition]}</div>
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
              <div><b>Sector solicitante:</b> {doc.sector_name}</div>
              <div><b>Prioridad:</b> {PRIORITIES[doc.pr.priority]}</div>
              <div><b>Necesaria para:</b> {date(doc.pr.needed_by)}</div>
              <div><b>Solicitó:</b> {doc.created_by_name}</div>
              <div className="col-span-2"><b>Motivo:</b> {doc.pr.reason}</div>
            </>
          )}
          {doc.doc_type === 'PURCHASE_ORDER' && doc.po && (
            <>
              <div className="col-span-2 rounded border border-slate-300 p-2">
                <div className="text-[11px] font-semibold text-slate-600 uppercase">Proveedor</div>
                <div className="font-semibold">{supplier?.legal_name}</div>
                <div>CUIT {supplier?.tax_id} (simulado) · {supplier ? VAT_CONDITIONS[supplier.vat_condition] : ''} · {supplier?.city}</div>
              </div>
              <div><b>Entrega:</b> {date(doc.po.expected_date)} en {warehouse?.name}</div>
              <div><b>Condición de pago:</b> {doc.po.payment_terms_days ? `${doc.po.payment_terms_days} días` : 'Contado'}</div>
              <div className="col-span-2"><b>Condiciones de entrega:</b> {doc.po.delivery_terms || '—'}</div>
            </>
          )}
          {doc.doc_type === 'GOODS_RECEIPT' && doc.gr && (
            <>
              <div><b>Orden de compra:</b> {data.related_order?.display_number}</div>
              <div><b>Proveedor:</b> {supplier?.legal_name}</div>
              <div><b>Remito del proveedor:</b> {doc.gr.supplier_delivery_note}</div>
              <div><b>Transportista:</b> {doc.gr.carrier_name || '—'}</div>
              <div><b>Depósito:</b> {warehouse?.name}</div>
              <div><b>Ingreso al stock:</b> {dateTime(doc.gr.received_at)}</div>
            </>
          )}
          {doc.doc_type === 'STOCK_ADJUSTMENT' && doc.sa && (
            <>
              <div><b>Depósito:</b> {warehouse?.name}</div>
              <div><b>Motivo:</b> {ADJUSTMENT_REASONS[doc.sa.reason_code]}</div>
            </>
          )}
          {doc.notes && <div className="col-span-2"><b>Observaciones:</b> {doc.notes}</div>}
        </section>

        <table className="mt-4 w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>#</th>
              <th className={th}>Código</th>
              <th className={th}>Descripción</th>
              {doc.doc_type === 'GOODS_RECEIPT' && <th className={`${th} text-right`}>Ordenado</th>}
              <th className={`${th} text-right`}>{doc.doc_type === 'GOODS_RECEIPT' ? 'Recibido' : doc.doc_type === 'STOCK_ADJUSTMENT' ? 'Ajuste' : 'Cantidad'}</th>
              {doc.doc_type === 'PURCHASE_ORDER' && (
                <>
                  <th className={`${th} text-right`}>Precio unit.</th>
                  <th className={`${th} text-right`}>IVA</th>
                  <th className={`${th} text-right`}>Subtotal</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td className={td}>{l.line_no}</td>
                <td className={`${td} font-mono`}>{l.product.code}</td>
                <td className={td}>{l.product.name}</td>
                {doc.doc_type === 'GOODS_RECEIPT' && <td className={`${td} text-right`}>{qty(l.qty_ordered_po, l.product.uom_code)}</td>}
                <td className={`${td} text-right`}>{qty(l.quantity, l.product.uom_code)}</td>
                {doc.doc_type === 'PURCHASE_ORDER' && (
                  <>
                    <td className={`${td} text-right`}>{money(l.unit_price)}</td>
                    <td className={`${td} text-right`}>{String(l.vat_rate).replace('.', ',')} %</td>
                    <td className={`${td} text-right`}>{money(l.line_subtotal)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {doc.doc_type === 'PURCHASE_ORDER' && (
          <div className="mt-3 ml-auto w-64">
            <div className="flex justify-between"><span>Subtotal neto</span><span>{money(doc.subtotal)}</span></div>
            <div className="flex justify-between"><span>IVA</span><span>{money(doc.tax_total)}</span></div>
            <div className="mt-1 flex justify-between border-t-2 border-navy pt-1 text-sm font-bold"><span>TOTAL</span><span>{money(doc.total)}</span></div>
          </div>
        )}

        <section className="mt-12 grid grid-cols-2 gap-10">
          {data.signatures.map((s) => (
            <div key={s.label} className="text-center">
              <div className="h-10 text-[11px] text-slate-600">{s.name ? `${s.name} · ${s.sector}` : ''}<br />{s.at ? dateTime(s.at) : ''}</div>
              <div className="border-t border-slate-500 pt-1 text-[11px] font-semibold uppercase">{s.label}</div>
            </div>
          ))}
        </section>

        <footer className="absolute right-[15mm] bottom-[12mm] left-[15mm] border-t border-slate-300 pt-1.5 text-center text-[9px] text-slate-500">
          {LEGEND} · Generado por INTEGR-AR (familia GEST-AR) · Empresa y datos ficticios con fines exclusivamente educativos.
        </footer>
      </article>
    </div>
  )
}
