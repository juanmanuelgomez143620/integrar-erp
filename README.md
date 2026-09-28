# INTEGR-AR · ERP educativo para el Aula Empresarial

> **Revisión de Fase 0 (26/09/2026):** el nuevo pedido de arquitectura se documenta en [docs/fase-0-2027/README.md](docs/fase-0-2027/README.md). Esa propuesta identifica diferencias con el prototipo existente; este documento conserva el contexto anterior y no implica que Supabase ya esté implementado.

> Aplicación de la **familia GEST-AR**. "INTEGR-AR" es su nombre de trabajo (D-01).

Sistema de gestión empresarial (ERP) **educativo y original**, desarrollado para 4.º, 5.º y 6.º año de la **Escuela Normal Superior N.º 9**, orientación en **Gestión y Administración de las Organizaciones**.

Si otra escuela lo adopta, recibe una **instancia propia**: la misma aplicación con base de datos, usuarios y configuración independientes ([docs/INSTANCIAS.md](docs/INSTANCIAS.md)).

Simula una PYME industrial y comercial —la empresa de demostración es **Forestal del Norte SRL**, fabricante de muebles de Misiones— en la que los estudiantes, organizados en islas de trabajo, ocupan puestos de distintos sectores y operan **sobre una misma base de datos**. Una solicitud que nace en Producción llega a Compras, se convierte en una orden que aprueba Gerencia, se recibe en Depósito y actualiza el stock: cada paso queda documentado, auditado y visible para el sector siguiente.

> **Aviso.** Proyecto con fines exclusivamente educativos. Los documentos generados son simulaciones **sin validez fiscal**. Todos los datos de empresas, personas, clientes y proveedores son ficticios. El sistema no está afiliado a ningún proveedor comercial de software de gestión ni reutiliza su código, interfaz o marcas.

## Estado

**Fase 1 — MVP en construcción** (septiembre 2026). La interfaz completa del circuito de compras ya funciona en local con un **backend simulado en el navegador** que aplica las mismas reglas que tendrá la base de datos:

- ingreso por usuario y accesos de demostración por isla;
- tablero por rol y bandeja "Mi trabajo";
- solicitud de compra → orden de compra → aprobación por monto con separación de funciones → recepción total o parcial → stock con kardex y PPP;
- notificaciones, flujo documental, auditoría, documentos imprimibles, maestros y panel docente.

La integración con Supabase (PostgreSQL, RLS, RPC) es el paso siguiente: ver [ARCHITECTURE.md §7.9](ARCHITECTURE.md#79-etapa-actual-backend-simulado).

## Qué se aprende

- Cómo funciona cada área de una organización y qué documentación utiliza.
- Quién inicia cada proceso, quién lo autoriza y hacia qué sector continúa.
- Qué impacto administrativo, contable, financiero o productivo tiene cada operación.
- Control interno: niveles de autorización, separación de funciones, trazabilidad.
- Trabajo colaborativo entre sectores sobre información compartida.

## Documentación

| Documento | Contenido |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Diagnóstico, stack, arquitectura, núcleo, seguridad, riesgos, decisiones |
| [DATABASE.md](DATABASE.md) | Modelo de datos, RLS, funciones, invariantes, datos demo |
| [MVP.md](MVP.md) | Alcance de la Fase 1, historias, pantallas, criterios de aceptación, plan |
| [ROADMAP.md](ROADMAP.md) | Fases 2026–2027 y funcionalidades pospuestas |
| [docs/ROLES_Y_PERMISOS.md](docs/ROLES_Y_PERMISOS.md) | Modelo de roles y matriz de permisos |
| [docs/FLUJO_COMPRAS.md](docs/FLUJO_COMPRAS.md) | Circuito del MVP: estados, reglas y excepciones |
| [docs/DISENO_UI.md](docs/DISENO_UI.md) | Guía visual y de redacción |
| [docs/GLOSARIO.md](docs/GLOSARIO.md) | Términos del dominio e identificadores técnicos |
| [docs/INSTANCIAS.md](docs/INSTANCIAS.md) | Una instancia por escuela: alta, configuración, actualizaciones, costos, temas a resolver antes de vender |

Los diagramas están escritos en Mermaid: se ven directamente en GitHub y en VS Code con una extensión de vista previa de Mermaid.

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React · Vite · TypeScript · Tailwind CSS · shadcn/ui · Lucide · TanStack Query/Table · React Hook Form · Zod |
| Backend | Supabase: PostgreSQL (RLS + funciones), Auth, Realtime, Storage, Edge Functions |
| Hosting | Netlify o Cloudflare Pages (sitio estático) |
| Pruebas | Vitest · pgTAP · Playwright |

## Estructura

```
docs/        documentación funcional y de diseño
supabase/    migraciones, funciones, pruebas de base de datos (próxima etapa)
src/         aplicación React organizada por funcionalidades
src/lib/     dominio (catálogos y tipos), API, backend simulado (mock/) y formatos
e2e/         pruebas extremo a extremo
scripts/     utilidades
```

Detalle en [ARCHITECTURE.md §15](ARCHITECTURE.md#15-estructura-de-carpetas).

## Puesta en marcha

Requisitos: Node.js 20.19 o superior (recomendado 24 LTS) y npm.

```bash
npm install
npm run dev
```

Abrí `http://localhost:5173` y elegí un usuario en **Accesos de demostración** (uno por isla, más docente y administración). Para ver la integración en vivo, abrí otra pestaña con otro usuario: lo que hace un sector aparece al instante en la bandeja del siguiente. Todos los usuarios demo usan la contraseña definida en `DEMO_PASSWORD` (`src/lib/mock/seed.ts`).

Los datos se guardan en el navegador (`localStorage`). El docente puede volver al estado inicial desde **Panel docente → Datos de demostración**.

| Comando | Uso |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run typecheck` | Verificación de tipos |
| `npm run build` | Compilación de producción en `dist/` |

## Relación con GEST-AR

INTEGR-AR es **una aplicación más de la familia GEST-AR**: comparte su identidad visual (azul marino `#1C2B4A`, azul `#185FA5`, tipografía Inter, logotipo "-AR") y su propósito pedagógico. Técnicamente es independiente: repositorio, código, base de datos y despliegue propios. No modifica ni reemplaza a GEST-AR, que sigue destinado a los cursos iniciales; la integración de datos entre ambas se evaluará más adelante.

## Licencia

Software propietario del autor, todos los derechos reservados. Su uso por otras escuelas se otorga mediante contrato de licencia y servicio (decisiones D-14, D-16 y D-17 en [ARCHITECTURE.md §18](ARCHITECTURE.md#18-decisiones-pendientes)).
