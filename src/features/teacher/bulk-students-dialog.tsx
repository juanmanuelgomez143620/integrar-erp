import { useMemo, useState } from 'react'
import { Printer, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { commands, type StudentCredential } from '@/lib/api'
import { MAX_BULK_STUDENTS, parseStudentList } from '@/lib/domain/students'
import { useCommand } from '@/hooks/use-command'
import { useCompany } from '@/app/company'
import { useMe } from '@/app/session'
import { credentialsSheetHtml, printCredentialsSheet } from './credentials-sheet'

/** Alta masiva de estudiantes (MVP.md, H-21): pegar la lista del curso y entregar usuarios impresos. */
export function BulkStudentsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const company = useCompany()
  const { data: me } = useMe()
  const [text, setText] = useState('')
  const [created, setCreated] = useState<StudentCredential[] | null>(null)
  const parsed = useMemo(() => parseStudentList(text), [text])
  const create = useCommand(
    () =>
      commands.createStudentsBulk(
        company.companyId,
        parsed.students.map(({ first_name, last_name }) => ({ first_name, last_name })),
      ),
    { success: (r) => `${r.length} estudiantes dados de alta.`, onSuccess: setCreated },
  )
  const close = () => {
    onOpenChange(false)
    setText('')
    setCreated(null)
  }
  const print = () => {
    if (!created) return
    printCredentialsSheet(
      credentialsSheetHtml(created, {
        title: `Usuarios de ${company.company.legal_name}`,
        subtitle: [
          me?.school.official_name,
          company.course ? `${company.course.name} ${company.course.academic_year}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        appUrl: new URL(import.meta.env.BASE_URL, window.location.origin).href.replace(/\/$/, ''),
      }),
    )
  }
  const ready = parsed.students.length > 0 && parsed.issues.length === 0

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : !created && close())}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!created}>
        {!created ? (
          <>
            <DialogHeader>
              <DialogTitle>Alta masiva de estudiantes</DialogTitle>
              <DialogDescription>
                Pegá la lista del curso, una persona por línea: <b>Apellido, Nombres</b>. También podés copiar dos
                columnas (apellido y nombres) desde una planilla. Sólo se registran nombre, apellido y usuario; las
                contraseñas iniciales las genera el sistema.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={'Gómez, Juan Manuel\nPérez, Lucía'}
              aria-label="Lista de estudiantes"
              className="font-mono text-sm"
            />
            {parsed.issues.length > 0 && (
              <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {parsed.issues.map((issue, i) => (
                  <li key={i} className="flex gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {issue.line > 0 && <b>Línea {issue.line}: </b>}
                      {issue.reason}
                      {issue.text && <span className="text-amber-700"> ({issue.text})</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {parsed.students.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border text-sm">
                <table className="w-full">
                  <thead className="sticky top-0 bg-muted text-left text-xs text-slate-600">
                    <tr>
                      <th className="px-3 py-1.5 font-semibold">Apellido</th>
                      <th className="px-3 py-1.5 font-semibold">Nombres</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.students.map((s) => (
                      <tr key={s.line} className="border-t">
                        <td className="px-3 py-1">{s.last_name}</td>
                        <td className="px-3 py-1">{s.first_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancelar
              </Button>
              <Button disabled={!ready || create.isPending} onClick={() => create.mutate([])}>
                {create.isPending
                  ? 'Creando…'
                  : parsed.students.length
                    ? `Dar de alta ${parsed.students.length} ${parsed.students.length === 1 ? 'estudiante' : 'estudiantes'}`
                    : `Hasta ${MAX_BULK_STUDENTS} por vez`}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Usuarios creados</DialogTitle>
              <DialogDescription>
                Entregale a cada estudiante su usuario y su contraseña inicial. Al ingresar por primera vez va a tener
                que elegir una propia. Después asignales rol y sector desde la tabla.
              </DialogDescription>
            </DialogHeader>
            <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              Imprimí la lista ahora: las contraseñas iniciales no se vuelven a mostrar. Si alguien pierde la suya, usá
              «Contraseña» en su fila para restablecerla.
            </p>
            <div className="max-h-72 overflow-y-auto rounded-lg border text-sm">
              <table className="w-full">
                <thead className="sticky top-0 bg-muted text-left text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-1.5 font-semibold">Estudiante</th>
                    <th className="px-3 py-1.5 font-semibold">Usuario</th>
                    <th className="px-3 py-1.5 font-semibold">Contraseña inicial</th>
                  </tr>
                </thead>
                <tbody>
                  {created.map((c) => (
                    <tr key={c.user_id} className="border-t">
                      <td className="px-3 py-1">
                        {c.last_name}, {c.first_name}
                      </td>
                      <td className="px-3 py-1 font-mono">{c.username}</td>
                      <td className="px-3 py-1 font-mono tracking-wide">{c.password}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={print}>
                <Printer /> Imprimir
              </Button>
              <Button onClick={close}>Listo, ya los entregué</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
