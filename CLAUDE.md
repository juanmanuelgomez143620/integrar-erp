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

- **Publicado (16/10):** repo **público** `juanmanuelgomez143620/integrar-erp` con todas las ramas; `main` llega hasta la Fase 3b y cada cambio en `main` se publica solo en **https://juanmanuelgomez143620.github.io/integrar-erp/** (`.github/workflows/pages.yml`), conectado a Supabase por las variables del repositorio (sin `VITE_BACKEND` vuelve a ser la demostración). El usuario además publica `main` en **Vercel** (https://integrar-erp.vercel.app, proyecto `gomezjuanmanuel1436-2119/integrar-erp`): `vercel.json` manda toda ruta a `index.html` (sin eso, recargar `/login` daba 404) y sus variables de entorno se cargan en el panel de Vercel (sin ellas es la demostración). Se trabaja en `mejoras/integracion` (worktree `C:\Proyectos\GESTAR-ERP-supabase`), que se sube como respaldo; `main` se actualiza al cerrar cada fase (eso la publica). `gh` tiene dos cuentas y la activa (`juanjmg1436`) no puede escribir en el repo: usar el token de `juanmanuelgomez143620` (`gh auth token --user …`) sin cambiar la cuenta activa.
- **Módulos funcionando (Fase 1, MVP):** núcleo (ingreso, perfil, empresas, tareas, avisos, auditoría, impresión, exportación CSV, cierre por inactividad), maestros, compras (SC y OC con aprobación por monto y separación de funciones), depósito y stock (recepciones, ajustes, kardex con PPP), tablero, panel docente, administración escolar (docentes, cursos, datos y logo de la escuela), alta masiva de estudiantes y empresas por curso desde la plantilla. Pantallas sin desbordes a 375/768/1366 px y contraste AA.
- **Fase 2, Contabilidad (14/10, `docs/FASE_2_CONTABILIDAD.md`):** plan de cuentas (108 cuentas), ejercicios y períodos que Contabilidad cierra y el docente reabre, asientos (borrador → registrado con número correlativo; anulación con contraasiento), libro diario, mayor y sumas y saldos imprimibles, y asiento de apertura en la plantilla y en cada empresa de curso; simulador, pantallas y Supabase con paridad probada. Falta: que el docente valide el plan de cuentas y la apertura (§6 del diseño). Banco de 30 proveedores y 30 clientes ficticios en `src/lib/mock/partner-bank.ts` (todavía sin usar).
- **Fase 3a, compras completo (15/10, `docs/FASE_3_COMPRAS_Y_TESORERIA.md`):** imputación automática por reglas (`posting_rules`, pantalla para Contabilidad), factura de proveedor `FP` contra lo recibido (letra A con IVA crédito fiscal, C con IVA al costo; vence según el plazo de la OC) que al registrarse genera el asiento de compra, anulación con contraasiento y cuentas corrientes de proveedores; simulador (DB v4), pantallas y Supabase con paridad. Falta: que el docente valide las reglas de imputación.
- **Fase 3b, tesorería (16/10):** cajas y bancos (las cuentas del rubro 1.1.01, saldo del mayor) y orden de pago `OP` (Contabilidad o Tesorería la prepara reservando el saldo de cada factura, Gerencia la aprueba, Tesorería la paga si alcanza el saldo: asiento automático `PAGO` y la factura pasa a pagada; anulación con contraasiento; SoD-5 y SoD-7); cuenta corriente con los pagos; simulador (DB v5), pantallas, impresión y Supabase con paridad.
- **Fase 3c, cotizaciones (18/10, `docs/FASE_3_COMPRAS_Y_TESORERIA.md` §6):** solicitud de cotización `SCT` a dos o más proveedores (a mano o desde una SC, botón "Pedir cotizaciones"), cotización `COT` por proveedor invitado (quien no es responsable inscripto cotiza el precio final, sin IVA), cuadro comparativo por costo para la empresa (el neto) con la más conveniente marcada, y adjudicación (acción `AWARD`, permiso `rfq.award`, Compras) que genera la OC en borrador con precios y condiciones de la cotización; si no es la más conveniente, se justifica. Simulador (DB v6, demo con `SCT-00001` y dos cotizaciones), pantallas (`src/features/purchasing/quotations/`), impresión con el cuadro y Supabase con paridad.
- **Fase 3d.1, transferencias y flujo de fondos (19/10, §7 del diseño):** transferencia entre cajas y bancos `TF` (Tesorería; al confirmarse controla el saldo del origen y genera el asiento automático `TRANSFERENCIA`; se anula con contraasiento si los fondos siguen en el destino; demo con `TF-00001` en borrador) y "Flujo de fondos" (`pagos/flujo-de-fondos`): real por período, por concepto según el documento que originó cada asiento, y proyectado con los vencimientos de las facturas por tramo y el aviso de falta de fondos. Simulador, pantallas, impresión y Supabase con paridad. Sigue la 3d.2 (cheques propios y conciliación bancaria).
- **Sin aplicar en Supabase:** las migraciones de la 3c (`20261018120000`, `…120100`) y de la 3d.1 (`20261019120000`, `…120100`); `main` sigue en la 3b. Antes de llevar `mejoras/integracion` a `main` hay que aplicarlas en orden (con autorización y un token nuevo del usuario, o `supabase db push` desde su PC).
- **Pruebas:** 267 con `npm run -s check`, entre ellas la paridad simulador↔base en lecturas y comandos (también los contables) y el aislamiento entre empresas (S01, que ahora falla si a una función nueva le falta un valor de prueba). En esta PC (3,8 GB de RAM) el chequeo usa `--maxWorkers=2`; si igual se queda sin memoria, cerrar Docker y WSL. Nunca "arreglar" las pruebas quitando Tailwind ni otra configuración.
- **Supabase** (proyecto `sapsimulado`, ref `iullbntntmfvsodrqjze`; el conector de Supabase de la sesión es de otra organización y no lo ve): el 16/10 se aplicaron las 14 migraciones pendientes con un token personal del usuario por la Management API, cada una en su transacción y registrada con la versión de su archivo (32 en el historial, como `supabase db push`); verificado: plan de cuentas, ejercicio y apertura en la plantilla, reglas de imputación y RPC nuevas; asesor de seguridad sin errores (los avisos son las RPC `security definer` del diseño; opcional, la protección de contraseñas filtradas de Auth). Edge Function `admin-users` sin cambios desde su despliegue (CORS `*`). Cuentas `soporte2` (SUPERADMIN) y `admin2` (ADMIN, debe cambiar la contraseña), con el rol correcto. Falta: la prueba de humo con cuentas reales (la hace el usuario en el sitio publicado), que el usuario revoque el token personal que pasó por el chat y rote las claves del proyecto. Un proyecto gratis se pausa por inactividad: si el host deja de resolver, está pausado.
- **Carpeta principal** (`C:\Proyectos\GESTAR-ERP`, rama `mejoras/revision-modulos`, ya integrada): tiene sin commitear un módulo nuevo, "Seguimiento y Evaluación" (12/10). Decidir su rama antes de seguir.
- **Diseño conversado, para después:** "entorno vivo" (proveedores, clientes, fisco simulados) con un banco de casos en plantillas y aprobación del docente; sin IA en vivo dentro de la app (las condiciones de la API de Gemini excluyen apps usadas por menores y la API gratuita de NVIDIA es sólo de prueba). La IA, si se usa, va afuera y se importa.
- **Siguiente** (`docs/PLAN_DE_ACCION.md`): aplicar en Supabase las migraciones de la 3c y llevar `mejoras/integracion` a `main` (con autorización); la prueba de humo del usuario en el sitio publicado; la Fase 3d (transferencias, cheques, conciliación y flujo de fondos). Con cada migración nueva: aplicarla también en Supabase (con autorización) antes de actualizar `main`, porque `main` se publica contra la base real.
