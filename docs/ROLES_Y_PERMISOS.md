# Roles y permisos — INTEGR-AR

> Versión 0.1 · Fase 0. Implementación técnica en [DATABASE.md §5 y §11](../DATABASE.md#5-roles-permisos-y-módulos).

## 1. Modelo en capas

La lista original de roles mezcla tres preguntas distintas. Separarlas simplifica los permisos y permite rotar estudiantes entre puestos sin crear usuarios nuevos.

| Capa | Pregunta | Valores |
|---|---|---|
| Escuela (instancia) | ¿Quién sos en la escuela? | `SUPERADMIN`, `ADMIN`, `DOCENTE`, `ESTUDIANTE` |
| Funcional (por empresa) | ¿Qué puesto ocupás en la empresa simulada? | `GERENCIA`, `COMPRAS`, `VENTAS`, `DEPOSITO`, `PRODUCCION`, `CONTABILIDAD`, `TESORERIA`, `RRHH`, `IMPUESTOS`, `LOGISTICA`, `AUDITOR`, `DOCENTE` (supervisor) |
| Organizacional | ¿En qué sector e isla trabajás? | Sectores e islas de cada empresa |

- `ESTUDIANTE` **no otorga permisos por sí mismo**: es la identidad escolar. Los permisos surgen de los roles funcionales asignados en cada empresa.
- Un usuario puede tener **varios roles** en una empresa (p. ej. `DEPOSITO` y `LOGISTICA` en la Isla 8) y roles distintos en empresas distintas.
- `DOCENTE` como rol funcional es **supervisor**: todos los permisos en esa empresa, sin bloqueos de módulo. Sus acciones quedan auditadas como "Docente".

### Roles de la escuela

Cada escuela tiene su propia instancia ([docs/INSTANCIAS.md](INSTANCIAS.md)); estos roles valen dentro de ella.

| Rol | Quién lo tiene | Qué puede hacer |
|---|---|---|
| `SUPERADMIN` | Soporte del proveedor del sistema | Instalación, actualizaciones, diagnóstico y alta del ADMIN inicial. Todo acceso queda auditado |
| `ADMIN` | Directivo o coordinador designado por la escuela | Datos de la escuela, cursos, alta y baja de docentes, restablecer contraseñas, ver todas las empresas |
| `DOCENTE` | Docentes | Sus cursos y estudiantes, empresas simuladas, asignación de roles y sectores, módulos, supervisión |
| `ESTUDIANTE` | Alumnos | Sólo lo que le otorgan sus roles funcionales en cada empresa |

## 2. Catálogo de roles funcionales

| Código | Nombre | Isla sugerida | Sector por defecto | Responsabilidad en la simulación |
|---|---|---|---|---|
| `GERENCIA` | Gerencia | 1 | Gerencia | Aprueba operaciones relevantes, supervisa indicadores y alertas |
| `AUDITOR` | Auditoría interna | 1 (o rotativo) | Control de Gestión | Consulta todo, revisa la auditoría, detecta desvíos. **No modifica nada** |
| `COMPRAS` | Compras | 2 | Compras | Atiende solicitudes, gestiona proveedores, emite órdenes de compra |
| `VENTAS` | Ventas | 3 | Ventas | Clientes (MVP); presupuestos, pedidos y facturación (Fase 4) |
| `CONTABILIDAD` | Contabilidad | 4 | Contabilidad | Plan de cuentas, asientos, libros y cierre de los meses (Fase 2); balances (fases siguientes) |
| `IMPUESTOS` | Impuestos | 4 | Impuestos | Libros IVA, obligaciones y vencimientos (Fase 7) |
| `TESORERIA` | Tesorería y Finanzas | 5 | Tesorería | Pagos, cobros, cajas y bancos (Fase 3+) |
| `RRHH` | Recursos Humanos y Sueldos | 6 | RRHH | Legajos, novedades y liquidación (Fase 6) |
| `PRODUCCION` | Producción | 7 | Producción | Detecta necesidades (SC en MVP); órdenes de producción (Fase 5) |
| `COSTOS` *(Fase 5)* | Costos | 7 | Costos | Costeo de órdenes, previsto vs. real |
| `DEPOSITO` | Depósito y Stock | 8 | Depósito | Recepciones, stock, ajustes, alertas de mínimo, SC de reposición |
| `LOGISTICA` | Logística | 8 | Logística | Consulta en MVP; despachos y entregas (Fase 7) |
| `DOCENTE` | Docente (supervisor) | — | — | Todo, incluido aprobar como supervisor |

`CONTROL_GESTION` podrá agregarse en la Fase 7 como rol de indicadores. Los roles son datos de catálogo: agregar uno no requiere cambiar código.

## 3. Permisos

Formato `recurso.acción`. Acciones: `read` (consultar), `create` (crear/enviar), `update` (modificar/avanzar), `approve` (aprobar/rechazar), `cancel` (anular/cerrar), `delete` (borrar — reservado), `export` (exportar/imprimir listados).

### 3.1 Catálogo del MVP

| Módulo | Permisos |
|---|---|
| core | `company.read`, `company.update`, `member.read`, `sector.read` |
| masters | `customer.read/create/update/export`, `supplier.read/create/update/export`, `product.read/create/update/export` |
| purchasing | `purchase_requisition.read/create/update/approve/cancel`, `purchase_order.read/create/update/approve/cancel/export`; desde la Fase 3, `supplier_invoice.read/create/cancel` (facturas de proveedor) |
| payables (Fase 3) | `payable.read` (cuentas corrientes de proveedores) |
| inventory | `goods_receipt.read/create/cancel`, `stock.read/export`, `stock_adjustment.read/create/approve/cancel` |
| accounting (Fase 2) | `account.read/create/update` (plan de cuentas), `journal_entry.read/create/update/cancel/export` (asientos), `ledger.read/export` (libros), `fiscal_period.update` (cerrar meses); desde la Fase 3, `posting_rule.read/update` (imputación automática) |
| management | `dashboard.read` (tablero ejecutivo consolidado), `task.read` (todas las tareas de la empresa) |
| audit | `audit.read`, `audit.export` |

Implícitos para cualquier miembro: ver y tomar sus tareas, sus notificaciones, su perfil, y el historial de los documentos que puede leer.

## 4. Matriz del MVP

Leyenda: **L** leer · **C** crear · **M** modificar · **A** aprobar/rechazar · **X** anular/cerrar · **E** exportar · — sin acceso.

| Recurso | GER | COM | VEN | DEP | PRO | CON | TES | RRHH | IMP | LOG | AUD | DOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Datos de empresa, sectores, miembros | L | L | L | L | L | L | L | L | L | L | L | Todo |
| Clientes | L E | — | L C M E | — | — | L | L | — | L | L | L E | Todo |
| Proveedores | L E | L C M E | — | L | L | L | L | — | L | L | L E | Todo |
| Productos | L E | L C M | L | L C M | L | L | — | — | — | L | L E | Todo |
| Stock y kardex | L E | L | L | L E | L | L | — | — | — | L | L E | Todo |
| Ajuste de stock | L A | — | — | L C X | — | L | — | — | — | — | L | Todo |
| Solicitud de compra | L | L A X¹ | — | L C M X | L C M X | — | — | — | — | — | L | Todo |
| Orden de compra | L A X E | L C M A² X E | — | L | L | L | L | — | L | L | L E | Todo |
| Recepción | L | L | — | L C X | L | L | — | — | — | L | L E | Todo |
| Tablero ejecutivo | L | — | — | — | — | — | — | — | — | — | L | Todo |
| Todas las tareas | L | — | — | — | — | — | — | — | — | — | L | Todo |
| Auditoría completa | L E | — | — | — | — | — | — | — | — | — | L E | Todo |
| Plan de cuentas (Fase 2) | L | — | — | — | — | L C M | L | — | L | — | L | Todo |
| Asientos (Fase 2) | L E | — | — | — | — | L C M X E | L | — | L | — | L E | Todo |
| Libro diario, mayor y sumas y saldos (Fase 2) | L E | — | — | — | — | L E | L | — | L | — | L E | Todo |
| Ejercicios y períodos (Fase 2) | L | — | — | — | — | L, cierra meses | L | — | L | — | L | Todo³ |
| Factura de proveedor (Fase 3) | L | L C X⁴ | — | — | — | L | L | — | L | — | L | Todo |
| Cuenta corriente de proveedores (Fase 3) | L | L | — | — | — | L | L | — | — | — | L | Todo |
| Imputación automática (Fase 3) | L | — | — | — | — | L M | — | — | — | — | L | Todo |

¹ Compras **rechaza** una SC o **cierra su saldo**; no la crea.
² Compras aprueba **sólo** OC dentro de su límite y **creadas por otro usuario** (ver §5 y §6).
³ Sólo el docente reabre un mes cerrado (con motivo) y abre un ejercicio nuevo.
⁴ Compras registra la factura contra lo recibido (nunca más de lo que llegó) y la anula sólo si no tiene pagos; el asiento de compra se genera solo, con las reglas de imputación de Contabilidad.

En el MVP, las islas de Tesorería, RRHH, Impuestos y Logística tienen **sólo consulta** (ver sugerencias de organización del piloto en [MVP.md §9](../MVP.md#9-organización-del-aula-en-el-piloto)); desde la Fase 2, Contabilidad registra asientos y lleva los libros.

## 5. Reglas de aprobación del MVP

| Documento | Monto (total con IVA) | Aprueba | Separación de funciones |
|---|---|---|---|
| Orden de compra | ≤ $ 500.000 | `COMPRAS` | El aprobador no puede ser quien creó la OC |
| Orden de compra | > $ 500.000 | `GERENCIA` | Ídem |
| Ajuste de stock | (Fase 2) negativos mayores a un umbral | `GERENCIA` | Quien ajusta no aprueba |

- Las reglas son **datos por empresa** (`approval_rules`); el umbral se ajusta sin tocar código (útil con inflación). Editor de reglas en la Fase 2.
- El monto evaluado se guarda como fotografía en la solicitud de aprobación.
- El docente siempre puede aprobar como supervisor (queda registrado).

## 6. Separación de funciones (control interno)

Se implementa como regla explícita porque es **contenido a enseñar**, no sólo seguridad.

| # | Regla | Cómo se aplica | Fase |
|---|---|---|---|
| SoD-1 | Quien crea una OC no la aprueba | Validación en `po_approve` | MVP |
| SoD-2 | Compras no registra recepciones; Depósito no emite OC | Matriz de permisos | MVP |
| SoD-3 | Quien confirmó una recepción no la anula (otro usuario de Depósito o Gerencia) | Validación en `gr_cancel` | MVP (P1) |
| SoD-4 | Quien carga un ajuste negativo relevante no lo aprueba | Regla de aprobación | 2 |
| SoD-5 | Quien registra la factura del proveedor no emite el pago | Matriz + validación | 3 |
| SoD-6 | Quien liquida sueldos no aprueba la liquidación | Regla de aprobación | 6 |

- Configuración por empresa: `settings.sod_enabled` (por defecto **activado**). Si una isla tiene un solo estudiante, el docente puede desactivarla o aprobar como supervisor.
- Cuando una acción se bloquea por esta regla, la interfaz muestra el motivo y la explicación: el bloqueo es una oportunidad de aprendizaje.

## 7. Matriz orientativa por módulo (fases futuras)

Leyenda: **O** opera · **A** aprueba · **L** consulta · — sin acceso. Se detalla por recurso al diseñar cada fase.

| Módulo | GER | COM | VEN | DEP | PRO | COS | CON | TES | RRHH | IMP | LOG | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cotizaciones y facturas de proveedor | L A | O | — | L | — | — | L | L | — | L | — | L |
| Cuentas a pagar / órdenes de pago | A | L | — | — | — | — | O | O | — | L | — | L |
| Ventas (presupuesto → factura) | L A | — | O | L | — | — | L | L | — | L | L | L |
| Cuentas a cobrar / cobros | L | — | L | — | — | — | O | O | — | L | — | L |
| Producción | L A | L | L | O | O | L | L | — | — | — | — | L |
| Costos | L | — | — | — | L | O | L | — | — | — | — | L |
| Contabilidad | L | — | — | — | — | L | O | L | — | L | — | L |
| Tesorería | L A | — | — | — | — | — | L | O | — | L | — | L |
| RRHH y Sueldos | L A | — | — | — | — | L | L | L | O | — | — | L |
| Impuestos | L | — | — | — | — | — | L | L | — | O | — | L |
| Logística | L | — | L | L | — | — | — | — | — | — | O | L |

## 8. Dónde se hace cumplir cada regla

| Capa | Qué controla | ¿Es la autoridad? |
|---|---|---|
| Interfaz | Oculta menús y deshabilita botones; explica por qué | No (comodidad) |
| RLS | Qué filas puede **leer** cada usuario; ABM de maestros | Sí |
| Comandos RPC | Transiciones, aprobaciones, separación de funciones, validaciones | Sí |
| Pruebas pgTAP | Que todo lo anterior se cumpla después de cada cambio | Verificación |
