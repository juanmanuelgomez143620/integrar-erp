# Fase 8g: escenarios con consignas, criterios de logro y progreso por isla

> Propuesta del 24/11, **a validar** con el usuario antes de programar. Es el cierre de la Fase 8
> (`docs/FASE_8_BANCO_Y_FISCO.md`) y lo que el ROADMAP llamaba "motor de escenarios": datos iniciales,
> consignas, criterios de logro y progreso por isla, con los siete escenarios. Va después de la Fase 9
> (completa el 24/11) porque aprovecha la empresa grande y la actividad del entorno.

## 1. Qué es un escenario

- Un **desafío con nombre** que el docente pone en marcha en la empresa del curso. Tiene tres partes:
  - la **situación de partida**: lo que pasa en la empresa, por ejemplo un cliente que no paga, un pedido grande sin stock o un pago grande sin fondos;
  - las **consignas** de cada isla: qué tiene que resolver;
  - los **criterios de logro**: qué se tiene que ver en los datos para darlo por resuelto.
- Se evalúa con lo que el sistema ya registra (documentos, estados, asientos y la auditoría) desde que el docente lo inicia (ARCHITECTURE.md §14). Nadie tiene que marcar nada a mano.
- Convive con la actividad del entorno (9d): la semana trae volumen; el escenario, un problema puntual con un objetivo.

## 2. Los siete escenarios, con lo que ya existe

| Escenario | Situación de partida | Islas | Criterios de logro (ejemplos) |
| --- | --- | --- | --- |
| Compra de materia prima | Producción tiene que fabricar un lote y faltan materiales (necesidades de la 5c) | Producción, Compras, Gerencia, Depósito, Contabilidad, Tesorería | Solicitud de los faltantes; cotizaciones de dos proveedores o más; orden aprobada por quien corresponde; recepción con el remito; factura registrada; pago |
| Venta a crédito | Un cliente pide por encima de su límite de crédito | Ventas, Gerencia, Depósito, Logística, Tesorería | El pedido no se entrega sin la autorización de Gerencia; se despacha, se reparte y se factura; se cobra |
| Producción | Un pedido de muebles que hay que fabricar | Ventas, Producción, Depósito | Orden de producción liberada, materiales entregados y terminada; costo real contra el previsto |
| Cliente moroso | Un cliente con facturas vencidas manda un pedido | Ventas, Gerencia, Tesorería, Contabilidad | El pedido no se confirma sin autorización; se gestiona el cobro de lo vencido; la cuenta corriente queda al día |
| Falta de stock | Un pedido más grande que el stock disponible | Ventas, Producción, Compras, Depósito | No se confirma por más de lo disponible; se carga lo disponible y se repone (fabricando o comprando); se entrega el resto |
| Pago de salarios | Fin de mes, con el parte de novedades | RRHH, Gerencia, Tesorería, Contabilidad | El parte cargado; la liquidación autorizada por Gerencia; los sueldos y las cargas pagados; el asiento |
| Problema de liquidez | Vencimientos mayores que el saldo del banco | Tesorería, Gerencia, Contabilidad | El flujo de fondos proyectado; un préstamo pedido y evaluado (o pagos reprogramados); ninguna orden rechazada por falta de fondos |

## 3. El motor (propuesta)

- **El catálogo, en el código**, como los demás catálogos. Cada escenario tiene su código, su nombre, su descripción, sus islas, las consignas de cada isla y sus criterios. Cada criterio tiene su isla, su texto y una regla que se evalúa sobre los datos, con la misma lógica en el simulador y en SQL.
- **Las corridas** (`scenario_runs`): la empresa, el escenario, quién lo inició, el inicio, el fin y el estado (en curso o terminado). Una corrida a la vez por empresa **(a validar)**.
- **El inicio:** el docente lo inicia desde **Panel docente → Escenarios**. El sistema arma la situación de partida con los comandos de siempre y el actor Sistema, como la 9d, y abre la tarea de la consigna de cada isla (con origen `ESCENARIO`, que las tareas ya admiten).
- **El progreso:** cada criterio se evalúa al leer, sin guardarse, como logrado o pendiente, por isla. El docente ve la grilla de criterios por isla, y cada estudiante ve en Mi trabajo la consigna de su isla y lo que falta.
- **El cierre:** el docente lo termina, y queda el resultado (los criterios logrados a esa fecha) para calificar.
- **El reinicio:** terminarlo y volver a iniciarlo arma una situación de partida nueva. Volver la empresa al estado inicial es crear otra desde la plantilla: no se borra nada.

## 4. Pasos propuestos

| Paso | Qué | Estado |
| --- | --- | --- |
| 8g.1 | El motor: el catálogo, las corridas, el inicio con la situación de partida, las tareas de consigna, la evaluación y el panel del docente, con dos escenarios: falta de stock y cliente moroso (aprovechan los pedidos de la 9d) | Pendiente |
| 8g.2 | Los otros cinco escenarios | Pendiente |
| 8g.3 | El informe para calificar, por isla y por estudiante (quién hizo qué, desde la auditoría), imprimible y con la rúbrica | Pendiente |

## 5. A validar con el usuario

- **Los siete escenarios y su orden.** Propuesta: empezar por falta de stock y cliente moroso.
- **Los criterios automáticos y los que evalúa el docente.** Algunos no se pueden medir con los datos, como la calidad de un descargo o de un análisis. Propuesta: los dos tipos; los automáticos se tildan solos y el docente agrega los suyos con una observación.
- **Una corrida a la vez por empresa, o varias en paralelo.**
- **Cómo se califica:** el progreso por isla (un porcentaje) o una rúbrica con niveles. Las consignas y la rúbrica pueden seguir el formato de actividades, evaluaciones y rúbricas que ya usa el usuario.
- **La fecha:** los escenarios usan la fecha de la empresa (la real). La fecha simulada por empresa (D-09) queda para después, si hace falta.
