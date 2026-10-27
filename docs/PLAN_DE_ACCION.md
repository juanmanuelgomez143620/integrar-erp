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
| D13 | Fase 6: legajos, novedades del mes, liquidación simulada con recibo, asiento de sueldos y pago por Tesorería; con los sueldos reales, la mano de obra sub- o sobreaplicada de la Fase 5 | Hecha (diseño en `docs/FASE_6_RRHH_Y_SUELDOS.md`): 6a, 6b y 6c (24/10 a 26/10, con paridad; falta aplicar sus doce migraciones en Supabase) |
| D14 | Fase 7: libros IVA y posición mensual, calendario de obligaciones, logística de entregas y tablero de control | En curso (diseño en `docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md`, 26/10): 7a (libros IVA y declaración de IVA) hecha el 27/10, con paridad; antes de la 7b va la 6d (convenios colectivos, pedida por el usuario); siguen 7b (ingresos brutos y vencimientos), 7c (logística) y 7d (tablero de control) |
| D15 | Fase 8: motor de escenarios con consignas, criterios de logro y progreso por isla | Pendiente |
| D16 | Módulo **fisco simulado** (pedido del usuario el 27/10: la simulación del organismo recaudador, al estilo de AFIP/ARCA), en la misma base que la facturación para que todo se cruce solo: padrón de contribuyentes ficticio (CUIT y condición frente al IVA de clientes, proveedores y la empresa); autorización simulada de cada factura de venta al registrarla; "comprobantes emitidos y recibidos" del lado del fisco, que cruza lo que declaró la empresa con lo que facturaron sus proveedores; presentación de las declaraciones (IVA, ingresos brutos y cargas sociales) con su constancia; cuenta corriente tributaria con vencimientos, pagos, saldo a favor e intereses por mora (a validar); retenciones y percepciones según el padrón. Referencia: el repositorio del usuario de tribut.ar (pedirle el enlace al empezar). Va después de la 7b, porque usa sus declaraciones. Límites de siempre: sin logos, formularios ni numeraciones oficiales (el código de autorización es simulado y lo dice) y con la leyenda de simulación | Pendiente |

## Reglas para quien ejecute el plan

- Trabajar en el worktree `C:\Proyectos\GESTAR-ERP-supabase`. No tocar cambios sin commitear de otros.
- Nada de push, merge a `main` ni cambios en el Supabase real sin autorización explícita del usuario.
- Las migraciones ya aplicadas no se editan: cada cambio va en una migración nueva.
- En esta PC (3,8 GB de RAM) las pruebas corren con `--maxWorkers=2`. Nunca "arreglarlas" quitando configuración.
- Las decisiones docentes (por ejemplo, el plan de cuentas) se proponen y las valida el usuario.
