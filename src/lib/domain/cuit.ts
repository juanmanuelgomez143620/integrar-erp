// El CUIT simulado (formato 30-12345678-9) y su dígito verificador, calculado como el oficial: los
// pesos 5, 4, 3, 2, 7, 6, 5, 4, 3, 2; si da 11 vale 0 y si da 10 el CUIT no es válido.

const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]

/** Si el CUIT tiene el formato 30-12345678-9 y su dígito verificador coincide. */
export function cuitIsValid(cuit: string): boolean {
  if (!/^\d{2}-\d{8}-\d$/.test(cuit)) return false
  const digits = cuit.replaceAll('-', '')
  const dv = 11 - (WEIGHTS.reduce((sum, w, i) => sum + w * Number(digits[i]), 0) % 11)
  return dv !== 10 && Number(digits[10]) === (dv === 11 ? 0 : dv)
}
