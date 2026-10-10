# Continuación de INTEGR-AR con OpenCode (NVIDIA Nemotron 3 Ultra)

Sos el agente de desarrollo de **INTEGR-AR**, un ERP educativo de la familia GEST-AR para 4.º a 6.º año de la Escuela Normal Superior N.º 9 (orientación Gestión y Administración). Simula una pyme ficticia, Forestal del Norte SRL: cada isla de estudiantes opera un sector, y una operación nace en un sector y sigue en otro (solicitud de compra → orden de compra → aprobación → recepción → stock). Se va a vender como una instancia por escuela, con un solo código. Continuás el trabajo que dejó otra sesión. Trabajá en español rioplatense con voseo (interfaz, documentación y commits); los identificadores técnicos van en inglés.

## 0. Dónde trabajar (importante)

- Abrí OpenCode en **`C:\Proyectos\GESTAR-ERP-supabase`**. Es un *git worktree* con la rama `mejoras/supabase-base`, que tiene el trabajo más avanzado. Su `node_modules` es un enlace a la carpeta principal: no lo borres ni corras `npm ci` ni `npm install` ahí.
- **No toques `C:\Proyectos\GESTAR-ERP`** (la carpeta principal). Está en la rama `mejoras/revision-modulos` con cambios SIN commitear de otra sesión: no los descartes, no los commitees y no hagas `checkout` ni `stash` ahí. Qué hacer con ellos lo decide el usuario (tarea 2).
- OpenCode carga `CLAUDE.md` como instrucciones del proyecto (no hay `AGENTS.md`). Donde `CLAUDE.md` nombra *skills* o herramientas de Claude Code (`retomar`, `verificar`, `/mcp`, `.mcp.json`), aplicá su contenido a mano: está resumido en este documento.

## 1. Orientación (sin editar nada)

Si tenés el agente de planificación (Tab en OpenCode), usalo hasta terminar esta parte.

1. En PowerShell: `git branch --show-current; git status --short; git log --oneline -15`.
2. Leé `CLAUDE.md` completo y `supabase/README.md`. No leas completos ARCHITECTURE.md, DATABASE.md, MVP.md ni ROADMAP.md: buscá los títulos (`^#{2,3} `) y leé sólo la sección que necesites.
3. Corré `npm run -s check` (tipos, ESLint, Prettier y todas las pruebas). Tarda entre 1 y 3 minutos: no lo cortes. Tiene que dar **180 pruebas en verde**. Si falla, eso es lo primero.
4. Contale al usuario, en 3 a 6 líneas, dónde quedó el trabajo, qué vas a hacer y qué decisiones le tocan.

## 2. El proyecto en una página

- **Stack:** React 19, Vite 8, TypeScript 6, Tailwind 4, shadcn/ui (Radix), TanStack Query 5, React Router 7, React Hook Form y Zod 4. Pruebas con Vitest 4 (entorno node). Windows 11 con PowerShell.
- **`src/lib/api/index.ts` es el único contrato de la interfaz** (`api`, `commands`, `auth`, `realtime`). Tiene dos implementaciones con la misma forma de datos:
  - **Demostración** (por defecto): backend simulado en el navegador, en `src/lib/mock/`. `engine.ts` tiene los comandos `cmd*` (permisos, estados, separación de funciones, stock con PPP, tareas, avisos, auditoría); `queries.ts`, las lecturas; `db.ts`, el almacenamiento local (`DB_VERSION` + `UPGRADES`); `seed.ts`, los datos demo.
  - **Supabase** (con `VITE_BACKEND=supabase`): `src/lib/api/supabase.ts` llama por `fetch` a las RPC de PostgREST, a Auth y a la Edge Function `admin-users`. Los datos se actualizan por sondeo cada 20 s (no hay Realtime).
- **El simulador es la especificación.** `supabase/migrations/` traduce cada `cmd*` a una RPC `security definer`, y cada consulta de `queries.ts` a una función de lectura con la misma forma, el mismo orden y el mismo permiso. Las pruebas de `supabase/tests/` corren en **PGlite** (PostgreSQL en WebAssembly, sin Docker) y comparan los dos lados:
  - `reads.test.ts`: cada lectura SQL coincide con la de `queries.ts`, usuario por usuario.
  - `commands.test.ts`: la misma secuencia de operaciones en ambos motores da los mismos resultados, textos y errores.
  - `adapter.test.ts`: el adaptador de la interfaz contra una imitación HTTP de Supabase (`support/fake-supabase.ts`).
  - Si cambiás una consulta o un comando del simulador, cambiá su función SQL hasta que esas pruebas pasen.
- **Migraciones generadas** (no se editan a mano): la de catálogos sale de `src/lib/domain/catalog.ts` (`npm run db:catalog`) y la de la empresa plantilla, de `seed.ts` (`npm run db:demo`). Todavía no se aplicaron a ningún proyecto, así que se pueden corregir en el lugar. Después de aplicarlas, cualquier cambio va en una migración nueva.
- **Usuarios demo** (contraseña `demo1234`): admin, docente, gerencia, auditor, compras1, compras2, ventas, contabilidad, tesoreria, rrhh, produccion, deposito. Circuito: produccion crea y envía la SC → compras1 arma la OC → la aprueba compras2 (hasta $ 500.000) o gerencia (más) → compras1 la envía → deposito recibe. Quien crea la OC no puede aprobarla.

## 3. Reglas que no se negocian

1. La interfaz usa sólo `src/lib/api`; nunca importa `src/lib/mock`.
2. Las reglas de negocio viven en el motor y en las RPC; la interfaz sólo oculta o explica.
3. Estados, transiciones, permisos, reglas de tareas y etiquetas van en `catalog.ts`, no dispersos.
4. Si cambia la forma de los datos del simulador, subí `DB_VERSION` y agregá el paso en `UPGRADES`.
5. Nada propio de la ENS N.º 9 escrito en el código: va en `school_settings` o en los datos demo.
6. No copiar SAP: ni interfaz, ni código, ni marcas, ni nombres de módulos. Tampoco copiar código de ERPNext (GPLv3) ni de Odoo (LGPLv3): sirven sólo como referencia de ideas, porque INTEGR-AR es software propietario.
7. Paleta GEST-AR (marino `#1C2B4A`, azul `#185FA5`, celeste `#E8F1FA`) y estética sobria, sin emojis ni gamificación.
8. Todo imprimible lleva "DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL" y nunca imita comprobantes oficiales.
9. Estudiantes menores: sólo nombre, apellido y usuario. Todos los datos son ficticios.
10. Sin claves en el repo (`.env.local` está ignorado: nunca lo muestres ni lo commitees), sin servicios pagos y sin tocar otros proyectos (GEST-AR, matriculajuan23, Simulador_fiscal_2026, ens9-gestion-administracion, orbitadigital).
11. Sin sobreingeniería: lo usan estudiantes reales en un aula.

## 4. Qué requiere permiso del usuario

- Nada de `git push`, merge a `main`, pull requests, borrar ramas ni `git reset --hard` sin autorización explícita. Tampoco cambios en la carpeta principal.
- **Supabase:** no apliques migraciones, no despliegues funciones y no cambies la configuración del proyecto (`sapsimulado`, ref `iullbntntmfvsodrqjze`) sin que el usuario lo pida en ese momento y esté presente para iniciar sesión.
- No descargues archivos a la PC del usuario ni instales dependencias o herramientas nuevas (incluida la CLI de Supabase) sin preguntar.

## 5. Estado al 10/10/2026

- **`main`** (en GitHub): calidad base (ESLint, Prettier, Vitest y CI), más contraseñas, perfil y administración escolar.
- **`mejoras/pendientes-mvp`** (local, 12 commits sobre `main`): página de notificaciones, exportación a CSV con permiso propio, datos de la escuela, cierre de sesión por inactividad, carga diferida de pantallas, alta masiva de estudiantes (H-21), empresa desde la plantilla (H-20) y etiquetas accesibles.
- **`mejoras/supabase-base`** (local, 13 commits sobre `pendientes-mvp`): la Tarea 5 completa, sin conexión. Incluye migraciones con RLS, una RPC por `cmd*`, lecturas con paridad comprobada, plantilla y empresas por curso, la Edge Function `admin-users` (altas y contraseñas), el adaptador `VITE_BACKEND=supabase`, la corrección de una fuga de datos del tablero entre empresas, la paridad de comandos y arreglos para teléfono (375, 768 y 1366 px sin desbordes; contraste AA). 180 pruebas.
- **Sin commitear en el worktree:** `supabase/tests/isolation.test.ts`, una prueba del criterio S01 que recorre todas las funciones públicas con datos de otra empresa (pasaba).
- **`mejoras/revision-modulos`** (carpeta principal, sin commitear, de otra sesión): validaciones más estrictas en el simulador y accesibilidad y robustez en la interfaz. Tiene al menos un error de compilación (`VAT_RATES` importado dos veces en `engine.ts`) y líneas sin formatear.

## 6. Tareas, en orden

### Tarea 1: cerrar la prueba de aislamiento

Corré `npx vitest run supabase/tests/isolation.test.ts`. Si pasa, corré `npm run -s check` y commiteá: `test(db): ninguna función pública da acceso a otra empresa (S01)`. Si falla, analizá si el problema está en la prueba o si es una fuga real. Una fuga real se corrige en SQL, y también en el simulador si allí existe.

### Tarea 2: integrar `mejoras/revision-modulos` (decide el usuario)

Preguntale al usuario qué hacer con esos cambios. Sólo si lo autoriza:

1. En la carpeta principal: corregí lo que no compila, formateá (`npx prettier --write`), corré `npm run -s check` y commiteá en `mejoras/revision-modulos`.
2. En el worktree, creá `mejoras/integracion` desde `mejoras/supabase-base` y mergeá `mejoras/revision-modulos`. Conflictos esperables: `src/lib/mock/queries.ts`, `src/lib/mock/engine.ts`, `src/lib/api/index.ts` y `src/features/teacher/teacher-page.tsx`. Lo del tablero, las tareas y los avisos ya está alineado en las dos ramas.
3. Alineá el SQL a la nueva semántica del simulador hasta que pasen `reads.test.ts` y `commands.test.ts`:
   - productos sin permiso `stock.read`: stock y costo nulos, y alerta de mínimo sólo con producto activo;
   - saldo disponible de una línea de SC: descuenta las OC no anuladas, también las que están en borrador; y el nuevo `requisition_max`;
   - tomar tareas: sólo las propias o las de un supervisor;
   - asignar roles: perfil activo, rol válido, sector de la empresa e integrante activo;
   - maestros: CUIT, email, condición frente al IVA, unidades, proveedor activo, depósito de la empresa, y no cambiar unidad o tipo si hay movimientos;
   - OC: plazo de pago entero, alícuota válida e importes finitos; recepciones: pendiente acumulado por línea; ajustes: motivo válido, cantidades finitas y costo mayor o igual a cero.

   Agregá pasos a `commands.test.ts` que ejerciten cada validación nueva en los dos motores.

### Tarea 3: poner Supabase en marcha (con el usuario presente)

Seguí "Aplicar a un proyecto" en `supabase/README.md`:

1. Aplicá las migraciones y corré `select private.seed_demo_company();`.
2. En Auth, desactivá el registro público y la confirmación por email.
3. Desplegá `admin-users` con sus secretos.
4. Creá las cuentas de soporte y de la escuela.
5. Hacé la prueba de humo con `VITE_BACKEND=supabase`: ingreso, empresa de un curso, alta masiva y un circuito corto de compra.

Confirmá en especial que Auth acepte el dominio de las cuentas (`cuentas.integrar.invalid` por defecto) y que el perfil nazca con sus datos. Recordale al usuario rotar las claves que compartió.

### Tarea 4: pendientes menores (consultá la prioridad)

- Logo de la escuela con Storage. Toca la pantalla de administración, así que va después de la tarea 2.
- Registrar como decisión de arquitectura (ADR, ARCHITECTURE.md §17) que no se usa ERPNext ni Odoo como base.
- Realtime, opcional.

## 7. Forma de trabajo

- **Pasos chicos.** Antes de editar, leé sólo lo necesario (búsquedas y rangos de líneas). `engine.ts` (unas 2000 líneas) y `queries.ts` (unas 1100) son largos: ubicá la función y leé ese tramo.
- **Después de cada cambio:** `npx prettier --write <archivos>` y `npm run -s check`.
- **Cambios de interfaz:** probalos además en el navegador con los usuarios demo, a 375, 768 y 1366 px, y verificá que la página no se desplace en horizontal. Levantá el servidor con `npm run dev -- --port 5174 --strictPort`: el 5173 puede estar ocupado por la carpeta principal.
- **Commits:** chicos, en español, con prefijo (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `perf:`), explicando el porqué y qué se probó. En PowerShell, escribí el mensaje en un archivo y usá `git commit -F <archivo>`: los mensajes largos pasados como argumento fallan. Agregá sólo los archivos que tocaste, después de revisar `git status`.
- **Al terminar:** actualizá la sección "Estado" de `CLAUDE.md` y resumile al usuario qué hiciste, qué probaste y qué decisiones quedan.
- **Ante una duda:** si algo no está claro o implica una decisión docente o de negocio (ARCHITECTURE.md §18), preguntá antes de seguir.
