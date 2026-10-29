# Fase 8 — El banco y el fisco, operados por estudiantes

Diseño corto. Sigue [ROADMAP.md](../ROADMAP.md) (Fase 8, "entorno vivo"), [DATABASE.md §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Hasta ahora el banco y el fisco no existen como tales: Tesorería paga y cobra y el saldo del banco es el del libro mayor; en la conciliación, el saldo del extracto se escribe a mano; Impuestos presenta una declaración y nadie la recibe. En esta fase son dos **entidades del entorno** de cada empresa del aula, y los estudiantes de una isla nueva las **operan**: el banco procesa lo que ordena la empresa, cobra sus cargos, emite el extracto y evalúa los préstamos; el fisco lleva el padrón, habilita los puntos de venta, autoriza las facturas, recibe y controla las declaraciones, imputa los pagos e intima. El resto de la empresa trata con ellos como con los reales: espera que el banco procese, concilia contra su extracto, pide un préstamo, recibe una observación o una intimación y la responde.

Referencias del propio autor: **Banco Aula** (simulador de homebanking para pymes: se revisa cuando estén sus archivos, `referencias/banco-aula` de la carpeta de trabajo) y **TRIBUT.AR** (simulador fiscal de GEST-AR, `juanjmg1436/tributar2026nuevo`): se toman sus conceptos y las reglas que ya validó, no su código (INTEGR-AR no depende de GEST-AR y tiene otro modelo: empresa con roles y lógica en la base).

Límites: banco y fisco son simulados (sin conexión con entidades reales); nombres, números y códigos tienen formato propio y lo dicen; nada imita logos, formularios ni numeraciones oficiales; tasas, cargos y plazos son propuestas **a validar**; lo impreso lleva la leyenda de simulación.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 8a | Isla del entorno, roles Banco y Fisco y modo de cada uno (lo opera el sistema o lo operan estudiantes). Banco: la cuenta corriente de la empresa, las órdenes que le llegan de sus operaciones (pagos, cobros, depósitos y transferencias) y el extracto, que pasa a ser la base de la conciliación | Tesorería trabaja contra un banco que procesa, no contra un saldo que se escribe | Pendiente |
| 8b | Banco: cargos del mes (comisión, impuesto a los débitos y créditos, intereses por descubierto), cheques emitidos presentados al cobro y rechazo por falta de fondos; la empresa registra los cargos desde la conciliación | La conciliación tiene partidas reales que explicar y registrar | Pendiente |
| 8c | Banco: préstamos (solicitud de Gerencia, evaluación con indicadores, acreditación y cuotas por sistema francés), con el préstamo de la apertura de la demo | Gerencia financia la empresa y ve el costo del dinero | Pendiente |
| 8d | Fisco: padrón de contribuyentes, puntos de venta habilitados y autorización simulada de cada factura de venta | No se factura sin estar habilitado; la letra sale del padrón | Pendiente |
| 8e | Fisco: recepción y control de las declaraciones (acuse u observación), cuenta corriente tributaria con intereses y pago a través del banco | Presentar y pagar tiene consecuencias | Pendiente |
| 8f | Fisco: domicilio fiscal electrónico, intimaciones y multas simuladas | Lo vencido o mal declarado genera una intimación que hay que responder | Pendiente |
| 8g | Escenarios con consignas, criterios de logro y progreso por isla (lo que el ROADMAP llamaba Fase 8) | Usan todo lo anterior | Pendiente |

Orden de trabajo: se termina la 7c.2 (hoja de ruta, ya diseñada); después 8a a 8f (el banco antes que el fisco, porque el pago de impuestos pasa por el banco); el tablero de control (7d) va después de la 8f, para nacer con los indicadores del banco y del fisco; los escenarios, al final.

## 2. Cómo se juega

- **Isla 9, "Entorno: banco y fisco"**, con los sectores Banco (`BAN`) y Fisco (`FIS`) y dos roles nuevos: **`BANCO`** (oficial del Banco Aula) y **`FISCO`** (agente del fisco simulado). Ven lo que vería esa entidad (las cuentas y los movimientos de la empresa en el banco; el padrón, los comprobantes autorizados y las declaraciones en el fisco), no los documentos internos de la empresa.
- **Misma empresa, misma base.** El banco y el fisco son el entorno de cada empresa del aula (no se comparten entre cursos). Todo pasa por comandos de la base, con auditoría, tareas y paridad simulador↔base, como el resto.
- **Dos modos por entidad**, que elige el docente en Docente → Módulos y control interno: **lo opera el sistema** (por defecto: responde en el momento, como hasta ahora) o **lo operan estudiantes** (cada operación espera en la bandeja de la isla 9 y genera una tarea para ese rol). Con pocos estudiantes, nada se traba. Al volver al modo automático, lo pendiente se procesa solo **(a validar)**.
- **Control por oposición (SoD-12, a validar):** quien tiene el rol Banco o Fisco no tiene roles de la empresa en el mismo curso (salvo el docente), y al revés.
- **Nombres y números simulados:** "Banco Aula" y "Fisco simulado" **(a validar)**; número de cuenta y clave bancaria con formato propio (no el de 22 dígitos); códigos de autorización y de transacción con prefijo `SIM-`.

## 3. El banco (8a a 8c)

- **Cuenta corriente** de la empresa en el Banco Aula, vinculada a la cuenta contable Banco cuenta corriente (`1.1.01.03`): número, clave simulada, fecha de apertura y acuerdo de descubierto (1.000.000 en la demo, **a validar**). Saldo inicial igual al de libros de la apertura.
- **Órdenes al banco.** La empresa registra sus operaciones como hoy (el pago, el cobro o el depósito queda en sus libros cuando lo hace) y cada una que mueve el banco le llega como una orden: transferencias que salen (pagos a proveedores, sueldos, cargas sociales, impuestos, transferencias entre cuentas), transferencias que entran (cobros), depósitos de valores y cheques emitidos. En modo automático el banco las procesa en el momento; en modo estudiantes, Banco las procesa desde su bandeja con la fecha del día. La diferencia de fechas aparece en la conciliación, que es justamente lo que enseña.
- **Extracto:** saldo inicial, movimientos por fecha de proceso y saldo final de un período. Lo ven Tesorería, Contabilidad y Gerencia (el homebanking de la empresa) y la conciliación toma de ahí el saldo y los movimientos, en lugar de escribirlos.
- **Cargos del mes (8b):** al cerrar el mes, el banco debita la comisión de mantenimiento (15.000), el impuesto a los débitos y créditos (0,6 % de cada movimiento) y los intereses por el descubierto usado (tasa mensual simple) **(a validar)**. La empresa no los ve hasta el extracto: los registra desde la conciliación, con la cuenta sugerida (gastos bancarios, impuesto a los débitos y créditos, intereses perdidos).
- **Cheques emitidos (8b):** se presentan al cobro unos días después de entregados (3, **a validar**) o cuando Banco los recibe; sin fondos (saldo más descubierto) se rechazan con un cargo, la empresa recibe el aviso y Tesorería anula el pago para volver a pagar. Lo mismo con una transferencia sin fondos.
- **Préstamos (8c):** Gerencia los pide (importe, plazo y destino) con los indicadores que salen del libro mayor (liquidez corriente, endeudamiento, cuota sobre ventas del mes); Banco los evalúa y los aprueba (tasa, plazo, sistema francés) o los rechaza con el motivo; al acreditarse, Tesorería registra el préstamo y cada cuota se debita el día de su vencimiento (capital e intereses perdidos). El préstamo de 10.000.000 de la apertura de la demo pasa a ser un préstamo del Banco Aula con su cronograma **(a validar)**.

## 4. El fisco (8d a 8f)

- **Padrón (8d):** contribuyentes con CUIT (dígito verificador válido), razón social, condición frente al IVA y actividad; incluye la empresa y los clientes y proveedores de la demo. Fisco da de alta y modifica; la empresa consulta la constancia de inscripción y la letra de la factura sale de ahí. Un cliente o proveedor con un CUIT que no está en el padrón genera un aviso, no un bloqueo **(a validar)**.
- **Puntos de venta (8d):** la empresa pide habilitar un punto de venta y Fisco lo habilita; la factura de venta sólo se registra con un punto de venta habilitado (la demo trae el suyo habilitado).
- **Autorización de comprobantes (8d):** al registrar una factura de venta, el fisco le asigna un código de autorización simulado (`SIM-…`) con su vencimiento; es siempre automática e inmediata, como la real. Fisco ve el registro de comprobantes autorizados y la factura impresa muestra el código.
- **Recepción de declaraciones (8e):** la declaración que presenta Impuestos llega al fisco con un control cruzado automático (en el IVA, el débito declarado contra el de los comprobantes autorizados del mes; en ingresos brutos, la base contra sus ventas). En modo estudiantes, Fisco la acepta (acuse con número de transacción simulado) o la observa con el motivo; en automático, se acepta si coincide y se observa si no. Una observada hay que anularla y presentarla de nuevo.
- **Cuenta corriente tributaria (8e):** por impuesto y período, lo declarado, lo pagado, los intereses por pago fuera de término (tasa mensual simple sobre los días de atraso, **a validar**) y el saldo. El pago de Tesorería sale por el banco (una orden más) y el fisco lo imputa cuando el banco lo procesa.
- **Domicilio fiscal electrónico (8f):** avisos e intimaciones del fisco a la empresa (declaración no presentada al vencimiento, pago fuera de término, diferencia del control cruzado), con un plazo para responder (15 días, **a validar**); los lee Impuestos y Gerencia y generan tareas. En automático los envía el sistema; en modo estudiantes los redacta Fisco. Multa formal simulada por presentar fuera de término **(a validar)**.

## 5. Permisos (a validar)

Módulos nuevos **`bank`** ("Banco") y **`fisco`** ("Fisco"), que el docente puede bloquear.

| Permiso | Roles |
|---|---|
| `bank.operate` (procesar órdenes, cargos, extracto, evaluar préstamos) | Banco |
| `bank.read` (cuenta, extracto y préstamos: el homebanking) | Tesorería, Contabilidad, Gerencia, Auditoría y Banco |
| `loan.request` (pedir un préstamo) | Gerencia |
| `fisco.operate` (padrón, puntos de venta, recepción, imputación, intimaciones) | Fisco |
| `fisco.read` (constancias, comprobantes autorizados, cuenta corriente y avisos) | Impuestos, Contabilidad, Gerencia, Ventas (padrón), Auditoría y Fisco |

## 6. Qué se toma de TRIBUT.AR y de Banco Aula

- De TRIBUT.AR: el circuito punto de venta habilitado → comprobante autorizado (no se emite sin habilitación), la validación del CUIT, el recargo por mora con tasa mensual simple, el estado de cuenta con su pago, el domicilio fiscal electrónico como bandeja, las reglas del IVA ya corregidas (la factura B con el IVA incluido genera débito igual; el saldo técnico se distingue del de retenciones y percepciones) y lo particular de ingresos brutos en Misiones. No se toman los nombres de formularios oficiales.
- De Banco Aula: sus pantallas y operaciones, para la vista de la empresa (homebanking) y los cargos, cuando estén sus archivos.

## 7. Fuera de esta fase

Otros bancos, plazos fijos, tarjetas y cheques de terceros rechazados; operaciones entre empresas de distintos cursos; formatos y tasas reales; la declaración anual de ganancias.
