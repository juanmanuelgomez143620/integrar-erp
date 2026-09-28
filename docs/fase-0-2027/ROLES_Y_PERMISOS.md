# Roles y permisos — ERP educativo 2027

Fase 0 · 26/09/2026. Matriz propuesta para el MVP; no describe permisos implementados en el prototipo. Ver [modelo](DATABASE.md), [flujo](FLUJO_COMPRAS.md) y [decisiones](DECISIONES.md).

## 1. Identidad, alcance y roles

| Capa | Qué define | Regla |
|---|---|---|
| Plataforma | SUPERADMIN | Instala/configura, habilita instituciones y primer docente; no opera compras automáticamente |
| Institución | DOCENTE / ESTUDIANTE | Membresía escolar activa; por sí sola no concede acceso a cualquier empresa |
| Empresa | Roles funcionales | Participación empresarial activa y roles explícitos por empresa |
| Organización | Sector/isla | Uno o varios por usuario; restringe acciones sectoriales y determina contexto auditado |

SUPERADMIN es un rol de aplicación, nunca una clave `service_role`. Para probar un circuito empresarial debe usar una identidad y membresía empresarial explícitas, sujetas a las mismas reglas.

DOCENTE administra estudiantes autorizados de sus cursos y supervisa sólo empresas asignadas. Crear una empresa dentro de su institución lo incorpora como supervisor; acceder a empresas ajenas exige una asignación explícita por una autoridad institucional autorizada. No puede darse acceso a otra institución ni asignar DOCENTE a un estudiante. Las altas de docentes son administrativas.

El alcance de configuración institucional se limita a datos de su institución y tareas delegadas; no otorga facultad de elevar roles. Un docente que sea también estudiante en otra institución mantiene ámbitos separados. ESTUDIANTE no concede permisos funcionales por sí solo.

| Rol funcional | Responsabilidad |
|---|---|
| GERENCIA | Consolidado de su empresa y aprobación de OC desde el umbral |
| COMPRAS | Proveedores, atender SC, emitir OC y aprobar dentro del límite |
| VENTAS | Clientes en MVP; ventas y cobros asociados después |
| DEPOSITO | Solicitudes de reposición, recepción y consulta de stock |
| PRODUCCION | Solicitar materiales en MVP; fabricación después |
| CONTABILIDAD | Consulta de documentos; asientos y libros después |
| TESORERIA | Consulta de OC; pagos, caja y bancos después |
| RRHH | Sin operaciones de personal en MVP; legajos y sueldos después |
| IMPUESTOS | Consulta pertinente; obligaciones educativas después |
| LOGISTICA | Consulta de productos/OC/recepción; despachos después |
| AUDITOR | Consulta transversal y auditoría; sin modificar operaciones |
| DOCENTE supervisor | Gestionar/supervisar su empresa asignada, con intervención explícita |

COSTOS y CONTROL_GESTION podrán incorporarse cuando se diseñen sus módulos. Varios roles suman permisos, pero no anulan restricciones por identidad, estado ni separación de funciones.

## 2. Catálogo de acciones

`recurso.read/create/update/approve/cancel/delete/export`. `delete` se reserva y no se concede sobre documentos, movimientos o auditoría. `cancel` requiere estado permitido y motivo; no equivale a borrar. `export` habilita la función de impresión/exportación, sin pretender impedir que quien puede leer copie información visible.

| Módulo | Recursos / acciones del MVP |
|---|---|
| Organización | `company.read/update`, `member.read/manage`, `sector.read/manage`, `module.manage` |
| Maestros | `customer`, `supplier`, `product`: read/create/update/export; desactivar mediante update |
| Compras | `purchase_requisition`: read/create/update/approve/cancel/export; `purchase_order`: read/create/update/approve/cancel/export |
| Inventario | `goods_receipt`: read/create/update/cancel/export; `stock.read/export`; `initial_stock.create/approve` docente |
| Gestión | `dashboard.read`, `task.read_all`, `audit.read/export`; `supervision.intervene` y `document_incident.create` docentes |

SC `approve` significa revisar/rechazar la solicitud; no exige aprobación monetaria previa a crear OC. Confirmar recepción es una acción del comando asociada a `goods_receipt.update`; además exige rol operativo, versión/estado y validación de pendientes.

Tareas propias/de roles vigentes, notificaciones y perfil limitado son capacidades personales condicionadas a su ámbito actual. Las tareas se resuelven mediante la operación; tomar/liberar manualmente queda después del MVP. Leer la historia de un documento exige poder leer ese documento. La auditoría completa de empresa requiere `audit.read`.

## 3. Matriz MVP

L leer · C crear · M modificar/confirmar según estado · A aprobar/rechazar · X anular · E imprimir/exportar · S supervisión explícita. GER Gerencia; COM Compras; VEN Ventas; DEP Depósito; PRO Producción; CON Contabilidad; TES Tesorería; IMP Impuestos; LOG Logística; AUD Auditor; DOC Docente.

| Recurso | GER | COM | VEN | DEP | PRO | CON | TES | RRHH | IMP | LOG | AUD | DOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Empresa/sectores/miembros | L | L | L | L | L | L | L | L | L | L | L | L M |
| Clientes | L E | — | L C M E | — | — | L | L | — | L | L | L E | L C M E |
| Proveedores | L E | L C M E | — | L | L | L | L | — | L | L | L E | L C M E |
| Productos | L E | L C M E | L | L C M E | L | L | — | — | — | L | L E | L C M E |
| SC | L E | L A E | — | L C M X E | L C M X E | — | — | — | — | — | L E | L S E |
| OC | L A X E | L C M A X E | — | L E | L | L E | L | — | L | L | L E | L S E |
| Recepción | L E | L E | — | L C M X E | L | L | — | — | — | L | L E | L S E |
| Stock/kardex | L E | L | L | L E | L | L | — | — | — | L | L E | L E |
| Inventario inicial | L | — | — | L | — | L | — | — | — | — | L | L C A |
| Dashboard consolidado | L | — | — | — | — | — | — | — | — | — | L | L |
| Todas las tareas | L | — | — | — | — | — | — | — | — | — | L | L |
| Auditoría completa | L E | — | — | — | — | — | — | — | — | — | L E | L E |

Toda lectura de miembros expone sólo información necesaria para coordinar el aula, nunca identificadores de recuperación o datos privados de Auth. Cada rol dispone de “Mi trabajo” aunque no vea el dashboard consolidado. RRHH no recibe pantallas ficticias: sus operaciones llegan en su fase.

S no significa modificación libre. El docente elige una intervención sobre una acción de negocio, aporta motivo y queda registrado como actor real. Se validan los mismos estados, integridad y cantidades. Si aprueba OC, debe ser distinto del creador. No reescribe una OC ajena: puede rechazar/anular según estado y preparar una sustituta desde la SC. Ante un error confirmado usa `record_document_incident`, que agrega documento, motivo y actor a la auditoría sin cambiar stock ni estados. Para operar habitualmente como Compras/Depósito recibe además el rol correspondiente.

## 4. Reglas que limitan la matriz

1. **Ámbito:** perfil habilitado y alta completa, institución activa, ambas membresías activas, empresa asignada, permiso y módulo habilitado. En empresa archivada sólo lectura autorizada.
2. **SC:** crear Producción/Depósito; editar/enviar/anular sólo creador o miembro autorizado de su sector, en estado permitido. Compras revisa/rechaza; la creación de OC inicia el proceso.
3. **OC:** edición material sólo en borrador por su creador si conserva permisos. Menor a ARS 500.000 con IVA educativo → COMPRAS; desde ARS 500.000 inclusive → GERENCIA. El creador nunca aprueba, tampoco al acumular roles o ser docente. Otro docente asignado puede intervenir con motivo; si falta el creador, se anula y reemplaza en vez de editar contenido ajeno.
4. **Recepción:** Depósito confirma sólo OC emitidas con pendiente. En MVP sólo se anula una recepción en borrador; ni Gerencia ni Docente revierten silenciosamente una confirmada.
5. **Roles acumulados:** recomendar estudiantes distintos en Compras y Depósito. La matriz separa funciones habituales, pero no garantiza por sí sola personas diferentes si ambas se asignan al mismo usuario; la separación obligatoria del MVP es autor/aprobador. Auditar las asignaciones y no presentar la suma de roles como un control por oposición independiente.
6. **Tareas:** leer exige destinatario vigente y acceso al documento. `task.read_all` permite observar, no ejecutar la tarea. El sector asignado también se verifica cuando existe.
7. **Revocación:** retirar rol/membresía o bloquear perfil impide nuevas lecturas y acciones, incluso con token vigente y notificaciones antiguas. La UI limpia caché; el servidor sigue siendo autoridad.
8. **Módulos:** un bloqueo impide operaciones ordinarias. El docente puede habilitarlo explícitamente o realizar una intervención de supervisión auditada; no existe bypass implícito por llamarse DOCENTE.
9. **Privilegios:** el usuario no modifica su rol escolar, pertenencia, estado ni los catálogos. El docente no convierte un alumno en supervisor. Claves secretas y Admin API permanecen en servidor.

## 5. Pruebas de autorización y diferencias anteriores

Probar mediante llamadas directas a API: estudiante sin empresa; empresa de otra institución; mismo rol en otra empresa; SC de otro sector; perfil desactivado; membresía revocada con JWT válido; DOCENTE sin asignación; SUPERADMIN intentando operar OC; combinación COMPRAS/GERENCIA autoaprobándose; valor exacto del umbral; tarea/notificación antigua; archivos vinculados sin permiso. También probar casos permitidos para evitar un sistema seguro pero inutilizable.

Esta matriz corrige el bypass global administrativo del diseño anterior, aclara que multirrol no garantiza separación entre comprador/receptor, limita la intervención docente y alinea catálogo/matriz de exportación y recepción. Se elimina la desactivación general de la separación autor/aprobador; no se promete que retirar un menú retire acceso. No se aplican estos cambios a la implementación en Fase 0.
