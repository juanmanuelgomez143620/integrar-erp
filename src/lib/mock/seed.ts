// Datos de demostración: empresa plantilla FORESTAL DEL NORTE SRL (ficticia).
// Todos los nombres, CUIT y domicilios son simulados. Ver DATABASE.md §16.
//
// Credenciales de prueba (sólo backend simulado local): todos los usuarios
// demo usan la contraseña DEMO_PASSWORD.

import { DEMO_BOM_OPERATIONS, DEMO_BOMS, DEMO_WORK_CENTERS } from '../domain/boms'
import { DEMO_EMPLOYEES, DEMO_JOB_CATEGORIES, DEMO_LABOR_AGREEMENTS } from '../domain/employees'
import { DEMO_CARRIERS, DEMO_DELIVERY_ZONES, DEMO_VEHICLES } from '../domain/logistics'
import type * as T from '../domain/types'
import type { DB } from './db'
import { DB_VERSION, DEFAULT_SESSION_TIMEOUT_MINUTES } from './db'
import { BANK_CUSTOMERS, BANK_SUPPLIERS } from './partner-bank'
import {
  cmdApprovePurchaseOrder,
  cmdCreateDeliveryNote,
  cmdCreateFundsTransfer,
  cmdCreateGoodsReceipt,
  cmdCreateJournalEntry,
  cmdCreatePaymentOrder,
  cmdCreateProductionOrder,
  cmdCreatePurchaseOrder,
  cmdCreateRequisition,
  cmdCreateRfq,
  cmdCreateSalesOrder,
  cmdCreateStockAdjustment,
  cmdCreateSupplierInvoice,
  cmdCreateSupplierQuote,
  cmdSendPurchaseOrder,
  cmdSubmitPurchaseOrder,
  insertBomOperations,
  insertBoms,
  insertCarriers,
  insertEmployees,
  insertJobCategories,
  insertLaborAgreements,
  insertVehicles,
  insertWorkCenters,
  openBankAccount,
  scanStockAlerts,
  insertPadron,
  openPointOfSale,
  startAccounting,
  type Ctx,
} from './engine'
import { addDays, todayAR } from '../format'

export const DEMO_PASSWORD = 'demo1234'

/**
 * CUIT simulado con dígito verificador válido (rango reservado 000000xx). Como el oficial: si el
 * dígito da 10, la empresa pasa al prefijo 33 (y el dígito queda en 9).
 */
function cuit(prefix: number, body: number): string {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const digit = (p: number) => {
    const digits = `${p}${String(body).padStart(8, '0')}`
    const dv = 11 - (digits.split('').reduce((s, d, i) => s + Number(d) * weights[i], 0) % 11)
    return dv === 11 ? 0 : dv
  }
  const dv = digit(prefix)
  if (dv === 10) return `33-${String(body).padStart(8, '0')}-${digit(33)}`
  return `${prefix}-${String(body).padStart(8, '0')}-${dv}`
}

let counter = 0
/**
 * El segundo integrante de Impuestos (Fase 8e.1): el fisco lo opera Impuestos y quien preparó o
 * presentó una declaración no la recibe (SoD-15), así que en la demo recibe lo que presenta
 * `contabilidad`. También lo recibe la empresa demo de una base guardada antes.
 */
export function addDemoTaxOfficer(db: DB, companyId: string, now: string) {
  if (db.profiles.some((p) => p.username === 'impuestos2')) return
  const sector = db.sectors.find((s) => s.company_id === companyId && s.code === 'IMP')
  const profile: T.Profile = {
    id: 'usr-impuestos2',
    username: 'impuestos2',
    password: DEMO_PASSWORD,
    first_name: 'Paula',
    last_name: 'Quiroga',
    app_role: 'ESTUDIANTE',
    is_active: true,
    must_change_password: false,
    created_at: now,
  }
  db.profiles.push(profile)
  const member = {
    id: id('mbr'),
    company_id: companyId,
    user_id: profile.id,
    job_title: 'Analista de Impuestos',
    is_active: true,
  }
  db.members.push(member)
  db.memberRoles.push({
    id: id('mro'),
    company_id: companyId,
    member_id: member.id,
    role_code: 'IMPUESTOS',
    sector_id: sector?.id ?? null,
  })
}

/**
 * El segundo integrante de Tesorería (Fase 8a): el Banco Aula lo opera Tesorería y quien envía una
 * orden no la procesa (SoD-12), así que en la demo procesa lo que envía `tesoreria`. También lo
 * recibe la empresa demo de una base guardada antes.
 */
export function addDemoTreasurer(db: DB, companyId: string, now: string) {
  if (db.profiles.some((p) => p.username === 'tesoreria2')) return
  const sector = db.sectors.find((s) => s.company_id === companyId && s.code === 'TES')
  const profile: T.Profile = {
    id: 'usr-tesoreria2',
    username: 'tesoreria2',
    password: DEMO_PASSWORD,
    first_name: 'Tomás',
    last_name: 'Medina',
    app_role: 'ESTUDIANTE',
    is_active: true,
    must_change_password: false,
    created_at: now,
  }
  db.profiles.push(profile)
  const member = {
    id: id('mbr'),
    company_id: companyId,
    user_id: profile.id,
    job_title: 'Analista de Tesorería',
    is_active: true,
  }
  db.members.push(member)
  db.memberRoles.push({
    id: id('mro'),
    company_id: companyId,
    member_id: member.id,
    role_code: 'TESORERIA',
    sector_id: sector?.id ?? null,
  })
}

/**
 * Los proveedores del banco ficticio que suma la empresa que crece (Fase 9b.1, a validar): placas y
 * tableros, aserraderos, barnices, herrajes, embalajes, bulonería y tapicería.
 */
const DEMO_BANK_SUPPLIERS = [
  'PRV-101',
  'PRV-102',
  'PRV-103',
  'PRV-106',
  'PRV-107',
  'PRV-113',
  'PRV-114',
  'PRV-117',
  'PRV-122',
  'PRV-123',
]

const id = (prefix: string) => `${prefix}-${String(++counter).padStart(4, '0')}-${crypto.randomUUID().slice(0, 8)}`

export function buildSeed(): DB {
  counter = 0
  const now = new Date().toISOString()
  const db: DB = {
    version: DB_VERSION,
    seededAt: now,
    seq: { audit: 0, movement: 0 },
    school: {
      official_name: 'Escuela Normal Superior N.º 9',
      short_name: 'ENS N.º 9',
      city: '',
      province: '',
      contact_email: '',
      session_timeout_minutes: DEFAULT_SESSION_TIMEOUT_MINUTES,
      features: {},
    },
    profiles: [],
    courses: [],
    companies: [],
    islands: [],
    sectors: [],
    warehouses: [],
    members: [],
    memberRoles: [],
    companyModules: [],
    customers: [],
    suppliers: [],
    products: [],
    documentSequences: [],
    documents: [],
    prLines: [],
    poLines: [],
    grLines: [],
    saLines: [],
    jeLines: [],
    siLines: [],
    opLines: [],
    rfqLines: [],
    rfqSuppliers: [],
    sqLines: [],
    brLines: [],
    soLines: [],
    dnLines: [],
    fvLines: [],
    rcLines: [],
    qtLines: [],
    priceLists: [],
    priceListItems: [],
    boms: [],
    bomLines: [],
    prdLines: [],
    workCenters: [],
    bomOperations: [],
    prdOperations: [],
    laborAgreements: [],
    carriers: [],
    vehicles: [],
    deliveryZones: [],
    environmentWeeks: [],
    deliveryNotices: [],
    staffNovelties: [],
    scenarioRuns: [],
    rsLines: [],
    bankAccounts: [],
    bankMovements: [],
    bankClosings: [],
    bankLoans: [],
    bankLoanInstallments: [],
    taxpayers: [],
    pointsOfSale: [],
    fiscalNotices: [],
    jobCategories: [],
    employees: [],
    pyLines: [],
    postingRules: [],
    accounts: [],
    fiscalYears: [],
    fiscalPeriods: [],
    docLinks: [],
    stockMovements: [],
    stockBalances: [],
    approvalRules: [],
    approvalRequests: [],
    tasks: [],
    notifications: [],
    audit: [],
  }

  // ------------------------------------------------------------ Escuela y curso
  const course: T.Course = {
    id: id('crs'),
    academic_year: 2027,
    name: '5.º A',
    orientation: 'Gestión y Administración de las Organizaciones',
  }
  db.courses.push(course)

  // ------------------------------------------------------------ Empresa
  const companyId = id('cmp')
  db.companies.push({
    id: companyId,
    course_id: course.id,
    slug: 'forestal-del-norte',
    legal_name: 'Forestal del Norte SRL',
    trade_name: 'Forestal del Norte',
    tax_id: cuit(30, 1),
    vat_condition: 'RESPONSABLE_INSCRIPTO',
    activity: 'Fabricación de muebles y productos derivados de la madera',
    address_line: 'Av. de los Pioneros 1500 (domicilio ficticio)',
    city: 'Eldorado',
    province: 'Misiones',
    start_date: '2015-03-02',
    is_template: true,
    status: 'ACTIVA',
    settings: { sod_enabled: true, allow_negative_stock: false },
    created_at: now,
  })

  const islandNames = [
    'Gerencia y Control de Gestión',
    'Compras',
    'Ventas y Clientes',
    'Contabilidad e Impuestos',
    'Tesorería y Finanzas',
    'RRHH y Sueldos',
    'Producción y Costos',
    'Depósito y Logística',
  ]
  const islands = islandNames.map((name, i) => ({ id: id('isl'), company_id: companyId, number: i + 1, name }))
  db.islands.push(...islands)

  // prettier-ignore
  const sectorDefs: [string, string, number][] = [
    ['GER', 'Gerencia', 1], ['CGE', 'Control de Gestión', 1], ['COM', 'Compras', 2], ['VEN', 'Ventas', 3],
    ['CON', 'Contabilidad', 4], ['IMP', 'Impuestos', 4], ['TES', 'Tesorería y Finanzas', 5], ['RRH', 'RRHH y Sueldos', 6],
    ['PRO', 'Producción', 7], ['COS', 'Costos', 7], ['DEP', 'Depósito', 8], ['LOG', 'Logística', 8],
  ]
  const sector: Record<string, string> = {}
  for (const [code, name, island] of sectorDefs) {
    const s = { id: id('sec'), company_id: companyId, code, name, island_id: islands[island - 1].id }
    sector[code] = s.id
    db.sectors.push(s)
  }

  const whMP = { id: id('wh'), company_id: companyId, code: 'DEP-MP', name: 'Depósito de materias primas e insumos' }
  const whPT = { id: id('wh'), company_id: companyId, code: 'DEP-PT', name: 'Depósito de productos terminados' }
  db.warehouses.push(whMP, whPT)

  for (const module of ['masters', 'purchasing', 'inventory', 'accounting', 'management', 'audit'] as T.ModuleCode[]) {
    db.companyModules.push({ company_id: companyId, module_code: module, is_enabled: true })
  }

  // prettier-ignore
  db.approvalRules.push(
    { id: id('apr'), company_id: companyId, doc_type: 'PURCHASE_ORDER', level: 1, min_amount: 0, max_amount: 500000, approver_role: 'COMPRAS', require_different_user: true, is_active: true, description: 'Órdenes de hasta $ 500.000 (IVA incluido): las aprueba otro integrante de Compras.' },
    { id: id('apr'), company_id: companyId, doc_type: 'PURCHASE_ORDER', level: 1, min_amount: 500000.01, max_amount: null, approver_role: 'GERENCIA', require_different_user: true, is_active: true, description: 'Órdenes de más de $ 500.000 (IVA incluido): las aprueba Gerencia.' },
  )

  // ------------------------------------------------------------ Usuarios demo
  const users: Record<string, string> = {}
  const addUser = (
    username: string,
    first: string,
    last: string,
    appRole: T.AppRole,
    roles: [T.RoleCode, string | null][],
    jobTitle: string,
  ) => {
    const profile: T.Profile = {
      id: `usr-${username}`, // estable: la sesión sobrevive a un reinicio de datos
      username,
      password: DEMO_PASSWORD,
      first_name: first,
      last_name: last,
      app_role: appRole,
      is_active: true,
      must_change_password: false,
      created_at: now,
    }
    db.profiles.push(profile)
    users[username] = profile.id
    if (roles.length) {
      const member = { id: id('mbr'), company_id: companyId, user_id: profile.id, job_title: jobTitle, is_active: true }
      db.members.push(member)
      for (const [role, sectorCode] of roles) {
        db.memberRoles.push({
          id: id('mro'),
          company_id: companyId,
          member_id: member.id,
          role_code: role,
          sector_id: sectorCode ? sector[sectorCode] : null,
        })
      }
    }
  }
  addUser('admin', 'Coordinación', 'ENS N.º 9', 'ADMIN', [], 'Administración escolar')
  addUser('docente', 'Laura', 'Martínez', 'DOCENTE', [['DOCENTE', null]], 'Docente a cargo')
  addUser('gerencia', 'María', 'López', 'ESTUDIANTE', [['GERENCIA', 'GER']], 'Gerente general')
  addUser('auditor', 'Sofía', 'Acosta', 'ESTUDIANTE', [['AUDITOR', 'CGE']], 'Auditora interna')
  addUser('compras1', 'Juan', 'Pérez', 'ESTUDIANTE', [['COMPRAS', 'COM']], 'Jefe de Compras')
  addUser('compras2', 'Lucía', 'Benítez', 'ESTUDIANTE', [['COMPRAS', 'COM']], 'Analista de Compras')
  addUser('ventas', 'Carlos', 'Ramírez', 'ESTUDIANTE', [['VENTAS', 'VEN']], 'Ejecutivo de Ventas')
  addUser(
    'contabilidad',
    'Diego',
    'Fernández',
    'ESTUDIANTE',
    [
      ['CONTABILIDAD', 'CON'],
      ['IMPUESTOS', 'IMP'],
    ],
    'Contador',
  )
  addUser('tesoreria', 'Valentina', 'Ruiz', 'ESTUDIANTE', [['TESORERIA', 'TES']], 'Tesorera')
  addUser('rrhh', 'Martín', 'Silva', 'ESTUDIANTE', [['RRHH', 'RRH']], 'Analista de RRHH')
  addUser('produccion', 'Ana', 'Sosa', 'ESTUDIANTE', [['PRODUCCION', 'PRO']], 'Jefa de Producción')
  addUser(
    'deposito',
    'Pedro',
    'Gómez',
    'ESTUDIANTE',
    [
      ['DEPOSITO', 'DEP'],
      ['LOGISTICA', 'LOG'],
    ],
    'Encargado de Depósito',
  )
  addDemoTreasurer(db, companyId, now)
  addDemoTaxOfficer(db, companyId, now)

  // ------------------------------------------------------------ Proveedores
  const audited = { created_at: now, created_by: null, updated_at: now, updated_by: null }
  // prettier-ignore
  const supplierDefs: [string, string, string, T.VatCondition, string, string, number][] = [
    ['PRV-001', 'Aserradero Monte Verde SRL', 'Aserradero', 'RESPONSABLE_INSCRIPTO', 'Montecarlo', 'Rubén Ayala', 5],
    ['PRV-002', 'Placas del Litoral SA', 'Placas y tableros', 'RESPONSABLE_INSCRIPTO', 'Posadas', 'Gabriela Núñez', 7],
    ['PRV-003', 'Herrajes Guaraníes SRL', 'Herrajes', 'RESPONSABLE_INSCRIPTO', 'Oberá', 'Esteban Krause', 4],
    ['PRV-004', 'Pinturería Tierra Roja', 'Pinturería', 'RESPONSABLE_INSCRIPTO', 'Eldorado', 'Mónica Vera', 2],
    ['PRV-005', 'Bulonera Central Eldorado', 'Bulonera', 'RESPONSABLE_INSCRIPTO', 'Eldorado', 'Hugo Benítez', 2],
    ['PRV-006', 'Embalajes Misioneros SA', 'Embalajes', 'RESPONSABLE_INSCRIPTO', 'Posadas', 'Cecilia Duarte', 6],
    ['PRV-007', 'Colchonera del Nordeste SRL', 'Colchones', 'RESPONSABLE_INSCRIPTO', 'Resistencia', 'Raúl Giménez', 10],
    ['PRV-008', 'Transportes Ruta 12 SRL', 'Transporte', 'RESPONSABLE_INSCRIPTO', 'Eldorado', 'Omar Ferreyra', 1],
    ['PRV-009', 'Ferretería Industrial Oberá', 'Ferretería', 'RESPONSABLE_INSCRIPTO', 'Oberá', 'Silvina Kowalczuk', 3],
    ['PRV-010', 'Servicios Técnicos Iguazú', 'Servicios', 'MONOTRIBUTO', 'Puerto Iguazú', 'Andrés Cabral', 2],
  ]
  const supplier: Record<string, string> = {}
  supplierDefs.forEach(([code, name, category, vat, city, contact, lead], i) => {
    const s: T.Supplier = {
      id: id('sup'),
      company_id: companyId,
      code,
      legal_name: name,
      trade_name: '',
      tax_id: cuit(vat === 'MONOTRIBUTO' ? 20 : 30, 100 + i),
      vat_condition: vat,
      address_line: 'Domicilio ficticio',
      city,
      province: city === 'Resistencia' ? 'Chaco' : 'Misiones',
      phone: '',
      email: '',
      contact_name: contact,
      payment_terms_days: vat === 'MONOTRIBUTO' ? 0 : 30,
      notes: '',
      is_active: true,
      lead_time_days: lead,
      category,
      ...audited,
    }
    supplier[code] = s.id
    db.suppliers.push(s)
  })

  // ------------------------------------------------------------ Zonas de reparto (Fase 9c.1, a validar)
  const zoneByCity = new Map<string, string>()
  for (const { cities, ...row } of DEMO_DELIVERY_ZONES) {
    const zone: T.DeliveryZone = { id: id('zon'), company_id: companyId, ...row, is_active: true, ...audited }
    db.deliveryZones.push(zone)
    for (const city of cities) zoneByCity.set(city, zone.id)
  }
  /** La zona de reparto de un cliente de la demo: la de su localidad. */
  const zoneOf = (city: string) => zoneByCity.get(city) ?? null

  // ------------------------------------------------------------ Clientes
  // prettier-ignore
  const customerDefs: [string, string, T.VatCondition, string, number, number | null][] = [
    ['CLI-001', 'Mueblería El Ceibo SRL', 'RESPONSABLE_INSCRIPTO', 'Posadas', 30, 4000000],
    ['CLI-002', 'Hogar Colonial SA', 'RESPONSABLE_INSCRIPTO', 'Oberá', 30, 6000000],
    ['CLI-003', 'Distribuidora Paraná Muebles SRL', 'RESPONSABLE_INSCRIPTO', 'Corrientes', 45, 8000000],
    ['CLI-004', 'Constructora Tierra Colorada SA', 'RESPONSABLE_INSCRIPTO', 'Posadas', 60, 10000000],
    ['CLI-005', 'Carpintería Don Aurelio', 'MONOTRIBUTO', 'Apóstoles', 15, 800000],
    ['CLI-006', 'Cabañas Arroyo Azul', 'MONOTRIBUTO', 'Puerto Iguazú', 15, 1500000],
    ['CLI-007', 'Instituto de Formación Profesional (ficticio)', 'EXENTO', 'Eldorado', 30, 2000000],
    ['CLI-008', 'Decoraciones Yerba Mate SRL', 'RESPONSABLE_INSCRIPTO', 'Leandro N. Alem', 30, 2500000],
    ['CLI-009', 'Consumidor final — Mostrador', 'CONSUMIDOR_FINAL', 'Eldorado', 0, null],
    ['CLI-010', 'Amoblamientos del Sur SRL', 'RESPONSABLE_INSCRIPTO', 'Posadas', 30, 3000000],
  ]
  customerDefs.forEach(([code, name, vat, city, terms, limit], i) => {
    db.customers.push({
      id: id('cus'),
      company_id: companyId,
      code,
      legal_name: name,
      trade_name: '',
      tax_id: vat === 'CONSUMIDOR_FINAL' ? '' : cuit(vat === 'MONOTRIBUTO' ? 20 : 30, 200 + i),
      vat_condition: vat,
      address_line: 'Domicilio ficticio',
      city,
      province: city === 'Corrientes' ? 'Corrientes' : 'Misiones',
      phone: '',
      email: '',
      contact_name: '',
      payment_terms_days: terms,
      credit_limit: limit,
      price_list_id: null,
      zone_id: zoneOf(city),
      notes: '',
      is_active: true,
      ...audited,
    })
  })

  // La empresa que crece (Fase 9b.1): diez proveedores, por rubro de lo que compra la empresa, y los
  // treinta clientes del banco de contribuyentes ficticios, con sus plazos y sus límites de crédito.
  for (const s of BANK_SUPPLIERS.filter((p) => DEMO_BANK_SUPPLIERS.includes(p.code))) {
    const row: T.Supplier = { ...s, id: id('sup'), company_id: companyId, is_active: true, ...audited }
    supplier[s.code] = row.id
    db.suppliers.push(row)
  }
  for (const c of BANK_CUSTOMERS)
    db.customers.push({
      ...c,
      id: id('cus'),
      company_id: companyId,
      price_list_id: null,
      zone_id: zoneOf(c.city),
      is_active: true,
      ...audited,
    })

  // ------------------------------------------------------------ Productos
  type ProductDef = [
    string,
    string,
    T.ProductType,
    string,
    number,
    number | null,
    number,
    number | null,
    string | null,
    'MP' | 'PT',
    number,
    string,
  ]
  // código, descripción, tipo, unidad, costo, precio venta, stock mínimo, reposición, proveedor, depósito, stock inicial, categoría
  // prettier-ignore
  const productDefs: ProductDef[] = [
    ['MP-001', 'Tabla de pino elliottis 1" × 6"', 'MATERIA_PRIMA', 'PIE', 1300, null, 800, 1000, 'PRV-001', 'MP', 1200, 'Madera maciza'],
    ['MP-002', 'Tabla de eucalipto grandis 1" × 8"', 'MATERIA_PRIMA', 'PIE', 1600, null, 600, 800, 'PRV-001', 'MP', 900, 'Madera maciza'],
    ['MP-003', 'Tirante de pino 2" × 3"', 'MATERIA_PRIMA', 'PIE', 1400, null, 400, 500, 'PRV-001', 'MP', 520, 'Madera maciza'],
    ['MP-004', 'Placa MDF 18 mm 1,83 × 2,60 m', 'MATERIA_PRIMA', 'UN', 92000, null, 20, 40, 'PRV-002', 'MP', 8, 'Placas y tableros'],
    ['MP-005', 'Placa MDF 5,5 mm (fondos)', 'MATERIA_PRIMA', 'UN', 38000, null, 15, 30, 'PRV-002', 'MP', 22, 'Placas y tableros'],
    ['MP-006', 'Placa fenólica 18 mm', 'MATERIA_PRIMA', 'UN', 115000, null, 10, 20, 'PRV-002', 'MP', 12, 'Placas y tableros'],
    ['MP-007', 'Tablero de pino finger joint 18 mm', 'MATERIA_PRIMA', 'UN', 105000, null, 10, 20, 'PRV-002', 'MP', 6, 'Placas y tableros'],
    ['MP-008', 'Tela chenille para tapicería', 'MATERIA_PRIMA', 'M', 14000, null, 40, 100, 'PRV-117', 'MP', 80, 'Tapicería'],
    ['MP-009', 'Espuma de poliuretano D24 (plancha 2 × 1 m × 10 cm)', 'MATERIA_PRIMA', 'UN', 38000, null, 10, 20, 'PRV-122', 'MP', 16, 'Tapicería'],
    ['IN-001', 'Cola vinílica para madera', 'INSUMO', 'KG', 6500, null, 20, 40, 'PRV-009', 'MP', 35, 'Adhesivos y terminación'],
    ['IN-002', 'Barniz poliuretánico', 'INSUMO', 'L', 18000, null, 15, 30, 'PRV-004', 'MP', 18, 'Adhesivos y terminación'],
    ['IN-003', 'Tornillo para madera 4 × 40 (caja × 500)', 'INSUMO', 'CAJA', 14000, null, 10, 20, 'PRV-005', 'MP', 14, 'Herrajes y fijaciones'],
    ['IN-004', 'Bisagra cazoleta 35 mm', 'INSUMO', 'UN', 2200, null, 100, 200, 'PRV-003', 'MP', 240, 'Herrajes y fijaciones'],
    ['IN-005', 'Corredera telescópica 45 cm', 'INSUMO', 'PAR', 9500, null, 40, 100, 'PRV-003', 'MP', 36, 'Herrajes y fijaciones'],
    ['IN-006', 'Lija grano 120', 'INSUMO', 'UN', 900, null, 100, 200, 'PRV-009', 'MP', 150, 'Adhesivos y terminación'],
    ['IN-007', 'Film stretch para embalaje', 'INSUMO', 'ROL', 16000, null, 5, 10, 'PRV-006', 'MP', 9, 'Embalaje'],
    ['IN-008', 'Grampas para tapicería (caja × 5.000)', 'INSUMO', 'CAJA', 7500, null, 2, 5, 'PRV-117', 'MP', 4, 'Tapicería'],
    ['IN-009', 'Cincha elástica para tapicería (rollo × 50 m)', 'INSUMO', 'ROL', 42000, null, 2, 4, 'PRV-122', 'MP', 3, 'Tapicería'],
    ['IN-010', 'Tapacanto de PVC 22 mm (rollo × 50 m)', 'INSUMO', 'ROL', 9800, null, 4, 10, 'PRV-101', 'MP', 8, 'Placas y tableros'],
    ['IN-011', 'Manija de aluminio 128 mm', 'INSUMO', 'UN', 1900, null, 40, 100, 'PRV-106', 'MP', 90, 'Herrajes y fijaciones'],
    ['PT-001', 'Mesa de comedor de pino 1,60 m', 'PRODUCTO_TERMINADO', 'UN', 260000, 520000, 4, null, null, 'PT', 6, 'Comedor'],
    ['PT-002', 'Silla de eucalipto', 'PRODUCTO_TERMINADO', 'UN', 62000, 125000, 12, null, null, 'PT', 30, 'Comedor'],
    ['PT-003', 'Placard de MDF 2 puertas', 'PRODUCTO_TERMINADO', 'UN', 310000, 640000, 3, null, null, 'PT', 4, 'Dormitorio'],
    ['PT-004', 'Cama 2 plazas de eucalipto', 'PRODUCTO_TERMINADO', 'UN', 290000, 580000, 3, null, null, 'PT', 5, 'Dormitorio'],
    // Las líneas nuevas de la empresa que crece (Fase 9b.2): costo = materiales + horas por las tarifas.
    ['PT-005', 'Mesa de luz de pino con cajón', 'PRODUCTO_TERMINADO', 'UN', 110000, 220000, 4, null, null, 'PT', 8, 'Dormitorio'],
    ['PT-006', 'Cómoda de MDF 4 cajones', 'PRODUCTO_TERMINADO', 'UN', 276000, 550000, 2, null, null, 'PT', 3, 'Dormitorio'],
    ['PT-007', 'Escritorio de MDF 1,20 m con cajón', 'PRODUCTO_TERMINADO', 'UN', 155000, 310000, 3, null, null, 'PT', 5, 'Oficina'],
    ['PT-008', 'Biblioteca de MDF 5 estantes', 'PRODUCTO_TERMINADO', 'UN', 220000, 440000, 2, null, null, 'PT', 3, 'Oficina'],
    ['PT-009', 'Pupitre escolar de pino y fenólico', 'PRODUCTO_TERMINADO', 'UN', 76000, 150000, 10, null, null, 'PT', 24, 'Escolar'],
    ['PT-010', 'Silla tapizada de eucalipto', 'PRODUCTO_TERMINADO', 'UN', 75000, 150000, 8, null, null, 'PT', 16, 'Living y tapizados'],
    ['PT-011', 'Sillón tapizado de 1 cuerpo', 'PRODUCTO_TERMINADO', 'UN', 232000, 465000, 2, null, null, 'PT', 3, 'Living y tapizados'],
    ['PT-012', 'Sofá tapizado de 3 cuerpos', 'PRODUCTO_TERMINADO', 'UN', 553000, 1100000, 1, null, null, 'PT', 2, 'Living y tapizados'],
    ['MR-001', 'Colchón 2 plazas (reventa)', 'MERCADERIA_REVENTA', 'UN', 240000, 390000, 4, 8, 'PRV-007', 'PT', 7, 'Reventa'],
    ['MR-002', 'Colchón 1 plaza (reventa)', 'MERCADERIA_REVENTA', 'UN', 150000, 245000, 4, 8, 'PRV-007', 'PT', 6, 'Reventa'],
    ['SV-001', 'Servicio de flete y entrega', 'SERVICIO', 'UN', 0, 45000, 0, null, 'PRV-008', 'PT', 0, 'Servicios'],
  ]
  const product: Record<string, T.Product> = {}
  for (const [code, name, type, uom, cost, price, min, reorder, supplierCode, wh, , category] of productDefs) {
    const p: T.Product = {
      id: id('prd'),
      company_id: companyId,
      code,
      name,
      description: '',
      category,
      product_type: type,
      uom_code: uom,
      is_stockable: type !== 'SERVICIO',
      standard_cost: cost,
      sale_price: price,
      vat_rate: 21,
      min_stock: min,
      reorder_qty: reorder,
      default_supplier_id: supplierCode ? supplier[supplierCode] : null,
      default_warehouse_id: wh === 'MP' ? whMP.id : whPT.id,
      location: wh === 'MP' ? 'Nave 1' : 'Nave 2',
      is_active: true,
      ...audited,
    }
    product[code] = p
    db.products.push(p)
  }

  // ------------------------------------------------------------ Stock inicial (ajuste documentado)
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const ctx = (userId: string | null, minutes: number): Ctx => ({ db, userId, now: minutesAgo(minutes) })

  for (const [wh, whId] of [
    ['MP', whMP.id],
    ['PT', whPT.id],
  ] as const) {
    cmdCreateStockAdjustment(
      ctx(null, 300),
      companyId,
      {
        warehouse_id: whId,
        reason_code: 'INVENTARIO_INICIAL',
        notes: 'Carga del inventario inicial de la empresa.',
        lines: productDefs
          .filter((d) => d[9] === wh && d[10] > 0)
          .map((d) => ({ product_id: product[d[0]].id, quantity_delta: d[10], unit_cost: d[4] })),
      },
      true,
    )
  }

  // ------------------------------------------------------------ Contabilidad: plan de cuentas, ejercicio y apertura
  startAccounting(ctx(null, 290), companyId)
  // La cuenta en el Banco Aula, con el saldo inicial: lo que sigue mueve el banco con órdenes.
  openBankAccount(ctx(null, 290), companyId)
  // El padrón del fisco simulado: la empresa y sus proveedores y clientes con CUIT.
  insertPadron(ctx(null, 290), companyId)
  // El punto de venta 00001, habilitado por el fisco (Fase 8d.2).
  openPointOfSale(ctx(null, 290), companyId)

  // ------------------------------------------------------------ Listas de materiales y centros de trabajo (a validar)
  insertWorkCenters(ctx(null, 289), companyId, DEMO_WORK_CENTERS)
  insertBoms(ctx(null, 289), companyId, DEMO_BOMS)
  insertBomOperations(ctx(null, 289), companyId, DEMO_BOM_OPERATIONS)

  // ------------------------------------------------------------ El personal: convenios, categorías y legajos (a validar)
  insertLaborAgreements(ctx(null, 289), companyId, DEMO_LABOR_AGREEMENTS)
  insertJobCategories(ctx(null, 289), companyId, DEMO_JOB_CATEGORIES)
  insertEmployees(ctx(null, 289), companyId, DEMO_EMPLOYEES)

  // ------------------------------------------------------------ Transporte: los fletes y el camión propio (a validar)
  insertCarriers(ctx(null, 289), companyId, DEMO_CARRIERS)
  insertVehicles(ctx(null, 289), companyId, DEMO_VEHICLES)

  // ------------------------------------------------------------ Un circuito completo previo (historial de ejemplo)
  const sc = cmdCreateRequisition(
    ctx(users.produccion, 240),
    companyId,
    {
      needed_by: null,
      priority: 'NORMAL',
      reason: 'Reposición de insumos de terminación para la producción de la semana.',
      notes: '',
      lines: [
        { product_id: product['IN-001'].id, quantity: 20 },
        { product_id: product['IN-006'].id, quantity: 100 },
      ],
    },
    true,
  )
  const reqLines = db.prLines.filter((l) => l.document_id === sc.id)
  const oc = cmdCreatePurchaseOrder(ctx(users.compras1, 200), companyId, {
    supplier_id: supplier['PRV-009'],
    expected_date: null,
    warehouse_id: whMP.id,
    payment_terms_days: 30,
    delivery_terms: 'Entrega en planta Eldorado',
    notes: '',
    lines: reqLines.map((l) => ({
      product_id: l.product_id,
      requisition_line_id: l.id,
      quantity: l.quantity,
      unit_price: db.products.find((p) => p.id === l.product_id)!.standard_cost,
      vat_rate: 21,
    })),
  })
  cmdSubmitPurchaseOrder(ctx(users.compras1, 195), oc.id)
  cmdApprovePurchaseOrder(ctx(users.compras2, 170), oc.id, 'Precios dentro de lo habitual.')
  cmdSendPurchaseOrder(ctx(users.compras1, 160), oc.id)
  cmdCreateGoodsReceipt(
    ctx(users.deposito, 60),
    companyId,
    {
      purchase_order_id: oc.id,
      warehouse_id: whMP.id,
      supplier_delivery_note: '0003-00004521',
      carrier_name: 'Transportes Ruta 12 SRL',
      notes: 'Mercadería en buen estado.',
      lines: db.poLines.filter((l) => l.document_id === oc.id).map((l) => ({ po_line_id: l.id, quantity: l.quantity })),
    },
    true,
  )

  // La factura del proveedor por lo recibido: genera el asiento de compra y la deuda.
  cmdCreateSupplierInvoice(
    ctx(users.compras1, 55),
    companyId,
    {
      purchase_order_id: oc.id,
      point_of_sale: '3',
      invoice_number: '12874',
      document_date: todayAR(),
      notes: '',
      lines: db.poLines
        .filter((l) => l.document_id === oc.id)
        .map((l) => ({ po_line_id: l.id, quantity: l.quantity, unit_price: l.unit_price })),
    },
    true,
  )

  // Dos asientos de Contabilidad: uno registrado y un borrador para completar.
  const account = (code: string) => db.accounts.find((a) => a.company_id === companyId && a.code === code)!.id
  cmdCreateJournalEntry(
    ctx(users.contabilidad, 50),
    companyId,
    {
      document_date: todayAR(),
      description: 'Depósito en el banco del efectivo de la caja.',
      lines: [
        { account_id: account('1.1.01.03'), debit: 300000, credit: 0 },
        { account_id: account('1.1.01.01'), debit: 0, credit: 300000 },
      ],
    },
    true,
  )

  // La orden de pago de esa factura, desde el banco, esperando la autorización de Gerencia.
  const invoice = db.documents.find((d) => d.doc_type === 'SUPPLIER_INVOICE')!
  cmdCreatePaymentOrder(
    ctx(users.contabilidad, 45),
    companyId,
    {
      supplier_id: invoice.supplier_id!,
      treasury_account_id: account('1.1.01.03'),
      notes: '',
      lines: [{ invoice_id: invoice.id, amount: invoice.total }],
    },
    true,
  )
  cmdCreateJournalEntry(
    ctx(users.contabilidad, 40),
    companyId,
    {
      document_date: todayAR(),
      description: 'Pago de la factura de energía eléctrica del mes con transferencia bancaria.',
      lines: [
        { account_id: account('5.2.02.02'), debit: 185000, credit: 0 },
        { account_id: account('1.1.01.03'), debit: 0, credit: 185000 },
      ],
    },
    false,
  )

  // Alertas de los productos que ya empiezan por debajo del mínimo.
  scanStockAlerts(ctx(null, 30), companyId)

  // Depósito pide reponer dos placas bajo el mínimo y Compras pide cotización a
  // tres proveedores: respondieron dos (la más barata entrega más tarde y cobra
  // antes), así el cuadro comparativo tiene una decisión para discutir.
  const placas = cmdCreateRequisition(
    ctx(users.deposito, 29),
    companyId,
    {
      needed_by: null,
      priority: 'ALTA',
      reason: 'Reposición de placas por debajo del stock mínimo.',
      notes: '',
      lines: [
        { product_id: product['MP-004'].id, quantity: 40 },
        { product_id: product['MP-007'].id, quantity: 20 },
      ],
    },
    true,
  )
  const rfq = cmdCreateRfq(
    ctx(users.compras1, 28),
    companyId,
    {
      response_due: addDays(todayAR(), 5),
      warehouse_id: whMP.id,
      notes: '',
      supplier_ids: [supplier['PRV-002'], supplier['PRV-001'], supplier['PRV-009']],
      lines: db.prLines
        .filter((l) => l.document_id === placas.id)
        .map((l) => ({ product_id: l.product_id, quantity: l.quantity, requisition_line_id: l.id })),
    },
    true,
  )
  const items = db.rfqLines.filter((l) => l.document_id === rfq.id)
  const quote = (
    supplierCode: string,
    prices: number[],
    delivery: number,
    terms: number,
    valid: number,
    ref: string,
  ) => ({
    rfq_id: rfq.id,
    supplier_id: supplier[supplierCode],
    supplier_reference: ref,
    valid_until: addDays(todayAR(), valid),
    delivery_days: delivery,
    payment_terms_days: terms,
    notes: '',
    lines: items.map((l, i) => ({ rfq_line_id: l.id, unit_price: prices[i], vat_rate: 21 })),
  })
  cmdCreateSupplierQuote(ctx(users.compras2, 27), companyId, quote('PRV-002', [95000, 104000], 7, 30, 15, 'P-2231'))
  cmdCreateSupplierQuote(ctx(users.compras1, 26), companyId, quote('PRV-001', [89500, 108000], 12, 15, 10, ''))

  // Tesorería dejó preparado el depósito en el banco de lo cobrado en efectivo: falta confirmarlo.
  cmdCreateFundsTransfer(
    ctx(users.tesoreria, 25.5),
    companyId,
    {
      from_account_id: account('1.1.01.01'),
      to_account_id: account('1.1.01.03'),
      amount: 200000,
      reference: 'Boleta de depósito 0001-4587',
      notes: '',
    },
    false,
  )

  // Ventas: Mueblería El Ceibo compra sillas, mesas y el flete, dentro de su crédito: el pedido
  // reservó la mercadería y Depósito ya preparó el remito (falta despacharlo). Carpintería Don
  // Aurelio pide dos mesas que superan su límite de crédito: lo tiene que autorizar Gerencia.
  const customer = (code: string) => db.customers.find((c) => c.company_id === companyId && c.code === code)!.id
  const pv = cmdCreateSalesOrder(
    ctx(users.ventas, 25.4),
    companyId,
    {
      customer_id: customer('CLI-001'),
      warehouse_id: whPT.id,
      delivery_date: addDays(todayAR(), 3),
      payment_terms_days: 30,
      customer_reference: 'OC 1532',
      notes: '',
      lines: [
        { product_id: product['PT-002'].id, quantity: 8, unit_price: 125000 },
        { product_id: product['PT-001'].id, quantity: 2, unit_price: 520000 },
        { product_id: product['SV-001'].id, quantity: 1, unit_price: 45000 },
      ],
    },
    true,
  )
  cmdCreateDeliveryNote(
    ctx(users.deposito, 25.3),
    companyId,
    {
      sales_order_id: pv.id,
      carrier_name: 'Transporte propio',
      notes: '',
      lines: db.soLines.filter((l) => l.document_id === pv.id).map((l) => ({ so_line_id: l.id, quantity: l.quantity })),
    },
    false,
  )
  cmdCreateSalesOrder(
    ctx(users.ventas, 25.2),
    companyId,
    {
      customer_id: customer('CLI-005'),
      warehouse_id: whPT.id,
      delivery_date: null,
      payment_terms_days: 15,
      customer_reference: '',
      notes: 'Pide que se entreguen juntas.',
      lines: [{ product_id: product['PT-001'].id, quantity: 2, unit_price: 520000 }],
    },
    true,
  )

  // Producción planificó diez sillas y liberó la orden: Depósito tiene que entregar los materiales.
  cmdCreateProductionOrder(
    ctx(users.produccion, 25.1),
    companyId,
    {
      product_id: product['PT-002'].id,
      quantity: 10,
      materials_warehouse_id: whMP.id,
      output_warehouse_id: whPT.id,
      due_date: addDays(todayAR(), 5),
      notes: '',
    },
    true,
  )
  // Y planificó diez mesas que todavía no puede liberar: faltan tableros (ya los pidió
  // Depósito) y barniz, que hay que pedirle a Compras (Producción → Necesidades de materiales).
  cmdCreateProductionOrder(
    ctx(users.produccion, 25),
    companyId,
    {
      product_id: product['PT-001'].id,
      quantity: 10,
      materials_warehouse_id: whMP.id,
      output_warehouse_id: whPT.id,
      due_date: addDays(todayAR(), 10),
      notes: 'Para reponer el stock de mesas.',
    },
    false,
  )

  // El historial previo no debe aparecer como "no leído".
  for (const n of db.notifications) n.read_at = now

  return db
}
