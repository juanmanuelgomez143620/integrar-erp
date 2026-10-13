# Plan de acción (desde el 13/10/2026)

Objetivo: que INTEGR-AR tenga todos sus módulos desarrollados y funcionando, sobre una base segura y respaldada. Cada etapa termina con `npm run -s check` en verde, prueba en el navegador y commit. El método de cada módulo es el del MVP: primero el simulador (la especificación), después la interfaz, después la base de datos de Supabase, con pruebas que comparan ambos.

## Etapa A — Base sana (necesita al usuario)

| Paso | Qué | Estado |
|---|---|---|
| A1 | Corregir el alta de usuarios (el rol sólo sale de los datos del servidor) | Hecho (`70981b8`) |
| A2 | Aplicar esa corrección en Supabase, revisar los perfiles creados antes y hacer la prueba de humo con `VITE_BACKEND=supabase` | Con el usuario presente |
| A3 | Subir las ramas a GitHub (respaldo) | Necesita autorización |
| A4 | Llevar `mejoras/integracion` a `main` después de la prueba de humo | Necesita autorización |
| A5 | Decidir la rama del módulo "Seguimiento y Evaluación" (sin commitear en la carpeta principal) | Decide el usuario |

## Etapa B — Datos de demostración más ricos

| Paso | Qué |
|---|---|
| B1 | Faker (sólo desarrollo) y un generador de bancos de proveedores y clientes ficticios argentinos: CUIT de un rango ficticio con dígito verificador, condición frente al IVA coherente, localidades del NEA y contactos. Se guarda como datos del repositorio, para revisar. |
| B2 | Usar esos bancos cuando hagan falta: más clientes con Ventas (Fase 4) y en el entorno vivo (Fase 8). En Supabase, siempre con una migración nueva. |

## Etapa C — Fase 2: Contabilidad base

| Paso | Qué |
|---|---|
| C1 | Diseño corto (`docs/FASE_2_CONTABILIDAD.md`) y plan de cuentas propuesto, para que lo valide el docente |
| C2 | Simulador: plan de cuentas, ejercicios y períodos, asientos con partida doble (borrador → confirmado; la anulación genera un contraasiento), libro diario, mayor y balance de sumas y saldos, con pruebas |
| C3 | Interfaz: menú Contabilidad con plan de cuentas, asientos, diario, mayor y sumas y saldos; impresión con la leyenda de simulación |
| C4 | Supabase: tablas, permisos (RLS), RPC y lecturas, con las pruebas de paridad ampliadas |
| C5 | Motor de imputación (`posting_rules`) listo para que la Fase 3 genere asientos automáticos |

## Etapa D — Módulos siguientes (roadmap 2027)

Fase 3 compras completo y tesorería → Fase 4 ventas y clientes → Fase 5 producción y costos → Fase 6 RRHH y sueldos → Fase 7 impuestos (fisco simulado), logística y control → Fase 8 escenarios y entorno vivo (banco de casos con plantillas, aprobación del docente, IA sólo por fuera de la app).

## Reglas para quien ejecute el plan

- Trabajar en el worktree `C:\Proyectos\GESTAR-ERP-supabase`. No tocar cambios sin commitear de otros.
- Nada de push, merge a `main` ni cambios en el Supabase real sin autorización explícita del usuario.
- Las migraciones ya aplicadas no se editan: cada cambio va en una migración nueva.
- En esta PC (3,8 GB de RAM) las pruebas corren con `--maxWorkers=2`. Nunca "arreglarlas" quitando configuración.
- Las decisiones docentes (por ejemplo, el plan de cuentas) se proponen y las valida el usuario.
