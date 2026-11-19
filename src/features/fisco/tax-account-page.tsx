import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Landmark } from 'lucide-react'
import { DataTable } from '@/components/common/data-table'
import { EmptyState, Loading, Mono, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { api, type TaxAccountRow } from '@/lib/api'
import { FISCO_DEFAULTS } from '@/lib/domain/catalog'
import type { Badge } from '@/lib/domain/types'
import { date, money } from '@/lib/format'
import { useCompany } from '@/app/company'
import { taxTitle } from '@/features/tax/tax-return'

/** Cómo está cada declaración para el fisco. */
const STATES: Record<TaxAccountRow['state'], { label: string; badge: Badge }> = {
  SIN_SALDO: { label: 'Sin saldo', badge: 'neutral' },
  A_VENCER: { label: 'A vencer', badge: 'info' },
  VENCIDA: { label: 'Vencida', badge: 'danger' },
  A_PAGAR: { label: 'A pagar', badge: 'warning' },
  EN_EL_BANCO: { label: 'Pago en el banco', badge: 'warning' },
  RECHAZADA: { label: 'Rechazada por el banco', badge: 'danger' },
  PAGADA: { label: 'Pagada', badge: 'success' },
}

/**
 * Fisco simulado → Cuenta corriente (Fase 8e.2): las declaraciones que el fisco aceptó, con lo declarado,
 * los intereses resarcitorios, lo que imputó (cuando el banco procesó el pago) y el saldo.
 */
export function TaxAccountPage() {
  const company = useCompany()
  const { data, error } = useQuery({
    queryKey: ['tax-account', company.companyId],
    queryFn: () => api.taxAccount(company.companyId),
  })
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Fisco simulado' }, { label: 'Cuenta corriente' }]}
        title="Cuenta corriente tributaria"
        description={`Lo que la empresa le debe al fisco simulado: cada declaración que aceptó, con su vencimiento, lo declarado, los intereses resarcitorios (${FISCO_DEFAULTS.interest_rate} % mensual simple por los días de atraso: los pagados o, si está vencida sin pagar, a hoy), lo que imputó y el saldo; después de cada declaración, su multa si se presentó fuera de término. El fisco imputa un pago cuando el Banco Aula procesa la orden.`}
      />
      {!data ? (
        <Loading error={error} />
      ) : data.rows.length ? (
        <Section
          title={
            data.balance > 0
              ? `Deuda con el fisco al ${date(data.date)}: ${money(data.balance)}`
              : 'Sin deuda con el fisco'
          }
          description={
            data.balance > 0
              ? 'Lo declarado y los intereses de lo que todavía no se imputó (incluye lo que está en el banco).'
              : `Al ${date(data.date)}, todas las declaraciones están pagadas o sin saldo.`
          }
          bodyClassName="p-0"
        >
          <DataTable<TaxAccountRow>
            rows={data.rows}
            rowKey={(r) => r.document.id}
            search={(r) => `${taxTitle(r.tax, r.period)} ${r.document.display_number} ${r.transaction_code ?? ''}`}
            columns={[
              {
                key: 'tax',
                header: 'Declaración',
                cell: (r) => (
                  <span className="whitespace-normal">
                    {r.kind === 'MULTA' && 'Multa: '}
                    {taxTitle(r.tax, r.period)}
                    <span className="block text-xs text-muted-foreground">
                      <Link className="underline" to={r.document.path}>
                        {r.document.display_number}
                      </Link>
                      {r.transaction_code && (
                        <>
                          {' · '}
                          <Mono>{r.transaction_code}</Mono>
                        </>
                      )}
                    </span>
                  </span>
                ),
              },
              { key: 'due', header: 'Vence', cell: (r) => date(r.due_date) },
              {
                key: 'declared',
                header: 'Declarado',
                align: 'right',
                cell: (r) =>
                  r.declared > 0 ? (
                    money(r.declared)
                  ) : (
                    <span className="text-muted-foreground">
                      {money(0)}
                      {r.balance_in_favor > 0 && (
                        <span className="block text-xs">a favor {money(r.balance_in_favor)}</span>
                      )}
                    </span>
                  ),
              },
              { key: 'interest', header: 'Intereses', align: 'right', cell: (r) => money(r.interest) },
              {
                key: 'paid',
                header: 'Imputado',
                align: 'right',
                cell: (r) => (
                  <span>
                    {money(r.paid)}
                    {r.imputed_on && (
                      <span className="block text-xs text-muted-foreground">
                        el {date(r.imputed_on)}
                        {r.bank_transaction && <> · {r.bank_transaction}</>}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'balance',
                header: 'Saldo',
                align: 'right',
                cell: (r) => <span className={r.balance > 0 ? 'font-semibold' : ''}>{money(r.balance)}</span>,
              },
              {
                key: 'state',
                header: 'Estado',
                cell: (r) => <StatusBadge label={STATES[r.state].label} badge={STATES[r.state].badge} />,
              },
            ]}
          />
        </Section>
      ) : (
        <EmptyState icon={Landmark} title="El fisco todavía no aceptó declaraciones">
          Las declaraciones aparecen acá cuando el fisco las acepta con su acuse.
        </EmptyState>
      )}
    </>
  )
}
