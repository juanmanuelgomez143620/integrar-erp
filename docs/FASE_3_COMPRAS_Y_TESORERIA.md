# Fase 3 — Compras completo, cuentas a pagar y tesorería

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 3), [DATABASE.md §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §7](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 3a | Motor de imputación, factura de proveedor y cuenta corriente | La compra termina en un asiento automático y en la deuda con el proveedor | Hecho (simulador, pantallas y Supabase con paridad) |
| 3b | Tesorería: cajas y bancos, orden de pago con aprobación y pago | La deuda se cancela; el pago mueve el banco o la caja y genera su asiento | Hecho (simulador, pantallas y Supabase con paridad) |
| 3c | Solicitud de cotización, cotizaciones y cuadro comparativo | La OC nace de la mejor cotización | Pendiente |
| 3d | Transferencias entre cuentas, cheques, conciliación simplificada y flujo de fondos | Tesorería completa | Pendiente |

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

## 6. Permisos (a validar)

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
