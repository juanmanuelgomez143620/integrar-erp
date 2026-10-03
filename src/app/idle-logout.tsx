import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { idleStatus } from '@/lib/idle'
import { useSession } from './session'

/** Cualquiera de estos eventos cuenta como "hay alguien usando la computadora". */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

/**
 * El aviso para la pantalla de ingreso viaja en sessionStorage y no en el
 * estado de la navegación: al cerrarse la sesión, el guardia de rutas
 * también redirige a /login y esa redirección pisaría el estado.
 */
const NOTICE_KEY = 'integrar-erp.idle-logout'

/** Minutos del cierre por inactividad que hay que avisar al volver a ingresar; se muestra una sola vez. */
export function useIdleLogoutNotice(): number | null {
  const [minutes] = useState<number | null>(() => {
    try {
      const value = sessionStorage.getItem(NOTICE_KEY)
      return value ? Number(value) : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      sessionStorage.removeItem(NOTICE_KEY)
    } catch {
      // Sin almacenamiento disponible: no hay aviso que limpiar.
    }
  }, [])
  return minutes
}

/**
 * Cierra la sesión si nadie usa la computadora durante los minutos que fijó
 * la escuela (school_settings). Un minuto antes avisa; cualquier movimiento
 * del mouse o tecla posterga el cierre. Cada pestaña tiene su propia sesión
 * y su propio reloj.
 */
export function IdleLogout({ minutes }: { minutes: number }) {
  const { logout } = useSession()
  const navigate = useNavigate()
  const lastActivity = useRef(0)
  const [warning, setWarning] = useState(false)
  // Se conserva el último valor para que el texto no quede vacío durante la animación de cierre.
  const [secondsLeft, setSecondsLeft] = useState(0)

  useEffect(() => {
    if (minutes <= 0) return
    lastActivity.current = Date.now()
    const markActivity = () => {
      lastActivity.current = Date.now()
    }
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, markActivity, { capture: true, passive: true })
    }
    const timer = window.setInterval(() => {
      const status = idleStatus(lastActivity.current, Date.now(), minutes)
      if (status.expired) {
        window.clearInterval(timer)
        try {
          sessionStorage.setItem(NOTICE_KEY, String(minutes))
        } catch {
          // Sin almacenamiento disponible: se cierra igual, sin aviso.
        }
        logout()
        navigate('/login', { replace: true })
        return
      }
      if (status.secondsLeft !== null) setSecondsLeft(status.secondsLeft)
      setWarning(status.secondsLeft !== null)
    }, 1000)
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, markActivity, { capture: true })
      window.clearInterval(timer)
    }
  }, [minutes, logout, navigate])

  return (
    <AlertDialog open={warning}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Seguís ahí?</AlertDialogTitle>
          <AlertDialogDescription>
            Por seguridad, tu sesión se va a cerrar en {secondsLeft} segundos porque no hubo actividad. En una
            computadora compartida, otra persona podría usar tu usuario.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => {
              lastActivity.current = Date.now()
              setWarning(false)
            }}
          >
            Seguir trabajando
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
