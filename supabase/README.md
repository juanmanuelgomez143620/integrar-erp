# Base de datos (Supabase)

Migraciones, permisos (RLS), funciones RPC y la Edge Function de cuentas de INTEGR-AR. Todavía **no están aplicadas** a ningún proyecto. La interfaz usa el backend simulado (`src/lib/mock`, la especificación ejecutable de estas reglas) salvo que se compile con `VITE_BACKEND=supabase`: entonces usa este backend a través de `src/lib/api/supabase.ts`, con el mismo contrato.

## Estructura

| Carpeta | Contenido |
|---|---|
| `migrations/` | Migraciones en orden (formato de la CLI de Supabase). Dos se **generan** y no se editan a mano: la de catálogos, desde `src/lib/domain/catalog.ts` (`npm run db:catalog`), y la de la empresa plantilla, desde el seed del backend simulado (`npm run db:demo`). |
| `seed.sql` | Datos para desarrollo local (`npx supabase db reset`): una escuela de demostración y la plantilla. |
| `functions/admin-users/` | Edge Function de cuentas: altas de estudiantes (individual y masiva), de docentes y restablecimiento de contraseñas, con la API de administración de Auth. La lógica (`handler.ts`) usa sólo APIs web estándar y se prueba en Node. |
| `tests/` | Pruebas de la base con [PGlite](https://pglite.dev) (PostgreSQL embebido): corren con `npm test`, en local y en CI, sin Docker. |
| `tests/support/supabase-shim.sql` | Imitación mínima de Supabase (roles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()`) con sus permisos por defecto, que exponen todo lo de `public`: las pruebas verifican que las migraciones lo cierren. |
| `tests/support/mock-loader.ts` | Copia un estado completo del simulador a la base de prueba: así cada lectura SQL se compara con la de `queries.ts` sobre los mismos datos (`reads.test.ts`). |
| `tests/support/fake-supabase.ts` | Imitación HTTP de PostgREST, Auth y la Edge Function sobre PGlite: prueba el adaptador de la interfaz y la función de punta a punta, sin red (`adapter.test.ts`, `admin-users.test.ts`). |

## Decisiones de diseño

- **Toda escritura pasa por funciones RPC** (`security definer`). Los usuarios sólo tienen permiso de lectura sobre las tablas, filtrado por RLS: nadie puede modificar datos, roles ni su propio perfil desde el navegador.
- **Las reglas son las del motor simulado**, que se corrigió después de escribir DATABASE.md: ADMIN (administración escolar) no ve ni opera las empresas; sólo SUPERADMIN y el rol DOCENTE son supervisores; el perfil tiene que estar activo en cada pedido.
- **Roles identificados por código** (`COMPRAS`, `GERENCIA`…), no por uuid: es el mismo identificador que usa la interfaz.
- **Errores de negocio** con `SQLSTATE P0001`: el código estable (`SIN_PERMISO`, `SEPARACION_FUNCIONES`…) viaja en `details`, el mensaje para el estudiante en `message` y la pista en `hint`.
- **Alta de usuarios**: el perfil nace con el usuario de Auth, y el rol de la aplicación sale **sólo** de `raw_app_meta_data` (lo escribe el servidor). Los metadatos que elige el propio usuario al registrarse se ignoran.
- **Pruebas con PGlite en vez de pgTAP**: la PC de desarrollo no tiene Docker. Las mismas pruebas corren en GitHub Actions.
- **Las lecturas también son funciones** (`security definer`) con la misma exigencia de permiso que el simulador: cada una decide qué campos devuelve y en qué orden (códigos en orden de bytes con `collate "C"`, nombres sin acentos con `private.sort_key`), así la interfaz recibe exactamente lo mismo.
- **Las contraseñas nunca pasan por la base**: la Edge Function valida con la sesión de quien opera (`*_check`, `students_plan`), crea o modifica la cuenta en Auth y recién entonces registra membresía y auditoría (`*_register`, `member_password_reset`). Si Auth falla a mitad de un alta masiva, borra las cuentas ya creadas. Sólo se restablece la contraseña de estudiantes.
- **La plantilla sale del seed simulado**: Forestal del Norte SRL tiene en la base la misma estructura, los mismos maestros y el mismo inventario inicial que la demo local (una prueba lo compara). Las empresas de los cursos se crean con `company_create_from_template`, igual que `cmdCreateCompanyFromTemplate`.

## Qué cubre

| Parte | Estado |
|---|---|
| Escuela, perfiles, cursos, empresas, membresías, permisos efectivos | Listo |
| Maestros (clientes, proveedores, productos) con auditoría | Listo |
| Circuito de compras completo (SC, OC con aprobación, REC, AJS), kardex con PPP, tareas, notificaciones | Listo |
| Empresa plantilla y empresas por curso | Listo |
| Lecturas: una función por cada consulta de `queries.ts`, con paridad comprobada usuario por usuario | Listo |
| Cuentas: altas de estudiantes y docentes, restablecer contraseña (Edge Function `admin-users`) | Listo |
| Adaptador de la interfaz (`src/lib/api/supabase.ts`): sesión con Auth, RPC, cuentas, sondeo cada 20 s | Listo |
| Logo de la escuela (Storage), Realtime opcional | Pendiente |

**Cómo se mantiene la paridad:** si se cambia una consulta o un comando del simulador, hay que cambiar su función SQL; `reads.test.ts` y `adapter.test.ts` fallan si no coinciden.

## Aplicar a un proyecto

1. Iniciar sesión en el MCP `supabase-integrar` (`/mcp`, organización del proyecto) o vincular la CLI (`npx supabase link`).
2. Aplicar las migraciones en orden (`npx supabase db push`, o una por una con el MCP).
3. Cargar la fila de `school_settings` de la escuela (procedimiento de alta en `docs/INSTANCIAS.md`) y la empresa plantilla: `select private.seed_demo_company();` (idempotente).
4. Auth: desactivar el registro público y la confirmación por email (las cuentas las crea la Edge Function, ya confirmadas). Revisar los avisos de seguridad (Security Advisor).
5. Desplegar la función: `npx supabase functions deploy admin-users`. Si el proyecto usa las claves nuevas, cargar los secretos `SUPABASE_PUBLISHABLE_KEY` y `SUPABASE_SECRET_KEY`; si se usa un dominio de cuentas propio, `AUTH_EMAIL_DOMAIN` (el mismo que `VITE_AUTH_EMAIL_DOMAIN`).
6. Crear la cuenta `SUPERADMIN` de soporte y la `ADMIN` de la escuela. Desde el panel de Auth el usuario nace **pendiente** (inactivo y sin rol), porque el panel no carga los datos del servidor. Se completa con SQL y el perfil se activa solo:
   `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"username":"admin2","first_name":"…","last_name":"…","app_role":"ADMIN"}' where email = 'admin2@cuentas.integrar.invalid';`
   El rol sale sólo de `raw_app_meta_data`: nunca de los metadatos que elige el usuario.
7. Sitio: `VITE_BACKEND=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` y, si corresponde, `VITE_AUTH_EMAIL_DOMAIN`.
8. Prueba de humo (`docs/INSTANCIAS.md` §6, paso 7): ingresar, crear la empresa de un curso, alta masiva de estudiantes y un circuito corto de compra. Verificar en especial que Auth acepte el dominio de las cuentas y que el perfil nazca con sus datos.
