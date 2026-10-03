import { useState } from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '@/lib/csv'
import { showError } from '@/hooks/use-command'

/**
 * Descarga un listado completo como CSV. Los datos se piden a la API en el
 * momento (que valida el permiso `*.export`), no se toman de la pantalla.
 */
export function ExportCsvButton<T>({
  dataset,
  companySlug,
  load,
  columns,
}: {
  /** Nombre del listado en el archivo: "clientes", "stock"… */
  dataset: string
  companySlug: string
  load: () => Promise<T[]>
  columns: CsvColumn<T>[]
}) {
  const [busy, setBusy] = useState(false)
  const onClick = async () => {
    setBusy(true)
    try {
      const rows = await load()
      const filename = csvFilename(dataset, companySlug)
      downloadCsv(filename, toCsv(rows, columns))
      toast.success(`Se descargó ${filename}`, {
        description: `${rows.length} ${rows.length === 1 ? 'registro' : 'registros'}.`,
      })
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="outline" disabled={busy} onClick={onClick}>
      <Download /> Exportar CSV
    </Button>
  )
}
