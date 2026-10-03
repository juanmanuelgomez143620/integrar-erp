import { describe, expect, it } from 'vitest'
import { csvCell, round2, toCsv } from './csv'

describe('CSV para planillas en es-AR', () => {
  it('usa ";" como separador, fin de línea CRLF y marca BOM UTF-8', () => {
    const csv = toCsv(
      [{ name: 'Placa MDF', qty: 8 }],
      [
        { header: 'Producto', value: (r) => r.name },
        { header: 'Stock', value: (r) => r.qty },
      ],
    )
    expect(csv).toBe('\uFEFF"Producto";"Stock"\r\n"Placa MDF";"8"\r\n')
  })

  it('escribe los números con coma decimal y sin separador de miles', () => {
    expect(csvCell(1234567.891)).toBe('"1234567,891"')
    expect(csvCell(0.5)).toBe('"0,5"')
    expect(csvCell(Number.NaN)).toBe('""')
  })

  it('vacíos como celda vacía, booleanos como Sí/No y comillas duplicadas', () => {
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
    expect(csvCell(true)).toBe('"Sí"')
    expect(csvCell(false)).toBe('"No"')
    expect(csvCell('Placa "MDF"; 1,83 m')).toBe('"Placa ""MDF""; 1,83 m"')
  })

  it('neutraliza los textos que una planilla ejecutaría como fórmula', () => {
    expect(csvCell('=HIPERVINCULO("http://ejemplo")')).toBe('"\'=HIPERVINCULO(""http://ejemplo"")"')
    for (const text of ['+54 11 1234', '-2+3', '@SUMA(A1)']) expect(csvCell(text)).toBe(`"'${text}"`)
    // Un "=" en el medio del texto no es una fórmula.
    expect(csvCell('Rubro = maderas')).toBe('"Rubro = maderas"')
  })

  it('redondea importes a dos decimales', () => {
    expect(round2(1234.5678)).toBe(1234.57)
    expect(round2(null)).toBeNull()
  })
})
