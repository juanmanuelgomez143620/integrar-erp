# Fase 3 — Compras completo, cuentas a pagar y tesorería

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 3), [DATABASE.md §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §7](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 3a | Motor de imputación, factura de proveedor y cuenta corriente | La compra termina en un asiento automático y en la deuda con el proveedor | Hecho (simulador, pantallas y Supabase con paridad) |
| 3b | Tesorería: cajas y bancos, orden de pago con aprobación y pago | La deuda se cancela; el pago mueve el banco o la caja y genera su asiento | Hecho (simulador, pantallas y Supabase con paridad) |
| 3c | Solicitud de cotización, cotizaciones y cuadro comparativo | La OC nace de la mejor cotización | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
| 3d.1 | Transferencias entre cajas y bancos y flujo de fondos (real y proyectado) | Tesorería mueve fondos y anticipa si alcanzan | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
| 3d.2 | Cheques propios y conciliación bancaria simplificada | Tesorería completa | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |

## 2. Motor de imputación (`posting_rules`)

Cada evento contable tiene reglas por empresa que dicen a qué cuenta va cada importe: `(evento, clave) → cuenta`. La plantilla trae las reglas base y Contabilidad puede cambiar la cuenta de cada una (pantalla "Imputación automática"). El motor arma el asiento con origen **Automático**, lo registra en el libro diario con las mismas validaciones que uno manual (período abierto, fecha correlativa) y lo vincula al documento de origen, que lo muestra en su flujo documental. Si falta una regla o el mes está cerrado, la operación no se hace y el mensaje dice por qué.

| Evento | Clave | Cuenta propuesta (a validar) |
|---|---|---|
| `COMPRA` (factura registrada) | `MATERIA_PRIMA`, `INSUMO`, `PRODUCTO_TERMINADO`, `MERCADERIA_REVENTA` | Bienes de cambio de cada tipo |
| | `SERVICIO` | Fletes y acarreos |
| | `IVA_CREDITO` | IVA crédito fiscal |
| | `PROVEEDORES` | Proveedores |
| `PAGO` (orden de pago pagada, 3b) | `PROVEEDORES` | Proveedores (la contrapartida es la cuenta contable de la caja o el banco) |

## 3. Factura de proveedor (`FP-00001`)

- La registra **Compras** contra una OC enviada o recibida (control por oposición): por cada línea, como mucho lo **recibido menos lo ya facturado**, al precio de la OC (editable; la diferencia con la OC se muestra). Datos del comprobante del proveedor: letra (A si es responsable inscripto, C si no), punto de venta y número (`0003-00004521`), fecha y vencimiento (fecha + plazo de pago pactado en la OC). No se repite el mismo comprobante del mismo proveedor.
- Estados: **Borrador** → **Registrada** (genera el asiento `COMPRA` y la deuda) → **Pagada parcialmente** / **Pagada** (por las órdenes de pago, 3b). Se **anula** sólo si no tiene pagos: el asiento se revierte con un contraasiento.
- Con letra A, el IVA va a IVA crédito fiscal; con letra C, el IVA no se discrimina y es parte del costo.
- Es un documento de registro, no un comprobante: nunca imita una factura oficial y su impresión lleva la leyenda de simulación.

## 4. Cuenta corriente de proveedores

Se calcula, nunca se edita: por proveedor, las facturas registradas (aumentan la deuda) y los pagos (la disminuyen), con saldo acumulado y facturas pendientes con su vencimiento. La suma de los saldos coincide con el mayor de Proveedores (salvo los saldos de apertura, que por ahora no tienen proveedor).

## 5. Tesorería (3b)

- **Cajas y bancos** son las cuentas imputables del rubro 1.1.01 "Caja y bancos" del plan de cuentas (Caja, Fondo fijo, Banco cuenta corriente, Valores a depositar y las que agregue Contabilidad): no hay un maestro aparte ni saldos editables. La pantalla "Cajas y bancos" muestra el saldo de cada una, que sale del libro mayor, y lleva a sus movimientos (su mayor).
- **Orden de pago (`OP-00001`)**: la prepara Contabilidad o Tesorería para **un** proveedor: qué facturas cancela, cuánto de cada una (pago total o parcial) y desde qué caja o banco. Por factura, como mucho su saldo menos lo que ya está en otras órdenes en curso (lo reservado no se paga dos veces). No se modifica: si está mal, se anula y se prepara otra.
- Estados: **Borrador → Pendiente de aprobación → Aprobada** (Gerencia) **→ Pagada** (Tesorería). Gerencia puede **rechazarla** con motivo (queda Rechazada). Antes de pagarse se anula con motivo; una orden **pagada** se anula con el contraasiento de su pago y las facturas vuelven a tener saldo.
- **Pagar**: la caja o el banco tiene que tener saldo suficiente; genera el asiento automático `PAGO` (Proveedores al debe, la caja o el banco al haber) con fecha de hoy, y cada factura pasa a **Pagada parcialmente** o **Pagada**. Se puede anotar una referencia (número de transferencia o de cheque).
- **Separación de funciones**: quien preparó la orden no la aprueba ni la rechaza; quien registró una de sus facturas no la paga (SoD-5).
- Una factura incluida en una orden en curso no se anula: primero se anula la orden. En la cuenta corriente, los pagos van al debe y bajan el saldo.

## 6. Cotizaciones (3c)

El circuito enseña a **pedir precio antes de comprar** y a **justificar la elección**: Compras pide cotización a varios proveedores, carga lo que responde cada uno, los compara en un cuadro y adjudica; de la cotización elegida nace la OC, que sigue su aprobación por monto como siempre.

- **Solicitud de cotización (`SCT-00001`)**: la prepara Compras, a mano o desde una SC pendiente (botón "Pedir cotizaciones"): productos y cantidades (cada línea puede atender una línea de SC, como en la OC, sin superar lo pendiente), depósito de entrega, fecha límite para responder y los **proveedores invitados**, al menos dos **(a validar)**. Estados: **Borrador → Enviada → Adjudicada**; se **anula** con motivo antes de adjudicarse. No se modifica: si está mal, se anula y se prepara otra. Se imprime para mandarla a los proveedores.
- **Cotización (`COT-00001`)**: Compras carga la respuesta de un proveedor invitado a una solicitud enviada: precio unitario de cada ítem que cotiza (puede no cotizar alguno), alícuota de IVA, plazo de entrega en días, condición de pago, validez de la oferta (no se carga una oferta vencida) y su referencia. Un proveedor responde una vez por solicitud: si cambia su oferta, se anula la cotización y se carga la nueva. Estados: **Recibida → Adjudicada / Descartada**, o **Anulada** con motivo.
- Un proveedor que no es responsable inscripto cotiza el **precio final** (no discrimina IVA: su IVA es costo), así que sus líneas van sin IVA.
- **Cuadro comparativo** (en la solicitud y en su impresión): una columna por cotización y una fila por ítem, con el precio más bajo de cada fila marcado; por cotización, el **costo para la empresa** (el neto sin IVA, porque el IVA de un responsable inscripto es crédito fiscal; si el proveedor no lo discrimina, su precio final), el total con IVA, los ítems que cotizó, el plazo de entrega, la condición de pago y la validez. Los proveedores invitados que no respondieron figuran como "Sin respuesta". Mientras la solicitud está enviada, se marca la **más conveniente por precio**: la de menor costo entre las vigentes que cotizan todos los ítems (a igual costo, la de menor plazo de entrega) **(a validar)**.
- **Adjudicar** (Compras): se elige **una** cotización vigente para toda la solicitud. Si no es la más conveniente por precio (o ninguna cotiza todo), hay que **justificar** la elección (por ejemplo, el plazo de entrega o la condición de pago) **(a validar)**. Se genera la **OC en borrador** con el proveedor, los ítems cotizados a sus precios, el depósito de la solicitud, la condición de pago y la entrega comprometida (hoy + plazo de entrega), vinculada a las SC que atendía; la solicitud queda Adjudicada con su justificación, la cotización elegida Adjudicada y las demás Descartadas. Los ítems que la cotización no cubría quedan pendientes en su SC.
- La aprobación de Gerencia (la **A** de la matriz de ROLES_Y_PERMISOS.md §7) ocurre en la OC, por monto: Gerencia ve de qué cotización nace y, en la solicitud, la justificación.
- Tareas: "Enviar SCT-00001 a los proveedores" (a quien la preparó, si quedó en borrador) y "Comparar y adjudicar SCT-00001" (a Compras, mientras está enviada).

## 7. Tesorería completa (3d)

**3d.1 — Transferencias y flujo de fondos**

- **Transferencia entre cuentas (`TF-00001`)**: Tesorería mueve fondos entre dos cajas o bancos de la empresa (depositar el efectivo en el banco, extraer para la caja, reponer el fondo fijo, depositar valores), con importe y referencia (número de boleta o de transferencia). **Borrador → Confirmada**: al confirmarse controla que alcance el saldo de la cuenta de origen y genera el asiento automático (la cuenta de destino al debe, la de origen al haber). Una confirmada se anula con el contraasiento. No es para gastos ni intereses del banco: esos los registra Contabilidad con un asiento.
- **Flujo de fondos real** (pantalla "Flujo de fondos", por período): saldo inicial de cajas y bancos, entradas y salidas agrupadas por concepto según el documento que las originó (pagos a proveedores, movimientos entre cajas y bancos, saldos de apertura y otros asientos de Contabilidad) y saldo final, por cuenta y en total. Sale del libro mayor: nunca se carga a mano.
- **Flujo de fondos proyectado**: desde el saldo de hoy, resta lo que vence de las facturas de proveedores (lo que les falta pagar), agrupado por vencimiento (vencidas, próximos 7 días, 8 a 15, 16 a 30 y más de 30), con el saldo que quedaría después de cada tramo. Si en algún tramo no alcanza, lo avisa: es el escenario "problema de liquidez" (conseguir fondos o negociar plazos). Los cobros a clientes se sumarán con Ventas (Fase 4).

**3d.2 — Cheques y conciliación**

- **Cheques propios**: al pagar una orden de pago desde un banco, Tesorería elige el medio, transferencia o cheque (con su número, obligatorio); desde una caja, efectivo. La pantalla "Cheques emitidos" lista los pagos con cheque y su estado: pendiente de débito, debitado (cuando una conciliación lo encuentra en el extracto) o anulado.
- **Conciliación bancaria simplificada (`CB-00001`)**: con el extracto del banco que da el docente, **Contabilidad** (no Tesorería, que maneja los fondos: control por oposición **(a validar)**) elige el banco, la fecha y el saldo del extracto, y marca qué movimientos del mayor figuran en el extracto. La pantalla calcula el saldo según libros, los movimientos pendientes (depósitos no acreditados y cheques o pagos no debitados) y la diferencia con el extracto; sólo se confirma si la diferencia es cero. Si no cierra, faltan registrar movimientos del banco (comisiones, intereses): Contabilidad los registra con un asiento y vuelve a conciliar. Confirmada, sus movimientos quedan conciliados; se anula sólo la última de cada banco.

## 8. Permisos (a validar)

| Permiso | Roles |
|---|---|
| `supplier_invoice.read` | Compras, Contabilidad, Tesorería, Impuestos, Gerencia, Auditoría |
| `supplier_invoice.create/cancel` | Compras (un borrador no se modifica: se anula y se carga de nuevo) |
| `payable.read` (cuenta corriente) | Compras, Contabilidad, Tesorería, Gerencia, Auditoría |
| `posting_rule.read/update` | Contabilidad (lectura: Gerencia, Auditoría) |
| `treasury.read` (cajas y bancos), `payment_order.read` | Contabilidad, Tesorería, Gerencia, Auditoría |
| `payment_order.create/cancel` | Contabilidad y Tesorería |
| `payment_order.approve` | Gerencia |
| `payment_order.pay` | Tesorería |
| `rfq.read`, `supplier_quote.read` (solicitudes de cotización y cotizaciones) | Compras, Gerencia, Contabilidad, Tesorería, Impuestos, Depósito, Auditoría |
| `rfq.create/cancel/award` (adjudicar), `supplier_quote.create/cancel` | Compras |
| `funds_transfer.read` (transferencias entre cuentas) | Tesorería, Contabilidad, Gerencia, Auditoría |
| `funds_transfer.create/cancel` | Tesorería |
| `bank_reconciliation.read` (conciliaciones, 3d.2) | Tesorería, Contabilidad, Gerencia, Auditoría |
| `bank_reconciliation.create/cancel` | Contabilidad |
