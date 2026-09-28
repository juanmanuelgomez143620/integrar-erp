# ERP educativo 2027 — propuesta de Fase 0

Revisión del 26/09/2026, elaborada a partir del requerimiento adjunto. **Entregable de arquitectura, no implementación ni certificación del prototipo.** Nombre definitivo pendiente; `INTEGR-AR` es el nombre de trabajo encontrado en el repositorio.

El producto será independiente de GEST-AR: código, datos, credenciales y despliegue propios. El objetivo es que estudiantes de 4.º, 5.º y 6.º experimenten la circulación de una operación entre sectores de una PYME. La empresa de demostración será **FORESTAL DEL NORTE SRL**, ubicada ficticiamente en Misiones, dedicada a muebles y derivados de madera.

## Situación encontrada

La carpeta de origen `C:\Users\juanj\OneDrive\Desktop\SAP SIMULADO` contiene una versión anterior de la documentación y un aviso de traslado. En `C:\Proyectos\GESTAR-ERP` existe un repositorio con interfaz React y backend simulado en `localStorage`. Esta entrega se guarda en el destino señalado, sin modificar la aplicación existente.

Los documentos de la raíz describen decisiones y un prototipo anteriores. Esta carpeta contiene una **propuesta autocontenida** que responde al pedido actual de Fase 0. Sus diferencias están identificadas en el [diagnóstico](DIAGNOSTICO.md). Para desarrollar esta propuesta se usarían sus contratos de datos, permisos y estados; antes habría que reconciliarlos con el prototipo. No se afirma que el código actual los implemente.

## Entregables solicitados

| Pedido | Documento |
|---|---|
| A. Diagnóstico técnico | [DIAGNOSTICO.md](DIAGNOSTICO.md) |
| B. Arquitectura; C. diagrama conceptual; I. carpetas | [ARCHITECTURE.md](ARCHITECTURE.md) |
| D. Entidades y relaciones | [DATABASE.md](DATABASE.md) |
| E. Matriz de roles y permisos | [ROLES_Y_PERMISOS.md](ROLES_Y_PERMISOS.md) |
| F. Circuito y estados | [FLUJO_COMPRAS.md](FLUJO_COMPRAS.md) |
| G. Roadmap | [ROADMAP.md](ROADMAP.md) |
| H. MVP preciso | [MVP.md](MVP.md) |
| J. Documentación inicial y decisiones | Este índice y [DECISIONES.md](DECISIONES.md) |

Los diagramas Mermaid quedan junto al texto que explica sus reglas. Las tablas del modelo son especificaciones preliminares: **no son migraciones SQL ejecutables**.

## Recomendación ejecutiva

Una aplicación modular con React, Vite y TypeScript, alojada como sitio estático, sobre Supabase Auth y PostgreSQL. RLS limita las lecturas; comandos transaccionales del servidor validan permisos y ejecutan aprobaciones, recepciones, stock, tareas y auditoría como una única operación.

Primero se construiría identidad + institución + empresas + permisos, con pruebas de aislamiento por API. Después, un recorrido completo: solicitud → orden → aprobación → recepción → stock. El MVP no necesita microservicios, un editor de flujos, un motor contable, ni IA.

Las decisiones pedagógicas más relevantes son el tamaño de los grupos, la separación entre quien prepara y quien aprueba, el umbral de autorización y el alcance del docente. Las decisiones operativas son conectividad, responsable del servicio, copias recuperables y presupuesto. Se proponen valores concretos en [DECISIONES.md](DECISIONES.md), sin dar por aceptadas decisiones de marca, venta o titularidad que no aparecen en este pedido.

## Cómo continuar

No hay instalación adicional para leer estos documentos. Los comandos de la aplicación existente están en el [README del repositorio](../../README.md); arrancar esa demo no habilita un aula colaborativa entre computadoras.

La siguiente etapa sería Fase 1A del [roadmap](ROADMAP.md): preparar el backend real y demostrar que dos usuarios autorizados comparten una empresa y que un tercero no puede acceder a ella. El resto de las fases depende de esa verificación.

Todos los comprobantes deberán mostrar: **DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL**.
