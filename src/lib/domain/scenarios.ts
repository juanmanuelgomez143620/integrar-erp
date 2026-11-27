// Los escenarios de la Fase 8g (docs/FASE_8G_ESCENARIOS.md): un desafío con nombre que el docente inicia en
// la empresa del curso, con su situación de partida, la consigna de cada isla y los criterios de logro, que se
// evalúan sobre la auditoría desde el inicio. Los textos usan los datos de la corrida: {pedido}, {cliente},
// {producto}, {cantidad}, {disponible} y {limite}.

import type { RoleCode } from './types'

export type ScenarioCode = 'FALTA_STOCK' | 'VENTA_CREDITO'

/** Un criterio de logro: lo que se tiene que ver en los datos, de qué isla es. */
export interface ScenarioCriterion {
  key: string
  island: number
  text: string
}

/** La consigna de una isla: la tarea va al rol que la resuelve. */
export interface ScenarioBrief {
  island: number
  role: RoleCode
  text: string
}

export interface ScenarioInfo {
  code: ScenarioCode
  name: string
  /** Para elegirlo en el panel del docente, antes de iniciarlo. */
  summary: string
  /** La situación de partida, con los datos de la corrida. */
  situation: string
  briefs: ScenarioBrief[]
  criteria: ScenarioCriterion[]
}

export const SCENARIOS: Record<ScenarioCode, ScenarioInfo> = {
  FALTA_STOCK: {
    code: 'FALTA_STOCK',
    name: 'Falta de stock',
    summary:
      'Llega un pedido más grande que el stock disponible de un mueble: Ventas no puede confirmarlo completo, Producción fabrica lo que falta y Depósito despacha.',
    situation:
      '{cliente} pide {cantidad} unidades de {producto} con el pedido {pedido}, pero el stock disponible alcanza para {disponible}.',
    briefs: [
      {
        island: 3,
        role: 'VENTAS',
        text: 'Revisá el pedido {pedido} de {cliente}: no hay stock para todo. No lo confirmes por más de lo disponible: rechazalo con el motivo, cargá otro pedido con lo disponible y confirmalo, y avisale a Producción cuánto falta. Cuando Depósito despache, facturá.',
      },
      {
        island: 7,
        role: 'PRODUCCION',
        text: 'Fabricá lo que falta de {producto} para el pedido de {cliente}: una orden de producción por lo que falta, liberada, con los materiales entregados y terminada.',
      },
      {
        island: 8,
        role: 'DEPOSITO',
        text: 'Despachá a {cliente} lo disponible de {producto} con su remito y, cuando Producción termine, el resto.',
      },
    ],
    criteria: [
      {
        key: 'FS_RECHAZO',
        island: 3,
        text: 'Ventas rechazó el pedido {pedido} con el motivo: no lo confirmó por más de lo disponible.',
      },
      { key: 'FS_DISPONIBLE', island: 3, text: 'Ventas cargó y confirmó otro pedido de {cliente} con {producto}.' },
      { key: 'FS_FABRICA', island: 7, text: 'Producción terminó una orden de producción de {producto}.' },
      { key: 'FS_DESPACHO', island: 8, text: 'Depósito despachó {producto} a {cliente} con un remito.' },
      { key: 'FS_FACTURA', island: 3, text: 'Ventas facturó a {cliente} lo despachado.' },
    ],
  },
  VENTA_CREDITO: {
    code: 'VENTA_CREDITO',
    name: 'Venta a crédito',
    summary:
      'Un cliente pide por encima de su límite de crédito: Ventas lo confirma, Gerencia decide si le vende, Depósito despacha, Ventas factura y Tesorería cobra.',
    situation:
      '{cliente} pide {cantidad} unidades de {producto} con el pedido {pedido}: supera su límite de crédito de {limite}.',
    briefs: [
      {
        island: 3,
        role: 'VENTAS',
        text: 'Revisá el pedido {pedido} de {cliente} y confirmalo: como supera su límite de crédito, va a esperar la autorización de Gerencia. Cuando esté autorizado y despachado, facturalo.',
      },
      {
        island: 1,
        role: 'GERENCIA',
        text: 'Decidí si se le vende a crédito a {cliente}: mirá su cuenta corriente y autorizá el pedido {pedido} o rechazalo con el motivo. Quien cargó el pedido no puede autorizarlo.',
      },
      {
        island: 8,
        role: 'DEPOSITO',
        text: 'Cuando el pedido {pedido} esté autorizado, prepará la mercadería y despachala con su remito.',
      },
      {
        island: 5,
        role: 'TESORERIA',
        text: 'Cuando {cliente} pague la factura del pedido {pedido}, registrá el cobro con su recibo.',
      },
    ],
    criteria: [
      {
        key: 'VC_REVISA',
        island: 3,
        text: 'Ventas confirmó el pedido {pedido} y quedó esperando a Gerencia por el crédito.',
      },
      { key: 'VC_DECIDE', island: 1, text: 'Gerencia autorizó el crédito o rechazó el pedido {pedido} con el motivo.' },
      { key: 'VC_DESPACHO', island: 8, text: 'Depósito despachó el pedido {pedido} con su remito.' },
      { key: 'VC_FACTURA', island: 3, text: 'Ventas facturó el pedido {pedido}.' },
      { key: 'VC_COBRO', island: 5, text: 'Tesorería registró un cobro de {cliente}.' },
    ],
  },
}

/** Los datos de una corrida que completan los textos. */
export interface ScenarioLabels {
  order: string
  customer: string
  product: string
  quantity: number
  available: number | null
  credit_limit: number | null
}

/** Completa un texto del escenario con los datos de la corrida. */
export function scenarioText(text: string, labels: ScenarioLabels, money: (n: number) => string) {
  return text
    .replaceAll('{pedido}', labels.order)
    .replaceAll('{cliente}', labels.customer)
    .replaceAll('{producto}', labels.product)
    .replaceAll('{cantidad}', String(labels.quantity))
    .replaceAll('{disponible}', String(labels.available ?? 0))
    .replaceAll('{limite}', labels.credit_limit === null ? 'sin límite' : money(labels.credit_limit))
}
