// Transportistas y vehículos de la demo (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §4, a
// validar). Los usan la demo (src/lib/mock/seed.ts), la plantilla de Supabase
// (scripts/generate-demo-sql.mjs) y las empresas creadas antes. Datos ficticios: el primer
// transportista es el mismo proveedor de fletes de la demo (PRV-008), con su CUIT simulado.

/** Los fletes contratados. */
// prettier-ignore
export const DEMO_CARRIERS: { code: string; legal_name: string; tax_id: string; phone: string }[] = [
  { code: 'TR-001', legal_name: 'Transportes Ruta 12 SRL', tax_id: '30-00000107-0', phone: '' },
  { code: 'TR-002', legal_name: 'Expreso Tierra Colorada SRL', tax_id: '30-00000111-9', phone: '' },
]

/** Los vehículos propios: el camión que maneja el chofer (legajo 11). */
// prettier-ignore
export const DEMO_VEHICLES: { code: string; plate: string; description: string }[] = [
  { code: 'CAM-01', plate: 'AF 512 MS', description: 'Camión con caja cerrada para muebles (3,5 t)' },
]
