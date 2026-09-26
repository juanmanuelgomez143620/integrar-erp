# Guía de diseño de interfaz — INTEGR-AR

> Versión 0.1 · Fase 0. Se implementa con Tailwind CSS + shadcn/ui + Lucide.

## 1. Principios

1. **Software de trabajo, no juego.** El estudiante debe sentir que usa una herramienta empresarial real.
2. **Densidad razonable.** Mucha información legible por pantalla; nada de tarjetas gigantes con un solo dato.
3. **El estado siempre visible.** Cada documento muestra su estado con una insignia de color **y texto**.
4. **Explicar, no sólo bloquear.** Si una acción no está disponible, se dice por qué y quién puede hacerla.
5. **Identidad de la familia GEST-AR.** Misma paleta, tipografía y logotipo "-AR" que GEST-AR; menú lateral azul marino. No imitar la estética de ERPs comerciales conocidos (barra superior azul intensa, lanzador de mosaicos).

## 2. Estructura de pantalla

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ▣ INTEGR-AR │ Forestal del Norte SRL ▾ │ Buscar documento, producto…  │ ◔3 │ JP ▾ │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ Inicio      │ Compras › Órdenes de compra › OC-00023                          │
│ Mi trabajo 4│ ┌──────────────────────────────────────────────┐ ┌────────────┐ │
│             │ │ OC-00023  [Pendiente de aprobación]           │ │ ¿Qué sigue?│ │
│ COMPRAS     │ │ Aserradero … · Entrega 15/04 · $ 812.400,00   │ │ Gerencia   │ │
│  Solicitudes│ │                          [Rechazar] [Aprobar] │ │ debe       │ │
│  Órdenes    │ ├──────────────────────────────────────────────┤ │ aprobar    │ │
│ DEPÓSITO    │ │ Detalle │ Flujo documental │ Historial        │ │ porque el  │ │
│  Recepciones│ │                                              │ │ total      │ │
│  Stock      │ │  #  Código  Descripción   Cant.  Precio  Total│ │ supera …   │ │
│ MAESTROS    │ │  1  MP-004  Placa MDF 18  40     …      …    │ └────────────┘ │
│  Productos  │ │                                              │                │
│  Proveedores│ └──────────────────────────────────────────────┘                │
│  Clientes   │                                                                 │
│ CONTROL     │                                                                 │
│  Auditoría  │                                                                 │
└─────────────┴─────────────────────────────────────────────────────────────────┘
```

- **Barra superior**: marca del producto junto al nombre y logo de la escuela (tomados de `school_settings`, nunca fijos en el código), selector de empresa, buscador global (documentos por número, productos, proveedores, clientes), notificaciones, "Mi trabajo" y menú de usuario (perfil, rol y sector activos, salir).
- **Menú lateral**: agrupado por área; sólo muestra módulos habilitados y permitidos. Colapsable a íconos.
- **Migas de pan** en todas las pantallas internas.
- **Área de contenido**: ancho máximo cómodo en listados; documentos con panel lateral opcional.

## 3. Color

Tokens definidos como variables CSS en `src/index.css` (tema de shadcn), con la paleta de la familia GEST-AR:

| Token | Valor | Uso |
|---|---|---|
| `--navy` / `--sidebar` | `#1C2B4A` | Marca, menú lateral, títulos |
| `--primary` / `--brand-blue` | `#185FA5` | Botones principales, enlaces, selección, sufijo "-AR" del logotipo |
| `--brand-blue-soft` / `--accent` | `#E8F1FA` | Fondos de resaltado (panel "¿Qué sigue?", ítems seleccionados) |
| `--background` | `#F8FAFC` | Fondo general |
| `--card` | `#FFFFFF` | Superficies |
| `--border` | `#E2E8F0` | Bordes y divisores |
| `--foreground` | `#0F172A` | Texto principal |
| `--muted-foreground` | `#64748B` | Texto secundario |
| `--destructive` | `#B91C1C` | Acciones destructivas (anular, rechazar) |

Modo oscuro: previsto en los tokens, se habilita en una fase posterior.

### Insignias de estado

| Variante | Fondo / texto | Estados típicos |
|---|---|---|
| `neutral` | `#F1F5F9` / `#334155` | Borrador, Anulada, Cerrada |
| `info` | `#EFF6FF` / `#1D4ED8` | Solicitada, Enviada, Recibida parcialmente |
| `warning` | `#FFFBEB` / `#B45309` | Pendiente de aprobación |
| `success` | `#F0FDF4` / `#15803D` | Aprobada, Recibida, Confirmada, Ordenada |
| `danger` | `#FEF2F2` / `#B91C1C` | Rechazada |

La variante de cada estado viene del catálogo `document_statuses.badge`: la interfaz no la decide.

## 4. Tipografía y números

- Fuente: **Inter**, empaquetada con la aplicación (`@fontsource-variable/inter`) para no depender de servicios externos en la red escolar. Base 14 px en tablas y formularios; títulos 20–24 px.
- **Números tabulares** (`tabular-nums`) y **alineados a la derecha** en importes y cantidades.
- Moneda: `$ 1.234.567,89`. Cantidades con los decimales de la unidad (`40 UN`, `125,500 KG`).
- Fechas `dd/mm/aaaa`; fecha y hora `dd/mm/aaaa hh:mm`.
- Números de documento en fuente monoespaciada suave (`OC-00023`).

## 5. Componentes clave

| Componente | Descripción |
|---|---|
| `DataTable` | Búsqueda, filtros por estado y fecha, orden, paginación en servidor, selección, exportación; filas de 40 px |
| `StatusBadge` | Insignia de estado desde el catálogo |
| `DocumentHeader` | Número, estado, contraparte, fechas, totales, acciones |
| `LineItemsEditor` | Edición de líneas (producto, cantidad, precio, IVA) con totales en vivo; teclado primero |
| `DocumentFlow` | Cadena de documentos vinculados con sus estados |
| `AuditTimeline` | Historial: hora, persona, sector, acción, cambio de estado |
| `NextStepPanel` | "¿Qué sigue?": próximo paso, sector responsable, explicación |
| `KpiCard` | Indicador con valor, variación y enlace al detalle |
| `EmptyState` | Estado vacío **educativo** (ver §7) |
| `ConfirmDialog` | Confirmación que **describe el efecto** de la acción |
| `PrintLayout` | Formato A4 de documentos |

Íconos Lucide, uno por área y consistentes en todo el sistema: Mi trabajo `Inbox`, Notificaciones `Bell`, Gerencia `LayoutDashboard`, Compras `ShoppingCart`, Ventas `Store`, Depósito `Warehouse`, Stock `Boxes`, Producción `Factory`, Contabilidad `BookOpen`, Tesorería `Landmark`, RRHH `Users`, Sueldos `Banknote`, Impuestos `ReceiptText`, Logística `Truck`, Auditoría `History`.

## 6. Documentos imprimibles

- Formato A4 vertical, márgenes de 15 mm, sin elementos de navegación.
- **Encabezado**: logo y datos de la empresa simulada (razón social, CUIT simulado, domicilio), tipo de documento, número y fecha en un recuadro.
- **Cuerpo**: contraparte, condiciones, tabla de ítems, subtotales, IVA discriminado, total, observaciones.
- **Firmas**: recuadros "Solicitó / Autorizó / Recibió" con nombre, sector, fecha y hora tomados de la auditoría.
- **Leyenda obligatoria** en encabezado y pie: **DOCUMENTO DE SIMULACIÓN EDUCATIVA — SIN VALIDEZ FISCAL**, más una marca de agua diagonal tenue "SIMULACIÓN EDUCATIVA".
- **Nunca** incluir CAE, códigos QR fiscales ni otros elementos que imiten comprobantes oficiales.

## 7. Redacción

- **Voseo rioplatense**, trato cercano y profesional: "Ingresá tu usuario", "Revisá las cantidades".
- Mayúscula sólo al inicio: "Órdenes de compra", no "Órdenes De Compra".
- Botones con verbo y objeto: "Aprobar orden", "Registrar recepción"; nunca "OK" o "Aceptar" a secas.
- Confirmaciones que explican el efecto: *"Al confirmar la recepción se sumarán 30 UN de MP-004 al Depósito de Materias Primas y la OC-00001 quedará Recibida parcialmente."*
- Errores que dicen qué pasó y qué hacer: *"No podés aprobar una orden que creaste vos. Pedile a otro integrante de Compras o a Gerencia que la revise."*
- Estados vacíos que enseñan: *"Todavía no hay solicitudes de compra. Las inician Producción o Depósito cuando detectan una necesidad de materiales."*
- Siglas explicadas la primera vez o con ayuda contextual (SC, OC, PPP).

## 8. Adaptación a pantallas

| Ancho | Comportamiento |
|---|---|
| ≥ 1280 px | Diseño completo con panel lateral de documento |
| 768–1279 px | Menú colapsado a íconos; panel "¿Qué sigue?" debajo del documento |
| < 768 px | Menú como cajón deslizable; tablas como tarjetas; foco en consultas, "Mi trabajo" y aprobaciones |

## 9. Accesibilidad

- Contraste mínimo AA en texto e insignias.
- Foco visible en todos los controles; orden de tabulación lógico.
- Etiquetas en todos los campos; mensajes de error asociados al campo.
- El estado nunca se comunica sólo con color.
- Sin animaciones decorativas; transiciones breves y respetando `prefers-reduced-motion`.

## 10. Qué evitar

- Colores saturados, degradados llamativos, ilustraciones infantiles, mascotas, emojis en la interfaz.
- Elementos de juego: puntos, medallas, confeti, sonidos.
- Animaciones innecesarias y carruseles.
- Mensajes técnicos crudos ("violates row-level security policy"): siempre traducirlos.
