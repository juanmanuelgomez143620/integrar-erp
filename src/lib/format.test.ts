import { describe, expect, it } from 'vitest'
import { parseAmount, percent } from './format'

describe('importes escritos por el estudiante', () => {
  it('acepta la coma decimal y los puntos de miles de es-AR', () => {
    expect(parseAmount('1300,50')).toBe(1300.5)
    expect(parseAmount('1.300,50')).toBe(1300.5)
    expect(parseAmount('266.200,5')).toBe(266200.5)
    expect(parseAmount('1.000.000')).toBe(1000000)
    expect(parseAmount('12.500')).toBe(12500)
    expect(parseAmount('$ 1.300')).toBe(1300)
  })

  it('también el punto decimal y los números sin separadores', () => {
    expect(parseAmount('1300.50')).toBe(1300.5)
    expect(parseAmount('266200')).toBe(266200)
    expect(parseAmount(' 45 ')).toBe(45)
  })

  it('lo vacío o lo que no es un número no es un importe', () => {
    expect(parseAmount('')).toBeNaN()
    expect(parseAmount('   ')).toBeNaN()
    expect(parseAmount('mil')).toBeNaN()
    expect(parseAmount('1.2.3')).toBeNaN()
  })
})

describe('por cientos', () => {
  it('con la coma decimal y, en una diferencia, el signo', () => {
    expect(percent(12.5)).toBe('12,5 %')
    expect(percent(21)).toBe('21 %')
    expect(percent(0.46)).toBe('0,5 %')
    expect(percent(0.5, true)).toBe('+0,5 %')
    expect(percent(-3, true)).toBe('-3 %')
    expect(percent(0, true)).toBe('0 %')
  })
})
