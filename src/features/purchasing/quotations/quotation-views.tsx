import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Scale } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Section } from '@/components/common/blocks'
import { DocStatus, StatusBadge } from '@/components/common/status-badge'
import { commands, type ComparisonQuote, type DocumentDetail } from '@/lib/api'
import { date, money, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

/** Justificación mínima cuando no se elige la más conveniente por precio (igual que el motor). */
const MIN_REASON = 10

const terms = (days: number) => (days ? `${days} días` : 'Contado')

/** Marcas de una cotización en el cuadro: la elegida, la más conveniente o vencida. */
function QuoteTags({ quote, best }: { quote: ComparisonQuote; best: boolean }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {quote.status !== 'RECIBIDA' && <DocStatus info={quote.status_info} />}
      {best && <StatusBadge label="Más conveniente por precio" badge="success" />}
      {quote.expired && <StatusBadge label="Vencida" badge="danger" />}
      {!quote.complete && <StatusBadge label="No cotiza todo" badge="warning" />}
    </div>
  )
}

/**
 * Cuadro comparativo: una columna por cotización y una fila por ítem, con el
 * precio más bajo de cada fila marcado, y abajo lo que se compara de cada oferta.
 */
export function ComparisonSection({ detail }: { detail: DocumentDetail }) {
  const rfq = detail.rfq!
  const head = 'h-9 text-xs font-semibold text-slate-600'
  const missing = rfq.invited.filter((i) => !i.quote)
  const footer: [string, (q: ComparisonQuote) => string, boolean?][] = [
    ['Costo para la empresa (neto)', (q) => money(q.subtotal), true],
    ['IVA', (q) => money(q.tax_total)],
    ['Total con IVA', (q) => money(q.total)],
    ['Ítems cotizados', (q) => `${q.quoted_lines} de ${detail.lines.length}`],
    ['Plazo de entrega', (q) => `${q.delivery_days} días`],
    ['Condición de pago', (q) => terms(q.payment_terms_days)],
    ['Válida hasta', (q) => date(q.valid_until)],
  ]
  return (
    <Section
      title="Cuadro comparativo"
      description="Se compara el costo para la empresa: el neto sin IVA, porque el IVA de un responsable inscripto es crédito fiscal; quien no discrimina IVA cotiza su precio final."
      bodyClassName="p-0"
    >
      {rfq.quotes.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Todavía no hay cotizaciones cargadas. Cuando responda cada proveedor, cargá su cotización desde "Cargar
          cotización".
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className={cn(head, 'min-w-48')}>Ítem</TableHead>
                {rfq.quotes.map((q) => (
                  <TableHead
                    key={q.id}
                    className={cn(
                      head,
                      'h-auto min-w-40 py-2 align-top whitespace-normal',
                      q.id === rfq.awarded_quote_id && 'bg-green-50',
                    )}
                  >
                    <div className="font-semibold text-navy">{q.supplier.legal_name}</div>
                    <Link to={q.path} className="font-mono text-xs font-normal hover:underline">
                      {q.display_number}
                    </Link>
                    <QuoteTags quote={q} best={q.id === rfq.best_quote_id} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lines.map((l, i) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm whitespace-normal">
                    <span className="font-mono text-xs font-semibold text-navy">{l.product.code}</span> {l.product.name}
                    <div className="text-xs text-muted-foreground">{qty(l.quantity, l.product.uom_code)}</div>
                  </TableCell>
                  {rfq.quotes.map((q) => {
                    const p = q.prices[i]
                    return (
                      <TableCell
                        key={q.id}
                        className={cn('tabular text-right', q.id === rfq.awarded_quote_id && 'bg-green-50/60')}
                      >
                        {p ? (
                          <>
                            <div className={cn(p.lowest && 'font-semibold text-green-800')}>{money(p.unit_price)}</div>
                            <div className="text-xs text-muted-foreground">{money(p.line_subtotal)}</div>
                            {p.lowest && <div className="text-[11px] font-medium text-green-800">Precio más bajo</div>}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">No cotiza</span>
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              {footer.map(([label, value, strong]) => (
                <TableRow key={label}>
                  <TableCell className={cn('text-sm', strong ? 'font-semibold text-navy' : 'text-muted-foreground')}>
                    {label}
                  </TableCell>
                  {rfq.quotes.map((q) => (
                    <TableCell
                      key={q.id}
                      className={cn(
                        'tabular text-right text-sm',
                        strong && 'font-semibold text-navy',
                        q.id === rfq.awarded_quote_id && 'bg-green-50/60',
                      )}
                    >
                      {value(q)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableFooter>
          </Table>
        </div>
      )}
      {(missing.length > 0 || rfq.award_reason) && (
        <div className="flex flex-col gap-2 border-t px-4 py-3 text-sm">
          {missing.length > 0 && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Sin respuesta:</span>{' '}
              {missing.map((i) => i.supplier.legal_name).join(', ')}.
            </p>
          )}
          {rfq.award_reason && (
            <p>
              <span className="font-medium">Por qué se adjudicó así:</span> {rfq.award_reason}
            </p>
          )}
        </div>
      )}
    </Section>
  )
}

/** Elegir la cotización: si no es la más conveniente por precio, se justifica. */
export function AwardDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: DocumentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const company = useCompany()
  const navigate = useNavigate()
  const rfq = detail.rfq!
  const candidates = rfq.quotes.filter((q) => q.status === 'RECIBIDA')
  const [selected, setSelected] = useState(rfq.best_quote_id ?? candidates.find((q) => !q.expired)?.id ?? '')
  const [reason, setReason] = useState('')
  const needsReason = !!selected && selected !== rfq.best_quote_id
  const award = useCommand(() => commands.awardRfq(detail.doc.id, selected, reason.trim()), {
    success: (order) => `Se generó ${order.display_number} en borrador: revisala y enviala a aprobación.`,
    onSuccess: (order) => {
      onOpenChange(false)
      navigate(company.docPath('PURCHASE_ORDER', order.display_number))
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Adjudicar {detail.doc.display_number}</DialogTitle>
          <DialogDescription>
            Se genera la orden de compra en borrador con los precios y las condiciones de la cotización elegida; las
            demás quedan descartadas.
          </DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label="Cotización elegida"
          className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto"
        >
          {candidates.map((q) => (
            <button
              key={q.id}
              type="button"
              role="radio"
              aria-checked={selected === q.id}
              disabled={q.expired}
              onClick={() => setSelected(q.id)}
              className={cn(
                'rounded-lg border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                selected === q.id ? 'border-brand-blue bg-brand-blue-soft/60' : 'hover:border-brand-blue/40',
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-navy">{q.supplier.legal_name}</span>
                <span className="tabular font-semibold">{money(q.subtotal)}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {q.display_number} · entrega en {q.delivery_days} días · {terms(q.payment_terms_days).toLowerCase()} ·
                válida hasta {date(q.valid_until)}
              </div>
              <QuoteTags quote={q} best={q.id === rfq.best_quote_id} />
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="award-reason" className="text-xs font-medium text-slate-700">
            Justificación
            {needsReason && <span className="text-red-600"> *</span>}
          </label>
          <Textarea
            id="award-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder={
              needsReason
                ? 'No es la más conveniente por precio: explicá por qué la elegís (plazo de entrega, condición de pago…).'
                : 'Opcional'
            }
          />
          {needsReason && (
            <p className="text-xs text-muted-foreground">
              Al menos {MIN_REASON} caracteres. Queda en la solicitud y Gerencia la ve al aprobar la orden de compra.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={award.isPending}>
            Volver
          </Button>
          <Button
            disabled={award.isPending || !selected || (needsReason && reason.trim().length < MIN_REASON)}
            onClick={() => award.mutate([])}
          >
            <Scale /> {award.isPending ? 'Procesando…' : 'Adjudicar y generar la OC'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
