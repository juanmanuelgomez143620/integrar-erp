// Listas de materiales y centros de trabajo de la demo (docs/FASE_5_PRODUCCION_Y_COSTOS.md §2 y
// §4, a validar): cuánto lleva cada unidad de cada material y cuántas horas en cada centro. Los
// usan la demo (src/lib/mock/seed.ts), la plantilla de Supabase (scripts/generate-demo-sql.mjs) y
// las empresas creadas antes de la Fase 5. Con los costos de conversión, el costo de cada mueble
// queda cerca de su costo estándar.

/** Centros de trabajo del taller, con sus tarifas por hora (a validar). */
// prettier-ignore
export const DEMO_WORK_CENTERS: { code: string; name: string; labor_rate: number; overhead_rate: number }[] = [
  // Sierras y cepilladoras: la carga fabril es alta (energía, mantenimiento, amortización).
  { code: 'CORTE', name: 'Corte y cepillado', labor_rate: 9000, overhead_rate: 7000 },
  { code: 'ARMADO', name: 'Armado', labor_rate: 8500, overhead_rate: 3500 },
  { code: 'TERMINACION', name: 'Terminación (lijado, barnizado y embalaje)', labor_rate: 8000, overhead_rate: 4000 },
  // La línea de living con tapicería (Fase 9b.2): mesas de trabajo y máquinas de coser, poca carga fabril.
  { code: 'TAPICERIA', name: 'Tapicería', labor_rate: 8200, overhead_rate: 2500 },
]

/** Horas por unidad de cada mueble en cada centro de trabajo (la ruta simplificada, a validar). */
// prettier-ignore
export const DEMO_BOM_OPERATIONS: { product: string; operations: [string, number][] }[] = [
  { product: 'PT-001', operations: [['CORTE', 2.5], ['ARMADO', 1.5], ['TERMINACION', 1]] },
  { product: 'PT-002', operations: [['CORTE', 0.6], ['ARMADO', 0.6], ['TERMINACION', 0.5]] },
  { product: 'PT-003', operations: [['CORTE', 1.5], ['ARMADO', 2], ['TERMINACION', 0.5]] },
  { product: 'PT-004', operations: [['CORTE', 1.5], ['ARMADO', 1.5], ['TERMINACION', 1.1]] },
  // Las líneas nuevas de la empresa que crece (Fase 9b.2).
  { product: 'PT-005', operations: [['CORTE', 0.8], ['ARMADO', 0.8], ['TERMINACION', 0.6]] },
  { product: 'PT-006', operations: [['CORTE', 1.2], ['ARMADO', 1.8], ['TERMINACION', 0.5]] },
  { product: 'PT-007', operations: [['CORTE', 1], ['ARMADO', 1.2], ['TERMINACION', 0.4]] },
  { product: 'PT-008', operations: [['CORTE', 1.2], ['ARMADO', 1], ['TERMINACION', 0.4]] },
  { product: 'PT-009', operations: [['CORTE', 0.7], ['ARMADO', 0.7], ['TERMINACION', 0.4]] },
  { product: 'PT-010', operations: [['CORTE', 0.6], ['ARMADO', 0.6], ['TERMINACION', 0.3], ['TAPICERIA', 0.5]] },
  { product: 'PT-011', operations: [['CORTE', 1], ['ARMADO', 1.5], ['TAPICERIA', 2.5]] },
  { product: 'PT-012', operations: [['CORTE', 2], ['ARMADO', 3], ['TAPICERIA', 5]] },
]

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
  // Las líneas nuevas de la empresa que crece (Fase 9b.2). Mesa de luz de pino: la tapa, el bastidor y el cajón.
  { product: 'PT-005', components: [['MP-007', 0.4], ['MP-003', 4], ['MP-005', 0.2], ['IN-005', 1], ['IN-011', 1], ['IN-001', 0.1], ['IN-002', 0.5], ['IN-003', 0.05], ['IN-006', 2], ['IN-007', 0.05]] },
  // Cómoda de MDF de 4 cajones.
  { product: 'PT-006', components: [['MP-004', 1.5], ['MP-005', 1], ['IN-005', 4], ['IN-011', 4], ['IN-010', 0.3], ['IN-003', 0.15], ['IN-007', 0.15]] },
  // Escritorio de MDF de 1,20 m con un cajón.
  { product: 'PT-007', components: [['MP-004', 1], ['MP-005', 0.3], ['IN-005', 1], ['IN-011', 1], ['IN-010', 0.2], ['IN-003', 0.1], ['IN-007', 0.1]] },
  // Biblioteca de MDF de 5 estantes.
  { product: 'PT-008', components: [['MP-004', 1.5], ['MP-005', 1], ['IN-010', 0.4], ['IN-003', 0.15], ['IN-007', 0.15]] },
  // Pupitre escolar: la tapa fenólica y la estructura de pino.
  { product: 'PT-009', components: [['MP-006', 0.25], ['MP-003', 8], ['IN-001', 0.1], ['IN-002', 0.4], ['IN-003', 0.05], ['IN-006', 2], ['IN-007', 0.05]] },
  // Silla tapizada de eucalipto: la de comedor con el asiento de espuma y tela.
  { product: 'PT-010', components: [['MP-002', 16], ['MP-008', 0.6], ['MP-009', 0.15], ['IN-008', 0.02], ['IN-001', 0.1], ['IN-002', 0.3], ['IN-003', 0.04], ['IN-006', 2], ['IN-007', 0.03]] },
  // Sillón tapizado de 1 cuerpo: la estructura, la base, las cinchas, la espuma y la tela.
  { product: 'PT-011', components: [['MP-003', 20], ['MP-006', 0.3], ['MP-008', 4], ['MP-009', 1], ['IN-009', 0.2], ['IN-008', 0.1], ['IN-001', 0.2], ['IN-003', 0.08], ['IN-007', 0.2]] },
  // Sofá tapizado de 3 cuerpos.
  { product: 'PT-012', components: [['MP-003', 50], ['MP-006', 0.8], ['MP-008', 10], ['MP-009', 2.5], ['IN-009', 0.5], ['IN-008', 0.25], ['IN-001', 0.4], ['IN-003', 0.2], ['IN-007', 0.4]] },
]
