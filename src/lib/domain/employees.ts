// Categorías y legajos del personal de la demo (docs/FASE_6_RRHH_Y_SUELDOS.md §2, a validar).
// Los usan la demo (src/lib/mock/seed.ts), la plantilla de Supabase (scripts/generate-demo-sql.mjs)
// y las empresas creadas antes de la Fase 6. Son personajes de la empresa simulada: nombre y
// apellido inventados, sin documento ni otros datos personales. Los sueldos del taller guardan
// relación con las tarifas de mano de obra de los centros de trabajo (src/lib/domain/boms.ts).

/** Categorías de un convenio simplificado, con su sueldo básico mensual (a validar). */
// prettier-ignore
export const DEMO_JOB_CATEGORIES: { code: string; name: string; basic_salary: number; is_direct_labor: boolean }[] = [
  { code: 'OFICIAL', name: 'Oficial carpintero', basic_salary: 1250000, is_direct_labor: true },
  { code: 'MEDIO-OF', name: 'Medio oficial', basic_salary: 1100000, is_direct_labor: true },
  { code: 'AYUDANTE', name: 'Ayudante de taller', basic_salary: 950000, is_direct_labor: true },
  { code: 'ADMIN', name: 'Administrativo', basic_salary: 1050000, is_direct_labor: false },
  { code: 'VENDEDOR', name: 'Vendedor', basic_salary: 1000000, is_direct_labor: false },
  { code: 'OPERARIO', name: 'Operario de depósito', basic_salary: 980000, is_direct_labor: false },
  { code: 'ENCARGADO', name: 'Encargado general', basic_salary: 1500000, is_direct_labor: false },
]

/** El personal: seis en el taller (dos por centro de trabajo) y cuatro en las demás áreas (a validar). */
// prettier-ignore
export const DEMO_EMPLOYEES: {
  file_number: number
  first_name: string
  last_name: string
  hire_date: string
  category: string
  sector: string
  work_center: string | null
}[] = [
  { file_number: 1, first_name: 'Graciela', last_name: 'Paz', hire_date: '2015-03-02', category: 'ENCARGADO', sector: 'GER', work_center: null },
  { file_number: 2, first_name: 'Ramón', last_name: 'Ortiz', hire_date: '2015-04-06', category: 'OFICIAL', sector: 'PRO', work_center: 'CORTE' },
  { file_number: 3, first_name: 'Jorge', last_name: 'Cabral', hire_date: '2016-08-01', category: 'OFICIAL', sector: 'PRO', work_center: 'ARMADO' },
  { file_number: 4, first_name: 'Patricia', last_name: 'Núñez', hire_date: '2017-06-05', category: 'ADMIN', sector: 'CON', work_center: null },
  { file_number: 5, first_name: 'Hugo', last_name: 'Ledesma', hire_date: '2018-10-01', category: 'MEDIO-OF', sector: 'PRO', work_center: 'TERMINACION' },
  { file_number: 6, first_name: 'Néstor', last_name: 'Galeano', hire_date: '2019-03-11', category: 'MEDIO-OF', sector: 'PRO', work_center: 'CORTE' },
  { file_number: 7, first_name: 'Marcela', last_name: 'Ríos', hire_date: '2019-09-02', category: 'VENDEDOR', sector: 'VEN', work_center: null },
  { file_number: 8, first_name: 'Elena', last_name: 'Duarte', hire_date: '2020-02-03', category: 'MEDIO-OF', sector: 'PRO', work_center: 'ARMADO' },
  { file_number: 9, first_name: 'Oscar', last_name: 'Villalba', hire_date: '2021-01-04', category: 'OPERARIO', sector: 'DEP', work_center: null },
  { file_number: 10, first_name: 'Silvia', last_name: 'Romero', hire_date: '2023-05-02', category: 'AYUDANTE', sector: 'PRO', work_center: 'TERMINACION' },
]
