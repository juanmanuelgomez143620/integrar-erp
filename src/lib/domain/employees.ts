// Convenios, categorías y legajos del personal de la demo (docs/FASE_6_RRHH_Y_SUELDOS.md §2 y
// docs/FASE_6D_CONVENIOS.md §1, a validar). Los usan la demo (src/lib/mock/seed.ts), la plantilla
// de Supabase (scripts/generate-demo-sql.mjs) y las empresas creadas antes. Son personajes de la
// empresa simulada: nombre y apellido inventados, sin documento ni otros datos personales. Las
// escalas y los porcentajes son ficticios pero proporcionados (no los de las paritarias vigentes),
// y el valor hora del taller guarda relación con las tarifas de los centros de trabajo.

/** Las horas de un mes completo de quien cobra por hora: 22 días de 8 horas (a validar). */
export const MONTH_HOURS = 176

/** Los convenios colectivos de la demo, con sus adicionales y aportes (a validar). */
// prettier-ignore
export const DEMO_LABOR_AGREEMENTS: {
  code: string
  name: string
  union_name: string
  pay_basis: 'MONTHLY' | 'HOURLY'
  seniority_pct: number
  attendance_pct: number
  union_pct: number
  union_employer_pct: number
}[] = [
  { code: 'MADERA', name: 'Industria de la madera', union_name: 'UOMA', pay_basis: 'HOURLY', seniority_pct: 1, attendance_pct: 10, union_pct: 2, union_employer_pct: 1 },
  { code: 'COMERCIO', name: 'Empleados de Comercio (CCT 130/75)', union_name: 'Empleados de Comercio', pay_basis: 'MONTHLY', seniority_pct: 1, attendance_pct: 8.33, union_pct: 2.5, union_employer_pct: 1 },
  { code: 'CAMIONEROS', name: 'Camioneros (CCT 40/89)', union_name: 'Camioneros', pay_basis: 'MONTHLY', seniority_pct: 1, attendance_pct: 0, union_pct: 3, union_employer_pct: 2 },
  { code: 'FUERA', name: 'Fuera de convenio', union_name: '', pay_basis: 'MONTHLY', seniority_pct: 0, attendance_pct: 0, union_pct: 0, union_employer_pct: 0 },
]

/**
 * Las categorías, cada una de un convenio: con básico mensual o, en los convenios por hora,
 * valor hora (a validar). En el taller, el valor hora de un mes completo equivale al básico de antes.
 */
// prettier-ignore
export const DEMO_JOB_CATEGORIES: {
  code: string
  name: string
  agreement: string
  basic_salary: number
  is_direct_labor: boolean
}[] = [
  { code: 'OFICIAL', name: 'Oficial carpintero', agreement: 'MADERA', basic_salary: 7100, is_direct_labor: true },
  { code: 'MEDIO-OF', name: 'Medio oficial', agreement: 'MADERA', basic_salary: 6250, is_direct_labor: true },
  { code: 'AYUDANTE', name: 'Ayudante de taller', agreement: 'MADERA', basic_salary: 5400, is_direct_labor: true },
  { code: 'ADMIN', name: 'Administrativo', agreement: 'COMERCIO', basic_salary: 1050000, is_direct_labor: false },
  { code: 'VENDEDOR', name: 'Vendedor', agreement: 'COMERCIO', basic_salary: 1000000, is_direct_labor: false },
  { code: 'OPERARIO', name: 'Operario de depósito', agreement: 'MADERA', basic_salary: 5570, is_direct_labor: false },
  { code: 'ENCARGADO', name: 'Encargado general', agreement: 'FUERA', basic_salary: 1500000, is_direct_labor: false },
  { code: 'CHOFER', name: 'Chofer', agreement: 'CAMIONEROS', basic_salary: 1150000, is_direct_labor: false },
]

/** El personal: seis en el taller (dos por centro de trabajo) y cinco en las demás áreas (a validar). */
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
  { file_number: 11, first_name: 'Walter', last_name: 'Aguirre', hire_date: '2020-08-03', category: 'CHOFER', sector: 'LOG', work_center: null },
]
