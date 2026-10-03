import { describe, expect, it } from 'vitest'
import { MAX_BULK_STUDENTS, baseUsername, parseStudentList, uniqueUsername } from './students'

describe('nombres de usuario', () => {
  it('usan la inicial del primer nombre y el primer apellido, sin tildes', () => {
    expect(baseUsername('Juan Manuel', 'Gómez Paz')).toBe('jgomez')
    expect(baseUsername('Ñandú', 'Núñez')).toBe('nnunez')
    expect(baseUsername('Ana', "D'Angelo")).toBe('adangelo')
  })

  it('agregan un número si el usuario ya existe y nunca quedan más cortos que 3 letras', () => {
    expect(uniqueUsername('jgomez', new Set())).toBe('jgomez')
    expect(uniqueUsername('jgomez', new Set(['jgomez', 'jgomez2']))).toBe('jgomez3')
    expect(uniqueUsername('al', new Set())).toBe('al0')
  })
})

describe('lista pegada por el docente', () => {
  it('acepta "Apellido, Nombres" y dos columnas de una planilla, e ignora las líneas vacías', () => {
    const { students, issues } = parseStudentList('Gómez, Juan Manuel\n\nPérez\tLucía Belén\r\n')
    expect(issues).toEqual([])
    expect(students).toEqual([
      { line: 1, first_name: 'Juan Manuel', last_name: 'Gómez' },
      { line: 3, first_name: 'Lucía Belén', last_name: 'Pérez' },
    ])
  })

  it('pasa las mayúsculas de las planillas oficiales a nombre propio', () => {
    expect(parseStudentList('DE LA FUENTE, MARÍA JOSÉ').students[0]).toMatchObject({
      last_name: 'De La Fuente',
      first_name: 'María José',
    })
  })

  it('marca las líneas sin coma, los nombres demasiado cortos y las personas repetidas', () => {
    const { students, issues } = parseStudentList('Juan Gómez\nGómez, J\nAcosta, Sofía\nACOSTA, SOFIA')
    expect(students).toHaveLength(1)
    expect(issues.map((i) => i.line)).toEqual([1, 2, 4])
    expect(issues[2].reason).toContain('línea 3')
  })

  it(`no admite más de ${MAX_BULK_STUDENTS} estudiantes por vez`, () => {
    const text = Array.from({ length: MAX_BULK_STUDENTS + 1 }, (_, i) => `Apellido${i}, Nombre`).join('\n')
    expect(parseStudentList(text).issues.at(-1)?.reason).toContain(String(MAX_BULK_STUDENTS))
  })
})
