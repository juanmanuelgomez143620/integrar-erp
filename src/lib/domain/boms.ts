// Listas de materiales de los muebles de la demo (docs/FASE_5_PRODUCCION_Y_COSTOS.md §2, a validar):
// cuánto lleva cada unidad. Las usan la demo (src/lib/mock/seed.ts), la plantilla de
// Supabase (scripts/generate-demo-sql.mjs) y las empresas creadas antes de la Fase 5.
// Con los costos de conversión (5b), el costo de cada mueble queda cerca de su costo estándar.

// prettier-ignore
export const DEMO_BOMS: { product: string; components: [string, number][] }[] = [
  // Mesa de comedor de pino: la tapa, las patas y el bastidor, los faldones y la terminación.
  { product: 'PT-001', components: [['MP-007', 1], ['MP-003', 24], ['MP-001', 10], ['IN-001', 0.3], ['IN-002', 1.5], ['IN-003', 0.1], ['IN-006', 6], ['IN-007', 0.1]] },
  // Silla de eucalipto.
  { product: 'PT-002', components: [['MP-002', 18], ['IN-001', 0.1], ['IN-002', 0.4], ['IN-003', 0.04], ['IN-006', 2], ['IN-007', 0.03]] },
  // Placard de MDF de 2 puertas, con cajones.
  { product: 'PT-003', components: [['MP-004', 2], ['MP-005', 1], ['IN-004', 4], ['IN-005', 2], ['IN-003', 0.2], ['IN-007', 0.2]] },
  // Cama de 2 plazas de eucalipto: la estructura, el bastidor y la base.
  { product: 'PT-004', components: [['MP-002', 60], ['MP-003', 30], ['MP-006', 0.5], ['IN-001', 0.3], ['IN-002', 1.5], ['IN-003', 0.15], ['IN-006', 6], ['IN-007', 0.15]] },
]
