// Genera el banco de proveedores y clientes ficticios
// (src/lib/mock/partner-bank.ts) para casos, escenarios y los módulos de ventas.
// Uso: npm run data:partners
//
// Faker (licencia MIT, sólo en desarrollo) aporta el azar con semilla fija: el
// resultado es siempre el mismo y se revisa en el repositorio. Los nombres y las
// reglas son propios, con sabor del NEA (los nombres de Faker en español suenan
// a España o México): CUIT del rango simulado 00000xxx con dígito verificador,
// condición frente al IVA según la forma jurídica, localidades reales de la
// región (Georef) con domicilios ficticios y emails en el dominio reservado
// .example.

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { faker } from '@faker-js/faker'
import * as prettier from 'prettier'

const OUTPUT = fileURLToPath(new URL('../src/lib/mock/partner-bank.ts', import.meta.url))

faker.seed(2027)
const pick = (list) => faker.helpers.arrayElement(list)
const between = (min, max, step = 1) => faker.number.int({ min: min / step, max: max / step }) * step

// prettier-ignore
const LOCALITIES = [
  ['Eldorado', 'Misiones', 5], ['Posadas', 'Misiones', 6], ['Oberá', 'Misiones', 4],
  ['Puerto Iguazú', 'Misiones', 2], ['Montecarlo', 'Misiones', 2], ['Apóstoles', 'Misiones', 2],
  ['Leandro N. Alem', 'Misiones', 2], ['Jardín América', 'Misiones', 2], ['San Vicente', 'Misiones', 1],
  ['Puerto Rico', 'Misiones', 1], ['Aristóbulo del Valle', 'Misiones', 1], ['Wanda', 'Misiones', 1],
  ['Corrientes', 'Corrientes', 3], ['Gobernador Virasoro', 'Corrientes', 2], ['Santo Tomé', 'Corrientes', 1],
  ['Goya', 'Corrientes', 1], ['Resistencia', 'Chaco', 2], ['Presidencia Roque Sáenz Peña', 'Chaco', 1],
  ['Formosa', 'Formosa', 1],
]

// prettier-ignore
const STREETS = [
  'Av. San Martín', 'Belgrano', 'Sarmiento', 'Rivadavia', 'Mitre', 'Moreno', 'Colón', 'Bolívar', 'Junín',
  'Córdoba', 'Entre Ríos', 'Santa Fe', 'Av. Libertad', 'Las Heras', 'Laprida', '25 de Mayo', '9 de Julio',
  'Independencia', 'Av. Lavalle', 'Buenos Aires', 'Tucumán', 'Salta',
]

// prettier-ignore
const FIRST_NAMES = {
  female: ['María', 'Ana', 'Laura', 'Silvia', 'Graciela', 'Mónica', 'Patricia', 'Claudia', 'Andrea', 'Marcela',
    'Liliana', 'Norma', 'Viviana', 'Gabriela', 'Lorena', 'Carolina', 'Natalia', 'Romina', 'Florencia', 'Valeria',
    'Verónica', 'Cecilia', 'Soledad', 'Mariela', 'Rosana', 'Alejandra', 'Daniela', 'Paola', 'Sandra', 'Teresa'],
  male: ['Juan', 'Carlos', 'Luis', 'Jorge', 'Roberto', 'Daniel', 'Ricardo', 'Sergio', 'Gustavo', 'Hugo', 'Rubén',
    'Néstor', 'Walter', 'Marcelo', 'Diego', 'Pablo', 'Martín', 'Federico', 'Matías', 'Lucas', 'Facundo', 'Gastón',
    'Esteban', 'Hernán', 'Fabián', 'Raúl', 'Omar', 'Ramón', 'Javier', 'Oscar'],
}

/** Apellidos criollos, guaraníticos y de la inmigración (alemana, polaca, ucraniana, nórdica, brasileña). */
// prettier-ignore
const SURNAMES = [
  'González', 'Rodríguez', 'Fernández', 'López', 'Martínez', 'Gómez', 'Díaz', 'Sosa', 'Romero', 'Álvarez',
  'Acosta', 'Giménez', 'Ayala', 'Duarte', 'Núñez', 'Vera', 'Cabral', 'Ferreyra', 'Villalba', 'Ojeda', 'Ríos',
  'Báez', 'Cardozo', 'Ortiz', 'Rojas', 'Escobar', 'Maidana', 'Galeano', 'Insaurralde', 'Godoy', 'Aquino',
  'Encina', 'Medina', 'Paredes', 'Leiva', 'Olivera', 'Fleitas', 'Brítez', 'Krause', 'Schmidt', 'Wagner', 'Kuhn',
  'Zimmermann', 'Olsen', 'Hansen', 'Lindström', 'Nowak', 'Kozlowski', 'Lewandowski', 'Wiszniewski', 'Fischer',
  'Weber', 'Bauer', 'Koch', 'Tkachuk', 'Melnyk', 'Boiko', 'Kovalenko', 'Dos Santos', 'Da Silva', 'Oliveira',
  'Pereira', 'Machado', 'Rocha',
]

/** Palabras de la región para nombres de fantasía; sin las que ya usa la empresa plantilla. */
// prettier-ignore
const REGIONAL = [
  'del Alto Paraná', 'Yaguareté', 'Lapacho', 'Timbó', 'Urunday', 'Itaembé', 'Selva Misionera', 'Monte Alegre',
  'Ruta 14', 'Cerro Azul', 'Arroyo Pindapoy', 'Los Cedros', 'Tacuaruzú', 'Paranay', 'Guatambú', 'Cañafístola',
  'Araucaria', 'Peteribí', 'Caá Yarí', 'Loreto',
]

const slug = (text) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** CUIT con el dígito verificador oficial: si da 10, el prefijo pasa a 23 (personas) o 33 (sociedades). */
function cuit(prefix, body) {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const digits = `${prefix}${String(body).padStart(8, '0')}`
  const dv = 11 - (digits.split('').reduce((sum, d, i) => sum + Number(d) * weights[i], 0) % 11)
  if (dv === 10) return cuit(prefix >= 30 ? 33 : 23, body)
  return `${prefix}-${String(body).padStart(8, '0')}-${dv === 11 ? 0 : dv}`
}

/** Saca de un mazo mezclado y lo vuelve a mezclar al terminarse: así no se repiten seguidos. */
function deck(list) {
  let cards = []
  return () => {
    if (!cards.length) cards = faker.helpers.shuffle([...list])
    return cards.pop()
  }
}
const firstName = { female: deck(FIRST_NAMES.female), male: deck(FIRST_NAMES.male) }
const surname = deck(SURNAMES)
const regional = deck(REGIONAL)

function person() {
  const sex = pick(['female', 'male'])
  return { sex, first: firstName[sex](), last: surname() }
}

const usedNames = new Set()
/** Devuelve el primer nombre que no se usó antes (razones sociales y nombres de fantasía únicos). */
function unique(make) {
  for (;;) {
    const name = make()
    if (!usedNames.has(name)) {
      usedNames.add(name)
      return name
    }
  }
}

/** Nombre de fantasía: rubro + apellido (a veces "Hnos.") o palabra de la región. */
const fantasyName = (type) =>
  unique(() => {
    const bySurname = type.x === 'surname' || (type.x !== 'regional' && faker.datatype.boolean())
    const x = bySurname ? `${surname()}${faker.datatype.boolean(0.15) ? ' Hnos.' : ''}` : regional()
    return pick(type.patterns).replace('{x}', x)
  })

/**
 * Datos comunes. Las sociedades (SRL, SA, SAS) son responsables inscriptas;
 * las personas humanas monotributistas tienen razón social con su nombre y un
 * nombre de fantasía; las entidades exentas son asociaciones (prefijo 30).
 */
function partner(code, body, type, emailUser) {
  const vat = type.exempt
    ? 'EXENTO'
    : faker.datatype.boolean(type.mono ?? 0.1)
      ? 'MONOTRIBUTO'
      : 'RESPONSABLE_INSCRIPTO'
  const where = faker.helpers.weightedArrayElement(
    LOCALITIES.map(([city, province, weight]) => ({ weight, value: { city, province } })),
  )
  let contact = person()
  if (vat === 'MONOTRIBUTO') unique(() => `${(contact = person()).last}, ${contact.first}`)
  const fantasy = fantasyName(type)
  const row = {
    code,
    legal_name: fantasy,
    trade_name: '',
    tax_id: cuit(30, body),
    vat_condition: vat,
    address_line: `${pick(STREETS)} ${between(100, 3900, 10)} (domicilio ficticio)`,
    city: where.city,
    province: where.province,
    phone: '',
    email: `${emailUser}@${slug(fantasy)}.example`,
    contact_name: `${contact.first} ${contact.last}`,
  }
  if (vat === 'RESPONSABLE_INSCRIPTO') row.legal_name = `${fantasy} ${pick(['SRL', 'SRL', 'SA', 'SAS'])}`
  if (vat === 'MONOTRIBUTO') {
    row.legal_name = `${contact.last}, ${contact.first}`
    row.trade_name = fantasy
    row.tax_id = cuit(contact.sex === 'female' ? 27 : 20, body)
  }
  return row
}

/** Tipos con su cantidad exacta, mezclados para que los códigos no queden agrupados por rubro. */
const expand = (types) => faker.helpers.shuffle(types.flatMap((t) => Array(t.count).fill(t)))

// prettier-ignore
const SUPPLIER_TYPES = [
  { category: 'Aserradero', count: 4, lead: [3, 8], patterns: ['Aserradero {x}', 'Maderas {x}', 'Industrias Madereras {x}'] },
  { category: 'Placas y tableros', count: 3, lead: [5, 10], patterns: ['Placas {x}', 'Tableros {x}', 'Maderera {x}'] },
  { category: 'Herrajes', count: 3, lead: [3, 8], patterns: ['Herrajes {x}', 'Accesorios para Muebles {x}'] },
  { category: 'Pinturería', count: 3, lead: [1, 4], patterns: ['Pinturería {x}', 'Barnices y Lacas {x}'] },
  { category: 'Bulonera', count: 2, lead: [1, 3], patterns: ['Bulonera {x}', 'Tornillería {x}'] },
  { category: 'Embalajes', count: 2, lead: [4, 8], patterns: ['Embalajes {x}', 'Envases y Films {x}'] },
  { category: 'Tapicería', count: 2, lead: [5, 12], patterns: ['Telas y Espumas {x}', 'Tapicería {x}'] },
  { category: 'Transporte', count: 3, lead: [1, 2], mono: 0.4, patterns: ['Transportes {x}', 'Fletes {x}', 'Logística {x}'] },
  { category: 'Ferretería', count: 3, lead: [1, 4], patterns: ['Ferretería {x}', 'Herramientas {x}'] },
  { category: 'Servicios', count: 3, lead: [1, 3], mono: 0.6, patterns: ['Servicios Técnicos {x}', 'Mantenimiento Industrial {x}', 'Afilados {x}'] },
  { category: 'Librería comercial', count: 1, lead: [1, 3], mono: 0.3, patterns: ['Librería Comercial {x}'] },
  { category: 'Capacitación', count: 1, lead: [7, 15], exempt: true, x: 'regional', patterns: ['Asociación de Productores Forestales {x} (ficticia)'] },
]

// prettier-ignore
const CUSTOMER_TYPES = [
  { segment: 'Mueblería minorista', count: 9, terms: [30, 45], limit: [2000000, 8000000], patterns: ['Mueblería {x}', 'Muebles {x}', 'Amoblamientos {x}', 'Hogar {x}'] },
  { segment: 'Constructora: equipa viviendas y oficinas', count: 4, terms: [45, 60], limit: [6000000, 15000000], patterns: ['Constructora {x}', 'Desarrollos {x}', 'Obras y Proyectos {x}'] },
  { segment: 'Turismo: compra mobiliario para habitaciones', count: 5, terms: [15, 30], limit: [1500000, 5000000], mono: 0.4, x: 'surname', patterns: ['Hotel {x}', 'Cabañas {x}', 'Hostería {x}'] },
  { segment: 'Carpintería: compra tableros y piezas', count: 5, terms: [0, 15], limit: [300000, 1500000], mono: 0.8, x: 'surname', patterns: ['Carpintería {x}', 'Taller de Muebles {x}'] },
  { segment: 'Decoración y diseño de interiores', count: 3, terms: [15, 30], limit: [800000, 3000000], mono: 0.5, patterns: ['Decoraciones {x}', 'Interiores {x}'] },
  { segment: 'Institución: compra mobiliario escolar o de oficina', count: 3, terms: [30, 30], limit: [1000000, 4000000], exempt: true, x: 'regional', patterns: ['Biblioteca Popular {x} (ficticia)', 'Club Social y Deportivo {x} (ficticio)', 'Asociación Cooperadora {x} (ficticia)'] },
]

const suppliers = expand(SUPPLIER_TYPES).map((type, i) => {
  const row = partner(`PRV-${101 + i}`, 300 + i, type, 'ventas')
  return {
    ...row,
    payment_terms_days: row.vat_condition === 'RESPONSABLE_INSCRIPTO' ? pick([30, 30, 45, 60]) : pick([0, 15]),
    notes: '',
    lead_time_days: between(...type.lead),
    category: type.category,
  }
})

const customers = expand(CUSTOMER_TYPES).map((type, i) => ({
  ...partner(`CLI-${101 + i}`, 500 + i, type, 'compras'),
  payment_terms_days: between(...type.terms, 15),
  notes: type.segment,
  credit_limit: between(...type.limit, 100000),
}))
// Las ventas de mostrador del showroom de Posadas (DATABASE.md §16) no llevan CUIT.
customers.push({
  code: `CLI-${101 + customers.length}`,
  legal_name: 'Consumidor final — Showroom Posadas',
  trade_name: '',
  tax_id: '',
  vat_condition: 'CONSUMIDOR_FINAL',
  address_line: '',
  city: 'Posadas',
  province: 'Misiones',
  phone: '',
  email: '',
  contact_name: '',
  payment_terms_days: 0,
  notes: 'Ventas de mostrador del showroom, sin CUIT',
  credit_limit: null,
})

const source = `// Generado por scripts/generate-partner-bank.mjs (npm run data:partners). No editar a mano.
// Proveedores y clientes ficticios para casos, escenarios y los módulos de
// ventas: CUIT del rango simulado 00000xxx, domicilios ficticios y emails en el
// dominio reservado .example. Antes de usarlos en clase, revisar que ningún
// nombre coincida con un comercio real de la zona (DATABASE.md §16).
import type * as T from '../domain/types'

/** Un proveedor o cliente listo para cmdSaveMaster: sin id, empresa, lista de precios ni auditoría. */
export type BankPartner<P extends T.Partner> = Omit<
  P,
  'id' | 'company_id' | 'is_active' | 'price_list_id' | 'created_at' | 'created_by' | 'updated_at' | 'updated_by'
>

export const BANK_SUPPLIERS: BankPartner<T.Supplier>[] = ${JSON.stringify(suppliers)}

export const BANK_CUSTOMERS: BankPartner<T.Customer>[] = ${JSON.stringify(customers)}
`

const config = await prettier.resolveConfig(OUTPUT)
await writeFile(OUTPUT, await prettier.format(source, { ...config, filepath: OUTPUT }))
console.log(`Banco generado: ${suppliers.length} proveedores y ${customers.length} clientes.`)
