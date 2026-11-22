# Fase 9 — La empresa crece

Diseño corto. Pedido del usuario el 16/11: en lugar de sumar una segunda empresa plantilla (la foresto-industria diseñada el 30/10), **agrandar Forestal del Norte**: más personal, más ventas, más logística y todo lo que acompaña el crecimiento, para que los estudiantes tengan más trabajo en cada sector. Lo marcado **(a validar)** es decisión docente: queda implementado como propuesta.

Una sola empresa más grande en lugar de dos plantillas: todos los cursos tienen más movimiento, no hay dos demos que mantener y los módulos ya existen. La foresto-industria queda descartada (su diseño está en el historial de git, por si se retoma).

Límites: todo sigue siendo ficticio (personas, clientes, proveedores y marcas); los nombres de comercios se revisan antes de usarlos en clase, para que ninguno coincida con uno real de la zona; de las personas, sólo los datos mínimos.

## 1. Hoy y la propuesta (a validar)

| | Hoy | Propuesta |
|---|---|---|
| Personal (legajos) | 11: la encargada general, 6 en el taller, 1 en el depósito, 1 chofer, 1 vendedora y 1 administrativa | **36**: taller 16, depósito 3, logística 5 (4 choferes y un coordinador), ventas 4, administración 6 (compras, tesorería, contabilidad e impuestos, RRHH) y 2 en la gerencia y la jefatura de planta |
| Clientes | 10 | **40**, repartidos en zonas de reparto, cada uno con su lista de precios y su límite de crédito |
| Proveedores | 10 | **20** |
| Productos | 20 | **unos 35**: dos o tres líneas nuevas de muebles con sus materiales |
| Listas de materiales y centros de trabajo | 4 y 3 | **unas 12 y 4** (un centro nuevo, por ejemplo tapicería) |
| Vehículos, transportistas y choferes | 2, 2 y 1 | **4, 3 y 4** |
| Puntos de venta | 1 (casa central) | **2** (casa central y un local de ventas) |
| Balance inicial | el de hoy | crece en proporción: más fondos y capital (en la 9a, para pagar al personal) y más stock y rodados (9b) |
| Movimiento | lo que generan los estudiantes (y 2 pedidos de arranque) | además, **la actividad del entorno**: los pedidos de los clientes, las entregas de los proveedores y las novedades del personal de cada semana |

## 2. Pasos

| Paso | Qué | Resultado | Estado |
|---|---|---|---|
| 9a | Más personal: los legajos nuevos en todos los sectores, con sus categorías y convenios (madera, comercio y camioneros, como desde la 6d) | La liquidación de cada mes tiene más del triple de recibos: más trabajo para RRHH, Gerencia, Tesorería y Contabilidad | Hecha (22/11): 34 legajos (los dos de tapicería llegan con su centro en la 9b) y 80 millones más en el banco de la apertura |
| 9b | Más clientes, proveedores y productos: los del banco de contribuyentes ficticios (`partner-bank.ts`, revisado antes), las listas de precios y los límites de crédito, las líneas nuevas con sus listas de materiales y el centro de trabajo nuevo, el segundo punto de venta y el balance inicial más grande; el padrón del fisco los incluye | Más para vender, comprar y fabricar | Pendiente |
| 9c | Logística a escala: zonas de reparto (cada cliente en una, con sus días de reparto), más vehículos y choferes, y la hoja de ruta que propone los remitos de una zona | Varias hojas de ruta por semana | Pendiente |
| 9d | La actividad del entorno: el docente genera la semana (más adelante, el sistema con un ritmo): los pedidos de los clientes llegan para que Ventas los revise, los proveedores avisan que entregan lo pedido y el personal tiene sus novedades del mes | El volumen no depende de que los estudiantes inventen operaciones; cada curso arranca con una semana de trabajo pendiente | Pendiente |

### La 9a en detalle (escala confirmada por el usuario el 21/11; los nombres y las categorías, a validar)

- **Dos categorías nuevas:** jefe de planta (fuera de convenio, $ 1.400.000) y coordinador de logística (Camioneros, $ 1.250.000). Las demás ya existen: oficial, medio oficial y ayudante del taller y operario de depósito (Madera, por hora), administrativo y vendedor (Comercio), chofer (Camioneros) y encargado general (fuera de convenio).
- **23 legajos nuevos (12 a 34), con 34 en total:** la jefatura de planta (en Producción, sin centro de trabajo); 8 en el taller (2 en corte, 3 en armado y 3 en terminación: quedan 4, 5 y 5, con oficiales, medio oficiales y ayudantes); 2 operarios de depósito (3 en total); el coordinador y 3 choferes de logística (5); 2 vendedores y una administrativa de ventas (4); y un administrativo en Compras, Tesorería, Contabilidad, Impuestos y RRHH (6 con la de Contabilidad que ya estaba). Los dos que faltan para llegar a 36 son de tapicería y llegan con su centro de trabajo en la 9b.
- Nombres inventados, sin repetir los de los usuarios de la demo ni los legajos de hoy; ingresos entre 2016 y 2025, para que la antigüedad varíe.
- **Dónde crece:** la plantilla (en el simulador y en la base real, con una migración que le suma las categorías y los legajos que le falten, por número) y, con ella, las empresas que se creen después. Las empresas de los cursos ya creadas no cambian.
- **Los fondos para pagarlos (a validar):** con 34 legajos, los sueldos netos de un mes son unos $ 34,6 millones, y el banco de la apertura tenía $ 12,5 millones: la empresa no podía pagar ni un mes. La apertura suma $ 80 millones en el banco, aportados por los socios (capital de $ 120 a $ 200 millones). El resto del balance (stock y rodados) crece en la 9b.
- **La base guardada en el navegador no cambia:** sumarle el personal sin los fondos de la apertura la dejaría sin poder pagar los sueldos; la empresa grande llega al restablecer la demo (Administración) y con cada empresa nueva. La plantilla de la base real sí suma el personal, porque nadie la opera: sólo se copia, y cada empresa nueva arma su propia apertura, ya con los fondos nuevos.
- Notas de la 9a (22/11): `DEMO_EMPLOYEES` y `DEMO_JOB_CATEGORIES` (`src/lib/domain/employees.ts`) y `OPENING_BALANCES`; la carga de los legajos de la demo pasa a ser "los que falten, por número" (`insertEmployees` y `private.insert_demo_employees`). Las pruebas que contaban con el saldo chico de la apertura para provocar rechazos por falta de fondos corren sus importes los mismos 80 millones. Base de datos: migraciones 115 (`20261118120000_demo_template_personal.sql`, la plantilla regenerada) y 116 (`20261118120100_personal_plantilla.sql`, la plantilla que ya existía suma lo que le falta).

## 3. Decisiones (a validar)

- **La escala** de la tabla: se puede subir o bajar sin cambiar el diseño.
- **Las empresas ya creadas no cambian:** la empresa más grande es la plantilla, para los cursos nuevos (hoy, en la base real, sólo está la plantilla). Si un curso ya creado la quiere, se le puede sumar con una acción del docente **(a validar)**.
- **Los nombres de los clientes y proveedores** salen del banco ficticio; antes de usarlo en clase, el usuario revisa que ningún nombre coincida con un comercio real de la zona (es la Etapa B2 del plan).
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
