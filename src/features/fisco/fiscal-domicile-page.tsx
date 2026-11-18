import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Field, Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, commands, type FiscalNoticeCandidateRow, type FiscalNoticeRow } from '@/lib/api'
import { DOC_STATUSES, FISCAL_NOTICE_KINDS, FISCAL_NOTICE_STATUSES, FISCO_DEFAULTS } from '@/lib/domain/catalog'
import { date, money } from '@/lib/format'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { taxTitle } from '@/features/tax/tax-return'

/** Quien opera el fisco intima un vencimiento, con observaciones opcionales que se suman al texto. */
function IssueDialog({ candidate, onClose }: { candidate: FiscalNoticeCandidateRow; onClose: () => void }) {
  const company = useCompany()
  const [note, setNote] = useState('')
  const issue = useCommand(
    () =>
      commands.issueFiscalNotice(company.companyId, {
        kind: candidate.kind,
        tax: candidate.tax,
        period: candidate.period,
        note,
      }),
    {
      success: (r) => `Intimación N.º ${r.number} enviada al domicilio fiscal electrónico de la empresa.`,
      onSuccess: onClose,
    },
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{FISCAL_NOTICE_KINDS[candidate.kind].subject}</DialogTitle>
          <DialogDescription>
            {taxTitle(candidate.tax, candidate.period)}, que vencía el {date(candidate.due_date)}. El fisco le da a la
            empresa {FISCO_DEFAULTS.notice_days} días para cumplir o responder; Impuestos y Gerencia reciben el aviso.
          </DialogDescription>
        </DialogHeader>
        <Field label="Observaciones del fisco" hint="Opcional: se suman al texto de la intimación.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={3} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={issue.isPending}>
            Volver
          </Button>
          <Button disabled={issue.isPending} onClick={() => issue.mutate([])}>
            Intimar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Impuestos responde la intimación con su descargo. */
function RespondDialog({ notice, onClose }: { notice: FiscalNoticeRow; onClose: () => void }) {
  const company = useCompany()
  const [response, setResponse] = useState('')
  const respond = useCommand(() => commands.respondFiscalNotice(company.companyId, notice.id, response), {
    success: `Descargo enviado al fisco (intimación N.º ${notice.number}).`,
    onSuccess: onClose,
  })
  const length = response.trim().length
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Responder la intimación N.º {notice.number}</DialogTitle>
          <DialogDescription>
            El descargo explica por qué no se cumplió o qué se va a hacer. La intimación se cumple sola al presentar o
            pagar la declaración; si no, el fisco evalúa el descargo.
          </DialogDescription>
        </DialogHeader>
        <Field label="Descargo" required hint="De 10 a 1.000 caracteres.">
          <Textarea value={response} onChange={(e) => setResponse(e.target.value)} maxLength={1000} rows={5} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={respond.isPending}>
            Volver
          </Button>
          <Button disabled={respond.isPending || length < 10} onClick={() => respond.mutate([])}>
            Enviar el descargo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Quien opera el fisco acepta el descargo y da la intimación por cumplida. */
function CloseDialog({ notice, onClose }: { notice: FiscalNoticeRow; onClose: () => void }) {
  const company = useCompany()
  const [comment, setComment] = useState('')
  const close = useCommand(() => commands.closeFiscalNotice(company.companyId, notice.id, comment), {
    success: `Intimación N.º ${notice.number} cumplida.`,
    onSuccess: onClose,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Aceptar el descargo de la intimación N.º {notice.number}</DialogTitle>
          <DialogDescription>Como fisco: la intimación queda cumplida.</DialogDescription>
        </DialogHeader>
        <Field label="Comentario del fisco" hint="Opcional.">
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={300} rows={2} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={close.isPending}>
            Volver
          </Button>
          <Button disabled={close.isPending} onClick={() => close.mutate([])}>
            Dar por cumplida
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Una intimación: el texto del fisco, el descargo de la empresa y cómo se cumplió. */
function NoticeCard({
  notice,
  onRespond,
  onClose,
}: {
  notice: FiscalNoticeRow
  onRespond: () => void
  onClose: () => void
}) {
  const status = notice.overdue ? { label: 'Vencida', badge: 'danger' as const } : FISCAL_NOTICE_STATUSES[notice.status]
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-navy">
            N.º {notice.number} · {notice.subject}
          </div>
          <div className="text-xs text-muted-foreground">
            Del {date(notice.issued_on)} · {taxTitle(notice.tax, notice.period)}
            {notice.document && (
              <>
                {' · '}
                <Link className="underline" to={notice.document.path}>
                  {notice.document.display_number}
                </Link>
              </>
            )}
            {notice.status === 'PENDIENTE' && <> · Cumplir o responder hasta el {date(notice.response_due)}</>}
            {notice.issued_by_name && <> · Intimó {notice.issued_by_name}</>}
          </div>
        </div>
        <StatusBadge label={status.label} badge={status.badge} />
      </div>
      <p className="mt-3 text-sm">{notice.body}</p>
      {notice.response && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm">
          <div className="text-xs text-muted-foreground">
            Descargo de {notice.responded_by_name}, el {date(notice.responded_on)}
          </div>
          <p className="mt-1 whitespace-pre-line">{notice.response}</p>
        </div>
      )}
      {notice.status === 'CUMPLIDA' && (
        <p className="mt-3 text-xs text-muted-foreground">
          Cumplida el {date(notice.closed_on)}:{' '}
          {notice.closed_by_name
            ? `el fisco (${notice.closed_by_name}) aceptó el descargo${notice.close_note ? `: «${notice.close_note}»` : '.'}`
            : notice.response
              ? 'el fisco aceptó el descargo o se cumplió la obligación.'
              : 'se cumplió la obligación.'}
        </p>
      )}
      {(notice.can_respond || notice.can_close || notice.sod_reason) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {notice.can_respond && (
            <Button size="sm" onClick={onRespond}>
              Responder
            </Button>
          )}
          {notice.can_close && (
            <Button size="sm" onClick={onClose}>
              Aceptar el descargo (fisco)
            </Button>
          )}
          {notice.sod_reason && <span className="text-xs text-muted-foreground">{notice.sod_reason}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Fisco simulado → Domicilio fiscal electrónico (Fase 8f.1): las intimaciones del fisco a la empresa y,
 * para quien opera el fisco, los vencimientos sin intimar.
 */
export function FiscalDomicilePage() {
  const company = useCompany()
  const operates = company.can('fisco.operate')
  const notices = useQuery({
    queryKey: ['fiscal-notices', company.companyId],
    queryFn: () => api.fiscalNotices(company.companyId),
  })
  const candidates = useQuery({
    queryKey: ['fiscal-notices-to-issue', company.companyId],
    queryFn: () => api.fiscalNoticesToIssue(company.companyId),
    enabled: operates,
  })
  const [issuing, setIssuing] = useState<FiscalNoticeCandidateRow | null>(null)
  const [responding, setResponding] = useState<FiscalNoticeRow | null>(null)
  const [closing, setClosing] = useState<FiscalNoticeRow | null>(null)
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'Fisco simulado' },
          { label: 'Domicilio fiscal electrónico' },
        ]}
        title="Domicilio fiscal electrónico"
        description={`Las comunicaciones del fisco simulado a la empresa: intimaciones por falta de presentación, por falta de pago o por diferencias del control cruzado, con ${FISCO_DEFAULTS.notice_days} días para cumplir o responder. Se cumplen solas al presentar o pagar la declaración; si no, Impuestos responde con un descargo que evalúa el fisco.`}
      />
      {operates && (
        <Section
          title="Vencimientos para intimar (fisco)"
          description="Lo que el fisco puede intimar hoy: las obligaciones vencidas desde el alta de la empresa sin declaración aceptada o sin el pago imputado, y las declaraciones aceptadas con diferencias. La app no tiene un reloj: el control lo hace quien opera el fisco."
          bodyClassName="p-0"
          className="mb-4"
        >
          {!candidates.data ? (
            <Loading error={candidates.error} />
          ) : candidates.data.length ? (
            <DataTable<FiscalNoticeCandidateRow>
              rows={candidates.data}
              rowKey={(r) => `${r.kind}-${r.tax}-${r.period}`}
              columns={[
                {
                  key: 'obligation',
                  header: 'Obligación',
                  cell: (r) => (
                    <span className="whitespace-normal">
                      {taxTitle(r.tax, r.period)}
                      {r.document && (
                        <span className="block text-xs text-muted-foreground">
                          <Link className="underline" to={r.document.path}>
                            {r.document.display_number}
                          </Link>{' '}
                          · {DOC_STATUSES.TAX_RETURN[r.document.status]?.label ?? r.document.status}
                        </span>
                      )}
                    </span>
                  ),
                },
                { key: 'kind', header: 'Qué se intima', cell: (r) => FISCAL_NOTICE_KINDS[r.kind].label },
                { key: 'due', header: 'Vencía', cell: (r) => date(r.due_date) },
                {
                  key: 'amount',
                  header: 'Importe',
                  align: 'right',
                  cell: (r) => (r.amount === null ? '—' : money(r.amount)),
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  cell: (r) => (
                    <Button size="sm" variant="outline" onClick={() => setIssuing(r)}>
                      Intimar
                    </Button>
                  ),
                },
              ]}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No hay vencimientos para intimar.</p>
          )}
        </Section>
      )}
      {!notices.data ? (
        <Loading error={notices.error} />
      ) : notices.data.length ? (
        <div className="grid gap-3">
          {notices.data.map((n) => (
            <NoticeCard key={n.id} notice={n} onRespond={() => setResponding(n)} onClose={() => setClosing(n)} />
          ))}
        </div>
      ) : (
        <EmptyState icon={Mail} title="El fisco no intimó a la empresa">
          Las intimaciones aparecen acá: por falta de presentación, por falta de pago o por diferencias del control
          cruzado.
        </EmptyState>
      )}
      {issuing && <IssueDialog candidate={issuing} onClose={() => setIssuing(null)} />}
      {responding && <RespondDialog notice={responding} onClose={() => setResponding(null)} />}
      {closing && <CloseDialog notice={closing} onClose={() => setClosing(null)} />}
    </>
  )
}
