import { useEffect } from 'react'
import { RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { realtime } from '@/lib/api'
import { SessionProvider } from './session'
import { router } from './router'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: true },
  },
})

/** Refresca todo cuando cambian los datos en otra pestaña (hoy) o por Realtime (con Supabase). */
function RealtimeBridge() {
  const client = useQueryClient()
  useEffect(
    () =>
      realtime.subscribe(() => {
        client.invalidateQueries()
      }),
    [client],
  )
  return null
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TooltipProvider delayDuration={200}>
          <RealtimeBridge />
          <RouterProvider router={router} />
          <Toaster theme="light" position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>
  )
}
