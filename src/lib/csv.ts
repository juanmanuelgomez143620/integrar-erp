// Exportación a CSV pensada para abrirse con Excel o LibreOffice en es-AR:
// separador ";" (la coma es el separador decimal), números con coma decimal
// y sin separador de miles, fin de línea CRLF y marca BOM para que la
// planilla reconozca la codificación UTF-8 (tildes y eñes).

import { todayAR } from './format'

export type CsvValue = string | number | boolean | null | undefined

export interface CsvColumn<T> {
  header: string
  value: (row: T) => CsvValue
}

const DECIMAL = new Intl.NumberFormat('es-AR', { useGrouping: false, maximumFractionDigits: 4 })

/**
 * Un texto que empieza con "=", "+", "-" o "@" la planilla lo interpreta como
 * fórmula (inyección CSV). Los datos los cargan estudiantes, así que se
 * neutraliza con un apóstrofo inicial, que Excel no muestra.
 */
const FORMULA_START = /^[=+\-@\t\r]/

/** Importes a dos decimales (el costo promedio se guarda con más precisión). */
export function round2(value: number | null | undefined): number | null {
  return value == null ? null : Math.round((value + Number.EPSILON) * 100) / 100
}

export function csvCell(value: CsvValue): string {
  let text: string
  if (value == null) text = ''
  else if (typeof value === 'number') text = Number.isFinite(value) ? DECIMAL.format(value) : ''
  else if (typeof value === 'boolean') text = value ? 'Sí' : 'No'
  else text = FORMULA_START.test(value) ? `'${value}` : value
  return `"${text.replace(/"/g, '""')}"`
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => csvCell(c.header)), ...rows.map((row) => columns.map((c) => csvCell(c.value(row))))]
  return `\uFEFF${lines.map((cells) => cells.join(';')).join('\r\n')}\r\n`
}

/** Nombre del archivo: listado, empresa y fecha (clientes-forestal-del-norte-2026-10-03.csv). */
export function csvFilename(dataset: string, companySlug: string): string {
  return `${dataset}-${companySlug}-${todayAR()}.csv`
}

export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Revocar en el mismo instante puede cancelar la descarga en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
