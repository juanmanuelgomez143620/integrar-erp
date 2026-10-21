# Fase 4 — Ventas, clientes y cobranzas

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 4), [DATABASE.md §7.1 y §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §7](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

El circuito es el espejo del de compras, que los estudiantes ya conocen: el cliente pide, Ventas arma el **pedido** (controla el crédito y reserva el stock), Depósito prepara y despacha con el **remito**, Ventas **factura** lo entregado, la deuda del cliente queda en su **cuenta corriente** y Tesorería **cobra**. Cada paso lo hace otro sector, y la contabilidad se arma sola.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 4a | Pedido de venta con control de crédito y reserva de stock; remito que descuenta el stock y genera el costo de lo vendido | El pedido del cliente llega a Depósito y la mercadería sale | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
| 4b | Factura de venta contra lo entregado, con su asiento; cuenta corriente de clientes | La venta termina en la contabilidad y en la deuda del cliente | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
| 4c | Recibo de cobro, antigüedad de saldos (clientes morosos) y cobros en el flujo de fondos proyectado | El circuito vuelve a la caja y al banco | Pendiente |
| 4d | Listas de precios y presupuestos | El pedido nace de un presupuesto aceptado, con los precios de la lista del cliente | Pendiente |

## 2. Pedido de venta (`PV-00001`, 4a)

- Lo carga **Ventas** cuando el cliente compra: cliente, depósito desde el que se entrega, fecha de entrega pedida (opcional), condición de pago en días (propone la del cliente), referencia del cliente (por ejemplo, su número de orden de compra) y los ítems. Se venden **productos terminados, mercaderías de reventa y servicios** (el flete); las materias primas y los insumos no **(a validar)**. Cada ítem lleva cantidad y precio unitario sin IVA: se propone el precio de venta del producto y, si Ventas lo baja, el pedido muestra la bonificación. No se modifica: si está mal, se anula y se carga otro.
- **Confirmar** (Ventas) hace dos controles:
  - **Stock disponible**: de cada producto, lo que hay en el depósito menos lo reservado para otros pedidos. Si alcanza, el pedido lo **reserva**; si no, no se confirma y el mensaje dice cuánto hay y cuánto está reservado (escenario **"falta de stock"**: pedir menos, esperar la reposición o la producción, o entregar desde otro depósito). Lo reservado no se guarda aparte: es lo que les falta entregar a los pedidos en curso.
  - **Crédito del cliente**: si tiene facturas vencidas sin cobrar, o si con este pedido su deuda (facturas sin cobrar más los pedidos en curso todavía sin facturar, con IVA) superaría su **límite de crédito**, el pedido queda **pendiente de aprobación** de Gerencia, con el motivo a la vista (escenarios **"venta a crédito"** y **"cliente moroso"**) **(a validar)**. Un cliente sin límite definido sólo se controla por las facturas vencidas. El stock queda reservado mientras Gerencia decide.
- **Gerencia** autoriza el crédito (el pedido queda confirmado) o lo rechaza con motivo (la reserva se libera). Quien preparó el pedido no lo autoriza (SoD-8).
- Estados: **Borrador → Confirmado** (o **Pendiente de aprobación → Confirmado / Rechazado**) **→ Entregado parcialmente → Entregado**. Se **anula** con motivo antes de la primera entrega; con entregas, se **cierra con saldo** y la reserva de lo que falta se libera.
- Se imprime como nota de pedido para el cliente, con la leyenda de simulación.

## 3. Remito (`REM-00001`, 4a)

- Lo prepara **Depósito** contra un pedido confirmado o entregado parcialmente: qué sale de cada ítem (como mucho lo que falta entregar), transportista y observaciones. En borrador está **en preparación**: todavía no movió stock.
- **Despachar** (confirmar): el stock baja al costo promedio ponderado (movimiento "Despacho por venta"), la reserva se libera, el pedido pasa a entregado parcialmente o entregado, Ventas recibe el aviso y se genera el asiento automático **`COSTO_VENTA`**: Costo de ventas al debe y Bienes de cambio al haber, al costo con que salió la mercadería **(a validar)**. Así el inventario de la contabilidad acompaña al stock en cada salida; la venta en sí (el ingreso y el crédito) la registra la factura (4b). Los servicios van en el remito sin mover stock ni costo.
- Se **anula** con motivo: el borrador, sin más; uno despachado, con contramovimiento (la mercadería vuelve al depósito al costo con que salió) y el contraasiento de su costo, siempre que lo entregado no quede por debajo de lo facturado y el pedido no esté cerrado. No lo anula quien lo despachó (SoD-3, como las recepciones), salvo Gerencia.
- El remito impreso es un documento de simulación: no imita un remito oficial (sin CAI, sin código de barras, sin la letra R).

## 4. Factura de venta y cuenta corriente de clientes (4b)

- **Factura de venta (`FV-00001`)**: la emite **Ventas** contra un pedido, por lo entregado y todavía no facturado (control por oposición: no se factura lo que no salió). Como la empresa es responsable inscripta, la letra depende del cliente: **A** a responsables inscriptos y monotributistas (desde la Ley 27.618 y la RG 5003/2021, el monotributista recibe factura A) y **B** a exentos y consumidores finales; en la A el IVA se discrimina, en la B está incluido en los precios **(a validar)**. Lleva un número de comprobante simulado (punto de venta 00001 y número correlativo por letra, que se asigna al registrarla: un borrador no consume número y una anulada conserva el suyo), toma la fecha del día en que se registra y vence según la condición de pago del pedido. Los precios son los del pedido.
- **Registrar** genera el asiento automático **`VENTA`** (Deudores por ventas al debe; Ventas de productos terminados, de mercaderías o de servicios e IVA débito fiscal al haber) y la deuda del cliente. Se anula con contraasiento si no tiene cobros. Nunca imita una factura oficial: sin CAE, sin código QR, con la leyenda de simulación.
- **Cuenta corriente de clientes**: por cliente, las facturas (debe) y los cobros (haber), con el saldo acumulado y las facturas pendientes con su vencimiento. Se calcula, nunca se edita; la suma de los saldos coincide con el mayor de Deudores por ventas.

## 5. Cobros (4c)

- **Recibo de cobro (`RBO-00001`)**: lo registra **Tesorería** cuando el cliente paga: qué facturas cancela y cuánto de cada una (el cobro puede ser parcial), el medio (efectivo, transferencia o cheque de terceros, con su número) y la caja o el banco donde ingresa; los cheques van a Valores a depositar hasta que se depositan con una transferencia entre cuentas (3d.1). Al confirmarse genera el asiento automático **`COBRO`** (la caja o el banco al debe, Deudores por ventas al haber) y cada factura pasa a cobrada parcialmente o cobrada. Se anula con contraasiento. Quien emitió la factura no registra su cobro (SoD-9).
- **Antigüedad de saldos**: la deuda de cada cliente según el vencimiento de sus facturas (a vencer, vencida de 1 a 30 días, de 31 a 60, de 61 a 90 y de más de 90). Los clientes con facturas vencidas son los **morosos**: para venderles a crédito hace falta la autorización de Gerencia (§2).
- El **flujo de fondos proyectado** (3d.1) suma los cobros esperados, por el vencimiento de las facturas de venta, a los pagos.

## 6. Listas de precios y presupuestos (4d)

- **Listas de precios**: el precio de cada producto en cada lista (por ejemplo, mayorista y minorista); cada cliente tiene la suya, y la lista se actualiza por porcentaje (contexto inflacionario). El pedido propone el precio de la lista del cliente.
- **Presupuesto (`PRE-00001`)**: Ventas le cotiza a un cliente (ítems, precios de su lista, validez de la oferta). **Enviado → Aceptado** (genera el pedido en borrador) **/ Rechazado / Vencido**. No reserva stock ni controla crédito: eso pasa al confirmar el pedido.

## 7. Asientos automáticos (reglas base, a validar)

| Evento | Clave | Cuenta propuesta |
|---|---|---|
| `COSTO_VENTA` (remito despachado, 4a) | `COSTO_PRODUCTO_TERMINADO`, `COSTO_MERCADERIA_REVENTA` | Costo de productos vendidos, Costo de mercaderías vendidas (debe) |
| | `PRODUCTO_TERMINADO`, `MERCADERIA_REVENTA` | Productos terminados, Mercaderías de reventa (haber) |
| `VENTA` (factura registrada, 4b) | `DEUDORES` | Deudores por ventas (debe) |
| | `PRODUCTO_TERMINADO`, `MERCADERIA_REVENTA`, `SERVICIO` | Ventas de productos terminados, de mercaderías de reventa, Ingresos por servicios (haber) |
| | `IVA_DEBITO` | IVA débito fiscal (haber) |
| `COBRO` (recibo confirmado, 4c) | `DEUDORES` | Deudores por ventas (haber; la contrapartida es la caja o el banco del recibo) |

## 8. Permisos (a validar)

| Permiso | Roles |
|---|---|
| `sales_order.read` (pedidos de venta) | Ventas, Gerencia, Depósito, Contabilidad, Tesorería, Impuestos, Logística, Auditoría |
| `sales_order.create/cancel` | Ventas (cancel también cierra con saldo) |
| `sales_order.approve` (autorizar el crédito) | Gerencia |
| `delivery_note.read` (remitos) | Depósito, Ventas, Logística, Gerencia, Contabilidad, Tesorería, Impuestos, Auditoría |
| `delivery_note.create/cancel` | Depósito |
| `sales_invoice.read` (facturas de venta, 4b) | Ventas, Gerencia, Contabilidad, Tesorería, Impuestos, Auditoría |
| `sales_invoice.create/cancel` | Ventas (sólo se anula una registrada sin cobros) |
| `receivable.read` (cuenta corriente de clientes) | Ventas, Gerencia, Contabilidad, Tesorería, Impuestos, Auditoría |
| Cobros (4c) | Se detallan al hacerlos: Tesorería cobra; Contabilidad y Gerencia consultan |

Separación de funciones nueva: **SoD-8**, quien prepara un pedido de venta no autoriza su crédito; **SoD-9**, quien emite la factura no registra su cobro. Depósito despacha y Ventas factura: lo que se factura se controla contra lo que salió.
