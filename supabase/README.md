# Base de datos (Supabase)

Migraciones, permisos (RLS) y funciones RPC de INTEGR-AR. Todavía **no están aplicadas** a ningún proyecto: la interfaz sigue usando el backend simulado (`src/lib/mock`), que es la especificación ejecutable de estas reglas.

## Estructura

| Carpeta | Contenido |
|---|---|
| `migrations/` | Migraciones en orden (formato de la CLI de Supabase). La de catálogos se **genera** desde `src/lib/domain/catalog.ts` con `npm run db:catalog`: no se edita a mano. |
| `tests/` | Pruebas de la base con [PGlite](https://pglite.dev) (PostgreSQL embebido): corren con `npm test`, en local y en CI, sin Docker. |
| `tests/support/supabase-shim.sql` | Imitación mínima de Supabase (roles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()`) con sus permisos por defecto, que exponen todo lo de `public`: las pruebas verifican que las migraciones lo cierren. |

## Decisiones de diseño

- **Toda escritura pasa por funciones RPC** (`security definer`). Los usuarios sólo tienen permiso de lectura sobre las tablas, filtrado por RLS: nadie puede modificar datos, roles ni su propio perfil desde el navegador.
- **Las reglas son las del motor simulado**, que se corrigió después de escribir DATABASE.md: ADMIN (administración escolar) no ve ni opera las empresas; sólo SUPERADMIN y el rol DOCENTE son supervisores; el perfil tiene que estar activo en cada pedido.
- **Roles identificados por código** (`COMPRAS`, `GERENCIA`…), no por uuid: es el mismo identificador que usa la interfaz.
- **Errores de negocio** con `SQLSTATE P0001`: el código estable (`SIN_PERMISO`, `SEPARACION_FUNCIONES`…) viaja en `details`, el mensaje para el estudiante en `message` y la pista en `hint`.
- **Alta de usuarios**: el perfil nace con el usuario de Auth, y el rol de la aplicación sale **sólo** de `raw_app_meta_data` (lo escribe el servidor). Los metadatos que elige el propio usuario al registrarse se ignoran.
- **Pruebas con PGlite en vez de pgTAP**: la PC de desarrollo no tiene Docker. Las mismas pruebas corren en GitHub Actions.

## Aplicar a un proyecto

1. Iniciar sesión en el MCP `supabase-integrar` (`/mcp`, organización del proyecto) o vincular la CLI (`npx supabase link`).
2. Aplicar las migraciones en orden (`npx supabase db push`, o una por una con el MCP).
3. Cargar la fila de `school_settings` de la escuela (procedimiento de alta en `docs/INSTANCIAS.md`).
4. Revisar los avisos de seguridad de Supabase (Security Advisor) y desactivar el registro público en Auth.
