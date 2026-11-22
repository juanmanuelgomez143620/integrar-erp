// Transportistas y vehículos de la demo (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §4, a
// validar). Los usan la demo (src/lib/mock/seed.ts), la plantilla de Supabase
// (scripts/generate-demo-sql.mjs) y las empresas creadas antes. Datos ficticios: el primer
// transportista es el mismo proveedor de fletes de la demo (PRV-008), con su CUIT simulado.

/** Los fletes contratados. */
// prettier-ignore
export const DEMO_CARRIERS: { code: string; legal_name: string; tax_id: string; phone: string }[] = [
  { code: 'TR-001', legal_name: 'Transportes Ruta 12 SRL', tax_id: '30-00000107-0', phone: '' },
  { code: 'TR-002', legal_name: 'Expreso Tierra Colorada SRL', tax_id: '30-00000111-9', phone: '' },
  // La empresa que crece (Fase 9c.2): un flete de Corrientes para los viajes largos (el del banco ficticio).
  { code: 'TR-003', legal_name: 'Logística Lapacho SRL', tax_id: '30-00000315-4', phone: '' },
]

/**
 * Las zonas de reparto de la demo (Fase 9c.1, a validar), con sus días (de lunes, 1, a sábado, 6) y las
 * localidades de sus clientes: cada cliente de la demo queda en la zona de su localidad.
 */
// prettier-ignore
export const DEMO_DELIVERY_ZONES: { code: string; name: string; delivery_days: number[]; notes: string; cities: string[] }[] = [
  { code: 'Z-ELD', name: 'Eldorado y Alto Paraná', delivery_days: [1, 3, 5], notes: 'Por la ruta 12, de Puerto Iguazú a Jardín América.', cities: ['Eldorado', 'Puerto Iguazú', 'Jardín América'] },
  { code: 'Z-POS', name: 'Posadas y sur', delivery_days: [2, 4], notes: '', cities: ['Posadas', 'Apóstoles'] },
  { code: 'Z-CEN', name: 'Centro de Misiones', delivery_days: [3], notes: 'Por la ruta 14.', cities: ['Oberá', 'Leandro N. Alem', 'Aristóbulo del Valle'] },
  { code: 'Z-COR', name: 'Corrientes', delivery_days: [4], notes: '', cities: ['Corrientes', 'Santo Tomé', 'Gobernador Virasoro', 'Goya'] },
  { code: 'Z-CHA', name: 'Chaco', delivery_days: [5], notes: 'Viaje largo: conviene un camión con transportista.', cities: ['Resistencia', 'Presidencia Roque Sáenz Peña'] },
]

/**
 * Los vehículos propios: el camión que maneja el chofer (legajo 11) y, con la empresa que crece (Fase 9c.2),
 * un segundo camión y dos furgones para los repartos de la ciudad, para los cuatro choferes.
 */
// prettier-ignore
export const DEMO_VEHICLES: { code: string; plate: string; description: string }[] = [
  { code: 'CAM-01', plate: 'AF 512 MS', description: 'Camión con caja cerrada para muebles (3,5 t)' },
  { code: 'CAM-02', plate: 'AG 145 KM', description: 'Camión con caja cerrada para muebles (3,5 t)' },
  { code: 'FUR-01', plate: 'AH 233 PL', description: 'Furgón utilitario para las entregas de la ciudad' },
  { code: 'FUR-02', plate: 'AH 871 RT', description: 'Furgón utilitario para las entregas de la ciudad' },
]
