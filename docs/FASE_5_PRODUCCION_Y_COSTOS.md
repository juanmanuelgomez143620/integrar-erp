# Fase 5 — Producción y costos

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 5), [DATABASE.md §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §7](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Forestal del Norte fabrica muebles: hasta ahora el stock de productos terminados sólo cambiaba con el inventario inicial y los ajustes, y las materias primas se compraban sin saber para qué. En esta fase **Producción** planifica qué fabricar, **Depósito** le entrega los materiales, la mercadería terminada entra al stock **a su costo real** y la contabilidad sigue el recorrido: materias primas → productos en proceso → productos terminados → costo de ventas (Fase 4). Es el escenario **"producción"** del ROADMAP.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 5a | Listas de materiales; orden de producción: planificada → liberada (reserva los materiales) → en proceso (Depósito entrega los materiales) → terminada (entra el producto al costo de los materiales) | Lo que se vende se fabrica, con su consumo y su costo | Pendiente |
| 5b | Centros de trabajo, horas y costos de conversión (mano de obra directa y carga fabril aplicadas); costo previsto contra real de cada orden | El costo del mueble suma los tres elementos y se ven los desvíos | Pendiente |
| 5c | Necesidades de materiales de las órdenes y solicitud de compra de lo que falta | Producción le pide a Compras exactamente lo que necesita | Pendiente |

## 2. Lista de materiales (5a)

- Es la **fórmula** de cada producto terminado: qué materias primas e insumos lleva y cuánto de cada uno **por unidad** (por ejemplo, una silla de eucalipto: 18 pies de tabla de eucalipto, 0,4 L de barniz, 0,1 kg de cola…). La arma y la mantiene **Producción**; la ven Depósito, Compras, Gerencia, Contabilidad y Auditoría.
- Sólo los **productos terminados** tienen lista, y sus componentes son **materias primas e insumos** activos, sin repetir. Una lista se puede desactivar (no se planifican órdenes de ese producto). Los cambios quedan en la auditoría y **no** alteran las órdenes ya cargadas: cada orden guarda su copia.
- Se muestra el **costo estimado de materiales** por unidad: cantidad × costo promedio actual de cada componente (o su costo estándar si todavía no hay stock).
- La plantilla trae las listas de los cuatro muebles de la demo **(a validar)**, calculadas para que, con los costos de conversión de 5b, el costo resulte cercano al costo estándar de cada producto.

## 3. Orden de producción (`OPR-00001`, 5a)

- La carga **Producción**: producto (con lista activa), cantidad a fabricar, depósito de materiales (el de materias primas), depósito de destino (el de productos terminados), fecha prevista de terminación y observaciones. Copia la lista: **consumo previsto** de cada componente = cantidad por unidad × unidades, con el **costo unitario previsto** de ese momento. No se modifica: si está mal, se anula y se carga otra.
- **Liberar** (Producción): controla el **disponible** de cada material en el depósito (lo que hay menos lo reservado para otras órdenes). Si alcanza, la orden **reserva** los materiales y Depósito recibe la tarea de entregarlos; si no, no se libera y el mensaje dice qué falta y cuánto (escenario **"falta de materiales"**: comprar, esperar la recepción o fabricar menos; en 5c, pedírselo a Compras desde la orden). Lo reservado no se guarda aparte: es lo que les falta entregar a las órdenes liberadas.
- **Entregar los materiales** (Depósito): registra lo que realmente sale de cada componente (propone lo previsto; puede ser más por desperdicio o menos si sobró). El stock baja al costo promedio ponderado (movimiento "Consumo de producción"), la reserva se libera, la orden pasa a **en proceso** y se genera el asiento automático **`CONSUMO_PRODUCCION`**: Productos en proceso al debe, Materias primas y Materiales e insumos al haber. Producción recibe la tarea de terminarla.
- **Terminar** (Producción): registra las unidades que salieron bien (como mucho, las planificadas; si salen menos, el costo de cada una es mayor). El producto entra al depósito de destino **a su costo real**: lo consumido dividido las unidades terminadas (en 5b, más la conversión), con el movimiento "Ingreso de producción", que actualiza el costo promedio del producto. Asiento automático **`PRODUCCION_TERMINADA`**: Productos terminados al debe, Productos en proceso al haber. Ventas recibe el aviso de las unidades nuevas.
- **Anular** con motivo: la planificada o la liberada, sin más (se libera la reserva); la que está en proceso, con la devolución de los materiales al depósito al costo con que salieron y el contraasiento del consumo. Una orden **terminada no se anula** **(a validar)**: el producto ya está en el stock y pudo venderse; si hubo un error, se corrige con un ajuste de stock.
- Estados: **Planificada → Liberada → En proceso → Terminada**, o **Anulada**. Se imprime como orden de trabajo para el taller, con los materiales previstos y entregados y la leyenda de simulación.
- Stock y ficha de producto: el **reservado** suma lo de los pedidos de venta (4a) y lo de las órdenes liberadas.

## 4. Centros de trabajo y costos de conversión (5b)

- **Centros de trabajo** (los mantiene Producción): por ejemplo **Corte y cepillado**, **Armado** y **Terminación** (lijado, barnizado y embalaje), cada uno con su **tarifa de mano de obra directa** por hora y su **tasa de carga fabril** por hora, predeterminadas **(a validar)**. La lista de materiales suma las **horas por unidad** de cada centro (la ruta simplificada).
- Al **terminar** la orden, Producción registra las **horas reales** de cada centro (propone las previstas). La orden aplica la conversión: horas × tarifa (mano de obra directa) y horas × tasa (carga fabril). Asiento automático **`CONVERSION_PRODUCCION`**: Productos en proceso al debe, **Mano de obra directa aplicada** y **Carga fabril aplicada** al haber (cuentas nuevas del plan, regularizadoras del costo, **a validar**); después, el de producción terminada por el total. Los sueldos reales llegan con la Fase 6: la diferencia entre lo aplicado y lo real es la sub- o sobreaplicación.
- **Costo de la orden**: previsto contra real de cada elemento (materia prima, mano de obra directa y carga fabril), con los desvíos de los materiales (de cantidad: se usó más o menos; de precio: el costo promedio cambió) y de las horas, y el **costo unitario real** contra el costo estándar del producto. Un listado de **costos de producción** muestra las órdenes terminadas de un período con su costo unitario y su desvío.

## 5. Necesidades de materiales (5c)

- **Necesidades**: para las órdenes planificadas y liberadas, lo que falta entregar de cada material contra lo disponible y lo que ya viene en camino (órdenes de compra sin recibir). Lo que no alcanza es un **faltante**.
- **Pedir a Compras**: desde las necesidades (o desde una orden que no se pudo liberar), Producción genera la **solicitud de compra** con los faltantes, vinculada a las órdenes; sigue el circuito de compras de siempre (Fase 1 y 3). Al recibir la mercadería, la orden se puede liberar.

## 6. Asientos automáticos (reglas base, a validar)

| Evento | Clave | Cuenta propuesta |
|---|---|---|
| `CONSUMO_PRODUCCION` (materiales entregados, 5a) | `PRODUCCION_EN_PROCESO` | Productos en proceso (debe) |
| | `MATERIA_PRIMA`, `INSUMO` | Materias primas, Materiales e insumos (haber) |
| `PRODUCCION_TERMINADA` (orden terminada, 5a) | `PRODUCTO_TERMINADO` | Productos terminados (debe) |
| | `PRODUCCION_EN_PROCESO` | Productos en proceso (haber) |
| `CONVERSION_PRODUCCION` (orden terminada, 5b) | `PRODUCCION_EN_PROCESO` | Productos en proceso (debe) |
| | `MANO_DE_OBRA_APLICADA`, `CARGA_FABRIL_APLICADA` | Mano de obra directa aplicada, Carga fabril aplicada (haber) |

## 7. Permisos (a validar)

| Permiso | Roles |
|---|---|
| `bom.read` (listas de materiales) | Producción, Depósito, Compras, Gerencia, Contabilidad, Auditoría |
| `bom.create/update` | Producción |
| `production_order.read` (órdenes de producción) | Producción, Depósito, Compras, Ventas, Gerencia, Contabilidad, Auditoría |
| `production_order.create/cancel` | Producción (create también libera y termina) |
| `production_order.issue` (entregar los materiales) | Depósito |
| `work_center.read/update` (centros de trabajo, 5b) | read: Producción, Contabilidad, Gerencia, Auditoría; update: Producción |

Depósito entrega y Producción usa: cada isla controla a la otra (lo que se consumió contra lo que se entregó, lo que entró al stock contra lo que se fabricó).
