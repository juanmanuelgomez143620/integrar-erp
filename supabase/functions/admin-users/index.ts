// Edge Function "admin-users" (Deno). La lógica está en handler.ts.
//
// Variables: SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY las
// provee Supabase. Con las claves nuevas, cargar SUPABASE_PUBLISHABLE_KEY y
// SUPABASE_SECRET_KEY como secretos. AUTH_EMAIL_DOMAIN tiene que coincidir con
// VITE_AUTH_EMAIL_DOMAIN del sitio (ver supabase/README.md).

import { DEFAULT_EMAIL_DOMAIN, handle } from './handler.ts'

const env = (...names: string[]) => names.map((name) => Deno.env.get(name)).find(Boolean) ?? ''

Deno.serve((req) =>
  handle(req, {
    url: env('SUPABASE_URL'),
    publicKey: env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'),
    serviceKey: env('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    emailDomain: env('AUTH_EMAIL_DOMAIN') || DEFAULT_EMAIL_DOMAIN,
  }),
)
