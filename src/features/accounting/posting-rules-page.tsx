import { useQuery } from '@tanstack/react-query'
import { Loading, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { api, commands, type PostingRuleRow } from '@/lib/api'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { AccountSelect, useAccounts } from './shared'

/** A qué cuenta va cada importe de los asientos que el sistema genera solo. */
export function PostingRulesPage() {
  const company = useCompany()
  const accounts = useAccounts()
  const { data, isLoading, error } = useQuery({
    queryKey: ['posting-rules', company.companyId],
    queryFn: () => api.postingRules(company.companyId),
  })
  const canEdit = company.can('posting_rule.update')
  const save = useCommand(
    (rule: PostingRuleRow, accountId: string) => commands.savePostingRule(company.companyId, rule.id, accountId),
    { success: 'Imputación actualizada.' },
  )
  if (isLoading || !data || !accounts.data) return <Loading error={error ?? accounts.error} />
  const events = [...new Set(data.map((r) => r.event))]
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Contabilidad' }, { label: 'Imputación automática' }]}
        title="Imputación automática"
        description="Algunas operaciones generan su asiento solas (por ejemplo, registrar la factura de un proveedor). Acá se define a qué cuenta va cada importe. Los asientos ya registrados no cambian."
      />
      <div className="flex flex-col gap-4">
        {events.map((event) => (
          <Section
            key={event}
            title={data.find((r) => r.event === event)!.event_label}
            bodyClassName="flex flex-col gap-3"
          >
            {data
              .filter((r) => r.event === event)
              .map((r) => (
                <div key={r.id} className="grid items-center gap-2 sm:grid-cols-[1fr_minmax(0,22rem)]">
                  <div className="text-sm">{r.key_label}</div>
                  {canEdit ? (
                    <AccountSelect
                      accounts={accounts.data}
                      value={r.account.id}
                      onChange={(id) => id !== r.account.id && save.mutate([r, id])}
                      aria-label={`Cuenta para ${r.key_label}`}
                    />
                  ) : (
                    <div className="text-sm">
                      <span className="font-mono text-xs text-muted-foreground">{r.account.code}</span> {r.account.name}
                    </div>
                  )}
                </div>
              ))}
          </Section>
        ))}
      </div>
    </>
  )
}
