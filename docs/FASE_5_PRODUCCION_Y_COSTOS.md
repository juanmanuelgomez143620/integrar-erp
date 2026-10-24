# Fase 5 — Producción y costos

Diseño corto. Sigue [ROADMAP.md §3](../ROADMAP.md) (Fase 5), [DATABASE.md §15](../DATABASE.md) y la matriz de [ROLES_Y_PERMISOS.md §7](ROLES_Y_PERMISOS.md). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Forestal del Norte fabrica muebles: hasta ahora el stock de productos terminados sólo cambiaba con el inventario inicial y los ajustes, y las materias primas se compraban sin saber para qué. En esta fase **Producción** planifica qué fabricar, **Depósito** le entrega los materiales, la mercadería terminada entra al stock **a su costo real** y la contabilidad sigue el recorrido: materias primas → productos en proceso → productos terminados → costo de ventas (Fase 4). Es el escenario **"producción"** del ROADMAP.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 5a | Listas de materiales; orden de producción: planificada → liberada (reserva los materiales) → en proceso (Depósito entrega los materiales) → terminada (entra el producto al costo de los materiales) | Lo que se vende se fabrica, con su consumo y su costo | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
| 5b | Centros de trabajo, horas y costos de conversión (mano de obra directa y carga fabril aplicadas); costo previsto contra real de cada orden | El costo del mueble suma los tres elementos y se ven los desvíos | Hecho (simulador, pantallas y Supabase con paridad; falta aplicarlo en la base publicada) |
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
- Decisiones de la implementación **(a validar)**: la orden copia, al planificarse, las horas de la lista (× unidades) y las tarifas de cada centro, así que cambiar una tarifa no altera las órdenes ya cargadas; como lo aplicado usa esas tarifas, no hay desvío de tarifa (aparece con los sueldos reales de la Fase 6). Las horas reales se cargan al terminar (pueden ser 0 si el centro no se usó). Un centro con listas activas se puede desactivar: las listas lo conservan y las órdenes nuevas siguen usando sus horas y tarifas, pero no se elige en una lista ni se vuelve a guardar una lista que lo tenga (hay que quitarlo o reactivarlo). Los desvíos se calculan sobre la orden entera; si salen menos unidades, se ve en el costo unitario.

## 5. Necesidades de materiales (5c)

- **Necesidades de materiales** (`produccion/necesidades`, la ve quien lee órdenes de producción): para cada material de las órdenes **planificadas** (las liberadas ya tienen su reserva), lo **necesario** (lo previsto de esas órdenes) contra lo **disponible** en sus depósitos de materiales (lo que hay menos lo reservado para pedidos de venta y órdenes liberadas), lo que está **en camino** (lo que falta recibir de las órdenes de compra, desde que se envían a aprobación hasta que se reciben o se cierran) y lo **ya pedido** a Compras (lo que todavía no está en una orden de compra, de las solicitudes en borrador, solicitadas u ordenadas en parte). El **faltante** es lo necesario menos lo disponible, lo que está en camino y lo ya pedido, si da positivo. Cada fila dice qué órdenes necesitan el material y qué documentos lo cubren.
- **Pedir a Compras** (Producción, o quien pueda crear solicitudes de compra): desde las necesidades (todas las órdenes planificadas con faltantes) o desde una orden planificada a la que le faltan materiales, se genera una **solicitud de compra en borrador** con los faltantes: un ítem por material, con la fecha necesaria en la terminación prevista más próxima de esas órdenes (si no pasó) y el motivo con las órdenes. Queda vinculada a cada orden (se ve en el flujo documental); Producción la revisa y la envía, y sigue el circuito de compras de siempre (Fases 1 y 3c). Si no falta nada que no esté ya pedido, no se genera.
- Cuando llega la mercadería, lo disponible sube y la orden se puede liberar (su tarea de liberarla sigue pendiente). Una solicitud anulada o rechazada deja de contar como ya pedida: el faltante vuelve a aparecer.
- Decisiones **(a validar)**: las solicitudes de compra no dicen el depósito, así que lo ya pedido cuenta para el producto; los faltantes no se redondean a la unidad de compra (Compras ajusta la cantidad en la orden de compra); la demo trae una orden planificada a la que le faltan materiales (escenario **"falta de materiales"**).

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
| Pedir a Compras los faltantes (5c) | `purchase_requisition.create` y `production_order.read`: Producción y Depósito |

Depósito entrega y Producción usa: cada isla controla a la otra (lo que se consumió contra lo que se entregó, lo que entró al stock contra lo que se fabricó).
