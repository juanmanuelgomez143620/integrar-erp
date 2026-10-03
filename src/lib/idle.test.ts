import { describe, expect, it } from 'vitest'
import { idleStatus } from './idle'

const MIN = 60_000

describe('cierre de sesión por inactividad', () => {
  it('antes del último minuto no avisa nada', () => {
    expect(idleStatus(0, 13 * MIN, 15)).toEqual({ expired: false, secondsLeft: null })
  })

  it('en el último minuto avisa cuántos segundos faltan', () => {
    expect(idleStatus(0, 14 * MIN, 15)).toEqual({ expired: false, secondsLeft: 60 })
    expect(idleStatus(0, 14 * MIN + 30_500, 15)).toEqual({ expired: false, secondsLeft: 30 })
  })

  it('al cumplirse el tiempo hay que cerrar la sesión', () => {
    expect(idleStatus(0, 15 * MIN, 15).expired).toBe(true)
    expect(idleStatus(0, 90 * MIN, 15).expired).toBe(true)
  })

  it('con 0 minutos la escuela eligió no cerrarla nunca', () => {
    expect(idleStatus(0, 24 * 60 * MIN, 0)).toEqual({ expired: false, secondsLeft: null })
  })
})
