/// <reference types="vite/client" />

// Variables del sitio (docs/INSTANCIAS.md §5). Sin VITE_BACKEND=supabase, la
// aplicación usa el backend simulado del navegador (la demostración).
interface ImportMetaEnv {
  readonly VITE_BACKEND?: 'mock' | 'supabase'
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_AUTH_EMAIL_DOMAIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
