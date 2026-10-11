import { useState } from 'react'
import { Save, Upload, Image } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, Section } from '@/components/common/blocks'
import { SimpleSelect } from '@/components/common/pickers'
import { commands, type SchoolSettingsInput } from '@/lib/api'
import type { SchoolSettings } from '@/lib/domain/types'
import { useCommand } from '@/hooks/use-command'

const TIMEOUT_OPTIONS = [
  { value: '0', label: 'No cerrar la sesión' },
  { value: '5', label: '5 minutos' },
  { value: '10', label: '10 minutos' },
  { value: '15', label: '15 minutos (recomendado)' },
  { value: '20', label: '20 minutos' },
  { value: '30', label: '30 minutos' },
  { value: '45', label: '45 minutos' },
  { value: '60', label: '1 hora' },
  { value: '120', label: '2 horas' },
]

/** Datos de la escuela dueña de la instancia (school_settings): MVP.md, pantalla 28. */
export function SchoolSettingsForm({ school }: { school: SchoolSettings }) {
  const [form, setForm] = useState<SchoolSettingsInput>(() => ({
    official_name: school.official_name,
    short_name: school.short_name,
    city: school.city,
    province: school.province,
    contact_email: school.contact_email,
    session_timeout_minutes: school.session_timeout_minutes,
    logo_path: school.logo_path,
  }))
  const set = (patch: Partial<SchoolSettingsInput>) => setForm((current) => ({ ...current, ...patch }))
  const save = useCommand(() => commands.updateSchoolSettings(form), { success: 'Datos de la escuela guardados.' })
  const uploadLogo = useCommand<[{ name: string; type: string; data: string }], { logo_path: string }>(
    (file) => commands.uploadSchoolLogo(file),
    { success: 'Logo actualizado.', onSuccess: (result) => set({ logo_path: result.logo_path }) },
  )
  const timeoutOptions = TIMEOUT_OPTIONS.some((o) => Number(o.value) === form.session_timeout_minutes)
    ? TIMEOUT_OPTIONS
    : [
        ...TIMEOUT_OPTIONS,
        { value: String(form.session_timeout_minutes), label: `${form.session_timeout_minutes} minutos` },
      ]

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1]
      uploadLogo.mutate([{ name: file.name, type: file.type, data: base64 }])
    }
    reader.readAsDataURL(file)
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate([])
      }}
    >
      <Section
        title="Identificación"
        description="Se muestra en la pantalla de ingreso y en el menú. No está escrita en el código: cada escuela que usa el sistema tiene la suya."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre oficial" required className="sm:col-span-2">
            <Input value={form.official_name} onChange={(e) => set({ official_name: e.target.value })} />
          </Field>
          <Field label="Nombre corto" required hint='Para espacios reducidos, por ejemplo "ENS N.º 9".'>
            <Input value={form.short_name} onChange={(e) => set({ short_name: e.target.value })} />
          </Field>
          <Field label="Email de contacto" hint="Opcional. Una dirección institucional, no personal.">
            <Input type="email" value={form.contact_email} onChange={(e) => set({ contact_email: e.target.value })} />
          </Field>
          <Field label="Localidad">
            <Input value={form.city} onChange={(e) => set({ city: e.target.value })} />
          </Field>
          <Field label="Provincia">
            <Input value={form.province} onChange={(e) => set({ province: e.target.value })} />
          </Field>
        </div>
      </Section>

      <Section
        title="Logo de la escuela"
        description="Se muestra en la pantalla de ingreso. Formatos: PNG, JPEG, WebP o SVG. Máx. 5 MB."
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] items-center">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-20 h-20 rounded-lg border bg-muted">
              {form.logo_path ? (
                <img
                  src={
                    form.logo_path.startsWith('data:')
                      ? form.logo_path
                      : `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${form.logo_path}`
                  }
                  alt="Logo de la escuela"
                  className="max-w-full max-h-full"
                />
              ) : (
                <Image className="w-10 h-10 text-muted-foreground" />
              )}
            </div>
            <div>
              <p className="font-medium">Logo actual</p>
              <p className="text-sm text-muted-foreground">
                {form.logo_path ? 'Se mostrará en la pantalla de ingreso' : 'Sin logo'}
              </p>
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Button type="button" variant="outline" className="shrink-0" disabled={uploadLogo.isPending}>
                <Upload className="mr-2 h-4 w-4" /> Subir nuevo logo
              </Button>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={handleFileChange}
                className="sr-only"
                disabled={uploadLogo.isPending}
              />
            </label>
            <p className="mt-1 text-xs text-muted-foreground">PNG, JPEG, WebP o SVG · Máx. 5 MB</p>
          </div>
        </div>
      </Section>

      <Section
        title="Computadoras compartidas"
        description="Una sesión olvidada abierta permite que otra persona actúe con ese usuario, y la auditoría registra sus acciones a nombre de quien no las hizo."
      >
        <Field
          label="Cerrar la sesión después de"
          hint="Si nadie usa el teclado ni el mouse durante ese tiempo, la sesión se cierra sola. Un minuto antes aparece un aviso para seguir trabajando."
        >
          <SimpleSelect
            value={String(form.session_timeout_minutes)}
            onChange={(v) => set({ session_timeout_minutes: Number(v) })}
            options={timeoutOptions}
            className="sm:max-w-xs"
          />
        </Field>
      </Section>

      <div className="flex justify-end">
        <Button type="submit" disabled={save.isPending}>
          <Save /> Guardar cambios
        </Button>
      </div>
    </form>
  )
}
