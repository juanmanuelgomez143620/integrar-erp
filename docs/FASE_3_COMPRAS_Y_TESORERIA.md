# Fase 3 — Compras completo, cuentas a pagar y tesorería

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 3), [DATABASE.md §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §7](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 3a | Motor de imputación, factura de proveedor y cuenta corriente | La compra termina en un asiento automático y en la deuda con el proveedor | Hecho (simulador, pantallas y Supabase con paridad) |
| 3b | Tesorería: cajas y bancos, orden de pago con aprobación y pago | La deuda se cancela; el pago mueve el banco o la caja y genera su asiento | Pendiente |
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

- **Cajas y bancos** de la empresa, cada una con su cuenta contable (Caja → 1.1.01.01, Banco cuenta corriente → 1.1.01.03). El saldo sale del libro mayor: no hay saldos editables.
- **Orden de pago (`OP-00001`)**: la prepara Contabilidad o Tesorería para un proveedor, con las facturas que cancela y el importe de cada una, y desde qué caja o banco se paga. **Borrador → Pendiente de aprobación** (la aprueba Gerencia) **→ Aprobada → Pagada** (Tesorería la ejecuta: asiento `PAGO` y la factura pasa a pagada). Separación de funciones (SoD-5): quien registró una factura no la paga.
- Los movimientos de cada caja y banco son su libro mayor.

## 6. Permisos (a validar)

| Permiso | Roles |
|---|---|
| `supplier_invoice.read` | Compras, Contabilidad, Tesorería, Impuestos, Gerencia, Auditoría |
| `supplier_invoice.create/cancel` | Compras (un borrador no se modifica: se anula y se carga de nuevo) |
| `payable.read` (cuenta corriente) | Compras, Contabilidad, Tesorería, Gerencia, Auditoría |
| `posting_rule.read/update` | Contabilidad (lectura: Gerencia, Auditoría) |
| `payment_order.*`, `treasury.*` (3b) | Contabilidad y Tesorería operan; Gerencia aprueba |
