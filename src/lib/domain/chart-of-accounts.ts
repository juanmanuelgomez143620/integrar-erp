// Plan de cuentas básico y saldos de apertura de la empresa plantilla
// (docs/FASE_2_CONTABILIDAD.md §6), propuestos para que los valide el docente.
// Nombres habituales de los manuales de Sistemas de Información Contable del
// secundario. Supabase recibe los mismos datos (scripts/generate-catalog-sql.mjs).

import type { AccountType, BalanceSide, ProductType } from './types'

/** Código jerárquico: clase · grupo · rubro (2 dígitos) · cuenta (2 dígitos). */
export const ACCOUNT_CODE_PATTERN = /^[1-5](\.[1-9](\.\d{2}(\.\d{2})?)?)?$/

export const IMPUTABLE_LEVEL = 4

const CLASS_TYPES: Record<string, AccountType> = {
  '1': 'ACTIVO',
  '2': 'PASIVO',
  '3': 'PATRIMONIO_NETO',
  '4': 'RESULTADO_POSITIVO',
  '5': 'RESULTADO_NEGATIVO',
}

export const accountLevel = (code: string) => code.split('.').length

export const accountTypeOf = (code: string): AccountType => CLASS_TYPES[code[0]]

export const parentCode = (code: string) => code.split('.').slice(0, -1).join('.')

/** Saldo normal: deudor para activo y pérdidas; al revés en las regularizadoras. */
export function normalSideOf(type: AccountType, contra = false): BalanceSide {
  const debit = type === 'ACTIVO' || type === 'RESULTADO_NEGATIVO'
  return debit !== contra ? 'DEBE' : 'HABER'
}

/** [código, nombre, descripción para el estudiante, regularizadora] */
type ChartRow = [string, string, string?, boolean?]

// prettier-ignore
export const BASE_CHART: ChartRow[] = [
  ['1', 'Activo'],
  ['1.1', 'Activo corriente'],
  ['1.1.01', 'Caja y bancos'],
  ['1.1.01.01', 'Caja', 'Dinero en efectivo en poder de la empresa.'],
  ['1.1.01.02', 'Fondo fijo', 'Efectivo asignado para gastos menores, que se repone periódicamente.'],
  ['1.1.01.03', 'Banco cuenta corriente', 'Dinero depositado en la cuenta corriente bancaria de la empresa.'],
  ['1.1.01.04', 'Valores a depositar', 'Cheques de terceros recibidos que todavía no se depositaron.'],
  ['1.1.02', 'Inversiones temporarias'],
  ['1.1.02.01', 'Plazo fijo', 'Depósitos a plazo fijo por menos de un año.'],
  ['1.1.03', 'Créditos por ventas'],
  ['1.1.03.01', 'Deudores por ventas', 'Lo que los clientes deben por ventas a crédito (cuenta corriente).'],
  ['1.1.03.02', 'Documentos a cobrar', 'Pagarés firmados por clientes a favor de la empresa.'],
  ['1.1.03.03', 'Previsión para deudores incobrables', 'Estimación de los créditos que probablemente no se cobren. Regulariza (resta) a Deudores por ventas.', true],
  ['1.1.04', 'Otros créditos'],
  ['1.1.04.01', 'IVA crédito fiscal', 'IVA facturado por los proveedores en las compras; se descuenta del IVA débito fiscal.'],
  ['1.1.04.02', 'Anticipos a proveedores', 'Pagos adelantados a proveedores por compras que todavía no se recibieron.'],
  ['1.1.04.03', 'Retenciones y percepciones sufridas', 'Impuestos que retuvieron o percibieron terceros y que se descuentan de lo que hay que pagar.'],
  ['1.1.05', 'Bienes de cambio'],
  ['1.1.05.01', 'Materias primas', 'Madera, placas y demás materiales que se transforman en la producción.'],
  ['1.1.05.02', 'Materiales e insumos', 'Cola, barniz, herrajes, lijas y embalajes que se consumen en la producción.'],
  ['1.1.05.03', 'Productos en proceso', 'Muebles empezados que todavía no están terminados.'],
  ['1.1.05.04', 'Productos terminados', 'Muebles fabricados listos para la venta.'],
  ['1.1.05.05', 'Mercaderías de reventa', 'Productos comprados para revender sin transformarlos (por ejemplo, colchones).'],
  ['1.2', 'Activo no corriente'],
  ['1.2.01', 'Bienes de uso'],
  ['1.2.01.01', 'Inmuebles', 'Terreno y edificio de la planta.'],
  ['1.2.01.02', 'Maquinarias y herramientas', 'Sierras, cepilladoras, lijadoras y herramientas de la planta.'],
  ['1.2.01.03', 'Rodados', 'Camiones y vehículos de la empresa.'],
  ['1.2.01.04', 'Muebles y útiles', 'Escritorios, sillas y equipamiento de las oficinas.'],
  ['1.2.01.05', 'Equipos de computación', 'Computadoras, impresoras y equipos de red.'],
  ['1.2.01.06', 'Amortización acumulada de bienes de uso', 'Desgaste acumulado de los bienes de uso. Regulariza (resta) a su valor de origen.', true],
  ['1.2.02', 'Activos intangibles'],
  ['1.2.02.01', 'Software y licencias', 'Programas y licencias de uso adquiridos.'],
  ['2', 'Pasivo'],
  ['2.1', 'Pasivo corriente'],
  ['2.1.01', 'Deudas comerciales'],
  ['2.1.01.01', 'Proveedores', 'Lo que la empresa debe a sus proveedores por compras a crédito (cuenta corriente).'],
  ['2.1.01.02', 'Documentos a pagar', 'Pagarés firmados por la empresa a favor de terceros.'],
  ['2.1.01.03', 'Anticipos de clientes', 'Cobros adelantados por ventas que todavía no se entregaron.'],
  ['2.1.02', 'Deudas bancarias y financieras'],
  ['2.1.02.01', 'Préstamos bancarios', 'Préstamos de bancos a devolver dentro del año.'],
  ['2.1.03', 'Remuneraciones y cargas sociales'],
  ['2.1.03.01', 'Sueldos a pagar', 'Sueldos devengados que todavía no se pagaron.'],
  ['2.1.03.02', 'Cargas sociales a pagar', 'Aportes y contribuciones a la seguridad social pendientes de pago.'],
  ['2.1.04', 'Cargas fiscales'],
  ['2.1.04.01', 'IVA débito fiscal', 'IVA facturado a los clientes en las ventas.'],
  ['2.1.04.02', 'IVA a pagar', 'Saldo de IVA a ingresar al fisco al cierre del mes (débito menos crédito).'],
  ['2.1.04.03', 'Ingresos brutos a pagar', 'Impuesto provincial sobre los ingresos brutos pendiente de pago.'],
  ['2.1.04.04', 'Impuesto a las ganancias a pagar', 'Impuesto nacional sobre las ganancias pendiente de pago.'],
  ['2.1.05', 'Otras deudas'],
  ['2.1.05.01', 'Acreedores varios', 'Deudas que no son con proveedores, bancos, el personal ni el fisco.'],
  ['2.2', 'Pasivo no corriente'],
  ['2.2.01', 'Deudas financieras a largo plazo'],
  ['2.2.01.01', 'Préstamos bancarios a largo plazo', 'Préstamos de bancos a devolver en más de un año.'],
  ['3', 'Patrimonio neto'],
  ['3.1', 'Aportes de los propietarios'],
  ['3.1.01', 'Capital'],
  ['3.1.01.01', 'Capital social', 'Aportes de los socios, según el contrato social.'],
  ['3.2', 'Resultados acumulados'],
  ['3.2.01', 'Reservas'],
  ['3.2.01.01', 'Reserva legal', 'Parte de las ganancias que la ley obliga a retener.'],
  ['3.2.02', 'Resultados'],
  ['3.2.02.01', 'Resultados no asignados', 'Ganancias o pérdidas de ejercicios anteriores que los socios todavía no distribuyeron.'],
  ['3.2.02.02', 'Resultado del ejercicio', 'Ganancia o pérdida del ejercicio, al cerrarlo.'],
  ['4', 'Resultados positivos'],
  ['4.1', 'Ingresos operativos'],
  ['4.1.01', 'Ventas'],
  ['4.1.01.01', 'Ventas de productos terminados', 'Ventas de los muebles que fabrica la empresa.'],
  ['4.1.01.02', 'Ventas de mercaderías de reventa', 'Ventas de los productos comprados para revender.'],
  ['4.1.01.03', 'Ingresos por servicios', 'Fletes y otros servicios cobrados a los clientes.'],
  ['4.2', 'Otros resultados positivos'],
  ['4.2.01', 'Resultados financieros positivos'],
  ['4.2.01.01', 'Intereses ganados', 'Intereses cobrados por plazos fijos o ventas financiadas.'],
  ['4.2.01.02', 'Descuentos obtenidos', 'Descuentos que hacen los proveedores por pagar antes.'],
  ['4.2.02', 'Otros ingresos'],
  ['4.2.02.01', 'Sobrante de inventario', 'Diferencia a favor entre el conteo físico y el stock registrado.'],
  ['4.2.02.02', 'Ingresos varios', 'Ingresos ocasionales que no son ventas.'],
  ['5', 'Resultados negativos'],
  ['5.1', 'Costo de lo vendido'],
  ['5.1.01', 'Costo de ventas'],
  ['5.1.01.01', 'Costo de productos vendidos', 'Costo de fabricación de los muebles vendidos.'],
  ['5.1.01.02', 'Costo de mercaderías vendidas', 'Costo de compra de las mercaderías de reventa vendidas.'],
  ['5.1.02', 'Costos de producción aplicados'],
  ['5.1.02.01', 'Mano de obra directa aplicada', 'Mano de obra que las órdenes de producción cargaron a su costo (horas por tarifa). Regulariza (resta) a los sueldos de la fábrica: la diferencia es la sub- o sobreaplicación.', true],
  ['5.1.02.02', 'Carga fabril aplicada', 'Costos indirectos de fabricación que las órdenes cargaron a su costo (horas por tasa). Regulariza (resta) a los gastos reales de la fábrica.', true],
  ['5.1.03', 'Costos de producción reales'],
  ['5.1.03.01', 'Mano de obra directa', 'Sueldos y contribuciones del personal del taller: el costo real de la mano de obra. Contra la aplicada a las órdenes (5.1.02.01) da la sub- o sobreaplicación.'],
  ['5.2', 'Gastos de administración y comercialización'],
  ['5.2.01', 'Gastos en personal'],
  ['5.2.01.01', 'Sueldos y jornales', 'Remuneraciones del personal.'],
  ['5.2.01.02', 'Cargas sociales', 'Contribuciones patronales a la seguridad social.'],
  ['5.2.02', 'Gastos generales'],
  ['5.2.02.01', 'Alquileres', 'Alquileres que paga la empresa (por ejemplo, el del showroom).'],
  ['5.2.02.02', 'Servicios públicos', 'Energía eléctrica, agua y gas.'],
  ['5.2.02.03', 'Teléfono e internet', 'Telefonía e internet.'],
  ['5.2.02.04', 'Fletes y acarreos', 'Transporte de compras y ventas a cargo de la empresa.'],
  ['5.2.02.05', 'Gastos de librería y oficina', 'Papelería e insumos de oficina.'],
  ['5.2.02.06', 'Seguros', 'Primas de seguros de bienes y personas.'],
  ['5.2.02.07', 'Publicidad', 'Avisos y promoción.'],
  ['5.2.02.08', 'Mantenimiento y reparaciones', 'Arreglos de máquinas, vehículos e instalaciones.'],
  ['5.2.02.09', 'Amortizaciones de bienes de uso', 'Desgaste del período de los bienes de uso.'],
  ['5.2.02.10', 'Deudores incobrables', 'Créditos que se dan por perdidos.'],
  ['5.2.03', 'Impuestos y tasas'],
  ['5.2.03.01', 'Impuesto sobre los ingresos brutos', 'Impuesto provincial que se calcula sobre las ventas.'],
  ['5.2.03.02', 'Tasas municipales', 'Tasa de comercio e higiene y otros tributos municipales.'],
  ['5.3', 'Resultados financieros y otros egresos'],
  ['5.3.01', 'Gastos financieros'],
  ['5.3.01.01', 'Intereses perdidos', 'Intereses pagados por préstamos o compras financiadas.'],
  ['5.3.01.02', 'Descuentos otorgados', 'Descuentos a clientes por pagar antes.'],
  ['5.3.01.03', 'Gastos y comisiones bancarias', 'Mantenimiento de cuenta, comisiones e impuestos bancarios.'],
  ['5.3.02', 'Otras pérdidas'],
  ['5.3.02.01', 'Faltante de inventario', 'Diferencia en contra entre el conteo físico y el stock registrado.'],
  ['5.3.02.02', 'Pérdida por roturas', 'Bienes que se rompieron o deterioraron y se dan de baja.'],
]

/** Saldos fijos del asiento de apertura (a validar). Los bienes de cambio salen del inventario inicial. */
// prettier-ignore
export const OPENING_BALANCES: { code: string; debit: number; credit: number }[] = [
  { code: '1.1.01.01', debit: 850000, credit: 0 },
  { code: '1.1.01.03', debit: 12500000, credit: 0 },
  { code: '1.2.01.01', debit: 85000000, credit: 0 },
  { code: '1.2.01.02', debit: 24000000, credit: 0 },
  { code: '1.2.01.03', debit: 18000000, credit: 0 },
  { code: '1.2.01.04', debit: 3200000, credit: 0 },
  { code: '2.1.02.01', debit: 0, credit: 10000000 },
  { code: '3.1.01.01', debit: 0, credit: 120000000 },
]

/** La diferencia del asiento de apertura: lo que los socios acumularon en ejercicios anteriores. */
export const OPENING_BALANCING_ACCOUNT = '3.2.02.01'

/**
 * Reglas base de la imputación automática (a validar): a qué cuenta va cada
 * importe de cada evento (catalog.ts, POSTING_EVENTS). Contabilidad las cambia
 * por empresa en "Imputación automática".
 */
// prettier-ignore
export const BASE_POSTING_RULES: { event: string; key: string; code: string }[] = [
  { event: 'COMPRA', key: 'MATERIA_PRIMA', code: '1.1.05.01' },
  { event: 'COMPRA', key: 'INSUMO', code: '1.1.05.02' },
  { event: 'COMPRA', key: 'PRODUCTO_TERMINADO', code: '1.1.05.04' },
  { event: 'COMPRA', key: 'MERCADERIA_REVENTA', code: '1.1.05.05' },
  { event: 'COMPRA', key: 'SERVICIO', code: '5.2.02.04' },
  { event: 'COMPRA', key: 'IVA_CREDITO', code: '1.1.04.01' },
  { event: 'COMPRA', key: 'PROVEEDORES', code: '2.1.01.01' },
  { event: 'PAGO', key: 'PROVEEDORES', code: '2.1.01.01' },
  { event: 'COSTO_VENTA', key: 'COSTO_PRODUCTO_TERMINADO', code: '5.1.01.01' },
  { event: 'COSTO_VENTA', key: 'COSTO_MERCADERIA_REVENTA', code: '5.1.01.02' },
  { event: 'COSTO_VENTA', key: 'PRODUCTO_TERMINADO', code: '1.1.05.04' },
  { event: 'COSTO_VENTA', key: 'MERCADERIA_REVENTA', code: '1.1.05.05' },
  { event: 'VENTA', key: 'PRODUCTO_TERMINADO', code: '4.1.01.01' },
  { event: 'VENTA', key: 'MERCADERIA_REVENTA', code: '4.1.01.02' },
  { event: 'VENTA', key: 'SERVICIO', code: '4.1.01.03' },
  { event: 'VENTA', key: 'IVA_DEBITO', code: '2.1.04.01' },
  { event: 'VENTA', key: 'DEUDORES', code: '1.1.03.01' },
  { event: 'COBRO', key: 'DEUDORES', code: '1.1.03.01' },
  { event: 'CONSUMO_PRODUCCION', key: 'PRODUCCION_EN_PROCESO', code: '1.1.05.03' },
  { event: 'CONSUMO_PRODUCCION', key: 'MATERIA_PRIMA', code: '1.1.05.01' },
  { event: 'CONSUMO_PRODUCCION', key: 'INSUMO', code: '1.1.05.02' },
  { event: 'CONVERSION_PRODUCCION', key: 'PRODUCCION_EN_PROCESO', code: '1.1.05.03' },
  { event: 'CONVERSION_PRODUCCION', key: 'MANO_DE_OBRA_APLICADA', code: '5.1.02.01' },
  { event: 'CONVERSION_PRODUCCION', key: 'CARGA_FABRIL_APLICADA', code: '5.1.02.02' },
  { event: 'PRODUCCION_TERMINADA', key: 'PRODUCTO_TERMINADO', code: '1.1.05.04' },
  { event: 'PRODUCCION_TERMINADA', key: 'PRODUCCION_EN_PROCESO', code: '1.1.05.03' },
  { event: 'SUELDOS', key: 'REMUNERACIONES', code: '5.2.01.01' },
  { event: 'SUELDOS', key: 'CONTRIBUCIONES', code: '5.2.01.02' },
  { event: 'SUELDOS', key: 'MANO_DE_OBRA_DIRECTA', code: '5.1.03.01' },
  { event: 'SUELDOS', key: 'SUELDOS_A_PAGAR', code: '2.1.03.01' },
  { event: 'SUELDOS', key: 'CARGAS_SOCIALES_A_PAGAR', code: '2.1.03.02' },
  { event: 'PAGO_SUELDOS', key: 'SUELDOS_A_PAGAR', code: '2.1.03.01' },
  { event: 'PAGO_CARGAS_SOCIALES', key: 'CARGAS_SOCIALES_A_PAGAR', code: '2.1.03.02' },
]

/** Rubro de las cajas y los bancos: sus cuentas imputables son desde donde se paga. */
export const TREASURY_RUBRO = '1.1.01'

/** Cuenta de bienes de cambio de cada tipo de producto (asiento de apertura). */
export const INVENTORY_ACCOUNTS: Record<ProductType, string | null> = {
  MATERIA_PRIMA: '1.1.05.01',
  INSUMO: '1.1.05.02',
  PRODUCTO_TERMINADO: '1.1.05.04',
  MERCADERIA_REVENTA: '1.1.05.05',
  SERVICIO: null,
}
