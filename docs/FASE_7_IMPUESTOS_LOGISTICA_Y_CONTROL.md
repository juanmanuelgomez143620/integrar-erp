# Fase 7 — Impuestos, logística y control de gestión

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 7), [DATABASE.md §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §4](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Forestal del Norte es responsable inscripta en el IVA y contribuyente de ingresos brutos (simulado). Hasta ahora cada factura registraba su IVA (crédito fiscal en las compras con letra A, débito fiscal en las ventas), pero nadie lo liquidaba, y las islas de **Impuestos** y **Logística** sólo consultaban. En esta fase Impuestos arma los libros IVA, liquida el IVA y los ingresos brutos de cada mes con declaraciones simuladas y lleva el calendario de vencimientos; **Tesorería** le paga al fisco simulado; Logística organiza el reparto de lo que despacha Depósito y registra cada entrega; y **Gerencia** tiene un tablero de control con los indicadores de todas las áreas. Completa los escenarios "venta a crédito" (el pedido termina con la entrega) y "problema de liquidez" (los impuestos entran al flujo de fondos).

Límites: el fisco es simulado (no hay conexión con organismos reales, ni CAE, ni formularios oficiales o sus números); alícuotas y vencimientos son propuestas **a validar**; lo que se imprime lleva la leyenda de simulación y no imita un formulario oficial.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 7a | Libros IVA compras y ventas por mes; declaración mensual de IVA (débito menos crédito y saldo a favor anterior) con su asiento al presentarla; pago por Tesorería | Impuestos sabe cuánto IVA se paga y de dónde sale | Pendiente |
| 7b | Ingresos brutos simplificado (alícuota sobre las ventas netas del mes) con percepciones y retenciones sufridas; calendario de obligaciones (IVA, ingresos brutos, cargas sociales y sueldos) con su estado | Nada vence sin que se vea | Pendiente |
| 7c | Logística: transportistas y vehículos; hojas de ruta con los remitos despachados; entrega con conformidad o no entrega con motivo | El pedido termina cuando el cliente lo recibe | Pendiente |
| 7d | Tablero de control: indicadores por área, comparación con el mes anterior y alertas | Gerencia ve la empresa entera en una pantalla | Pendiente |

## 2. IVA (7a)

- **Libro IVA ventas** de un mes: las facturas de venta cuyo asiento es del mes, una por fila: fecha, comprobante (letra, punto de venta y número), cliente con su CUIT (simulado) y condición frente al IVA, neto gravado por alícuota (21 %, 10,5 % y 27 %), exento o no gravado (alícuota 0), IVA por alícuota y total. Una factura anulada resta en el mes de su contraasiento. Los totales coinciden con lo que se movió en el mes en IVA débito fiscal (`2.1.04.01`).
- **Libro IVA compras**: las facturas de proveedores cuyo asiento es del mes. Las de letra A discriminan el crédito fiscal; las de letra C van por el total, sin crédito fiscal (el IVA es costo). Los totales coinciden con IVA crédito fiscal (`1.1.04.01`) del mes.
- **Declaración mensual de IVA** (`DJ-00001`, simulada): la prepara Impuestos para un mes ya terminado.
  - Cálculo: débito fiscal del mes − crédito fiscal del mes − saldo a favor de la declaración del mes anterior = **saldo a pagar** o, si es negativo, **saldo a favor** para el mes siguiente.
  - Estados: **Borrador** (se revisa; se recalcula si cambian los libros) → **Presentada** (asiento `IVA`; queda fijo lo declarado) → **Pagada** (Tesorería, asiento `PAGO_IVA`). Con saldo a favor no hay nada que pagar: queda Presentada. Se anula con motivo mientras no esté pagada (la presentada, con contraasiento).
  - Asiento al presentarla: IVA débito fiscal al debe por el débito del mes; IVA crédito fiscal al haber por lo que se usa (el crédito del mes más el saldo anterior, hasta el débito); IVA a pagar al haber por el saldo. El saldo a favor no se mueve: queda en IVA crédito fiscal, que así muestra lo que hay a favor.
  - Pago: desde una caja o un banco con saldo, como los sueldos (Fase 6c). Asiento `PAGO_IVA`: IVA a pagar al debe, la caja o el banco al haber. Entra al flujo de fondos real (concepto "Impuestos") y, presentada sin pagar, al proyectado en su vencimiento.
- Decisiones de la implementación **(a validar)**:
  - El mes de cada factura es el de su asiento (la registración), no la fecha del comprobante.
  - Una sola declaración por impuesto y mes (sin contar las anuladas). Después de la primera presentada, los meses van en orden: no se prepara la de un mes si la del anterior no está presentada.
  - Vence el día 20 del mes siguiente.
  - Quien la presentó no la paga (SoD-10), como en los sueldos.

## 3. Ingresos brutos y calendario (7b)

- **Ingresos brutos simplificado**: una alícuota única sobre las ventas netas de IVA del mes (neto gravado más exento de las facturas de venta del mes, menos las anuladas), **3 % por defecto, a validar**; el docente la cambia en la configuración de la empresa.
- **Percepciones y retenciones sufridas**: la factura de proveedor suma un importe opcional, "Percepción de ingresos brutos", que cobra el proveedor (va a Retenciones y percepciones sufridas, `1.1.04.03`, y a lo que se le debe); el recibo de cobro suma la "Retención de ingresos brutos" que hace el cliente al pagar (entrega el certificado en lugar de ese dinero: va a la misma cuenta). Las del mes se descuentan del impuesto.
- **Declaración mensual de ingresos brutos** (`DJ`, impuesto ingresos brutos): impuesto determinado (base × alícuota) − percepciones y retenciones del mes − saldo a favor anterior = saldo a pagar o a favor. Asiento `IIBB` al presentarla: Impuesto sobre los ingresos brutos (`5.2.03.01`) al debe; Retenciones y percepciones sufridas al haber por lo que se usa; Ingresos brutos a pagar al haber por el saldo. Pago `PAGO_IIBB`. Mismos estados y reglas que la de IVA; vence el día 15 del mes siguiente (a validar).
- **Calendario de obligaciones** (Impuestos → Vencimientos): por mes, cada obligación con su vencimiento y su estado, que sale de los documentos (no se carga a mano):
  - IVA e ingresos brutos: **pendiente** (sin declaración presentada), **presentada** (falta pagar), **pagada**; **vencida** si pasó la fecha sin pagarse.
  - Sueldos y cargas sociales, de la liquidación del mes (Fase 6c): pendiente o pagada, y vencida.

## 4. Logística (7c)

- **Transportistas** (fletes contratados: razón social, CUIT simulado y teléfono) y **vehículos** propios (dominio ficticio y descripción). Los mantiene Logística; se desactivan, no se borran.
- **Hoja de ruta** (`HR-00001`): Logística la arma para un día con un vehículo propio y su chofer, o con un transportista, y los remitos despachados que todavía no se entregaron, en el orden de visita. Estados: **Borrador** → **En camino** (salió: sus remitos pasan a "en camino") → **Cerrada** (rendida: cada remito queda **entregado**, con quién lo recibió, o **no entregado**, con el motivo, y vuelve a estar pendiente para otra hoja). Se anula en borrador.
- El remito muestra su estado de entrega (pendiente, en camino, entregado o no entregado) y Ventas recibe el aviso de cada entrega.
- Decisiones **(a validar)**: no hay rechazo con devolución de mercadería (sería una nota de crédito y un ingreso al stock, fuera de esta fase); el flete de un transportista se registra con su factura de proveedor, como hasta ahora; el chofer es un empleado del legajo.

## 5. Tablero de control (7d)

- **Control → Tablero de control** (Gerencia, Auditoría y el docente): un mes elegido contra el anterior, por área, con su variación:
  - Ventas: facturado neto y margen bruto (ventas netas menos costo de lo vendido).
  - Cobranzas: cobrado, deuda de los clientes y lo vencido.
  - Compras y pagos: comprado, pagado, deuda con proveedores y lo vencido.
  - Stock: valorizado y productos bajo el mínimo.
  - Producción: órdenes terminadas, costo real contra estándar y mano de obra sub- o sobreaplicada.
  - Personal: costo laboral del mes.
  - Tesorería: disponible y saldo proyectado.
  - Impuestos: IVA e ingresos brutos del mes y vencimientos.
- **Alertas**: lo que requiere atención, con el enlace a cada caso (stock bajo el mínimo, facturas vencidas, falta de fondos, obligaciones vencidas).
- Todo sale de los documentos y del libro mayor; cada indicador respeta lo que el usuario puede leer.

## 6. Asientos automáticos (reglas base, a validar)

| Evento | Clave | Cuenta propuesta |
|---|---|---|
| `IVA` (declaración presentada) | `IVA_DEBITO` | IVA débito fiscal (debe) |
| | `IVA_CREDITO` | IVA crédito fiscal (haber) |
| | `IVA_A_PAGAR` | IVA a pagar (haber) |
| `PAGO_IVA` | `IVA_A_PAGAR` | IVA a pagar (debe); la caja o el banco al haber |
| `IIBB` (declaración presentada) | `IMPUESTO` | Impuesto sobre los ingresos brutos (debe) |
| | `RETENCIONES` | Retenciones y percepciones sufridas (haber) |
| | `IIBB_A_PAGAR` | Ingresos brutos a pagar (haber) |
| `PAGO_IIBB` | `IIBB_A_PAGAR` | Ingresos brutos a pagar (debe); la caja o el banco al haber |
| `COMPRA` (7b) | `PERCEPCIONES` | Retenciones y percepciones sufridas (debe) |
| `COBRO` (7b) | `RETENCIONES` | Retenciones y percepciones sufridas (debe) |

## 7. Permisos (a validar)

Módulos nuevos **`tax`** ("Impuestos") y **`logistics`** ("Logística"), que el docente puede bloquear.

| Permiso | Roles |
|---|---|
| `tax_return.read` (libros IVA, declaraciones y vencimientos) | Impuestos, Contabilidad, Gerencia, Tesorería, Auditoría |
| `tax_return.create/cancel` (preparar, presentar y anular) | Impuestos |
| `tax_return.pay` (pagar al fisco) | Tesorería |
| `carrier.read` (transportistas y vehículos) y `route_sheet.read` (hojas de ruta) | Logística, Depósito, Ventas, Gerencia, Auditoría |
| `carrier.create/update` y `route_sheet.create/cancel` | Logística |

Impuestos liquida y Tesorería paga (control por oposición); Depósito despacha y Logística entrega.
