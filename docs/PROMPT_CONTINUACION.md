# Prompt para continuar y mejorar INTEGR-AR

Sos un desarrollador full stack senior, especialista en sistemas ERP y en software educativo. Vas a **continuar y mejorar** INTEGR-AR, un ERP educativo que ya está iniciado y funcionando.

## Carpeta de trabajo (destino)

**`C:\Proyectos\GESTAR-ERP`**

- Trabajá únicamente dentro de esa carpeta. Es un repositorio git (rama `main`, commit inicial `e6faa6b`).
- Antes de modificar código, creá una rama: `git checkout -b mejoras/<tema>`. No hagas push ni crees repositorios remotos sin autorización.
- No uses la carpeta vieja `C:\Users\juanj\OneDrive\Desktop\SAP SIMULADO`: quedó obsoleta.
- No modifiques GEST-AR (`C:\Users\juanj\OneDrive\Desktop\PROYECTOS DE CLAUDE\GEST-AR`) ni ningún otro proyecto.

## Qué es el proyecto

INTEGR-AR es una aplicación de la **familia GEST-AR**, propiedad del autor, para 4.º, 5.º y 6.º año de la **Escuela Normal Superior N.º 9**, orientación Gestión y Administración de las Organizaciones. Simula una PYME industrial y comercial ficticia, **Forestal del Norte SRL**, que fabrica muebles en Misiones. Los estudiantes trabajan en islas por sector sobre una misma base de datos. Una operación nace en un sector y continúa en otro:

Producción/Depósito → solicitud de compra → Compras → orden de compra → aprobación → recepción → stock.

Otras escuelas podrán comprar una **instancia propia**: el mismo código, con base de datos independiente.

## Leé primero, en este orden

1. `README.md`
2. `ARCHITECTURE.md`, sobre todo §6 (núcleo), §7 (backend) y §7.9 (backend simulado)
3. `DATABASE.md`
4. `MVP.md`
5. `docs/FLUJO_COMPRAS.md`, `docs/ROLES_Y_PERMISOS.md`, `docs/DISENO_UI.md`, `docs/INSTANCIAS.md`, `docs/GLOSARIO.md`

## Estado actual

- **Stack:** React 19, Vite 8, TypeScript 7 (`tsc` nativo), Tailwind CSS 4, shadcn/ui (base Radix, preset nova), Lucide, TanStack Query 5, React Router 7, React Hook Form, Zod 4, sonner. Tipografía Inter empaquetada localmente.
- **Backend:** todavía **simulado en el navegador** (localStorage), con el mismo contrato que tendrán las funciones RPC de Supabase. La base de datos real se integra después.
- **Mapa de archivos clave:**
  - `src/lib/domain/types.ts`: tipos de dominio (espejo de DATABASE.md).
  - `src/lib/domain/catalog.ts`: roles, permisos, matriz rol→permiso, tipos y estados de documento, transiciones, reglas de tareas y etiquetas.
  - `src/lib/mock/engine.ts`: motor de negocio. Las funciones `cmd*` equivalen a las RPC; valida permisos, estados y separación de funciones, mueve stock con PPP y registra tareas, notificaciones y auditoría.
  - `src/lib/mock/queries.ts`: modelos de lectura.
  - `src/lib/mock/db.ts`: almacenamiento con escritura "todo o nada" y sincronización entre pestañas. Contiene `DB_VERSION`.
  - `src/lib/mock/seed.ts`: datos demo (20 productos, 10 proveedores, 10 clientes, 12 usuarios, stock inicial y un circuito completo de ejemplo). Incluye `DEMO_PASSWORD`.
  - `src/lib/api/index.ts`: **único contrato** que usa la interfaz (`api`, `commands`, `auth`, `realtime`).
  - `src/app/`: router, sesión, contexto de empresa, menú y AppShell.
  - `src/features/`: pantallas por funcionalidad.
  - `src/components/common/`: DataTable, StatusBadge, PageHeader, AuditTimeline, DocumentFlow, diálogos y selectores.
- **Ya funciona:**
  - ingreso con accesos de demostración por isla;
  - tablero por rol y bandeja "Mi trabajo";
  - notificaciones en vivo entre pestañas;
  - solicitudes de compra (incluso creadas desde una alerta de stock mínimo);
  - órdenes de compra con aprobación por monto: hasta $ 500.000 aprueba otro integrante de Compras, por encima aprueba Gerencia;
  - separación de funciones;
  - rechazo, reapertura y reenvío;
  - recepción total o parcial y anulación con contramovimiento;
  - stock, kardex y PPP;
  - ajustes de stock;
  - flujo documental, historial y auditoría con exportación CSV;
  - documentos imprimibles;
  - maestros (clientes, proveedores, productos);
  - panel docente: roles, módulos, control interno, actividad y reinicio de datos;
  - vista adaptable a notebook, tablet y teléfono.
- **Entorno:** Windows 11, PowerShell, Node 20.20, npm 10. Comandos: `npm install`, `npm run dev` (http://localhost:5173), `npm run typecheck`, `npm run build`.

## Reglas que no se negocian

1. La interfaz usa **sólo** `src/lib/api`. Nunca importa `src/lib/mock` directamente.
2. Las reglas de negocio viven en el motor (`engine.ts`, luego en las RPC), nunca en los componentes. La interfaz sólo oculta o explica acciones; el motor es la autoridad.
3. Estados, transiciones, permisos y reglas de tareas se definen en los catálogos, no en código disperso.
4. Si cambiás la forma de los datos o el seed, incrementá `DB_VERSION` en `src/lib/mock/db.ts`.
5. Una instancia por escuela y un solo código: nada propio de la ENS N.º 9 escrito en el código, fuera de los datos de configuración y demostración.
6. No copiar SAP: ni interfaz, ni código, ni marcas, ni nombres de módulos.
7. Interfaz en español rioplatense con voseo. Identificadores técnicos en inglés. Paleta GEST-AR: marino `#1C2B4A`, azul `#185FA5`, celeste `#E8F1FA`. Estética enterprise sobria: sin emojis, sin gamificación, sin animaciones innecesarias.
8. Todo documento imprimible lleva la leyenda exacta "DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL" y nunca imita comprobantes oficiales (sin CAE ni QR fiscales).
9. Estudiantes menores de edad: sólo nombre, apellido y usuario. Todos los datos son ficticios.
10. Sin servicios pagos, sin claves en el repositorio y sin conectarse a proyectos remotos de Supabase sin autorización.
11. Evitá la sobreingeniería: lo van a usar estudiantes reales en un aula.

## Tareas, en este orden

### 1. Calidad base

- **ESLint** (flat config, reglas de React Hooks) y **Prettier**, con scripts `lint` y `format`; corregí los hallazgos. Si typescript-eslint no es compatible con TypeScript 7, usá reglas sin información de tipos o una versión 5.x de TypeScript sólo para el lint, y explicá la decisión.
- **Vitest** con pruebas del motor. Trabajá sobre `buildSeed()` y las funciones `cmd*` directamente, sin pasar por `db.ts` ni localStorage. Cubrí:
  - circuito completo SC → OC → aprobación → envío → recepción;
  - aprobación por monto: hasta $ 500.000 aprueba Compras (otro usuario); más de $ 500.000 aprueba Gerencia;
  - separación de funciones: quien crea una OC no la aprueba, y quien confirma una recepción no la anula;
  - recepción parcial, tarea por el saldo y recepción del saldo;
  - no se puede ordenar ni recibir más de lo pendiente;
  - stock negativo bloqueado;
  - PPP correcto;
  - invariante: el saldo es igual a la suma de los movimientos;
  - anular una OC libera las SC asociadas y reabre la tarea de Compras;
  - cada transición deja un evento de auditoría con usuario, rol, sector y estados;
  - un usuario sin permiso no puede ejecutar el comando.
- **GitHub Actions**: workflow con typecheck, lint, test y build. Dejalo listo aunque todavía no exista el repositorio remoto.

### 2. Completar lo pendiente del MVP

Ver `MVP.md` §2 y §5.

- Pantalla `/admin` para el rol ADMIN: datos de la escuela (`school_settings`), cursos y alta de docentes.
- Cambio de contraseña obligatorio en el primer ingreso (`must_change_password`) y pantalla de perfil.
- Página completa de notificaciones (`/e/:empresa/notificaciones`) con filtro de leídas y no leídas.
- Exportación CSV de clientes, proveedores, productos y stock, respetando los permisos `*.export`.
- Cierre de sesión por inactividad configurable, pensado para PCs compartidas.

### 3. Rendimiento

- Carga diferida de rutas (`React.lazy` y `Suspense`) para achicar el paquete inicial, que hoy pesa ~914 KB sin comprimir.

### 4. Pulido de experiencia de uso y accesibilidad

- Revisá cada pantalla a 1366, 768 y 375 px de ancho: sin desbordes horizontales, tablas legibles, foco visible, contraste AA.
- Estados vacíos que enseñen qué hace cada sector y mensajes de error claros.
- Seguí `docs/DISENO_UI.md`.

### 5. Preparar la integración con Supabase, sin conectarla

- En `supabase/migrations/`, escribí las migraciones según `DATABASE.md`: orden de §17, políticas RLS de §11 y una función RPC por cada `cmd*` del motor (correspondencias en `ARCHITECTURE.md` §7.9), con los mismos códigos de error de negocio.
- En `supabase/tests/database/`, escribí pruebas pgTAP de aislamiento entre empresas, permisos, transiciones y separación de funciones.
- Creá `src/lib/api/supabase-adapter.ts` con la misma interfaz que el adaptador simulado, seleccionable por variable de entorno y **desactivado por defecto**.

## Forma de trabajo

- Antes de cada tarea, mostrá un plan breve. Si la tarea implica una decisión de negocio o docente (ver `ARCHITECTURE.md` §18), detenete y preguntá.
- Hacé commits chicos en español, uno por mejora.
- Después de cada tarea, ejecutá `npm run typecheck`, `npm run lint`, `npm test` y `npm run build`.
- Levantá `npm run dev` y probá en el navegador el circuito SC → OC → aprobación → recepción → stock cambiando de usuario: Depósito, Compras 1, Gerencia y otra vez Depósito. Probá también que el creador de una OC no pueda aprobarla.
- Actualizá la documentación afectada: README, `ARCHITECTURE.md` §7.9, MVP y ROADMAP.

## Entregable al terminar

Un resumen en español con:

- qué cambiaste, commit por commit;
- cómo probarlo;
- qué quedó pendiente;
- los riesgos que detectaste;
- las decisiones que necesitás del autor.
