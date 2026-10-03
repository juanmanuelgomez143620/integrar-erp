// Alta de estudiantes: nombres de usuario y lectura de la lista que pega el
// docente (MVP.md, H-21). Funciones puras: las usa la interfaz para la vista
// previa y el motor para generar los usuarios definitivos.

/** Máximo de estudiantes por alta masiva (un curso real tiene menos de 40). */
export const MAX_BULK_STUDENTS = 60

const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '')

/** Inicial del primer nombre + primer apellido, en minúsculas y sin tildes: "Juan Manuel", "Gómez Paz" → "jgomez". */
export function baseUsername(firstName: string, lastName: string): string {
  const initial = stripAccents(firstName.trim()).charAt(0)
  const surname = stripAccents(lastName.trim().split(/\s+/)[0] ?? '')
  return `${initial}${surname}`.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Primer usuario libre a partir de la base: jgomez, jgomez2, jgomez3… (mínimo 3 caracteres). */
export function uniqueUsername(base: string, taken: Set<string>): string {
  const root = (base || 'estudiante').padEnd(3, '0').slice(0, 26)
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) if (!taken.has(`${root}${n}`)) return `${root}${n}`
}

/** "GÓMEZ" → "Gómez"; respeta lo que ya viene en minúsculas y mayúsculas mezcladas. */
function tidyName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name !== name.toUpperCase()) return name
  return name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase())
}

export interface ParsedStudent {
  line: number
  first_name: string
  last_name: string
}

export interface StudentListIssue {
  line: number
  text: string
  reason: string
}

/**
 * Lee una lista pegada, una persona por línea, con el formato de las
 * planillas escolares: "Apellido, Nombres" o dos columnas pegadas desde una
 * planilla de cálculo (Apellido ⇥ Nombres). Las líneas vacías se ignoran.
 */
export function parseStudentList(text: string): { students: ParsedStudent[]; issues: StudentListIssue[] } {
  const students: ParsedStudent[] = []
  const issues: StudentListIssue[] = []
  const seen = new Map<string, number>()
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1
    const content = rawLine.trim()
    if (!content) return
    const parts = content.includes('\t') ? content.split('\t') : content.split(',')
    if (parts.length < 2) {
      issues.push({ line, text: content, reason: 'Falta la coma entre apellido y nombre ("Apellido, Nombre").' })
      return
    }
    const last_name = tidyName(parts[0])
    const first_name = tidyName(parts.slice(1).join(' '))
    if (last_name.length < 2 || first_name.length < 2) {
      issues.push({ line, text: content, reason: 'El apellido y el nombre deben tener al menos 2 letras.' })
      return
    }
    const key = stripAccents(`${last_name}|${first_name}`).toLowerCase()
    const previous = seen.get(key)
    if (previous) {
      issues.push({ line, text: content, reason: `Repite a la persona de la línea ${previous}.` })
      return
    }
    seen.set(key, line)
    students.push({ line, first_name, last_name })
  })
  if (students.length > MAX_BULK_STUDENTS)
    issues.push({ line: 0, text: '', reason: `Se pueden dar de alta hasta ${MAX_BULK_STUDENTS} estudiantes por vez.` })
  return { students, issues }
}
