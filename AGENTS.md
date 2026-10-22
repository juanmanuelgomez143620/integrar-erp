# Guía para otros agentes (OpenCode y similares)

Este proyecto se desarrolla con Claude Code, que usa `CLAUDE.md`. Esta guía es para seguir con otro agente o modelo (por ejemplo, OpenCode con DeepSeek o Nemotron) sin romper lo hecho.

## 1. Antes de empezar

Abrí el agente en **`C:\Proyectos\GESTAR-ERP-supabase`** (el worktree de `mejoras/integracion`), nunca en `C:\Proyectos\GESTAR-ERP`: esa carpeta tiene trabajo de otro agente. Si Claude Code dejó cambios sin commitear, los vas a ver ahí y no se duplica el trabajo.

1. Leé **`CLAUDE.md` completo**: reglas, arquitectura y la sección "Estado" (dónde quedó el trabajo).
2. Leé **`docs/PLAN_DE_ACCION.md`**: el primer paso que no dice "Hecho" es el que sigue.
3. Si vas a trabajar en una fase, leé su diseño (`docs/FASE_*.md`). Si todavía no existe, escribilo primero (§3).
4. Corré `git status` y `git log --oneline -10`. Si hay cambios sin commitear, mostráselos al usuario antes de tocarlos: pueden ser trabajo a medio hacer de Claude Code.

## 2. Reglas que no se negocian

- **Rama propia.** Trabajá en una rama creada desde `mejoras/integracion` (por ejemplo `opencode/fase-5`). Nunca hagas `git push`, ni merge o rebase de `main` o `mejoras/integracion`: eso lo revisa e integra Claude Code o el usuario.
- **Nada en la base real.** No uses `supabase db push` ni te conectes al proyecto publicado. Las pruebas usan una base en memoria (PGlite).
- **Migraciones.** No edites las que ya existen: cada cambio de SQL va en una migración nueva en `supabase/migrations/`.
- **No toques** `create-school-settings.sql` (no es de este trabajo), ni la carpeta `C:\Proyectos\GESTAR-ERP`, ni otros proyectos de la PC.
- **Secretos.** No leas ni muestres `.env.local` ni ninguna clave o token, y nunca los escribas en un archivo.
- **Sin SAP:** ni nombres, ni pantallas, ni código. Tampoco copies código de ERPNext ni de Odoo.
- **Menores de edad:** de los estudiantes, sólo nombre, apellido y usuario.
- **Impresos:** llevan la leyenda "DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL" y nunca imitan comprobantes oficiales (sin CAE, QR ni CAI).
- **Nada específico de la escuela en el código:** va en la configuración.
- **Decisiones docentes** (cuentas, porcentajes, plazos): se proponen y se marcan "(a validar)".

## 3. Cómo se trabaja

- **Primero el diseño, después el código.** Cada fase tiene un diseño corto en `docs/` (el formato de `docs/FASE_4_VENTAS_Y_CLIENTES.md`). Sin sobreingeniería.
- **Un solo contrato:** `src/lib/api/index.ts`. Hay dos implementaciones que tienen que dar exactamente lo mismo:
  - el simulador (`src/lib/mock/engine.ts` para los comandos y `queries.ts` para las lecturas), que es la especificación ejecutable;
  - Supabase (`supabase/migrations/*.sql`): una función RPC por comando, con los mismos mensajes de error, y lecturas que devuelven el mismo JSON.
- **Paridad:** `supabase/tests/` compara los dos lados (lecturas, comandos y aislamiento entre empresas). Si cambiás uno, cambiá el otro.
- **Catálogos** (estados, transiciones, permisos, tareas): en `src/lib/domain/catalog.ts`. Su SQL se genera con `npm run db:catalog`, no se edita a mano.
- **Textos:** en español rioplatense, claros para estudiantes de secundaria.
- **Antes de cada commit:** `npx prettier --write <archivos tocados>` y `npm run -s check` (tipos, lint, formato y todas las pruebas; tarda unos 5 minutos). Si algo falla, se arregla el código: nunca la configuración ni las pruebas para que pasen.
- **Commits** chicos, en español, con el porqué y lo que se probó.

## 4. Entorno de esta PC

- Windows y 3,8 GB de RAM. Las pruebas ya corren con `--maxWorkers=2`; no corras dos procesos pesados a la vez.
- **Demo local** (sin la base real, que todavía no tiene las migraciones nuevas), en PowerShell:
  `$env:VITE_BACKEND='mock'; npm run dev`.
  Usuarios: admin, docente, gerencia, auditor, compras1, compras2, ventas, contabilidad, tesoreria, rrhh, produccion y deposito. Contraseña: `demo1234` (sólo existe en el simulador).

## 5. Al terminar

Actualizá la sección "Estado" de `CLAUDE.md`: qué hiciste, qué falta y qué quedó "(a validar)". Dejá todo commiteado en tu rama, con `npm run -s check` en verde.
