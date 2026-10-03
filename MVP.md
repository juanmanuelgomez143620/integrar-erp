# MVP — Fase 1

> **Revisión de Fase 0 (26/09/2026):** el nuevo pedido de arquitectura se documenta en [docs/fase-0-2027/README.md](docs/fase-0-2027/README.md). Esa propuesta identifica diferencias con el prototipo existente; este documento conserva el contexto anterior y no implica que Supabase ya esté implementado.

> Versión 0.1 · Fase 0. Arquitectura en [ARCHITECTURE.md](ARCHITECTURE.md); circuito detallado en [docs/FLUJO_COMPRAS.md](docs/FLUJO_COMPRAS.md).

## 1. Objetivo

Demostrar, con estudiantes reales en el aula, que **una misma operación circula entre sectores** sobre una base de datos común, con permisos, trazabilidad y efecto automático en el stock:

```
PRODUCCIÓN / DEPÓSITO → SOLICITUD DE COMPRA → COMPRAS → ORDEN DE COMPRA
→ APROBACIÓN → RECEPCIÓN → ACTUALIZACIÓN DE STOCK
```

**El MVP está terminado cuando** cuatro estudiantes en cuatro sectores distintos (Producción, Compras, Gerencia, Depósito) completan el circuito en menos de 20 minutos, sin ayuda técnica del docente, y cualquier miembro puede reconstruir después qué pasó, quién lo hizo y cuándo.

El MVP construye además el **núcleo** (multiempresa, permisos, documentos, flujo de trabajo, auditoría) sobre el que se apoyarán todas las fases siguientes. Por eso es más que un circuito de compras.

Se instala para la **Escuela Normal Superior N.º 9**, pero se construye como **producto replicable**: los datos de la escuela no están en el código y la instalación de una instancia queda documentada ([docs/INSTANCIAS.md](docs/INSTANCIAS.md)).

## 2. Alcance

**P0** = imprescindible para el piloto. **P1** = deseable; entra si el calendario lo permite, si no pasa a la Fase 2.

| Área | P0 | P1 |
|---|---|---|
| Acceso | Ingreso con usuario y contraseña; cierre de sesión; cambio de contraseña obligatorio en el primer ingreso | Cierre por inactividad configurable |
| Escuela y cursos | Configuración de la escuela (`school_settings`) cargada en la instalación; roles SUPERADMIN, ADMIN, DOCENTE, ESTUDIANTE; ADMIN da de alta docentes y cursos | Pantalla para editar datos y logo de la escuela |
| Instancias | Procedimiento de alta documentado; instancia demo creada con él | Script de alta automatizado |
| Empresas | Crear empresa desde la plantilla Forestal del Norte; datos generales; sectores; islas; depósitos | Logo; sucursales y centros de costo editables |
| Usuarios, roles y sectores | Panel docente: alta masiva de estudiantes, asignación de roles y sectores, restablecer contraseña | Rotación de roles guardada como "turnos" |
| Módulos | Bloquear o habilitar módulos por empresa | — |
| Maestros | Clientes, proveedores, productos (ABM, búsqueda, filtros, desactivar) | Productos ofrecidos por proveedor; exportar a CSV |
| Solicitud de compra | Crear, editar borrador, enviar, rechazar, anular; crear desde alerta de stock mínimo | Cerrar saldo |
| Orden de compra | Crear desde una o varias SC o en blanco; enviar a aprobación; aprobar/rechazar según reglas; reabrir; enviar al proveedor; anular | Retirar de aprobación; cerrar saldo |
| Aprobaciones | Reglas por monto (Compras ≤ $ 500.000 < Gerencia); separación de funciones | — |
| Recepción | Recepción total o parcial contra OC con N.º de remito; actualización de stock y PPP | Anulación con contramovimiento |
| Stock | Existencias por depósito; kardex por producto; alertas de stock mínimo; ajustes (incluye inventario inicial) | Valorización del inventario en el tablero |
| Mi trabajo | Tareas por rol y por usuario; contador en la barra superior; ir al documento | Tomar / liberar tarea |
| Notificaciones | Campana con no leídas; marcar como leídas; en tiempo real con respaldo por sondeo | Página de historial de notificaciones |
| Auditoría | Historial por documento; registro global con filtros (usuario, sector, acción, fecha, documento) | Exportar a CSV |
| Documentos | Vista de impresión de SC, OC y REC con leyenda de simulación | — |
| Trazabilidad | Pestaña "Flujo documental" (SC → OC → REC) | Panel "¿Qué sigue?" |
| Tablero | Tablero por rol: pendientes, OC por estado, productos bajo mínimo, actividad reciente | Tiempo promedio SC → recepción; valor del inventario |

**Avance al 03/10/2026** (interfaz con backend simulado; falta llevar todo a Supabase):
- Hechos además de lo P0 del circuito: cambio de contraseña obligatorio y perfil; `/admin` con docentes, cursos y datos de la escuela (sin logo, que espera a Supabase Storage); página de historial de notificaciones; exportación a CSV de maestros, stock y auditoría; cierre de sesión por inactividad configurable; anulación de recepción, retirar de aprobación y cerrar saldo.
- Alta masiva de estudiantes (H-21): pegar la lista del curso, usuarios únicos y contraseñas iniciales imprimibles.
- Crear empresa desde la plantilla (H-20): el docente elige el curso y obtiene una empresa con la estructura, los maestros y el inventario inicial de la plantilla, sin operaciones previas.
- Con esto, todo lo P0 de la interfaz está hecho; falta llevarlo a Supabase.

## 3. Fuera del MVP (y por qué)

| Funcionalidad | Motivo | Fase |
|---|---|---|
| Cotizaciones y comparación de proveedores | El circuito se entiende sin ellas; agregan dos documentos | 3 |
| Factura de proveedor, cuenta corriente, pagos | Requieren Tesorería y conviene que Contabilidad exista antes | 3 |
| Contabilidad | Necesita validación docente del plan de cuentas y los asientos modelo | 2 |
| Ventas, Producción, Costos, RRHH, Sueldos, Impuestos, Logística | Fases propias; reutilizan el núcleo | 4 a 7 |
| Motor de escenarios y consignas | La arquitectura los contempla; primero hay que validar el núcleo en el aula | 8 |
| Clonado y reinicio automático de empresas | Se puede recrear desde la plantilla | 8 (adelantable) |
| Editor visual de reglas de aprobación | Las reglas ya son datos; se editan por script en el piloto | 2 |
| Comentarios y adjuntos en documentos | Útiles, no imprescindibles | 2 |
| Exportación PDF generada en servidor | El navegador ya guarda como PDF | Posterior |
| Modo oscuro, atajos de teclado, personalización | Estética secundaria | Posterior |
| Tutor IA | Requiere datos de uso reales | 9 |

## 4. Historias de usuario

**Todos los miembros**
- H-01. Como estudiante, ingreso con mi usuario y contraseña y veo sólo las empresas donde participo.
- H-02. Como estudiante, en "Mi trabajo" veo qué operaciones esperan mi intervención y llego al documento con un clic.
- H-03. Como estudiante, recibo una notificación cuando algo requiere mi atención o cuando cambia un documento que inicié.
- H-04. Como estudiante, en cualquier documento que puedo ver, consulto su historial y los documentos anteriores y siguientes.

**Producción y Depósito**
- H-05. Como Producción, creo una solicitud de compra indicando qué necesito, cuánto, para cuándo y por qué, y la envío a Compras.
- H-06. Como Depósito, veo los productos bajo stock mínimo y creo una SC de reposición desde la alerta.
- H-07. Como solicitante, sigo el estado de mis SC y sé en qué OC quedaron incluidas.

**Compras**
- H-08. Como Compras, veo las SC pendientes y creo una OC a partir de una o varias, eligiendo proveedor, precios y fecha de entrega.
- H-09. Como Compras, envío la OC a aprobación y el sistema me indica quién debe aprobarla.
- H-10. Como Compras, corrijo y reenvío una OC rechazada, viendo el motivo.
- H-11. Como Compras, marco la OC como enviada e imprimo el documento para el proveedor.
- H-12. Como Compras, doy de alta y actualizo proveedores.

**Gerencia**
- H-13. Como Gerencia, apruebo o rechazo con motivo las OC que superan el umbral.
- H-14. Como Gerencia, veo un tablero consolidado: pendientes por sector, OC por estado, stock crítico, actividad reciente.

**Depósito**
- H-15. Como Depósito, registro la recepción de una OC con el N.º de remito del proveedor y las cantidades realmente recibidas (total o parcial).
- H-16. Como Depósito, consulto existencias y el kardex de cada producto.
- H-17. Como Depósito, registro ajustes de stock con motivo.

**Ventas**
- H-18. Como Ventas, doy de alta y actualizo clientes con su condición frente al IVA.

**Auditoría**
- H-19. Como Auditor, consulto todo el registro de auditoría con filtros y lo reviso sin poder modificar nada.

**Docente**
- H-20. Como docente, creo una empresa a partir de la plantilla Forestal del Norte para mi curso.
- H-21. Como docente, doy de alta a los estudiantes pegando una lista y obtengo usuarios y contraseñas iniciales imprimibles.
- H-22. Como docente, asigno a cada estudiante roles y sectores, y puedo cambiarlos entre clases.
- H-23. Como docente, bloqueo o habilito módulos para la empresa.
- H-24. Como docente, observo en tiempo real la actividad de todas las islas y puedo intervenir como supervisor.
- H-25. Como docente, restablezco la contraseña de un estudiante.

**Administración de la escuela**
- H-26. Como ADMIN de la escuela, doy de alta docentes y cursos del año lectivo sin depender del proveedor.
- H-27. Como SUPERADMIN (proveedor), instalo una instancia nueva siguiendo el procedimiento documentado, sin modificar el código.

## 5. Pantallas

| # | Pantalla | Ruta | Prioridad |
|---|---|---|---|
| 1 | Ingreso | `/login` | P0 |
| 2 | Cambio de contraseña | `/cambiar-contrasena` | P0 |
| 3 | Selector de empresa | `/empresas` | P0 |
| 4 | Tablero (según rol) | `/e/:empresa` | P0 |
| 5 | Mi trabajo | `/e/:empresa/mi-trabajo` | P0 |
| 6 | Notificaciones (menú desplegable) | barra superior | P0 |
| 7–8 | Clientes: listado · ficha | `/e/:empresa/clientes` | P0 |
| 9–10 | Proveedores: listado · ficha | `/e/:empresa/proveedores` | P0 |
| 11–12 | Productos: listado · ficha con stock | `/e/:empresa/productos` | P0 |
| 13 | Existencias por depósito | `/e/:empresa/stock` | P0 |
| 14 | Kardex de producto | `/e/:empresa/stock/productos/:codigo/kardex` | P0 |
| 15–16 | Ajustes de stock: listado · documento | `/e/:empresa/stock/ajustes` | P0 |
| 17–18 | Solicitudes de compra: listado · documento | `/e/:empresa/compras/solicitudes` | P0 |
| 19–20 | Órdenes de compra: listado · documento | `/e/:empresa/compras/ordenes` | P0 |
| 21–22 | Recepciones: listado · documento | `/e/:empresa/deposito/recepciones` | P0 |
| 23 | Vista de impresión (SC, OC, REC, AJS) | `/e/:empresa/documentos/:id/imprimir` | P0 |
| 24 | Auditoría | `/e/:empresa/auditoria` | P0 |
| 25 | Empresa: datos, sectores, islas, miembros | `/e/:empresa/empresa` | P0 |
| 26 | Panel docente: cursos, estudiantes, empresas, módulos, actividad | `/docente` | P0 |
| 27 | Administración de la escuela: docentes, cursos | `/admin` | P0 |
| 28 | Datos y logo de la escuela | `/admin/escuela` | P1 |

Los documentos comparten **un mismo esqueleto** (cabecera, acciones, pestañas Detalle / Flujo documental / Historial): se construye una vez y se reutiliza.

## 6. Requisitos no funcionales

| Tema | Requisito |
|---|---|
| Navegadores | Chrome y Edge actualizados (prioridad); Firefox |
| Pantallas | Óptimo ≥ 1280 px; tablet ≥ 768 px con menú colapsable; teléfono: consultas, Mi trabajo y aprobaciones |
| Rendimiento | Listados paginados (25/50 filas) en < 1 s en la red escolar; acciones < 2 s |
| Concurrencia | 30 usuarios simultáneos por empresa; 150 en total |
| Ingreso | 30 inicios de sesión en 2 minutos desde una misma IP sin bloqueos |
| Accesibilidad | Contraste AA; foco visible; navegación por teclado en formularios y tablas; estados con texto, no sólo color |
| Idioma y formatos | Español rioplatense; `dd/mm/aaaa`; `$ 1.234.567,89` |
| Seguridad | Lista de control de [ARCHITECTURE.md §10](ARCHITECTURE.md#10-seguridad) completa |
| Privacidad | Sólo nombre, apellido y curso de los estudiantes |

## 7. Criterios de aceptación

- CA-01. El circuito completo SC → OC → aprobación → recepción → stock funciona con cuatro usuarios distintos, cada uno sólo con su rol.
- CA-02. Una OC mayor a $ 500.000 sólo la aprueba Gerencia; una menor, otro usuario de Compras; el creador nunca (mensaje explicativo).
- CA-03. La recepción parcial deja la OC en "Recibida parcialmente" y genera una tarea por el saldo; la recepción del saldo la completa.
- CA-04. El stock y el PPP coinciden con la suma de movimientos (prueba automática de invariantes).
- CA-05. Un usuario de la empresa A no puede leer ni modificar datos de la empresa B, ni por la interfaz ni llamando directamente a la API (pruebas pgTAP).
- CA-06. Un estudiante sin permiso no puede aprobar, recibir ni cambiar estados llamando directamente a la API.
- CA-07. Cada transición queda en la auditoría con usuario, rol, sector, fecha y hora, documento, estado anterior y nuevo.
- CA-08. La bandeja de Compras muestra la SC nueva sin recargar la página (tiempo real) y, si la conexión en vivo falla, en menos de un minuto (sondeo).
- CA-09. SC, OC y REC se imprimen en A4 con la leyenda "DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL".
- CA-10. El docente crea una empresa desde la plantilla, da de alta 30 estudiantes y asigna roles en menos de 15 minutos.
- CA-11. Bloquear el módulo Compras impide a los estudiantes operarlo (no al docente).
- CA-12. La prueba E2E del circuito corre en CI y pasa.
- CA-13. RLS habilitado en el 100 % de las tablas; sin advertencias críticas del *Security Advisor* de Supabase.
- CA-14. La instancia demo se instala desde cero con el procedimiento documentado, en menos de 2 horas y sin tocar el código.
- CA-15. Ningún dato de la ENS N.º 9 (nombre, logo, localidad) aparece escrito en el código: todo proviene de `school_settings`.

## 8. Plan de trabajo

Supuesto: una persona con asistencia de IA, ~12–15 horas semanales. Se ajusta al ritmo real.

> **Cambio de orden (26/09/2026).** Se construyó primero la interfaz completa del MVP sobre un backend simulado en el navegador (ver [ARCHITECTURE.md §7.9](ARCHITECTURE.md#79-etapa-actual-backend-simulado)). Ya funcionan el circuito completo, "Mi trabajo", las notificaciones, la auditoría, la impresión, los maestros y el panel docente. Los sprints S1 a S5 pasan a centrarse en **llevar ese mismo contrato a Supabase** (migraciones, RLS, RPC y pruebas pgTAP), tomando el motor simulado como especificación.

| Sprint | Fechas | Entregables |
|---|---|---|
| Fase 0 | 26/09 – 18/10/2026 | Documentación (este paquete); decisiones ★ resueltas; spikes técnicos (§11) |
| S0 | 19/10 – 25/10 | Repositorio, Vite + TS + Tailwind + shadcn, Supabase local, ESLint/Prettier, CI, estructura de carpetas, *AppShell* vacío, primer deploy |
| S1 | 26/10 – 08/11 | Migraciones de escuela (`school_settings`, perfiles, cursos), empresas y RBAC; funciones de permisos y RLS; **pgTAP de aislamiento**; ingreso, contexto de sesión, selector de empresa; Edge Function `admin-users` |
| S2 | 09/11 – 22/11 | Maestros (productos, proveedores, clientes, categorías, depósitos) con auditoría por *trigger*; componentes DataTable y formularios reutilizables |
| S3 | 23/11 – 06/12 | Motor de documentos (catálogos, numeración, transición, tareas, notificaciones, auditoría); **SC completa** con pruebas |
| S4 | 07/12 – 20/12 | **OC** completa: reglas de aprobación, separación de funciones, vínculos con SC; vista de impresión |
| Receso | 21/12 – 03/01/2027 | — |
| S5 | 04/01 – 17/01 | **Recepción** y libro de stock (movimientos, saldos, PPP, kardex); ajustes; alertas de mínimo |
| S6 | 18/01 – 31/01 | Mi trabajo, notificaciones en tiempo real, tableros por rol, auditoría global, flujo documental |
| S7 | 01/02 – 14/02 | Panel docente y administración escolar; plantilla Forestal del Norte; E2E del circuito; endurecimiento (advisors, límites de Auth, prueba con 30 usuarios); **procedimiento de alta de instancia** probado creando la instancia demo; guías breves de uso |
| Margen | 15/02 – 28/02 | Prueba en la escuela con equipos y red reales; correcciones |
| Piloto | Marzo 2027 | Un curso, una empresa |

## 9. Organización del aula en el piloto

En el MVP operan activamente las islas **1 (Gerencia)**, **2 (Compras)**, **7 (Producción)** y **8 (Depósito)**. Sugerencias para que las demás islas participen desde el primer día:

| Isla | Actividad sugerida |
|---|---|
| 3 · Ventas | Carga y depuración de la cartera de clientes (condición de IVA, plazos) |
| 4 · Contabilidad | Consulta las OC y recepciones y redacta **en papel** los asientos que corresponderían; se contrastan con los automáticos cuando llegue la Fase 3 |
| 5 · Tesorería | Proyecta en planilla los pagos de las OC aprobadas según su condición de pago |
| 6 · RRHH | Actúa como **proveedor externo**: prepara remitos en papel (a veces con diferencias) que Depósito debe controlar al recibir |
| Auditor (rotativo) | Revisa la auditoría y detecta desvíos: OC sin SC, recepciones parciales, rechazos |

Se recomienda **rotar roles** entre clases para que todos recorran el circuito completo.

## 10. Guion de demostración (20 minutos)

Participantes: Producción (P), Depósito (D), Compras 1 (C1), Compras 2 (C2), Gerencia (G), Auditor (A), docente.

1. **D** abre el tablero: MP-004 Placa MDF 18 mm está bajo el mínimo (dato inicial de la plantilla). Crea SC-00001 desde la alerta por 40 placas, motivo "Reposición para producción de placares", y la envía.
2. **P** crea SC-00002 por 300 pies de pino elliottis para una orden de mesas y la envía.
3. **C1** ve ambas tareas aparecer en "Mi trabajo" sin recargar. Crea OC-00001 al proveedor de placas (SC-00001) y OC-00002 al aserradero (SC-00002). Las envía a aprobación.
4. OC-00001 supera $ 500.000 → tarea para **G**. OC-00002 es menor → tarea para Compras.
5. **C1** intenta aprobar OC-00002: el sistema lo impide y explica la separación de funciones. **C2** la aprueba.
6. **G** rechaza OC-00001 con el motivo "Pedir mejor precio". **C1** la reabre, ajusta el precio, la reenvía; **G** aprueba.
7. **C1** marca ambas OC como enviadas e imprime OC-00001.
8. El "proveedor" (isla 6) entrega un remito en papel por 30 de las 40 placas. **D** registra REC-00001 parcial: la OC queda "Recibida parcialmente" y aparece una nueva tarea por el saldo. **D** recibe completa OC-00002.
9. Todos ven el kardex de MP-004 (+30), el nuevo PPP y la alerta de mínimo resuelta.
10. **A** reconstruye la historia completa desde la auditoría y el flujo documental de SC-00001 → OC-00001 → REC-00001.
11. El docente muestra su panel con la actividad de cada isla.

## 11. Spikes técnicos (Fase 0, antes de S0)

| # | Pregunta | Criterio de éxito |
|---|---|---|
| S-01 | ¿Supabase Auth acepta el dominio sintético elegido para los emails de estudiantes? | Alta por Admin API e ingreso con usuario funcionan |
| S-02 | Patrón RLS con funciones de conjunto + comando RPC + prueba pgTAP | Un prototipo de `po_approve` pasa pruebas de permiso, estado y separación de funciones |
| S-03 | ¿La red de la escuela permite `*.supabase.co` y WebSockets? | Página de prueba con Realtime funcionando desde una PC del aula |
| S-04 | Límite de inicios de sesión por IP | 30 ingresos en 2 minutos sin errores tras ajustar la configuración |
