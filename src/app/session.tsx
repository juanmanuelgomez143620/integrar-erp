import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, auth, currentUserId } from '@/lib/api'

interface SessionValue {
  userId: string | null
  login: (username: string, password: string) => Promise<void>
  loginAs: (username: string) => Promise<void>
  logout: () => void
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(() => currentUserId())
  const queryClient = useQueryClient()

  const login = useCallback(
    async (username: string, password: string) => {
      const id = await auth.login(username, password)
      queryClient.clear()
      setUserId(id)
    },
    [queryClient],
  )

  const loginAs = useCallback(
    async (username: string) => {
      const id = await auth.loginAs(username)
      queryClient.clear()
      setUserId(id)
    },
    [queryClient],
  )

  const logout = useCallback(() => {
    auth.logout()
    queryClient.clear()
    setUserId(null)
  }, [queryClient])

  const value = useMemo(() => ({ userId, login, loginAs, logout }), [userId, login, loginAs, logout])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession fuera de SessionProvider')
  return ctx
}

export function useMe() {
  const { userId } = useSession()
  return useQuery({ queryKey: ['me', userId], queryFn: api.me, enabled: !!userId })
}
