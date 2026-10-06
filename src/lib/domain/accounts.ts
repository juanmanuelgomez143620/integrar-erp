// Cuentas en Supabase Auth. La escuela ve usuarios ("jgomez"), nunca emails: a
// cada usuario le corresponde un email sintético de un dominio que no recibe
// correo, así no se piden ni se guardan emails de estudiantes (ARCHITECTURE.md §8).

/**
 * Dominio por defecto. Cada instancia puede fijar el suyo con
 * VITE_AUTH_EMAIL_DOMAIN (sitio) y AUTH_EMAIL_DOMAIN (Edge Function "admin-users"):
 * los dos tienen que coincidir.
 */
export const DEFAULT_AUTH_EMAIL_DOMAIN = 'cuentas.integrar.invalid'

export function accountEmail(username: string, domain: string = DEFAULT_AUTH_EMAIL_DOMAIN): string {
  return `${username.trim().toLowerCase()}@${domain}`
}
