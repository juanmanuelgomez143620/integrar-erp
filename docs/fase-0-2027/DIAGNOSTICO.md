# Diagnóstico técnico y diferencias con el material existente

Inspección realizada el 26/09/2026. Alcance: sistema de archivos, Git, manifiesto, documentación y puntos de entrada del prototipo; verificación de tipos. No se probó una instalación Supabase ni un despliegue remoto.

## 1. Estado comprobado

| Elemento | Evidencia | Conclusión |
|---|---|---|
| Directorio recibido | `C:\Users\juanj\OneDrive\Desktop\SAP SIMULADO` | No está vacío: documentación previa y carpetas con `.gitkeep` |
| Aviso de traslado | `PROYECTO MOVIDO - VER C-Proyectos-GESTAR-ERP.txt` | Señala `C:\Proyectos\GESTAR-ERP`; no se eliminó ni movió la carpeta anterior |
| Destino | Git, `package.json`, lockfile, `src`, `dist`, `node_modules` | Existe un proyecto iniciado; no corresponde generar otro frontend desde cero |
| Git inicial del destino | Rama `main`, commit `983266b`, sin cambios pendientes | Esta revisión se preparó en `docs/revision-fase-0-2027` |
| Fuente de aplicación | 68 archivos `.ts`/`.tsx` en `src` | Ya existen pantallas y lógica simulada |
| Integración real | `src/lib/api/index.ts` importa `src/lib/mock`; `supabase/` sin archivos distintos de `.gitkeep` | No hay migraciones, RLS ni backend Supabase implementados en este repositorio |
| Autenticación actual | `auth.login` compara contraseña con el perfil del mock y escribe ID en `sessionStorage` | Acceso de demostración, no autenticación de servidor |
| Persistencia actual | `src/lib/mock/db.ts` guarda objetos en `localStorage` y escucha evento `storage` | Comparte datos entre pestañas del mismo origen/perfil de navegador; no entre computadoras del aula |
| Herramientas detectadas | Node 20.20.0, npm 10.8.2, Git 2.53.0.windows.2 | Revisar actualización de Node antes de continuar desarrollo |
| Docker y Supabase CLI | No encontrados en PATH mediante `Get-Command` | No se confirma ausencia de otras instalaciones; capacidad de Supabase local pendiente |
| Verificación ejecutada | `npm run typecheck` en el destino, salida 0 | Los tipos del prototipo pasan; no demuestra seguridad, persistencia compartida ni cobertura funcional |
| Pruebas del backend | No se encontraron pruebas implementadas en `supabase/` | La seguridad y las transacciones deben verificarse al construir el backend |

La afirmación antigua “directorio vacío” ya no describe el estado actual. Tampoco es correcto equiparar la copia de objetos en memoria del mock con una transacción PostgreSQL entre clientes concurrentes.

## 2. Evaluación de la base existente

Hay material aprovechable: separación por funcionalidades, capa de acceso a datos, documentos enlazados, bandeja, roles, stock por movimientos y documentación amplia. Conviene reutilizar interfaz y conceptos después de fijar los contratos del servidor.

El diseño anterior añade supuestos de escuela específica, marca compartida y comercialización. Se preserva como antecedente. El requerimiento de este turno no confirma esos detalles; la presente propuesta usa una institución configurable y mantiene independencia técnica respecto de GEST-AR.

## 3. Diferencias de esta propuesta

Los hallazgos siguientes surgen del **pseudomodelo documental**, no de pruebas sobre una base desplegada. No deben presentarse como ataques exitosos.

| Hallazgo en documentación anterior | Cambio propuesto para la próxima implementación |
|---|---|
| `DATABASE.md` elimina instituciones y usa sólo `school_settings` | Institución y pertenencia explícitas; piloto una institución por instancia, sin imponer SaaS |
| Helper `companies_with_permission` da cualquier permiso a ADMIN/SUPERADMIN | Privilegios administrativos separados de las operaciones empresariales; sin bypass universal |
| Ramas de acceso no comprueban perfil activo o mantienen acceso a notificaciones por destinatario | Evaluar identidad y membresías vigentes en cada lectura/comando, incluidas tareas, archivos y exportaciones |
| FK de subtipo OC no incluye empresa en la relación concreta con cabecera | Cabecera y subtipo unidos por empresa, identificador y tipo; líneas validadas contra su subtipo |
| La aprobación de ejemplo consulta campos que no existen en su solicitud | Snapshot completo de regla/versiones y contrato único de aprobación |
| Una SC queda ORDENADO por una OC borrador | EN_PROCESO mientras se prepara; ORDENADO sólo al emitir la OC autorizada |
| Consolidación y división de SC complican cobertura y tareas | Una SC completa → una OC activa en MVP; reglas explícitas de cancelación/rechazo |
| Umbral exacto ambiguo entre texto y pruebas | Propuesta: < $500.000 Compras; ≥ $500.000 Gerencia; probar el valor exacto |
| Bloqueos descritos sólo sobre documento receptor | Bloquear también OC/líneas fuente y saldos; idempotencia y control de remito duplicado |
| Reversión de recepción se suple con ajustes | No presentar un ajuste como corrección del documento; recepción confirmada inmutable en MVP, límite visible |
| Reinicio elimina documentos mientras auditoría se declara inmutable | Archivar empresa y crear nueva práctica; posponer borrado/reinicio automático |
| MVP incluye PPP, múltiples combinaciones, alta masiva y productización | Priorizar coordinación entre islas, seguridad y evidencia del circuito; esas mejoras se posponen |

Los contratos de [DATABASE.md](DATABASE.md), [ROLES_Y_PERMISOS.md](ROLES_Y_PERMISOS.md) y [FLUJO_COMPRAS.md](FLUJO_COMPRAS.md) se refieren a esta nueva propuesta. No se cambiaron los nombres de estado ni los permisos del prototipo existente.

## 4. Riesgos principales y cómo demostrar su control

| Riesgo | Consecuencia | Evidencia necesaria antes de aula |
|---|---|---|
| Confundir demo con sistema compartido | Alumnos en distintas PC trabajan sobre bases desconectadas | Circuito con usuarios en navegadores/dispositivos separados contra el mismo backend |
| Aislamiento incompleto | Empresa/sector ajeno visible o modificable | Pruebas API con otra empresa, otra institución, rol insuficiente y permiso revocado |
| Elevación de privilegios | Alumno cambia roles o se autoaprueba | Prohibición de DML directo y pruebas adversarias contra altas, perfiles, roles y comandos |
| Recepción duplicada o concurrente | Stock mayor que mercadería recibida | Doble clic/reintento, respuesta perdida, remito repetido y dos recepciones compitiendo por pendiente |
| Operación a medias | Documento, tareas y stock discrepan | Falla inducida y rollback verificado; invariantes de saldo |
| Pocos participantes en una isla | No existe aprobador distinto del autor | Segundo aprobador autorizado o intervención docente con motivo, visibles en bandeja |
| Red escolar, IP compartida o pausa de servicio | Aula sin login o sin actualización de tareas | Prueba de acceso simultáneo y recuperación; plan de clase ante caída, sin escritura offline |
| Copias incompletas | No se recuperan cuentas, archivos o trabajos | Restauración ensayada en entorno separado, no sólo “backup generado” |
| Alcance excesivo | Muchos formularios y ningún circuito usable | Puertas de salida por flujo completo y lista explícita de pospuestos |
| Divergencia documentación/código | Se desarrollan reglas incompatibles | Una decisión versionada por cambio, pruebas de contrato y revisión al sustituir el mock |

## 5. Resultado de esta entrega

Se propone conservar React/Vite/TypeScript y Supabase, construyendo primero identidad, pertenencia y permisos reales. Después, el circuito SC → OC → aprobación → recepción → stock con auditoría y bandeja integradas.

Esta etapa agrega documentación y enlaces de orientación. No cambia el frontend, no migra datos, no instala dependencias, no crea servicios externos y no toca GEST-AR. La validación documental final se registra en [VALIDACION.md](VALIDACION.md).
