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
- `src/lib/domain/catalog.ts`: roles, permisos, estados, transiciones, reglas de tareas y etiquetas. `types.ts`: tipos (espejo de DATABASE.md).
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

- `main`: calidad base (ESLint, Prettier, Vitest, CI) + contraseñas, perfil y `/admin` (Tareas 1 y 2-P0 de `docs/PROMPT_CONTINUACION.md`).
- Rama `mejoras/pendientes-mvp` (03/10/2026, sin mergear ni subir): página de notificaciones, exportación CSV con permiso `*.export`, datos de la escuela en `/admin/escuela`, cierre de sesión por inactividad, carga diferida de pantallas, alta masiva de estudiantes (H-21), crear empresa desde la plantilla (H-20) y etiquetas accesibles en formularios. 63 pruebas.
- Supabase: proyecto de desarrollo `sapsimulado` (ref `iullbntntmfvsodrqjze`, organización "juanmanuelgomez143620's Org"). Claves públicas en `.env.local`. MCP limitado a ese proyecto en `.mcp.json` (`supabase-integrar`); necesita iniciar sesión con `/mcp`. Pendiente: desactivar el registro público en Auth.
- Rama `mejoras/supabase-base` (sobre `pendientes-mvp`, sin mergear ni subir; worktree en `C:\Proyectos\GESTAR-ERP-supabase`): Tarea 5 completa sin conexión: migraciones con RLS, una RPC por `cmd*`, una función de lectura por consulta (paridad comprobada contra el simulador), plantilla y empresas por curso, Edge Function de cuentas y adaptador de la interfaz. 176 pruebas (PGlite en vez de pgTAP: no hay Docker).
- Rama `mejoras/revision-modulos` (en `C:\Proyectos\GESTAR-ERP`, cambios SIN commitear de otra sesión: validaciones del simulador y la interfaz). Al integrarla, ajustar las lecturas SQL a su nueva semántica (stock sin `stock.read`, tablero filtrado por permiso, saldo disponible de una SC) hasta que `reads.test.ts` pase.
- Siguiente: aplicar las migraciones al proyecto y desplegar la función (pasos en `supabase/README.md`), prueba de humo con `VITE_BACKEND=supabase`. Tarea 4: revisar 1366/768/375 px y contraste.
