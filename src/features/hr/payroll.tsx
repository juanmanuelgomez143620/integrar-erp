import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, Section } from '@/components/common/blocks'
import { PageHeader } from '@/components/common/page-header'
import { commands, type DocumentDetail, type PayrollLineView, type PayrollView } from '@/lib/api'
import { PAYROLL_DEFAULT_RATES } from '@/lib/domain/catalog'
import { money, qty, todayAR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'

const head = 'h-9 text-xs font-semibold text-slate-600'

const rateFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 })

/** Un porcentaje de la liquidación, con hasta 2 decimales: "8,33 %". */
export const rate = (value: number) => `${rateFmt.format(value)} %`

/** "05/2027": el mes liquidado. */
export const periodLabel = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`

/** Los porcentajes legales con que se calculó la liquidación, en una línea; los adicionales son de cada convenio. */
export function RatesLine({ rates }: { rates: PayrollView['rates'] }) {
  return (
    <p className="text-xs text-muted-foreground">
      Aportes: jubilación {rate(rates.retirement_pct)}, ley 19.032 {rate(rates.pami_pct)} y obra social{' '}
      {rate(rates.health_pct)} · contribuciones patronales {rate(rates.employer_pct)}. La antigüedad, el presentismo y
      lo sindical son los del convenio de cada empleado. Simulados: sin pretensión de exactitud legal.
    </p>
  )
}

const NOVELTIES = ['days_worked', 'hours_worked', 'absence_days', 'overtime_50', 'overtime_100'] as const
type Draft = Record<(typeof NOVELTIES)[number], string>
const draftOf = (l: PayrollLineView): Draft => ({
  days_worked: String(l.days_worked),
  hours_worked: String(l.hours_worked).replace('.', ','),
  absence_days: String(l.absence_days),
  overtime_50: String(l.overtime_50).replace('.', ','),
  overtime_100: String(l.overtime_100).replace('.', ','),
})
const numberOf = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : Number.NaN
}

/**
 * Lo de cada empleado: sus novedades (que RRHH carga mientras la liquidación está en
 * borrador) y los importes de su recibo (docs/FASE_6_RRHH_Y_SUELDOS.md §3).
 */
export function PayrollSection({ detail }: { detail: DocumentDetail }) {
  const company = useCompany()
  const view = detail.payroll!
  const editable = detail.doc.status === 'BORRADOR' && company.can('payroll.create')
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(view.lines.map((l) => [l.id, draftOf(l)])),
  )
  // Se compara el número ("4,0" es 4); lo que no es un número cuenta como cambio y lo rechaza la validación.
  const changed = view.lines.filter((l) => NOVELTIES.some((key) => numberOf(drafts[l.id][key]) !== l[key]))
  const save = useCommand(
    () =>
      commands.updatePayrollLines(
        detail.doc.id,
        changed.map((l) => ({
          line_id: l.id,
          days_worked: numberOf(drafts[l.id].days_worked),
          hours_worked: numberOf(drafts[l.id].hours_worked),
          absence_days: numberOf(drafts[l.id].absence_days),
          overtime_50: numberOf(drafts[l.id].overtime_50),
          overtime_100: numberOf(drafts[l.id].overtime_100),
        })),
      ),
    { success: 'Novedades guardadas: los recibos se recalcularon.' },
  )
  const set = (id: string, key: keyof Draft, value: string) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], [key]: value } }))
  const cell = (l: PayrollLineView, key: keyof Draft, label: string) =>
    editable ? (
      <Input
        inputMode="decimal"
        aria-label={`${label} de ${l.employee.last_name}`}
        value={drafts[l.id][key]}
        onChange={(e) => set(l.id, key, e.target.value)}
        className="h-8 w-16 text-right tabular"
      />
    ) : (
      <span className="tabular">{qty(l[key])}</span>
    )
  return (
    <Section
      title="Empleados y recibos"
      description={
        editable
          ? 'Cargá las novedades del mes: los días trabajados de quienes cobran por mes o las horas de los jornalizados (las licencias pagas cuentan como trabajadas), las ausencias sin aviso (pierden el presentismo) y las horas extra. Al guardar se recalculan los recibos.'
          : 'Las novedades del mes de cada empleado y su recibo: lo que cobra (el remunerativo menos los aportes) y lo que le cuesta a la empresa.'
      }
      actions={
        editable ? (
          <Button size="sm" disabled={!changed.length || save.isPending} onClick={() => save.mutate([])}>
            <Save />{' '}
            {save.isPending ? 'Guardando…' : `Guardar novedades${changed.length ? ` (${changed.length})` : ''}`}
          </Button>
        ) : undefined
      }
    >
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className={head}>Empleado</TableHead>
              <TableHead className={cn(head, 'text-right')}>Días u horas</TableHead>
              <TableHead className={cn(head, 'text-right')}>Ausencias</TableHead>
              <TableHead className={cn(head, 'text-right')}>HE 50 %</TableHead>
              <TableHead className={cn(head, 'text-right')}>HE 100 %</TableHead>
              <TableHead className={cn(head, 'text-right')}>Remunerativo</TableHead>
              <TableHead className={cn(head, 'text-right')}>Aportes</TableHead>
              <TableHead className={cn(head, 'text-right')}>Neto</TableHead>
              <TableHead className={cn(head, 'text-right')}>Contribuciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.lines.map((l) => (
              <TableRow key={l.id} className="align-top">
                <TableCell className="text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{l.employee.file_number}</span>{' '}
                  <span className="font-medium">
                    {l.employee.last_name}, {l.employee.first_name}
                  </span>
                  <div className="text-xs text-muted-foreground">
                    {l.category.name}
                    {l.agreement ? ` · ${l.agreement.code}` : ''}
                    {l.work_center ? ` · ${l.work_center.code}` : ''} · {l.seniority_years} años
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {l.pay_basis === 'HOURLY'
                    ? cell(l, 'hours_worked', 'Horas trabajadas')
                    : cell(l, 'days_worked', 'Días trabajados')}
                  <div className="text-xs text-muted-foreground">{l.pay_basis === 'HOURLY' ? 'horas' : 'días'}</div>
                </TableCell>
                <TableCell className="text-right">{cell(l, 'absence_days', 'Ausencias sin aviso')}</TableCell>
                <TableCell className="text-right">{cell(l, 'overtime_50', 'Horas extra al 50 %')}</TableCell>
                <TableCell className="text-right">{cell(l, 'overtime_100', 'Horas extra al 100 %')}</TableCell>
                <TableCell className="tabular text-right">
                  {money(l.gross)}
                  <div className="text-xs text-muted-foreground">
                    básico {money(l.basic)}
                    {l.seniority > 0 && ` · antig. ${money(l.seniority)}`}
                    {l.attendance > 0 && ` · present. ${money(l.attendance)}`}
                    {l.overtime > 0 && ` · HE ${money(l.overtime)}`}
                  </div>
                </TableCell>
                <TableCell className="tabular text-right">{money(l.deductions)}</TableCell>
                <TableCell className="tabular text-right font-medium">{money(l.net)}</TableCell>
                <TableCell className="tabular text-right">{money(l.employer + l.union_contribution)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5} className="text-right text-sm font-semibold">
                Totales
              </TableCell>
              <TableCell className="tabular text-right font-semibold">{money(view.gross)}</TableCell>
              <TableCell className="tabular text-right font-semibold">{money(view.deductions)}</TableCell>
              <TableCell className="tabular text-right font-semibold">{money(view.net)}</TableCell>
              <TableCell className="tabular text-right font-semibold">
                {money(view.employer + view.union_contribution)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      {editable && changed.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          Hay novedades sin guardar: los importes de la tabla son los de antes de cambiarlas.
        </p>
      )}
      <div className="mt-3">
        <RatesLine rates={view.rates} />
      </div>
    </Section>
  )
}

/** El mes siguiente a aaaa-mm, el día 4: la fecha de pago que se propone. */
function nextPaymentDate(period: string) {
  const [y, m] = period.split('-').map(Number)
  return m === 12 ? `${y + 1}-01-04` : `${y}-${String(m + 1).padStart(2, '0')}-04`
}

/** RRHH prepara la liquidación de un mes: entran los legajos activos con sus básicos y antigüedad. */
export function PayrollFormPage() {
  const company = useCompany()
  const navigate = useNavigate()
  const current = todayAR().slice(0, 7)
  const [period, setPeriod] = useState(current)
  const [paymentDate, setPaymentDate] = useState(nextPaymentDate(current))
  const [notes, setNotes] = useState('')
  const create = useCommand(
    () => commands.createPayroll(company.companyId, { period, payment_date: paymentDate, notes }),
    {
      success: (r) => `${r.display_number} preparada: cargá las novedades y confirmala.`,
      onSuccess: (r) => navigate(company.docPath('PAYROLL', r.display_number)),
    },
  )
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Inicio', to: company.to() },
          { label: 'RRHH' },
          { label: 'Liquidaciones de sueldos', to: company.docPath('PAYROLL') },
          { label: 'Nueva' },
        ]}
        title="Nueva liquidación de sueldos"
        description="Entra todo el personal activo que ingresó hasta el fin del mes, con el básico (o el valor hora) de su categoría, su antigüedad y los porcentajes de su convenio y de la empresa. Después se cargan las novedades de cada uno."
      />
      <Section className="max-w-xl">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mes" required>
            <Input
              type="month"
              value={period}
              max={current}
              onChange={(e) => {
                setPeriod(e.target.value)
                if (/^\d{4}-\d{2}$/.test(e.target.value)) setPaymentDate(nextPaymentDate(e.target.value))
              }}
            />
          </Field>
          <Field label="Fecha de pago" required hint="Se propone el día 4 del mes siguiente.">
            <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </Field>
          <Field label="Observaciones" className="sm:col-span-2">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Opcional" />
          </Field>
        </div>
        <div className="mt-4 flex gap-2">
          <Button disabled={!period || !paymentDate || create.isPending} onClick={() => create.mutate([])}>
            {create.isPending ? 'Preparando…' : 'Preparar la liquidación'}
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancelar
          </Button>
        </div>
      </Section>
    </>
  )
}

// La antigüedad y el presentismo son de cada convenio (RRHH → Convenios, Fase 6d).
const RATE_FIELDS: [keyof PayrollView['rates'], string, string][] = [
  ['retirement_pct', 'Jubilación', 'Aporte del empleado.'],
  ['pami_pct', 'Ley 19.032', 'Aporte del empleado.'],
  ['health_pct', 'Obra social', 'Aporte del empleado.'],
  ['employer_pct', 'Contribuciones', 'A cargo de la empresa.'],
]

/** El docente ajusta los porcentajes de la liquidación de la empresa (a validar: sin exactitud legal). */
export function PayrollRatesSection() {
  const company = useCompany()
  const current = { ...PAYROLL_DEFAULT_RATES, ...(company.company.settings.payroll ?? {}) }
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(RATE_FIELDS.map(([key]) => [key, String(current[key]).replace('.', ',')])),
  )
  const parsed = Object.fromEntries(RATE_FIELDS.map(([key]) => [key, numberOf(values[key])]))
  const valid = RATE_FIELDS.every(([key]) => parsed[key] >= 0 && parsed[key] <= 100)
  const changed = RATE_FIELDS.some(([key]) => parsed[key] !== current[key])
  const save = useCommand(() => commands.updateCompanySettings(company.companyId, { payroll: parsed }), {
    success: 'Porcentajes guardados: se usan en las liquidaciones nuevas.',
  })
  return (
    <Section
      title="Sueldos"
      description="Los porcentajes legales con que RRHH liquida: los aportes del empleado y las contribuciones patronales (a validar: simulados, sin pretensión de exactitud legal). La antigüedad, el presentismo y lo sindical son de cada convenio (RRHH → Convenios). Cada liquidación guarda los suyos: cambiarlos no altera las ya hechas."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {RATE_FIELDS.map(([key, label, hint]) => (
          <Field
            key={key}
            label={`${label} (%)`}
            hint={hint}
            error={!(parsed[key] >= 0 && parsed[key] <= 100) ? 'De 0 a 100.' : undefined}
          >
            <Input
              inputMode="decimal"
              value={values[key]}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              className="tabular text-right"
            />
          </Field>
        ))}
      </div>
      <Button className="mt-3" disabled={!valid || !changed || save.isPending} onClick={() => save.mutate([])}>
        {save.isPending ? 'Guardando…' : 'Guardar porcentajes'}
      </Button>
    </Section>
  )
}
