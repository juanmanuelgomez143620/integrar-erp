# Decisiones que conocer antes de implementar

Propuestas del 26/09/2026. No requieren una respuesta para entregar Fase 0. Algunas deben cerrarse antes de configurar el servicio o construir la correspondiente regla. Las decisiones anteriores de marca/venta no se consideran autorizaciones nuevas.

| ID | Tema | Propuesta concreta | Momento de cierre |
|---|---|---|---|
| D01 | Nombre e identidad | Nombre de trabajo INTEGR-AR; identidad propia, independencia técnica de GEST-AR | Antes de publicar; no bloquea modelo ni pruebas |
| D02 | Ubicación | Repositorio activo `C:\Proyectos\GESTAR-ERP`; carpeta OneDrive sólo referencia histórica | Usado para esta entrega conforme al aviso encontrado |
| D03 | Instituciones | Entidad explícita y membresías; una institución por instalación piloto, múltiples empresas | Antes de primeras migraciones |
| D04 | Aula | Una empresa por grupo o curso; usuarios individuales, no cuentas compartidas por isla | Antes de preparar datos piloto |
| D05 | Aprobación | Total ARS educativo con IVA simulado: menor a $500.000 Compras; $500.000 o más Gerencia | Antes del comando de aprobación; el caso exacto no estaba definido en el pedido |
| D06 | Control interno | Creador de OC no aprueba, aunque acumule roles; otro docente autorizado puede intervenir con motivo | Antes de habilitar aprobaciones |
| D07 | Alcance del docente | Gestiona institución y empresas asignadas; no acceso global automático a compras de otras escuelas | Antes de escribir políticas |
| D08 | Compras MVP | Una SC completa origina una OC activa; recepción parcial admitida; stock actualizado al confirmar | Antes de comandos y aceptación |
| D09 | Correcciones | Borradores editables; rechazo corregible y nueva aprobación; recepción confirmada inmutable en MVP | Antes del piloto; enseñar revisión antes de confirmar |
| D10 | Valuación | Cantidades y costo recibido educativo desde MVP; método PPP y ajustes posteriores | Antes de habilitar Costos/Contabilidad |
| D11 | Login | Alias por institución/usuario con Supabase Auth; alta/restablecimiento por docente autorizado | Ensayo técnico antes de comprometer alta de estudiantes |
| D12 | Hosting / presupuesto | Netlify SPA + Supabase; Free para piloto si cuotas alcanzan; continuidad con presupuesto explícito | Antes de crear servicios y usarlos en aula |
| D13 | Entorno | Node LTS soportado; preferir Supabase local con Docker, alternativa nube de desarrollo | Antes de la primera migración ejecutable |
| D14 | Operación | Responsable de cuentas, copias al finalizar jornada y restauración de prueba | Antes de datos de aula; acordar recuperación tolerable |
| D15 | Secuencia anual | Validar prioridades según planificación de 4.º–6.º; fechas del roadmap son orientativas | Antes de planificar cada circuito posterior |

## Alternativas que mejoran la idea inicial

- Separar **estado de cada comprobante** del estado agregado del proceso: evita una solicitud “pagada” o una orden marcada como recibida por sólo una entrega parcial.
- Separar **rol escolar, rol de empresa y sector**: un estudiante puede rotar de puesto sin cambiar de cuenta ni acceder a otra empresa.
- Aplicar movimientos de stock en **una transacción del servidor** con el documento, auditoría y tareas: evita duplicados y operaciones a medias.
- Empezar con **una SC → una OC** para evaluar la coordinación entre islas; consolidación y compras parciales de una SC aumentan mucho las reglas sin ser necesarias para demostrar el flujo.
- Conservar `institutions` incluso con una instalación por escuela: el modelo representa la pertenencia solicitada y no confunde infraestructura con organización.
- Adoptar la interfaz existente como material reutilizable, no como prueba de que Auth/RLS funcionan. El navegador puede simular roles, pero no custodiar permisos frente a otros usuarios.

## Si el aula tiene pocos integrantes

Recomendación: un segundo alumno con rol aprobador o el docente como aprobador independiente. No desactivar globalmente la separación de funciones para resolver una isla unipersonal. Si en el futuro se desea una excepción pedagógica, debe ser específica, visible y auditada, no un bypass silencioso.
