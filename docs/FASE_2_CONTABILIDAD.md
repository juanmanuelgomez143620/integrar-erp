# Fase 2 — Contabilidad base

**Estado (14/10/2026):** implementado en el simulador, la interfaz y Supabase (migraciones `20261014120000` a `20261014120300`, todavía sin aplicar al proyecto real), con pruebas de paridad. Falta la validación docente de lo marcado **(a validar)** y el motor de imputación (§2, último punto).

Diseño corto para implementar el módulo. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 2) y [DATABASE.md §15](../DATABASE.md). Lo marcado **(a validar)** es una decisión docente: está implementado como propuesta y se cambia sin tocar el diseño.

## 1. Alcance

| Entra | Queda para después |
|---|---|
| Plan de cuentas básico por empresa, con cuentas nuevas creadas por Contabilidad | Rubros nuevos (niveles 1 a 3), centros de costo |
| Ejercicios (año calendario) y períodos mensuales que se cierran y se reabren | Cierre de ejercicio y refundición de resultados |
| Asientos manuales por partida doble: borrador → registrado; anulación con contraasiento | Aprobación de asientos, asientos modelo |
| Libro diario, libro mayor y balance de sumas y saldos, imprimibles | Estados contables, ajuste por inflación |
| Asiento de apertura de la empresa plantilla | Saldos iniciales de cuentas corrientes (con las Fases 3 y 4) |
| Motor de imputación (`posting_rules`) listo para los circuitos | Asientos automáticos de compras, pagos y ventas (Fases 3 y 4) |

## 2. Reglas

**Plan de cuentas.** Código jerárquico `1.1.01.01`: clase (1 Activo, 2 Pasivo, 3 Patrimonio neto, 4 Resultados positivos, 5 Resultados negativos), grupo, rubro y cuenta. Sólo las cuentas de nivel 4 son **imputables**; los niveles 1 a 3 agrupan. El tipo sale de la clase y el saldo normal del tipo (deudor para activo y resultados negativos), salvo las **regularizadoras** (amortización acumulada, previsión para incobrables), que lo tienen al revés. Contabilidad crea cuentas nuevas dentro de un rubro existente. No se cambia el código de una cuenta con movimientos ni se desactiva una cuenta con saldo.

**Ejercicios y períodos.** Un ejercicio por año calendario, con doce períodos mensuales. Contabilidad cierra un mes cuando terminó de revisarlo; sólo el docente lo reabre (control). En un período cerrado no se registran asientos.

**Asientos.** Son un tipo de documento más (`AS-00001`), con el mismo historial, flujo documental e impresión que los demás.

- El **borrador** se puede guardar incompleto o desbalanceado y corregir.
- **Registrar** controla: al menos dos líneas, cada una sólo al debe o sólo al haber, con cuentas imputables y activas; debe = haber; fecha dentro de un período abierto, no posterior a hoy **ni anterior al último asiento registrado del ejercicio** (el libro diario es correlativo, como uno encuadernado) **(a validar)**. Al registrarse recibe el **número de asiento**, correlativo por ejercicio.
- Un asiento registrado **no se modifica ni se borra**: se anula con un **contraasiento** (las mismas cuentas con debe y haber invertidos, fecha de hoy) y los dos quedan en el diario. Un contraasiento no se anula: si hubo un error, se registra el asiento correcto.
- El saldo de una cuenta es siempre una suma de los asientos registrados; no hay saldos editables.

**Libros.** El diario lista los asientos registrados por número, con fecha, leyenda y cuentas (las del haber con sangría). El mayor muestra, para una cuenta y un rango de fechas, el saldo anterior, los movimientos con saldo acumulado y el saldo final. Sumas y saldos lista las cuentas con movimientos: total debe, total haber, saldo deudor o acreedor, y verifica que las sumas y los saldos coincidan. Se marca la cuenta con **saldo contrario a su naturaleza** (por ejemplo, Caja acreedora), un error típico.

**Apertura.** La empresa plantilla nace con el ejercicio del año en curso abierto y el asiento N.º 1 de apertura al 1.º de enero: caja, banco, bienes de uso y préstamo con importes fijos; los bienes de cambio, con el valor del inventario inicial por tipo de producto (así el mayor coincide con el stock); capital social, y la diferencia a resultados no asignados. Cada empresa de curso nace igual.

**Imputación automática (para las Fases 3 y 4).** Cada evento contable (`COMPRA`, `PAGO`, `VENTA`…) tiene reglas que dicen a qué cuenta va cada importe (`posting_rules`). El motor arma el asiento registrado, lo vincula al documento de origen y falla con un mensaje claro si falta una regla o el período está cerrado.

## 3. Permisos (módulo `accounting`, bloqueable por el docente)

| Rol | Puede |
|---|---|
| Contabilidad | Todo: cuentas, asientos (crear, corregir, registrar, anular), libros, exportar y cerrar períodos |
| Impuestos, Tesorería | Consultar plan de cuentas, asientos y libros |
| Gerencia, Auditoría | Consultar y exportar |
| Docente | Todo, y además reabrir períodos y abrir ejercicios |

Permisos nuevos: `account.read/create/update`, `journal_entry.read/create/update/cancel/export`, `ledger.read/export`, `fiscal_period.update`.

## 4. Datos

Simulador (`src/lib/mock`) y Supabase con la misma forma, como el resto:

| Tabla | Campos principales |
|---|---|
| `accounts` | código, nombre, tipo, saldo normal (`DEBE`/`HABER`), nivel, imputable, descripción, activa |
| `fiscal_years` | nombre, desde, hasta, estado (`ABIERTO`/`CERRADO`) |
| `fiscal_periods` | ejercicio, número, nombre, desde, hasta, estado, quién y cuándo lo cerró |
| `journal_entries` | 1 a 1 con `documents`: ejercicio, número de asiento, origen (`MANUAL`, `APERTURA`, `CONTRAASIENTO`, `AUTOMATICO`), leyenda, asiento que anula |
| `journal_entry_lines` | cuenta, debe, haber, detalle |
| `posting_rules` | evento, clave del importe, cuenta |

## 5. Pantallas (menú "Contabilidad")

Plan de cuentas (con saldos y acceso al mayor) · Asientos (lista, alta, edición del borrador, detalle e impresión) · Libro diario · Libro mayor · Sumas y saldos · Ejercicios y períodos. Los libros se imprimen con la leyenda de simulación.

## 6. Plan de cuentas propuesto (a validar)

Nombres habituales de los manuales de Sistemas de Información Contable del secundario. Las marcadas con (R) son regularizadoras.

| Rubro | Cuentas |
|---|---|
| **1 Activo** · 1.1 Corriente | |
| 1.1.01 Caja y bancos | Caja · Fondo fijo · Banco cuenta corriente · Valores a depositar |
| 1.1.02 Inversiones temporarias | Plazo fijo |
| 1.1.03 Créditos por ventas | Deudores por ventas · Documentos a cobrar · Previsión para deudores incobrables (R) |
| 1.1.04 Otros créditos | IVA crédito fiscal · Anticipos a proveedores · Retenciones y percepciones sufridas |
| 1.1.05 Bienes de cambio | Materias primas · Materiales e insumos · Productos en proceso · Productos terminados · Mercaderías de reventa |
| 1.2 No corriente · 1.2.01 Bienes de uso | Inmuebles · Maquinarias y herramientas · Rodados · Muebles y útiles · Equipos de computación · Amortización acumulada de bienes de uso (R) |
| 1.2.02 Activos intangibles | Software y licencias |
| **2 Pasivo** · 2.1 Corriente | |
| 2.1.01 Deudas comerciales | Proveedores · Documentos a pagar · Anticipos de clientes |
| 2.1.02 Deudas bancarias y financieras | Préstamos bancarios |
| 2.1.03 Remuneraciones y cargas sociales | Sueldos a pagar · Cargas sociales a pagar |
| 2.1.04 Cargas fiscales | IVA débito fiscal · IVA a pagar · Ingresos brutos a pagar · Impuesto a las ganancias a pagar |
| 2.1.05 Otras deudas | Acreedores varios |
| 2.2 No corriente · 2.2.01 Deudas financieras a largo plazo | Préstamos bancarios a largo plazo |
| **3 Patrimonio neto** · 3.1.01 Capital | Capital social |
| 3.2.01 Reservas | Reserva legal |
| 3.2.02 Resultados | Resultados no asignados · Resultado del ejercicio |
| **4 Resultados positivos** · 4.1.01 Ventas | Ventas de productos terminados · Ventas de mercaderías de reventa · Ingresos por servicios |
| 4.2.01 Resultados financieros positivos | Intereses ganados · Descuentos obtenidos |
| 4.2.02 Otros ingresos | Sobrante de inventario · Ingresos varios |
| **5 Resultados negativos** · 5.1.01 Costo de ventas | Costo de productos vendidos · Costo de mercaderías vendidas |
| 5.2.01 Gastos en personal | Sueldos y jornales · Cargas sociales |
| 5.2.02 Gastos generales | Alquileres · Servicios públicos · Teléfono e internet · Fletes y acarreos · Gastos de librería y oficina · Seguros · Publicidad · Mantenimiento y reparaciones · Amortizaciones de bienes de uso · Deudores incobrables |
| 5.2.03 Impuestos y tasas | Impuesto sobre los ingresos brutos · Tasas municipales |
| 5.3.01 Gastos financieros | Intereses perdidos · Descuentos otorgados · Gastos y comisiones bancarias |
| 5.3.02 Otras pérdidas | Faltante de inventario · Pérdida por roturas |

**Asiento de apertura propuesto (a validar):** Caja $ 850.000 · Banco cuenta corriente $ 12.500.000 · bienes de cambio según el inventario inicial (hoy $ 16.996.500) · Inmuebles $ 85.000.000 · Maquinarias y herramientas $ 24.000.000 · Rodados $ 18.000.000 · Muebles y útiles $ 3.200.000, **a** Préstamos bancarios $ 10.000.000 · Capital social $ 120.000.000 · Resultados no asignados (la diferencia, hoy $ 30.546.500). Sin deudores ni proveedores: sus saldos iniciales llegan con las cuentas corrientes (Fases 3 y 4).

## 7. Implementación y pruebas

1. Simulador: catálogos, cuentas, ejercicios, asientos, libros y apertura; pruebas de cada regla (partida doble, período cerrado, correlatividad, contraasiento, permisos) y de que el diario, el mayor y sumas y saldos cuadren.
2. Interfaz: las seis pantallas, el formulario del asiento con totales y diferencia en vivo, e impresión.
3. Supabase: migración nueva (tablas, RLS, catálogos, RPC y lecturas) sin editar las ya aplicadas; pruebas de paridad ampliadas.
4. Motor de imputación con sus reglas por empresa y pruebas.
