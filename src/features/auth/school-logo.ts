/**
 * La dirección del logo de la escuela (de school_settings, nunca del código: CA-15): una imagen embebida en
 * el simulador o un archivo público del Storage de Supabase.
 */
export function schoolLogoUrl(path: string | null | undefined): string | null {
  if (!path) return null
  return path.startsWith('data:') ? path : `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${path}`
}
