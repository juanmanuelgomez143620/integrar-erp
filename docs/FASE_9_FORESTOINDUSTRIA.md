# Fase 9 — Una segunda empresa: la foresto-industria

Diseño corto. Pedido del usuario el 30/10: poder trabajar con una foresto-industria de primera transformación (monte, aserradero y tableros), del tipo de las grandes empresas de la región; va **después de la Fase 8** (decisión del usuario, 30/10). Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Hoy cada curso recibe una copia de **la** empresa plantilla, Forestal del Norte SRL (una mueblería: segunda transformación de la madera). La propuesta no la reemplaza: suma una **segunda plantilla** y el docente elige con cuál trabaja cada curso. Reemplazarla trabaría el desarrollo: la demo está en el simulador (`src/lib/mock/seed.ts`), en 16 migraciones de plantilla y en 15 archivos de pruebas que usan sus códigos (482 usos). Con una plantilla más, todo eso sigue igual y los módulos (compras, ventas, stock, producción, costos, sueldos, impuestos, logística, contabilidad, tesorería, banco y fisco) sirven tal cual, porque el motor no depende del rubro.

Límites: empresa ficticia, sin nombre, logo, marcas, plantas ni datos de ninguna real; cifras, rendimientos y tasas son propuestas **(a validar)**; los documentos oficiales del sector (por ejemplo, las guías forestales) no se imitan: si hacen falta, son constancias propias con la leyenda de simulación.

## 1. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 9a | Varias plantillas: cada una con su nombre, su rubro y una descripción; el docente elige la plantilla al crear la empresa de su curso (la función de creación la recibe; migración nueva, las aplicadas no se tocan). Forestal del Norte sigue siendo la de siempre | El rubro se elige por curso | Pendiente |
| 9b | La plantilla foresto-industrial con el motor actual: maestros, inventario inicial, plan de cuentas, personal y convenios, listas de materiales y rutas; unidades nuevas: metro cúbico y tonelada | Un curso trabaja con un aserradero y una planta de tableros | Pendiente |
| 9c | Producción por desarme: una orden consume rollizos y da varios productos a la vez (coproductos y subproductos), con el costo repartido entre ellos | El aserradero se costea como en la realidad | Pendiente |

Orden: 9a y 9b no tocan el motor de producción; en la 9b, cada orden del aserradero fabrica su producto principal (la tabla) y los subproductos quedan para la 9c **(a validar: se explican en la consigna)**. La 9c es la parte grande: simulador, SQL, paridad y migraciones, como cualquier circuito nuevo.

## 2. La empresa (a validar)

- **Perfil:** sociedad anónima ficticia del norte de Misiones, con plantaciones propias de pino (y algo de eucalipto), un aserradero con secado y remanufactura y una línea de tableros. Vende a barracas y corralones, a mueblerías (como Forestal del Norte: más adelante, dos cursos podrían comerciar entre sí) y vende chips y aserrín a una planta de celulosa y a una usina de biomasa de terceros.
- **Sectores:** los mismos de hoy (Compras, Ventas, Producción, depósitos, Logística, Contabilidad, Tesorería, RRHH, Impuestos, Gerencia y Control). El depósito de materias primas es la playa de rollizos. La cosecha la hacen contratistas (lo más común); si se quiere cosecha propia, el monte es un centro de trabajo de Producción.
- **Productos:** rollizos de pino por diámetro (aserrables gruesos y finos, pulpables) en metros cúbicos o toneladas; tablas aserradas verdes y secas, tirantes y machimbre en pie tablar; tableros en unidades; subproductos: costaneros, chips, aserrín y corteza, en toneladas.
- **Proveedores:** contratistas de cosecha y fleteros de rollizos, viveros, combustibles y lubricantes, repuestos de sierras, adhesivos y resinas para tableros.
- **Clientes:** barracas, corralones, mueblerías, una planta de celulosa y una usina de biomasa (ficticias).
- **Centros de trabajo:** descortezado, aserrado principal, reaserrado y canteado, secado en cámaras, cepillado y moldurado; en tableros, preparación, prensado, lijado y corte.
- **Personal y convenios:** los que la demo ya tiene desde la 6d (madera para el aserradero y los tableros, comercio para la administración y camioneros para los choferes propios) y, si hay cosecha propia, el régimen del trabajo agrario para el monte.
- **Plan de cuentas:** el mismo, con plantaciones, rodados y maquinaria forestal en los bienes de uso.

## 3. El motor

- **9a:** la tabla de empresas ya distingue las plantillas; se suma el rubro y la descripción, y Docente → Cursos muestra la elección al crear la empresa. Las pruebas actuales no cambian, porque la demo sigue igual; se suma una para la elección de plantilla (simulador y base, con paridad).
- **9b:** las unidades `M3` y `TN` en el catálogo (y en su SQL); el generador de la plantilla arma una segunda plantilla; pruebas propias: que se cree, que el inventario inicial cuadre con el asiento de apertura y que el circuito compra → producción → venta funcione con sus códigos. Las listas de materiales expresan el rendimiento (por ejemplo, metros cúbicos de rollizo por pie tablar de tabla).
- **9c:** la orden de producción admite varias salidas: el producto principal y los coproductos o subproductos, con la cantidad real de cada uno al terminarla. El costo total (materiales, mano de obra y carga fabril) se reparte entre los coproductos por su valor de venta relativo o por volumen; los subproductos de poco valor entran a su valor neto de realización y se restan del costo **(a validar el criterio)**. Cambian el asiento de terminación (varias cuentas de productos terminados), las lecturas de la orden y su impresión.

## 4. El Mapa vivo

Formas nuevas por nombre y categoría (rollizos apilados, paquetes de tablas con separadores, tableros, montañas de chips y aserrín), la playa de rollizos en lugar del depósito de materias primas y las máquinas del aserradero. Todo sale de los datos, como ahora (`docs/MAPA_VIVO.md`).

## 5. Fuera de esta fase

- Plantaciones como activo biológico a valor razonable (RT 22), inventario forestal y cosecha propia como proceso completo.
- Exportación y certificaciones forestales.
- Comercio entre dos empresas del aula (parte del "entorno vivo").
- Celulosa y energía como plantas propias.
