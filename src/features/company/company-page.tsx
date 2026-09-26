import { InfoRow, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { MODULES, ROLES, VAT_CONDITIONS } from '@/lib/domain/catalog'
import { date, money } from '@/lib/format'
import { useCompany } from '@/app/company'
import { useMe } from '@/app/session'

export function CompanyPage() {
  const company = useCompany()
  const { data: me } = useMe()
  const c = company.company
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Inicio', to: company.to() }, { label: 'Empresa' }]}
        title={c.legal_name}
        description="Datos de la empresa simulada, su estructura organizativa y sus reglas de control interno. Todos los datos son ficticios."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Datos generales">
          <dl>
            <InfoRow label="Razón social">{c.legal_name}</InfoRow>
            <InfoRow label="Nombre comercial">{c.trade_name}</InfoRow>
            <InfoRow label="CUIT (simulado)">{c.tax_id}</InfoRow>
            <InfoRow label="Condición IVA">{VAT_CONDITIONS[c.vat_condition]}</InfoRow>
            <InfoRow label="Actividad">{c.activity}</InfoRow>
            <InfoRow label="Domicilio">{c.address_line}, {c.city}, {c.province}</InfoRow>
            <InfoRow label="Inicio de actividades">{date(c.start_date)}</InfoRow>
            <InfoRow label="Curso">{company.course ? `${company.course.name} ${company.course.academic_year} · ${company.course.orientation}` : '—'}</InfoRow>
            <InfoRow label="Escuela">{me?.school.official_name}</InfoRow>
          </dl>
        </Section>
        <Section title="Control interno">
          <dl>
            <InfoRow label="Separación de funciones">
              <StatusBadge label={c.settings.sod_enabled ? 'Activada' : 'Desactivada'} badge={c.settings.sod_enabled ? 'success' : 'warning'} />
            </InfoRow>
            <InfoRow label="Stock negativo">
              <StatusBadge label={c.settings.allow_negative_stock ? 'Permitido' : 'No permitido'} badge={c.settings.allow_negative_stock ? 'warning' : 'success'} />
            </InfoRow>
          </dl>
          <h3 className="mt-4 mb-2 text-xs font-semibold text-slate-600 uppercase">Reglas de aprobación de órdenes de compra</h3>
          <ul className="flex flex-col gap-2 text-sm">
            {company.approval_rules.map((r) => (
              <li key={r.id} className="rounded-lg bg-muted/60 px-3 py-2">
                <div className="font-medium">
                  {r.max_amount == null ? `Más de ${money(r.min_amount - 0.01)}` : `Hasta ${money(r.max_amount)}`} → {ROLES[r.approver_role].name}
                </div>
                <div className="text-xs text-muted-foreground">{r.description}</div>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 mb-2 text-xs font-semibold text-slate-600 uppercase">Módulos</h3>
          <div className="flex flex-wrap gap-1.5">
            {company.modules.map((m) => (
              <StatusBadge key={m.module_code} label={`${MODULES[m.module_code].name}: ${m.is_enabled ? 'habilitado' : 'bloqueado'}`} badge={m.is_enabled ? 'success' : 'neutral'} />
            ))}
          </div>
        </Section>
        <Section title="Organización por islas" className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[...company.islands].sort((a, b) => a.number - b.number).map((i) => (
              <div key={i.id} className="rounded-lg border p-3">
                <div className="text-xs font-semibold text-brand-blue">ISLA {i.number}</div>
                <div className="text-sm font-medium">{i.name}</div>
                <ul className="mt-1 text-xs text-muted-foreground">
                  {company.sectors.filter((s) => s.island_id === i.id).map((s) => <li key={s.id}>{s.code} · {s.name}</li>)}
                </ul>
              </div>
            ))}
          </div>
          <h3 className="mt-4 mb-2 text-xs font-semibold text-slate-600 uppercase">Depósitos</h3>
          <ul className="flex flex-wrap gap-2 text-sm">
            {company.warehouses.map((w) => <li key={w.id} className="rounded-lg border px-3 py-1.5"><span className="font-mono text-xs font-semibold">{w.code}</span> {w.name}</li>)}
          </ul>
        </Section>
      </div>
    </>
  )
}
