// Cierre de sesión por inactividad, pensado para computadoras compartidas
// (ARCHITECTURE.md §10, riesgo R9): una sesión olvidada abierta permite que
// otra persona actúe con ese usuario y la auditoría queda a su nombre.

/** Segundos antes del cierre en los que se avisa, para poder seguir trabajando. */
export const IDLE_WARNING_SECONDS = 60

export interface IdleStatus {
  /** Ya pasó el tiempo sin actividad: hay que cerrar la sesión. */
  expired: boolean
  /** Segundos que faltan para el cierre, sólo durante el aviso; null fuera de él. */
  secondsLeft: number | null
}

/** `timeoutMinutes` 0 significa que la escuela eligió no cerrar la sesión. */
export function idleStatus(lastActivityMs: number, nowMs: number, timeoutMinutes: number): IdleStatus {
  if (timeoutMinutes <= 0) return { expired: false, secondsLeft: null }
  const remaining = timeoutMinutes * 60 - (nowMs - lastActivityMs) / 1000
  if (remaining <= 0) return { expired: true, secondsLeft: 0 }
  return { expired: false, secondsLeft: remaining <= IDLE_WARNING_SECONDS ? Math.ceil(remaining) : null }
}
