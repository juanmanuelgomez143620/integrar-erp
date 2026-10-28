# Fase 6d — Convenios colectivos y autorización de la liquidación

Diseño corto, pedido por el usuario el 26/10 para que la liquidación de la Fase 6 se parezca a la de una empresa real. Completa [FASE_6_RRHH_Y_SUELDOS.md](FASE_6_RRHH_Y_SUELDOS.md). Lo marcado **(a validar)** es decisión docente.

En una PyME manufacturera como Forestal del Norte cada empleado está encuadrado en un **convenio colectivo de trabajo** (CCT) según la actividad y su tarea, y el convenio fija sus categorías, cómo cobra (por mes o por hora) y sus adicionales y aportes sindicales. **RRHH** (o el estudio contable) liquida con las novedades que pasan los encargados, **Gerencia** autoriza la liquidación y recién entonces **Tesorería** paga; lo retenido para el sindicato y lo que el convenio pone a cargo de la empresa se le deposita al sindicato junto con las cargas sociales.

Límites: las escalas salariales y los porcentajes son **ficticios pero proporcionados**: no son los de las paritarias vigentes, que cambian seguido; el docente los ajusta con los textos de cada convenio. El encuadramiento de cada sector es una propuesta **a validar**.

## 1. Los convenios de la demo (a validar)

| Convenio | Sindicato | Quiénes | Cómo cobran | Antigüedad | Presentismo | Aporte sindical | Contribución de la empresa |
|---|---|---|---|---|---|---|---|
| Industria de la madera | UOMA | Taller (corte, armado, terminación) y depósito | **Por hora** (jornalizados): valor hora × horas trabajadas | 1 % por año | 10 % sin faltas | 2 % | 1 % |
| Empleados de Comercio (CCT 130/75) | Comercio | Administración y ventas | Por mes | 1 % por año | 8,33 % sin faltas | 2,5 % | 1 % |
| Camioneros (CCT 40/89) | Camioneros | El chofer del camión propio (Fase 7c) | Por mes | 1 % por año | — | 3 % | 2 % |
| Fuera de convenio | — | La encargada general | Por mes, sueldo pactado | — | — | — | — |

- El **aporte sindical** se le retiene al empleado (representa la cuota sindical o el aporte solidario: no se distingue si está afiliado, **a validar**); la **contribución de la empresa** es lo que el convenio pone a su cargo (seguro de vida, fondo social), un costo como las contribuciones patronales.
- Jubilación, ley 19.032, obra social y las contribuciones patronales siguen siendo de la empresa (son legales, no del convenio) y las sigue fijando el docente.

## 2. Qué cambia

- **Convenios** (RRHH → Convenios, los mantiene RRHH): código, nombre, sindicato, forma de pago (por mes o por hora) y sus porcentajes. Se desactivan, no se borran.
- **Categorías**: cada una pertenece a un convenio. En uno por mes tienen sueldo básico mensual; en uno por hora, **valor hora**. La demo pasa las del taller a valor hora (manteniendo lo que cobra un mes completo), suma la categoría Chofer (Camioneros) y un empleado nuevo, el chofer, en Logística.
- **Liquidación**:
  - Cada recibo copia el convenio del empleado con sus porcentajes (como copia el básico): cambiarlos después no la altera.
  - Por hora: la novedad es **horas trabajadas** (176 por defecto, un mes de 22 días de 8 horas, **a validar**) en lugar de días; el básico es valor hora × horas. Por mes, igual que hasta ahora (días de un mes de 30).
  - Antigüedad y presentismo, con los porcentajes del convenio; el presentismo se pierde con una ausencia sin aviso.
  - Horas extra: el valor hora es el de la categoría más su antigüedad (por hora) o el básico más la antigüedad sobre 200 (por mes), con el 50 % o el 100 %.
  - Descuentos: los tres aportes legales más el **aporte sindical**. Costo de la empresa: las contribuciones patronales más la **contribución del convenio**.
  - El recibo muestra el convenio y el sindicato.
- **Asiento de sueldos**: el aporte sindical y la contribución del convenio van a una cuenta nueva, **Sindicatos a pagar** (`2.1.03.03`, a validar); Tesorería los paga con las cargas sociales (el pago tiene las dos cuentas al debe).
- **Autorización de Gerencia**: RRHH **envía** la liquidación a autorizar (ya no la confirma); Gerencia la **autoriza** (se registra el asiento de sueldos y Tesorería recibe la tarea de pagar) o la **devuelve** con el motivo, y vuelve a borrador para que RRHH la corrija. SoD-6 sigue: quien la preparó o la envió no la paga; y quien la preparó no la autoriza (salvo el docente).

## 3. Estados de la liquidación

Borrador → **Pendiente de autorización** (envió RRHH) → Confirmada (autorizó Gerencia: asiento de sueldos) → Sueldos pagados → Pagada. Desde Pendiente de autorización, Gerencia la devuelve a Borrador con el motivo. Se anula como hasta ahora: el borrador con motivo y la confirmada sin pagos con su contraasiento.

## 4. Pasos

| Paso | Qué | Estado |
|---|---|---|
| 6d.1 | Convenios, categorías por convenio (mensual o por hora), el chofer de la demo, el cálculo con los conceptos de cada convenio, la cuenta Sindicatos a pagar y el recibo | Hecho (28/10) |
| 6d.2 | Envío y autorización de Gerencia (o devolución con motivo) antes del asiento y del pago | Pendiente |

### Notas de la 6d.1

- Pantalla nueva **RRHH → Convenios** (permiso `employee.read` para verla y `employee.update` para cambiarla, como las categorías). Un convenio con categorías no cambia su forma de pago: sus importes son mensuales o por hora (se crea otro convenio).
- Base de datos: migraciones 62 a 65 (`20261028120000_convenios.sql`, catálogos, plantilla y empresas existentes). Tabla `labor_agreements`; `job_categories.agreement_id` (obligatoria) y, en `payroll_lines`, el convenio copiado con sus porcentajes, las horas trabajadas, el aporte sindical y la contribución del convenio.
- Las empresas que ya existían (y las bases guardadas del simulador, versión 18) reciben los cuatro convenios; sus categorías pasan al suyo (taller y depósito a Madera, con el valor hora = básico ÷ 176; la encargada, fuera de convenio; las demás, a Comercio), se suma el chofer con el legajo siguiente y las liquidaciones de antes quedan por mes, sin convenio y sin sindicato.
- El recibo no muestra los adicionales que el convenio no tiene (por ejemplo, fuera de convenio no hay antigüedad ni presentismo).
