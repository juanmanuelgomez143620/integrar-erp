# Fase 6 — RRHH y sueldos

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 6), [DATABASE.md](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §4](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Forestal del Norte tiene personal (ficticio): el taller, la administración, ventas y el depósito. Hasta ahora la isla de **RRHH y Sueldos** sólo consultaba, y la mano de obra entraba al costo de los muebles por horas × tarifa (Fase 5b) sin que nadie liquidara un sueldo. En esta fase **RRHH** lleva los legajos y las novedades del mes y liquida los sueldos (con un recibo simulado), el **asiento de sueldos** se genera solo, **Tesorería** paga los sueldos y las cargas sociales, y Contabilidad ve cuánta mano de obra del taller se aplicó de más o de menos a las órdenes. Es el escenario **"pago de salarios"** del ROADMAP.

Límites: los empleados son personajes de la empresa simulada (nombre y apellido inventados, sin documento ni datos reales); los porcentajes de aportes y contribuciones son **configurables** y no pretenden exactitud legal vigente; el recibo lleva la leyenda de simulación y no imita el formato de un recibo oficial.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 6a | Categorías (sueldo básico) y legajos: alta, cambios y baja del personal, con su sector y, en el taller, su centro de trabajo | RRHH conoce a la planta y lo que cuesta | Pendiente |
| 6b | Liquidación mensual: novedades (días, horas extra, ausencias), conceptos remunerativos, descuentos y contribuciones; recibos simulados; asiento `SUELDOS` al confirmarla | El sueldo de cada uno y su costo para la empresa | Pendiente |
| 6c | Pago de los sueldos y de las cargas sociales por Tesorería (con su asiento y en el flujo de fondos); mano de obra del taller real contra la aplicada a las órdenes | El ciclo cierra en el banco y en el costo de producción | Pendiente |

## 2. Categorías y legajos (6a)

- **Categoría** (la mantiene RRHH): código, nombre y **sueldo básico mensual** (un convenio simplificado, **a validar**): por ejemplo Oficial carpintero, Medio oficial, Ayudante de taller, Administrativo, Vendedor y Encargado. Si es del taller, su sueldo es **mano de obra directa**.
- **Legajo** de cada empleado: número correlativo, apellido y nombre (inventados), fecha de ingreso (para la antigüedad), categoría, sector de la empresa y, si trabaja en el taller, su **centro de trabajo** (Corte, Armado, Terminación). Se da de **baja** con fecha y motivo; no se borra. Sin documento, domicilio ni otros datos personales.
- La demo trae unos diez empleados **(a validar)**: cinco del taller (uno o dos por centro), dos de administración, uno de ventas, uno de depósito y el encargado. Sus sueldos guardan relación con las tarifas de mano de obra de los centros (Fase 5b), así la comparación del paso 6c da diferencias chicas y explicables.

## 3. Liquidación mensual (6b, `LIQ-00001`)

- La prepara **RRHH** para un período (mes) con su **fecha de pago**; trae a todos los legajos activos. De cada uno carga las **novedades**: días trabajados (30 por defecto), horas extra al 50 % y al 100 %, y días de ausencia sin aviso.
- **Conceptos** (los porcentajes están en la configuración de la empresa, **a validar**):
  - Remunerativos: **básico** (proporcional a los días), **antigüedad** (1 % del básico por año), **presentismo** (8,33 % de básico más antigüedad, si no tuvo ausencias) y **horas extra** (valor hora = básico más antigüedad sobre 200, con el 50 % o el 100 % de recargo).
  - Descuentos del empleado (aportes): jubilación 11 %, ley 19.032 3 % y obra social 3 % del remunerativo.
  - Contribuciones de la empresa (no se descuentan, son costo): un porcentaje único del remunerativo, por ejemplo 24 %.
  - **Neto a cobrar** = remunerativo − descuentos.
- Estados: **Borrador** (se cargan y corrigen las novedades) → **Confirmada** (se calculan los recibos y se genera el asiento) → **Pagada**. Una confirmada sin pagos se **anula** con motivo y contraasiento.
- **Recibo simulado** de cada empleado (se imprime): los conceptos con su cantidad e importe, el total remunerativo, los descuentos y el neto, con la leyenda de simulación.
- **Asiento `SUELDOS`** al confirmar: al debe, **Sueldos y jornales** y **Cargas sociales** (el remunerativo y las contribuciones del personal que no es del taller) y **Mano de obra directa** (el remunerativo y las contribuciones del taller: es lo que la tarifa por hora de la Fase 5b aplica a las órdenes; cuenta nueva `5.1.03.01`, del grupo de costos de producción reales, **a validar**); al haber, **Sueldos a pagar** (el neto) y **Cargas sociales a pagar** (los aportes retenidos más las contribuciones).

## 4. Pagos y mano de obra aplicada (6c)

- **Pagar los sueldos** (Tesorería): de una cuenta bancaria, el neto de la liquidación. Asiento **`PAGO_SUELDOS`**: Sueldos a pagar al debe, el banco al haber. La liquidación confirmada aparece en el **flujo de fondos proyectado** en su fecha de pago (Fase 3d).
- **Pagar las cargas sociales** del mes (Tesorería): los aportes y las contribuciones al organismo de la seguridad social (simulado). Asiento **`PAGO_CARGAS_SOCIALES`**: Cargas sociales a pagar al debe, el banco al haber.
- **Mano de obra del taller**, por mes: lo **real** (la cuenta Mano de obra directa, `5.1.03.01`) contra lo **aplicado** a las órdenes terminadas en el mes (Mano de obra directa aplicada, `5.1.02.01`, horas × tarifa de la Fase 5b). La diferencia es la mano de obra **subaplicada** (se cargó de menos al costo) o **sobreaplicada**; el saldo neto de las dos cuentas ya la muestra en el estado de resultados, y un informe la explica por mes. **A validar**: si Contabilidad la ajusta con un asiento contra el costo de ventas.

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

RRHH liquida y Tesorería paga: quien calcula los sueldos no mueve el dinero (control por oposición). Queda **a validar** si Gerencia aprueba la liquidación antes del pago.
