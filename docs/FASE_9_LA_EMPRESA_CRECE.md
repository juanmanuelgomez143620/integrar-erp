# Fase 9 — La empresa crece

Diseño corto. Pedido del usuario el 16/11: en lugar de sumar una segunda empresa plantilla (la foresto-industria diseñada el 30/10), **agrandar Forestal del Norte**: más personal, más ventas, más logística y todo lo que acompaña el crecimiento, para que los estudiantes tengan más trabajo en cada sector. Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Una sola empresa más grande en lugar de dos plantillas: todos los cursos tienen más movimiento, no hay dos demos que mantener y los módulos ya existen. La foresto-industria queda descartada (su diseño está en el historial de git, por si se retoma).

Límites: todo sigue siendo ficticio (personas, clientes, proveedores y marcas): los nombres se inventan y no hace falta revisar si alguno coincide con un comercio real de la zona, porque la app aclara por varios medios que son ficticios (decisión del usuario, 22/11); de las personas, sólo los datos mínimos.

## 1. Hoy y la propuesta (a validar)

| | Hoy | Propuesta |
|---|---|---|
| Personal (legajos) | 11: la encargada general, 6 en el taller, 1 en el depósito, 1 chofer, 1 vendedora y 1 administrativa | **36**: taller 16, depósito 3, logística 5 (4 choferes y un coordinador), ventas 4, administración 6 (compras, tesorería, contabilidad e impuestos, RRHH) y 2 en la gerencia y la jefatura de planta |
| Clientes | 10 | **40**, repartidos en zonas de reparto (9c), cada uno con su plazo y su límite de crédito; las listas de precios las sigue armando Ventas (4d) |
| Proveedores | 10 | **20** |
| Productos | 20 | **35**: tres líneas nuevas de muebles (dormitorio, oficina y escolar, living con tapicería) con sus materiales |
| Listas de materiales y centros de trabajo | 4 y 3 | **12 y 4** (el centro nuevo: tapicería) |
| Vehículos, transportistas y choferes | 2, 2 y 1 | **4, 3 y 4** |
| Puntos de venta | 1 (casa central) | el segundo, el del showroom de Posadas, lo pide Ventas y lo habilita Impuestos, como actividad (8d.2) |
| Balance inicial | el de hoy | crece en proporción: más fondos y capital (en la 9a, para pagar al personal) y más stock y rodados (9b) |
| Movimiento | lo que generan los estudiantes (y 2 pedidos de arranque) | además, **la actividad del entorno**: los pedidos de los clientes, las entregas de los proveedores y las novedades del personal de cada semana |

## 2. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 9a | Más personal: los legajos nuevos en todos los sectores, con sus categorías y convenios (madera, comercio y camioneros, como desde la 6d) | La liquidación de cada mes tiene más del triple de recibos: más trabajo para RRHH, Gerencia, Tesorería y Contabilidad | Hecha (22/11): 34 legajos (los dos de tapicería llegan con su centro en la 9b) y 80 millones más en el banco de la apertura |
| 9b.1 | Más clientes y proveedores: los del banco de contribuyentes ficticios (`partner-bank.ts`), con su plazo y su límite de crédito; el padrón del fisco los incluye | Más a quién vender y a quién comprar | Hecha (22/11): 40 clientes y 20 proveedores |
| 9b.2 | Más productos: las líneas nuevas con sus materiales, sus listas de materiales y el centro de trabajo nuevo (tapicería, con sus dos legajos), y el inventario inicial más grande | Más para vender y fabricar | Hecha (22/11): 35 productos, 12 listas de materiales, 4 centros y 36 legajos |
| 9c.1 | Zonas de reparto: cada cliente en una, con sus días de reparto; Logística las administra y la hoja de ruta propone los remitos de una zona | Varias hojas de ruta por semana, una por zona | Hecha (22/11): cinco zonas con sus días y los 40 clientes repartidos |
| 9c.2 | La flota: más vehículos propios y un transportista más, con los rodados de la apertura | Con qué salir a repartir a las zonas | Hecha (22/11): 3 transportistas, 4 vehículos propios y 4 choferes |
| 9d.1 | La actividad del entorno, los pedidos de los clientes: el docente genera la semana y llegan los pedidos de los clientes, que Ventas revisa (stock y crédito) y confirma o rechaza | El volumen no depende de que los estudiantes inventen operaciones; cada curso arranca con una semana de trabajo pendiente | Hecha (23/11): la pestaña Entorno del Panel docente, el estado Recibido del cliente y la tarea de Ventas |
| 9d.2 | Los proveedores avisan que entregan lo pedido: Depósito recibe con el remito del proveedor | Compras y Depósito tienen su semana | Pendiente |
| 9d.3 | Las novedades del personal: el parte del mes (ausencias y horas extra) que RRHH carga en la liquidación | RRHH tiene su mes | Pendiente |

### La 9a en detalle (escala confirmada por el usuario el 21/11; los nombres y las categorías, a validar)

- **Dos categorías nuevas:** jefe de planta (fuera de convenio, $ 1.400.000) y coordinador de logística (Camioneros, $ 1.250.000). Las demás ya existen: oficial, medio oficial y ayudante del taller y operario de depósito (Madera, por hora), administrativo y vendedor (Comercio), chofer (Camioneros) y encargado general (fuera de convenio).
- **23 legajos nuevos (12 a 34), con 34 en total:** la jefatura de planta (en Producción, sin centro de trabajo); 8 en el taller (2 en corte, 3 en armado y 3 en terminación: quedan 4, 5 y 5, con oficiales, medio oficiales y ayudantes); 2 operarios de depósito (3 en total); el coordinador y 3 choferes de logística (5); 2 vendedores y una administrativa de ventas (4); y un administrativo en Compras, Tesorería, Contabilidad, Impuestos y RRHH (6 con la de Contabilidad que ya estaba). Los dos que faltan para llegar a 36 son de tapicería y llegan con su centro de trabajo en la 9b.
- Nombres inventados, sin repetir los de los usuarios de la demo ni los legajos de hoy; ingresos entre 2016 y 2025, para que la antigüedad varíe.
- **Dónde crece:** la plantilla (en el simulador y en la base real, con una migración que le suma las categorías y los legajos que le falten, por número) y, con ella, las empresas que se creen después. Las empresas de los cursos ya creadas no cambian.
- **Los fondos para pagarlos (a validar):** con 34 legajos, los sueldos netos de un mes son unos $ 34,6 millones, y el banco de la apertura tenía $ 12,5 millones: la empresa no podía pagar ni un mes. La apertura suma $ 80 millones en el banco, aportados por los socios (capital de $ 120 a $ 200 millones). El resto del balance (stock y rodados) crece en la 9b.
- **La base guardada en el navegador no cambia:** sumarle el personal sin los fondos de la apertura la dejaría sin poder pagar los sueldos; la empresa grande llega al restablecer la demo (Administración) y con cada empresa nueva. La plantilla de la base real sí suma el personal, porque nadie la opera: sólo se copia, y cada empresa nueva arma su propia apertura, ya con los fondos nuevos.
- Notas de la 9a (22/11): `DEMO_EMPLOYEES` y `DEMO_JOB_CATEGORIES` (`src/lib/domain/employees.ts`) y `OPENING_BALANCES`; la carga de los legajos de la demo pasa a ser "los que falten, por número" (`insertEmployees` y `private.insert_demo_employees`). Las pruebas que contaban con el saldo chico de la apertura para provocar rechazos por falta de fondos corren sus importes los mismos 80 millones. Base de datos: migraciones 115 (`20261118120000_demo_template_personal.sql`, la plantilla regenerada) y 116 (`20261118120100_personal_plantilla.sql`, la plantilla que ya existía suma lo que le falta).

### La 9b.1 en detalle (22/11, a validar)

- **10 proveedores del banco ficticio, por rubro de lo que compra la empresa:** placas y tableros (PRV-101 y PRV-123), aserraderos (PRV-102 y PRV-113), barnices (PRV-103), herrajes (PRV-106), embalajes (PRV-107), bulonería (PRV-114) y tapicería (PRV-117 y PRV-122, para la línea nueva de la 9b.2). Quedan 20 en el banco para los casos y los escenarios.
- **Los 30 clientes del banco ficticio (CLI-101 a CLI-130):** mueblerías, constructoras, alojamientos turísticos, carpinterías, estudios de decoración, instituciones y el consumidor final del showroom de Posadas, cada uno con su plazo de pago y su límite de crédito. Con los diez de antes, 40.
- **El padrón del fisco** los incluye (los que tienen CUIT), como a los de antes.
- **Las listas de precios no vienen armadas:** son el ejercicio de Ventas de la 4d (crear una lista, ajustarla por porcentaje y asignarla, por ejemplo a las mueblerías que revenden), y las empresas de los cursos no las copian de la plantilla.
- **El segundo punto de venta no viene habilitado:** pedirlo (Ventas) y habilitarlo (Impuestos) es la actividad de la 8d.2; el showroom de Posadas ya está como cliente para sus ventas de mostrador.
- **Dónde crece:** como en la 9a, la plantilla (en el simulador, al restablecer la demo, y en la base real, con una migración que le suma los proveedores y los clientes que le falten, por código, y el padrón) y las empresas que se creen después.

### La 9b.2 en detalle (22/11, a validar)

- **15 productos nuevos (35 en total), en tres líneas que piden los clientes nuevos:**
  - Dormitorio (mueblerías y alojamientos): PT-005 Mesa de luz de pino con cajón y PT-006 Cómoda de MDF 4 cajones.
  - Oficina y escolar (constructoras e instituciones): PT-007 Escritorio de MDF 1,20 m con cajón, PT-008 Biblioteca de MDF 5 estantes y PT-009 Pupitre escolar de pino y fenólico.
  - Living con tapicería (mueblerías, decoración y alojamientos): PT-010 Silla tapizada de eucalipto, PT-011 Sillón tapizado de 1 cuerpo y PT-012 Sofá tapizado de 3 cuerpos.
  - Sus materiales: MP-008 Tela chenille (por metro) y MP-009 Espuma de poliuretano D24 (de los proveedores de tapicería de la 9b.1), IN-008 Grampas y IN-009 Cincha elástica para tapicería, IN-010 Tapacanto de PVC e IN-011 Manija de aluminio; y MR-002 Colchón 1 plaza de reventa, para los alojamientos.
- **Un centro de trabajo nuevo, Tapicería** ($ 8.200 la hora de mano de obra y $ 2.500 de carga fabril), con una categoría nueva (oficial tapicero, Madera, por hora) y sus dos legajos: el oficial y un ayudante. Con ellos, 36 legajos y 16 en el taller.
- **Ocho listas de materiales nuevas (12 en total)**, con sus horas por centro: los sillones y el sofá pasan por corte, armado y tapicería; la silla tapizada, por los cuatro centros. El costo estándar de cada mueble es el de sus materiales más sus horas por las tarifas de los centros (como en los de antes: la mesa de comedor da $ 258.950 contra $ 260.000), y el precio de venta, el doble.
- **El inventario inicial** suma unos $ 11 millones de stock (los productos nuevos, todos por encima de su mínimo), y con él crecen los bienes de cambio de la apertura. Los rodados crecen con los vehículos de la 9c.
- **Dónde crece:** como en la 9a y la 9b.1. La plantilla de la base carga los productos por código y registra el inventario inicial de los que nunca tuvieron stock: la plantilla nueva y la que ya existía pasan por las mismas funciones.
- Notas de la 9b.2 (22/11): el inventario inicial suma $ 11.002.400 a los bienes de cambio de la apertura (materias primas $ 9.038.000, insumos $ 2.301.900, productos terminados $ 14.079.000 y reventa $ 2.580.000). En el Mapa vivo, el taller sigue con sus tres máquinas: los dos de tapicería se dibujan junto a ellas. Base de datos: migraciones 120 (`20261120120000_demo_template_productos.sql`, la plantilla regenerada con `insert_demo_products`, `demo_initial_stock_rows` y `post_demo_initial_stock`) y 121 (`20261120120100_productos_plantilla.sql`, la plantilla que ya existía).

### La 9c en detalle (22/11, a validar)

- **Las zonas de reparto (9c.1)** son un dato nuevo de Logística, como los transportistas y los vehículos: un código, un nombre, los días de reparto (de lunes a sábado, al menos uno) y una nota; se desactivan en lugar de borrarse. Las administra Logística en **Logística → Transporte** (los mismos permisos de los transportistas: `carrier.create` y `carrier.update`) y las ve quien ve los transportistas o los clientes.
- **Cada cliente en una zona:** la zona es un dato del cliente (puede no tener) que Ventas elige en su ficha, entre las activas; la lista de clientes la muestra, y la de zonas dice cuántos clientes tiene cada una.
- **La hoja de ruta por zona:** los remitos para repartir dicen la zona de su cliente, y al armar la hoja se elige una zona para marcar sus remitos (con sus días de reparto a la vista); se pueden sumar o sacar a mano, como hoy.
- **Las zonas de la demo**, por la localidad de cada cliente: Eldorado y Alto Paraná (Eldorado, Puerto Iguazú y Jardín América: lunes, miércoles y viernes; 13 clientes), Posadas y sur (Posadas y Apóstoles: martes y jueves; 10), Centro de Misiones (Oberá, Leandro N. Alem y Aristóbulo del Valle: miércoles; 4), Corrientes (Corrientes, Santo Tomé, Gobernador Virasoro y Goya: jueves; 9) y Chaco (Resistencia y Presidencia Roque Sáenz Peña: viernes; 4).
- Notas de la 9c.1 (22/11): **Logística → Transporte → Zonas de reparto** (alta, cambios con auditoría y desactivación, con los días como casillas); la **zona de reparto** en la ficha del cliente (Ventas, entre las activas o la que ya tenía; vacía es "sin zona") y en la lista de clientes; en la **hoja de ruta nueva**, la columna de la zona de cada remito y "Proponer los de una zona", que marca sus remitos con los días a la vista. La base del simulador pasa a la versión 34 (las zonas vacías y los clientes sin zona en una base guardada). Base de datos: migraciones 122 (`20261121120000_zonas_de_reparto.sql`: la tabla `delivery_zones`, `customers.zone_id`, `delivery_zone_save`, `delivery_zone_set_active`, `delivery_zones_list` y las versiones nuevas de `master_save`, `route_sheet_candidates` y `clone_company`), 123 (`20261121120100_demo_template_zonas.sql`, la plantilla regenerada con `insert_demo_zones` y `assign_demo_zones`) y 124 (`20261121120200_zonas_plantilla.sql`, la plantilla que ya existía).
- **La flota (9c.2):** tres vehículos propios más (un segundo camión y dos furgones, para los cuatro choferes de la 9a) y un tercer transportista (Logística Lapacho SRL, de Corrientes, del banco ficticio: para los viajes largos), con los rodados de la apertura en proporción.
- Notas de la 9c.2 (22/11): CAM-02 (camión de 3,5 t), FUR-01 y FUR-02 (furgones para la ciudad) y TR-003; los rodados de la apertura pasan de $ 18 a $ 60 millones (lo absorben los resultados acumulados del asiento de apertura). Base de datos: migraciones 125 (`20261122120000_demo_template_flota.sql`, la plantilla regenerada) y 126 (`20261122120100_flota_plantilla.sql`, la plantilla que ya existía suma lo que le falta). Con la 9c.2, la 9c quedó completa.
- **Dónde crece:** como en la 9a y la 9b, la plantilla (en el simulador y en la base real) y las empresas que se creen después, que copian las zonas con sus clientes. La base guardada en el navegador recibe la tabla de zonas vacía (Logística las puede crear) y la demo completa llega al restablecerla.

### La 9d en detalle (23/11, a validar)

- **"Generar la semana"** es un botón del docente en el **Panel docente** de la empresa: genera la actividad de la semana en curso (la semana ISO de la fecha de la empresa) una sola vez; la lista de las semanas generadas dice qué llegó en cada una. Más adelante, en automático según la fecha.
- **Reproducible:** lo que llega sale de un sorteo con semilla fija (el año y el número de la semana), sobre los clientes y los productos ordenados por código: la misma semana genera lo mismo en cualquier curso, en el simulador y en la base.
- **9d.1, los pedidos de los clientes:** de 8 a 12 pedidos por semana, de clientes al azar (los que no son consumidor final), con 1 a 3 productos que se venden (terminados y de reventa, con precio), de 1 a 5 unidades, al precio de la lista del cliente (o el de venta), su condición de pago, la referencia de su orden de compra ("OC 4217") y la entrega pedida en el próximo día de reparto de su zona (desde pasado mañana; sin zona, a la semana). Entran en un estado nuevo del pedido, **Recibido del cliente**, con la tarea para Ventas (el rol): revisarlo y **confirmarlo** (los mismos controles de stock y de crédito; si supera el crédito, lo autoriza Gerencia) o **rechazarlo** con el motivo. Si falta stock, Ventas lo rechaza y carga lo disponible en otro pedido; el resto lo repone Compras o lo fabrica Producción.
- **9d.2, las entregas de los proveedores:** las órdenes de compra enviadas cuya fecha de entrega cae en la semana (o ya pasó) reciben el aviso del proveedor, con su remito: Depósito tiene la tarea de recibirlas.
- **9d.3, las novedades del personal:** el parte del mes (algunas ausencias sin aviso y horas extra al 50 y al 100 %) le llega a RRHH, que lo carga en la liquidación.
- Notas de la 9d.1 (23/11): **Panel docente → Entorno** tiene el botón "Generar la semana" (deshabilitado si la semana en curso ya se generó) y la lista de las semanas generadas con sus pedidos, su cliente, su importe y su estado. Los pedidos los carga el sistema (así lo dicen la auditoría y la tarea) y la semana queda a nombre del docente; las notas del pedido dicen de qué semana es. Con la demo, la semana 2027-W19 trae 12 pedidos: al confirmarlos, 6 quedan confirmados, 1 espera a Gerencia por el crédito y 5 no tienen stock suficiente (trabajo para Compras y Producción). Base de datos: migraciones 127 (`20261123120000_entorno_semanal.sql`: la tabla de las semanas, el pedido que nace recibido, el sorteo, la generación, la lectura y el próximo paso) y 128 (`20261123120100_catalog_data_entorno.sql`: el estado, sus dos transiciones y la tarea de Ventas). El simulador pasa a la versión 35: una base guardada recibe la lista de semanas vacía.

## 3. Decisiones (a validar)

- **La escala** de la tabla: se puede subir o bajar sin cambiar el diseño.
- **Las empresas ya creadas no cambian:** la empresa más grande es la plantilla, para los cursos nuevos (hoy, en la base real, sólo está la plantilla). Si un curso ya creado la quiere, se le puede sumar con una acción del docente **(a validar)**.
- **Los nombres de los clientes y proveedores** salen del banco ficticio. El usuario decidió el 22/11 que no hace falta revisar si coinciden con comercios reales de la zona: son inventados y la app aclara por varios medios que son ficticios.
- **La actividad del entorno (9d)** la dispara el docente con un botón ("Generar la semana"), con un ritmo propuesto (por ejemplo, de 8 a 12 pedidos por semana) y siempre igual para la misma semana (reproducible); más adelante, en automático según la fecha. Los pedidos llegan con el cliente y su referencia, como si los hubiera mandado él, y Ventas los revisa (crédito y stock) y los confirma: el resto del circuito (depósito, logística, facturación, cobranza, compras y producción) se mueve con eso. Los proveedores avisan que entregan lo pedido (Depósito recibe), y las novedades del mes (ausencias, horas extra) le llegan a RRHH como un parte que carga en la liquidación. **(a validar: qué genera y cuánto)**
- **Orden:** va después de la Fase 8, como estaba. Propuesta: después de la 8f y la 7d, y **antes de los escenarios (8g)**, que aprovechan la empresa más grande y la actividad del entorno.

## 4. El motor y las pruebas

- 9a a 9c son, sobre todo, datos de la demo: el simulador (`seed.ts` y los datos de `src/lib/domain`) y el generador de la plantilla (una migración nueva; las aplicadas no se tocan). La 9c suma un dato del cliente (la zona) y lo que lo usa, con paridad.
- La 9d es un circuito nuevo: comandos del simulador y su SQL, auditoría, tareas y paridad, como el resto.
- Los códigos de hoy no cambian y lo nuevo se suma después: las pruebas que usan la demo siguen andando. Cambian los totales que dependen del tamaño (la liquidación, el padrón, el inventario y el balance inicial), que se actualizan en cada paso.
- El simulador guarda la base en el navegador: hoy pesa 0,2 MB y la empresa grande, unos 0,5 a 0,7 MB al empezar (el navegador admite unos 5 MB). Alcanza para la demo; si un curso usara el simulador todo el año, la base pasaría a otro almacenamiento del navegador (IndexedDB) **(a validar cuando haga falta)**.
- El Mapa vivo muestra más gente y más camiones: se revisa que siga fluido.

## 5. Fuera de esta fase

- La segunda empresa plantilla y la producción por desarme (la foresto-industria del 30/10): descartadas el 16/11.
- El comercio entre dos empresas del aula.
- La capacidad de carga de los vehículos y la planificación de rutas.
