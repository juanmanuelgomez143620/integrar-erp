# Mapa vivo de la empresa (muestra)

Muestra didáctica, de sólo lectura, del circuito operativo: dónde está cada documento, qué
sector tiene trabajo pendiente y cómo se mueve el stock entre los dos depósitos. No agrega
reglas de negocio ni datos nuevos: usa las lecturas que ya existen en `src/lib/api`.

## 1. Qué muestra

- **Circuito operativo**: los sectores en cuatro carriles (aprobaciones, circuito físico,
  dinero/registros y soporte). Cada tarjeta resume los documentos abiertos y las tareas
  pendientes del sector; cada ficha es un documento con su número y estado.
- **Cola por sector**: tareas abiertas ordenadas por cantidad, con la más antigua y su
  responsable. Sirve para ver dónde se acumula el trabajo.
- **Recorrido de la actividad**: reproduce los últimos eventos de auditoría con play, pausa,
  velocidad y salto. Resalta el sector que actuó; no reconstruye el estado histórico del mapa.
- **Depósito en 2.5D**: dos naves isométricas. Cada caja es un producto; la altura representa
  la cantidad relativa al máximo de la nave y el color, la cobertura sobre el stock mínimo.
  El borde punteado indica cantidad reservada.

## 2. Datos y permisos

Todo sale de lecturas existentes:

| Parte | Lectura |
|---|---|
| Documentos | `api.documents(companyId, docType)` |
| Tareas | `api.tasks(companyId, 'all')` |
| Actividad | `api.audit(companyId)` |
| Stock | `api.stock(companyId)` |

- Sólo se consultan los tipos de documento que el rol puede leer (`*.read`). Si el rol no
  tiene `stock.read`, no se muestra el depósito. `api.tasks` y `api.audit` ya recortan lo que
  cada usuario puede ver.
- La pantalla se refresca cada 20 segundos mientras la pestaña está visible. No usa
  `realtime.subscribe` para no multiplicar consultas.
- No toca el motor, las RPC ni las migraciones: no hay cambios de paridad.

## 3. Decisiones

- **Sin 3D real ni dependencias nuevas.** El depósito es isométrico en SVG; se ve en
  cualquier equipo del aula y no exige WebGL. Si más adelante se justifica un 3D, se carga
  sólo en una pantalla aparte y con vuelta atrás a esta vista.
- **El mapa no inventa movimientos.** Cada ficha está donde el documento dice que está según
  su estado. El “recorrido” ilumina el sector que actuó en cada evento de auditoría.
- **Posiciones estables del depósito.** Las cajas se ubican por el orden del código de
  producto; no hace falta agregar una ubicación física al modelo.
- **Se degrada por rol.** Un sector ve su parte del circuito y lo que puede leer; el docente
  y Gerencia ven el conjunto.

## 4. Qué falta (para después)

- Una lectura agregada `flowMap(companyId)` en el simulador y en Supabase, para no hacer una
  consulta por tipo de documento.
- Reconstrucción completa del estado en el tiempo (hoy el recorrido sólo resalta al actor).
- Hoja de ruta y entregas de la Fase 7c para animar el tramo Depósito → cliente.
- Modo docente con preguntas guiadas (“¿qué falta para que esta OC llegue al depósito?”).

## 5. A validar

- El umbral de cobertura (menos de 1,5 veces el mínimo = atención) y los colores.
- El intervalo de actualización (20 s) y la cantidad de documentos visibles por sector.
- Si el mapa debe estar en “General” para todos los roles o sólo en “Control”.
