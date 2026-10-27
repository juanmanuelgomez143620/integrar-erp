# Fase 6 — RRHH y sueldos

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 6), [DATABASE.md](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §4](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Forestal del Norte tiene personal (ficticio): el taller, la administración, ventas y el depósito. Hasta ahora la isla de **RRHH y Sueldos** sólo consultaba, y la mano de obra entraba al costo de los muebles por horas × tarifa (Fase 5b) sin que nadie liquidara un sueldo. En esta fase **RRHH** lleva los legajos y las novedades del mes y liquida los sueldos (con un recibo simulado), el **asiento de sueldos** se genera solo, **Tesorería** paga los sueldos y las cargas sociales, y Contabilidad ve cuánta mano de obra del taller se aplicó de más o de menos a las órdenes. Es el escenario **"pago de salarios"** del ROADMAP.

Límites: los empleados son personajes de la empresa simulada (nombre y apellido inventados, sin documento ni datos reales); los porcentajes de aportes y contribuciones son **configurables** y no pretenden exactitud legal vigente; el recibo lleva la leyenda de simulación y no imita el formato de un recibo oficial.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 6a | Categorías (sueldo básico) y legajos: alta, cambios y baja del personal, con su sector y, en el taller, su centro de trabajo | RRHH conoce a la planta y lo que cuesta | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
| 6b | Liquidación mensual: novedades (días, horas extra, ausencias), conceptos remunerativos, descuentos y contribuciones; recibos simulados; asiento `SUELDOS` al confirmarla | El sueldo de cada uno y su costo para la empresa | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
| 6c | Pago de los sueldos y de las cargas sociales por Tesorería (con su asiento y en el flujo de fondos); mano de obra del taller real contra la aplicada a las órdenes | El ciclo cierra en el banco y en el costo de producción | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |

## 2. Categorías y legajos (6a)

- **Categoría** (la mantiene RRHH): código, nombre y **sueldo básico mensual** (un convenio simplificado, **a validar**): por ejemplo Oficial carpintero, Medio oficial, Ayudante de taller, Administrativo, Vendedor y Encargado. Si es del taller, su sueldo es **mano de obra directa**.
- **Legajo** de cada empleado: número correlativo, apellido y nombre (inventados), fecha de ingreso (para la antigüedad), categoría, sector de la empresa y, si trabaja en el taller, su **centro de trabajo** (Corte, Armado, Terminación). Se da de **baja** con fecha y motivo; no se borra. Sin documento, domicilio ni otros datos personales.
- La demo trae diez empleados **(a validar)**: seis del taller (dos por centro), una administrativa, una vendedora, un operario de depósito y la encargada general, con siete categorías. Sus sueldos guardan relación con las tarifas de mano de obra de los centros (Fase 5b), así la comparación del paso 6c da diferencias chicas y explicables. La empresa nueva de un curso copia el personal de la plantilla.
- Pantallas: **RRHH → Legajos** (el alta, los cambios y la baja en el mismo diálogo; las bajas se ven a pedido) y **RRHH → Categorías**.
- Decisiones de la implementación **(a validar)**: la fecha de ingreso no puede ser futura ni anterior al inicio de actividades de la empresa; una categoría con personal activo no cambia entre taller y no taller (primero se pasa a esa gente a otra categoría); una categoría o un centro inactivo no se asigna, pero quien ya lo tiene lo conserva; la baja es definitiva (no hay reincorporación: se da de alta un legajo nuevo) y el número de legajo nunca se reutiliza. RRHH ve los centros de trabajo para asignarlos.

## 3. Liquidación mensual (6b, `LIQ-00001`)

- La prepara **RRHH** para un período (mes) con su **fecha de pago**; trae a todos los legajos activos. De cada uno carga las **novedades**: días trabajados (30 por defecto), horas extra al 50 % y al 100 %, y días de ausencia sin aviso.
- **Conceptos** (los porcentajes están en la configuración de la empresa, **a validar**):
  - Remunerativos: **básico** (proporcional a los días), **antigüedad** (1 % del básico por año), **presentismo** (8,33 % de básico más antigüedad, si no tuvo ausencias) y **horas extra** (valor hora = básico más antigüedad sobre 200, con el 50 % o el 100 % de recargo).
  - Descuentos del empleado (aportes): jubilación 11 %, ley 19.032 3 % y obra social 3 % del remunerativo.
  - Contribuciones de la empresa (no se descuentan, son costo): un porcentaje único del remunerativo, por ejemplo 24 %.
  - **Neto a cobrar** = remunerativo − descuentos.
- Estados: **Borrador** (se cargan y corrigen las novedades) → **Confirmada** (quedan los recibos y se genera el asiento) → **Pagada** (6c). El borrador se **anula** con motivo; la confirmada sin pagos, con motivo y contraasiento.
- **Recibo simulado** de cada empleado (se imprimen todos juntos, uno por hoja): los conceptos con su cantidad e importe, el total remunerativo, los descuentos y el neto, con la leyenda de simulación.
- Pantallas: **RRHH → Liquidaciones** (la lista; la nueva pide el mes y la fecha de pago, y propone el día 4 del mes siguiente; el documento muestra los totales, las novedades de cada empleado, que se cambian mientras está en borrador, el asiento y los recibos para imprimir). El docente cambia los porcentajes en **Panel docente → Módulos y control interno → Sueldos**.
- Decisiones de la implementación **(a validar)**:
  - Una sola liquidación por mes (sin contar las anuladas), de un mes que ya empezó y no anterior al inicio de actividades; la fecha de pago no puede ser anterior al mes liquidado.
  - Entran los legajos activos que ingresaron hasta el fin del mes. Quien ingresó en el mes empieza con los días desde su ingreso (mes comercial de 30 días). Las bajas no entran: la liquidación final queda para más adelante.
  - Al crearla se copian el básico de cada categoría, la antigüedad (años cumplidos al fin del mes) y los porcentajes de la empresa: si después cambian, la liquidación conserva los suyos (para tomarlos, se anula y se hace otra).
  - Novedades: días trabajados y ausencias sin aviso, enteros que juntos no pasan de 30 (las licencias pagas cuentan como trabajadas); horas extra de 0 a 200, con hasta 2 decimales.
  - Cada concepto se redondea a centavos; el valor hora es el básico más la antigüedad del mes entero, sobre 200.
  - El asiento lleva la fecha en que se confirma (el libro diario es correlativo), no la del fin del mes.
  - Los porcentajes los cambia el docente en la configuración de la empresa: de 0 a 100, con hasta 2 decimales.
  - La confirma RRHH, la misma isla que la prepara: el control por oposición está en el pago, que hace Tesorería (6c). Una liquidación sin importes (todos con 0 días trabajados) no se confirma. Confirmada, la tarea pasa a Tesorería: pagar los netos en la fecha de pago.
  - La línea de cada empleado copia si su categoría es del taller y su centro de trabajo: es lo que usa el asiento (mano de obra directa) y lo que usará el informe de la 6c.
- **Asiento `SUELDOS`** al confirmar: al debe, **Sueldos y jornales** y **Cargas sociales** (el remunerativo y las contribuciones del personal que no es del taller) y **Mano de obra directa** (el remunerativo y las contribuciones del taller: es lo que la tarifa por hora de la Fase 5b aplica a las órdenes; cuenta nueva `5.1.03.01`, del grupo de costos de producción reales, **a validar**); al haber, **Sueldos a pagar** (el neto) y **Cargas sociales a pagar** (los aportes retenidos más las contribuciones).

## 4. Pagos y mano de obra aplicada (6c)

- **Pagar los sueldos** (Tesorería, desde la liquidación confirmada): elige la caja o el banco (lo habitual es el banco, por transferencia a la cuenta sueldo de cada empleado) y paga los netos de todos. Asiento **`PAGO_SUELDOS`**: Sueldos a pagar al debe, la caja o el banco al haber. La liquidación pasa a **Sueldos pagados**.
- **Pagar las cargas sociales** del mes (Tesorería, después de los sueldos): los aportes retenidos y las contribuciones, al organismo de la seguridad social (simulado). Asiento **`PAGO_CARGAS_SOCIALES`**: Cargas sociales a pagar al debe, la caja o el banco al haber. La liquidación queda **Pagada**.
- **Flujo de fondos** (Fase 3d): el real suma el concepto **Sueldos y cargas sociales**; el proyectado resta los netos sin pagar en su fecha de pago y las cargas sociales sin pagar en su vencimiento.
- **Mano de obra del taller**, por mes y por centro de trabajo: lo **real** (el remunerativo y las contribuciones del personal del taller en la liquidación del mes, lo que fue a Mano de obra directa, `5.1.03.01`) contra lo **aplicado** a las órdenes terminadas en el mes (horas × tarifa de la Fase 5b, lo que fue a Mano de obra directa aplicada, `5.1.02.01`). La diferencia es la mano de obra **subaplicada** (se cargó de menos al costo) o **sobreaplicada**; el saldo neto de las dos cuentas ya la muestra en el estado de resultados, y el informe (**Contabilidad → Mano de obra del taller**) la explica por mes, con el costo real por hora aplicada contra la tarifa. **A validar**: si Contabilidad la ajusta con un asiento contra el costo de ventas.
- Decisiones de la implementación **(a validar)**:
  - Se paga todo junto (no empleado por empleado), desde una sola caja o banco y por el total (sin pagos parciales). Las cargas sociales se pagan después de los sueldos y vencen el día 10 del mes siguiente al liquidado.
  - Tiene que alcanzar el saldo de la caja o el banco, como en las órdenes de pago: si no, primero se consiguen los fondos (el flujo proyectado lo anticipa).
  - **SoD-6**: quien preparó o confirmó la liquidación no paga sus sueldos ni sus cargas sociales (pasa si un estudiante tiene los roles de RRHH y de Tesorería); el docente, como supervisor, sí.
  - Un pago no se anula (la transferencia a los empleados no vuelve) y una liquidación con algo pagado ya no se anula: un error se corrige con un asiento manual de Contabilidad.
  - La mano de obra real de un mes es la de su liquidación confirmada (también si ya se pagó), repartida por el centro de trabajo de cada empleado del taller; la aplicada, la de las órdenes terminadas en el mes (el día de su ingreso al stock), con las horas reales de cada centro por la tarifa que copió la orden.
  - El informe lo ven quienes ven las liquidaciones (Gerencia, Contabilidad, Tesorería, RRHH y Auditoría). A validar: si Producción también lo ve, para ajustar las tarifas de sus centros.
- Pantallas: en la liquidación, **Pagar los sueldos** y después **Pagar las cargas sociales** (Tesorería elige la caja o el banco y ve si alcanza el saldo); la cabecera muestra cada pago o su vencimiento. **Pagos y tesorería → Flujo de fondos** suma la columna de sueldos y cargas sociales; **Contabilidad → Mano de obra del taller** tiene el informe por mes.

## 5. Asientos automáticos (reglas base, a validar)

| Evento | Clave | Cuenta propuesta |
|---|---|---|
| `SUELDOS` (liquidación confirmada) | `REMUNERACIONES` | Sueldos y jornales (debe) |
| | `MANO_DE_OBRA_DIRECTA` | Mano de obra directa (debe) |
| | `CONTRIBUCIONES` | Cargas sociales (debe) |
| | `SUELDOS_A_PAGAR` | Sueldos a pagar (haber) |
| | `CARGAS_SOCIALES_A_PAGAR` | Cargas sociales a pagar (haber) |
| `PAGO_SUELDOS` | `SUELDOS_A_PAGAR` | Sueldos a pagar (debe); el banco elegido al haber |
| `PAGO_CARGAS_SOCIALES` | `CARGAS_SOCIALES_A_PAGAR` | Cargas sociales a pagar (debe); el banco elegido al haber |

## 6. Permisos (a validar)

Módulo nuevo **`hr`** ("RRHH y sueldos"), que el docente puede bloquear.

| Permiso | Roles |
|---|---|
| `employee.read` (legajos y categorías) | RRHH, Gerencia, Contabilidad, Auditoría |
| `employee.create/update` | RRHH |
| `payroll.read` (liquidaciones y recibos) | RRHH, Gerencia, Contabilidad, Tesorería, Auditoría |
| `payroll.create/cancel` (preparar, confirmar y anular) | RRHH |
| `payroll.pay` (pagar sueldos y cargas sociales) | Tesorería |

RRHH liquida y Tesorería paga: quien calcula los sueldos no mueve el dinero (control por oposición, SoD-6). Queda **a validar** si Gerencia aprueba la liquidación antes del pago.
