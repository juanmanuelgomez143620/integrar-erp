import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { BusinessError } from '@/lib/api'

export function showError(error: unknown) {
  if (error instanceof BusinessError) {
    toast.error(error.message, { description: error.hint, duration: 7000 })
    return
  }
  toast.error('Ocurrió un error inesperado.', { description: error instanceof Error ? error.message : String(error) })
}

interface Options<R> {
  success?: string | ((result: R) => string)
  onSuccess?: (result: R) => void
}

/** Ejecuta un comando de negocio: muestra el resultado y refresca todos los datos. */
export function useCommand<A extends unknown[], R>(fn: (...args: A) => Promise<R>, options: Options<R> = {}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      if (options.success) toast.success(typeof options.success === 'function' ? options.success(result) : options.success)
      options.onSuccess?.(result)
    },
    onError: showError,
  })
}
