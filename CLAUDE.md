# INTEGR-AR — guía para Claude

ERP educativo de la familia GEST-AR para 4.º–6.º año de la ENS N.º 9 (orientación Gestión y Administración). Simula la PYME ficticia Forestal del Norte SRL: cada isla de estudiantes opera un sector y una operación nace en un sector y sigue en otro (SC → OC → aprobación → recepción → stock). Una instancia por escuela, un solo código. Interfaz y documentación en español rioplatense con voseo; identificadores técnicos en inglés.

## Ahorro de contexto (leer primero)

- Al empezar o retomar, usá la skill `retomar`. No leas transcripciones de sesiones anteriores: el estado está acá abajo y en `git log`.
- No leas completos ARCHITECTURE.md (50 KB), DATABASE.md (49 KB), MVP.md ni ROADMAP.md: buscá el título con Grep (`^#{2,3} `) y leé sólo ese rango.
- Archivos grandes (`engine.ts` ~1950 líneas, `queries.ts` ~1000): ubicá la función con Grep (`export function cmdX`) y leé con offset/limit.
- Verificá con `npm run -s check` (tipos + lint + formato + pruebas, salida mínima). `npm run build` sólo al cerrar una tarea o si tocaste rutas, dependencias o configuración. Antes de commitear, skill `verificar`.
- En el navegador preferí `get_page_text` o `javascript_tool`; capturas sólo para revisar diseño.
- Shell: PowerShell. En este Windows el Bash del entorno no trae `head`, `find` ni `sort`.

## Comandos

`npm run dev` (http://localhost:5173; usuarios demo en /login, contraseña `demo1234`) · `npm run -s check` · `npm test` · `npm run build`

## Mapa del código

- `src/lib/api/index.ts`: único contrato de la interfaz (`api`, `commands`, `auth`, `realtime`). Implementa la demostración (simulador) y, con `VITE_BACKEND=supabase`, usa `supabase.ts` (RPC, Auth y Edge Function por `fetch`, misma forma de datos).
- `supabase/`: migraciones (escrituras y lecturas como RPC), Edge Function `admin-users` y pruebas en PGlite. Ver `supabase/README.md`. Si cambia una consulta o un comando del simulador, cambia su función SQL (las pruebas de paridad fallan si no).
- `src/lib/mock/engine.ts`: motor de negocio. Cada `cmd*` equivale a una RPC: valida permiso, estado y separación de funciones; mueve stock con PPP; registra tareas, notificaciones y auditoría.
- `src/lib/mock/queries.ts`: modelos de lectura (futuras consultas con RLS). Los `export*` exigen el permiso `*.export`.
- `src/lib/mock/db.ts`: almacenamiento local con `DB_VERSION` y `upgradeDatabase` (pasos `UPGRADES`). `seed.ts`: datos demo (`buildSeed()`).
- `src/lib/domain/catalog.ts`: roles, permisos, estados, transiciones, reglas de tareas y etiquetas. `types.ts`: tipos (espejo de DATABASE.md). `chart-of-accounts.ts`: plan de cuentas básico y saldos de apertura (a validar por el docente; la base los recibe con `npm run db:demo`).
- `src/app/`: router con carga diferida, sesión, empresa, menú (`modules.ts`), `AppShell`, `IdleLogout`.
- `src/features/<área>/`: pantallas. `src/components/common/`: DataTable, PageHeader, ExportCsvButton, diálogos, selectores.
- Pruebas: `src/lib/**/*.test.ts` (Vitest, entorno node) sobre `buildSeed()` y los `cmd*` directos, sin localStorage.

## Reglas que no se negocian

1. La interfaz usa sólo `src/lib/api`; nunca importa `src/lib/mock`.
2. Las reglas de negocio viven en el motor (después, en las RPC). La interfaz sólo oculta o explica.
3. Estados, transiciones, permisos, reglas de tareas y etiquetas van en los catálogos, no dispersos.
4. Si cambia la forma de los datos del mock: subir `DB_VERSION` y agregar el paso en `UPGRADES`.
5. Nada de la ENS N.º 9 escrito en el código (CA-15): va en `school_settings` o en los datos demo.
6. No copiar SAP: ni interfaz, ni código, ni marcas, ni nombres de módulos.
7. Paleta GEST-AR (marino `#1C2B4A`, azul `#185FA5`, celeste `#E8F1FA`), estética sobria: sin emojis ni gamificación.
8. Todo imprimible lleva "DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL" y nunca imita comprobantes oficiales.
9. Estudiantes menores: sólo nombre, apellido y usuario. Todos los datos son ficticios.
10. Sin claves en el repo (`.env.local` está ignorado), sin servicios pagos y sin tocar otros proyectos (GEST-AR ni matriculajuan23).
11. Sin sobreingeniería: lo usan estudiantes reales en un aula.

## Flujo de trabajo

- Rama `mejoras/<tema>` desde `main`; commits chicos en español (`feat:`, `fix:`, `perf:`, `test:`, `docs:`, `chore:`) que expliquen el porqué. Push y merge sólo con autorización.
- Mensajes de commit largos: escribirlos en un archivo y usar `git commit -F archivo` (en PowerShell, los here-strings pasados como argumento fallan).
- Las herramientas de escritura decodifican `\uXXXX`: para dejar el escape literal en el código, escribí `\\uFEFF`.
- Si la tarea implica una decisión de negocio o docente (ARCHITECTURE.md §18), preguntá antes.

## Estado (actualizar al cerrar cada sesión)

- **Ramas** (nada mergeado a `main` ni subido a GitHub): `main` ← `mejoras/pendientes-mvp` ← `mejoras/supabase-base` ← **`mejoras/integracion`**, la más completa (incluye `mejoras/revision-modulos`). Se trabaja en `mejoras/integracion`, en el worktree `C:\Proyectos\GESTAR-ERP-supabase`.
- **Módulos funcionando (Fase 1, MVP):** núcleo (ingreso, perfil, empresas, tareas, avisos, auditoría, impresión, exportación CSV, cierre por inactividad), maestros, compras (SC y OC con aprobación por monto y separación de funciones), depósito y stock (recepciones, ajustes, kardex con PPP), tablero, panel docente, administración escolar (docentes, cursos, datos y logo de la escuela), alta masiva de estudiantes y empresas por curso desde la plantilla. Pantallas sin desbordes a 375/768/1366 px y contraste AA.
- **Fase 2, Contabilidad (14/10, `docs/FASE_2_CONTABILIDAD.md`):** plan de cuentas (108 cuentas), ejercicios y períodos que Contabilidad cierra y el docente reabre, asientos (borrador → registrado con número correlativo; anulación con contraasiento), libro diario, mayor y sumas y saldos imprimibles, y asiento de apertura en la plantilla y en cada empresa de curso; simulador, pantallas y Supabase con paridad probada. Falta: que el docente valide el plan de cuentas y la apertura (§6 del diseño) y el motor de imputación (`posting_rules`). Banco de 30 proveedores y 30 clientes ficticios en `src/lib/mock/partner-bank.ts` (todavía sin usar).
- **Pruebas:** 221 con `npm run -s check`, entre ellas la paridad simulador↔base en lecturas y comandos (también los contables) y el aislamiento entre empresas (S01, que ahora falla si a una función nueva le falta un valor de prueba). En esta PC (3,8 GB de RAM) el chequeo usa `--maxWorkers=2`; si igual se queda sin memoria, cerrar Docker y WSL. Nunca "arreglar" las pruebas quitando Tailwind ni otra configuración.
- **Supabase** (proyecto `sapsimulado`, ref `iullbntntmfvsodrqjze`; verificado el 13/10 con lecturas públicas): migraciones aplicadas hasta la del logo, plantilla cargada, registro público desactivado, Edge Function `admin-users` desplegada; cuentas `soporte2` (SUPERADMIN) y `admin2` (ADMIN). Falta: aplicar `20261013120000_alta_de_usuarios_segura.sql` (la versión anterior del alta podía tomar el rol de los metadatos del usuario) y las cuatro de Contabilidad (`20261014120000` a `20261014120300`), revisar los perfiles creados con la versión anterior del alta, la prueba de humo con `VITE_BACKEND=supabase` y rotar las claves.
- **Carpeta principal** (`C:\Proyectos\GESTAR-ERP`, rama `mejoras/revision-modulos`, ya integrada): tiene sin commitear un módulo nuevo, "Seguimiento y Evaluación" (12/10). Decidir su rama antes de seguir.
- **Diseño conversado, para después:** "entorno vivo" (proveedores, clientes, fisco simulados) con un banco de casos en plantillas y aprobación del docente; sin IA en vivo dentro de la app (las condiciones de la API de Gemini excluyen apps usadas por menores y la API gratuita de NVIDIA es sólo de prueba). La IA, si se usa, va afuera y se importa.
- **Siguiente** (`docs/PLAN_DE_ACCION.md`): con el usuario, aplicar las migraciones pendientes en Supabase y hacer la prueba de humo; subir las ramas a GitHub (con autorización); el motor de imputación (`posting_rules`, paso C5) y la Fase 3 (compras completo y tesorería).
