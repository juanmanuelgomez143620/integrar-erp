# Plan de acción (desde el 13/10/2026)

Objetivo: que INTEGR-AR tenga todos sus módulos desarrollados y funcionando, sobre una base segura y respaldada. Cada etapa termina con `npm run -s check` en verde, prueba en el navegador y commit. El método de cada módulo es el del MVP: primero el simulador (la especificación), después la interfaz, después la base de datos de Supabase, con pruebas que comparan ambos.

## Etapa A — Base sana (necesita al usuario)

| Paso | Qué | Estado |
|---|---|---|
| A1 | Corregir el alta de usuarios (el rol sólo sale de los datos del servidor) | Hecho (`70981b8`) |
| A2 | Aplicar en Supabase esa corrección y las migraciones de Contabilidad, revisar los perfiles creados antes y hacer la prueba de humo con `VITE_BACKEND=supabase` | Migraciones aplicadas y perfiles revisados (16/10); falta la prueba de humo con cuentas reales (la hace el usuario) |
| A3 | Subir las ramas a GitHub (respaldo) | Hecho (16/10; el repo es público) |
| A4 | Llevar `mejoras/integracion` a `main` | Hecho (16/10): `main` se publica en GitHub Pages contra Supabase |
| A6 | Revocar el token personal de Supabase usado el 16/10 y rotar las claves del proyecto | Lo hace el usuario |
| A5 | Decidir la rama del módulo "Seguimiento y Evaluación" (sin commitear en la carpeta principal) | Decide el usuario |
| A7 | Publicar la corrección de las bases guardadas (29/10): la versión de `main` (Fase 6, en Vercel) no abre un navegador con datos de la Fase 5 ("La base guardada está incompleta") porque no reconoce las colecciones nuevas del personal; está corregido en `mejoras/integracion` y llega al actualizar `main` | Necesita la autorización del usuario |

## Etapa B — Datos de demostración más ricos

| Paso | Qué | Estado |
|---|---|---|
| B1 | Faker (sólo desarrollo) y un generador de bancos de proveedores y clientes ficticios argentinos: CUIT de un rango ficticio con dígito verificador, condición frente al IVA coherente, localidades del NEA y contactos. Se guarda como datos del repositorio, para revisar. | Hecho (`src/lib/mock/partner-bank.ts`) |
| B2 | Usar esos bancos cuando hagan falta: más clientes con Ventas (Fase 4) y en el entorno vivo (Fase 8). En Supabase, siempre con una migración nueva. | Pendiente |

## Etapa C — Fase 2: Contabilidad base

| Paso | Qué | Estado |
|---|---|---|
| C1 | Diseño corto (`docs/FASE_2_CONTABILIDAD.md`) y plan de cuentas propuesto, para que lo valide el docente | Hecho; falta la validación docente |
| C2 | Simulador: plan de cuentas, ejercicios y períodos, asientos con partida doble (borrador → registrado; la anulación genera un contraasiento), libro diario, mayor y balance de sumas y saldos, con pruebas | Hecho |
| C3 | Interfaz: menú Contabilidad con plan de cuentas, asientos, diario, mayor, sumas y saldos y ejercicios; impresión con la leyenda de simulación | Hecho |
| C4 | Supabase: tablas, permisos (RLS), RPC y lecturas, con las pruebas de paridad ampliadas | Hecho (sin aplicar al proyecto real) |
| C5 | Motor de imputación (`posting_rules`) listo para que la Fase 3 genere asientos automáticos | Hecho (en la Fase 3a) |

## Etapa D — Módulos siguientes (roadmap 2027)

Fase 3 compras completo y tesorería → Fase 4 ventas y clientes → Fase 5 producción y costos → Fase 6 RRHH y sueldos → Fase 7 impuestos (fisco simulado), logística y control → Fase 8 escenarios y entorno vivo (banco de casos con plantillas, aprobación del docente, IA sólo por fuera de la app).

| Paso | Qué | Estado |
|---|---|---|
| D1 | Fase 3a (`docs/FASE_3_COMPRAS_Y_TESORERIA.md`): imputación automática, factura de proveedor contra lo recibido con su asiento, cuentas corrientes de proveedores | Hecho y aplicado en Supabase (16/10); falta que el docente valide las reglas de imputación |
| D2 | Fase 3b: cajas y bancos, orden de pago con aprobación de Gerencia y pago (asiento `PAGO`, SoD-5) | Hecho y aplicado en Supabase (16/10) |
| D3 | Fase 3c: solicitud de cotización a varios proveedores, cotizaciones, cuadro comparativo y adjudicación que genera la OC | Hecho (18/10, con paridad); falta aplicar sus dos migraciones en Supabase y publicar (con autorización) |
| D4 | Fase 3d.1: transferencias entre cajas y bancos, flujo de fondos real y proyectado | Hecho (19/10, con paridad); falta aplicar sus dos migraciones en Supabase y publicar (con autorización) |
| D5 | Fase 3d.2: medio de pago (cheques propios), cheques emitidos y conciliación bancaria simplificada | Hecho (19/10, con paridad); falta aplicar sus dos migraciones en Supabase y publicar (con autorización) |
| D6 | Fase 4a (`docs/FASE_4_VENTAS_Y_CLIENTES.md`): pedido de venta con control de crédito y reserva de stock; remito que descuenta el stock y registra el costo de lo vendido | Hecho (20/10, con paridad); falta aplicar sus cuatro migraciones en Supabase y publicar (con autorización) |
| D7 | Fase 4b: factura de venta contra lo entregado (letra A o B) con su asiento, y cuenta corriente de clientes | Hecho (21/10, con paridad); falta aplicar sus cuatro migraciones en Supabase y publicar (con autorización) |
| D8 | Fase 4c: recibo de cobro, antigüedad de saldos y cobros en el flujo de fondos proyectado | Hecho (22/10, con paridad); falta aplicar sus cuatro migraciones en Supabase y publicar (con autorización) |
| D9 | Fase 4d: listas de precios y presupuestos | Hecho (22/10, con paridad); falta aplicar sus dos migraciones en Supabase y publicar (con autorización) |
| D10 | Fase 5a (`docs/FASE_5_PRODUCCION_Y_COSTOS.md`): listas de materiales y orden de producción (liberar con reserva, entrega de materiales, terminación al costo real) | Hecho (22/10, con paridad); falta aplicar sus cuatro migraciones en Supabase y publicar (con autorización) |
| D11 | Fase 5b: centros de trabajo, horas y costos de conversión; costo previsto contra real de cada orden | Hecho (22/10, con paridad); falta aplicar sus cuatro migraciones en Supabase y publicar (con autorización) |
| D12 | Fase 5c: necesidades de materiales y solicitud de compra de los faltantes | Hecho (24/10, con paridad); falta aplicar su migración en Supabase y publicar (con autorización). Con esto la Fase 5 está completa |
| D13 | Fase 6: legajos, novedades del mes, liquidación simulada con recibo, asiento de sueldos y pago por Tesorería; con los sueldos reales, la mano de obra sub- o sobreaplicada de la Fase 5 | Hecha (diseño en `docs/FASE_6_RRHH_Y_SUELDOS.md`): 6a, 6b y 6c (24/10 a 26/10, con paridad; falta aplicar sus doce migraciones en Supabase). La 6d (convenios colectivos y autorización de Gerencia, `docs/FASE_6D_CONVENIOS.md`, pedida por el usuario el 26/10): 6d.1 (convenios, jornal del taller, chofer, Sindicatos a pagar) hecha el 28/10 y 6d.2 (Gerencia autoriza o devuelve la liquidación, SoD-11) el 29/10, con paridad (falta aplicar sus seis migraciones) |
| D14 | Fase 7: libros IVA y posición mensual, calendario de obligaciones, logística de entregas y tablero de control | En curso (diseño en `docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md`, 26/10): 7a (libros IVA y declaración de IVA) hecha el 27/10, con paridad; antes de la 7b va la 6d (convenios colectivos, pedida por el usuario: hecha el 28 y el 29/10); 7b (ingresos brutos con percepciones y retenciones, y calendario de vencimientos) hecha el 29/10, con paridad; 7c.1 (transportistas y vehículos) hecha el 29/10, con paridad; 7c.2 (hojas de ruta y estado de entrega de los remitos) hecha el 29/10, con paridad: la 7c está completa; la 7d (tablero de control) pasa a después de la 8f, para nacer con los indicadores del banco y del fisco |
| D15 | Fase 8, banco y fisco operados por estudiantes (pedido del usuario el 29/10: que la isla de bancos y organismos fiscales opere esas lógicas con realismo; diseño en `docs/FASE_8_BANCO_Y_FISCO.md`): 8a cuenta, órdenes y extracto del banco con la conciliación; 8b cargos del mes y cheques; 8c préstamos; 8d padrón, puntos de venta y autorización de facturas; 8e recepción de declaraciones, cuenta corriente tributaria y pago por el banco; 8f domicilio fiscal electrónico e intimaciones; cada entidad, en modo automático o operada por la isla 9. Al final, 8g: escenarios con consignas, criterios de logro y progreso por isla | Pendiente: sigue la 8a |
| D16 | Módulo **fisco simulado** (pedido del usuario el 27/10, al estilo de AFIP/ARCA) | Pasa a la Fase 8 (8d a 8f, D15). Referencia analizada el 29/10: TRIBUT.AR (`juanjmg1436/tributar2026nuevo`, app de GEST-AR): se toman sus conceptos y reglas validadas, no su código |

## Reglas para quien ejecute el plan

- Trabajar en el worktree `C:\Proyectos\GESTAR-ERP-supabase`. No tocar cambios sin commitear de otros.
- Nada de push, merge a `main` ni cambios en el Supabase real sin autorización explícita del usuario.
- Las migraciones ya aplicadas no se editan: cada cambio va en una migración nueva.
- En esta PC (3,8 GB de RAM) las pruebas corren con `--maxWorkers=2`. Nunca "arreglarlas" quitando configuración.
- Las decisiones docentes (por ejemplo, el plan de cuentas) se proponen y las valida el usuario.
