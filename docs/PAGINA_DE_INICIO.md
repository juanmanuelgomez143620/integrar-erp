# Página de inicio pública (pedido del usuario el 23/11)

> El pedido: "mejorar la página de inicio. Debe ser más explicativa y persuasiva: explicarle al usuario de
> qué se trata. Como es restringido, sólo existirá un panel público explicativo o con datos de muestra."
>
> Estado: **hecha el 23/11** (el usuario pidió seguir con la página): P1 a P3. Falta revisarla en el celular y publicarla con el resto de `main`.

## 1. Cómo está hoy (análisis del 23/11)

- **La única pantalla pública es el ingreso** (`/login`, `src/features/auth/login-page.tsx`). La raíz (`/`) exige sesión y, sin ella, manda al ingreso.
- **En la computadora**, a la izquierda, un panel azul con una frase ("Una empresa, muchas áreas, una sola base de datos"), un párrafo y la cadena Solicitud → Orden → Aprobación → Recepción → Stock (el circuito de compras de la Fase 1); a la derecha, el formulario.
- **En el celular** ese panel se oculta: se ve sólo "Ingresar" con el usuario y la contraseña.
- **En el sitio publicado** (GitHub Pages y Vercel, con Supabase) no hay accesos de demostración: quien llega sin usuario no puede ver nada de la aplicación ni entender qué es.
- **No dice:** para quién es (la escuela y sus cursos), qué se aprende, cómo se trabaja (las ocho islas, los roles, el docente), qué tiene hoy (compras, ventas, producción, depósito y logística, contabilidad, impuestos, tesorería con el Banco Aula, sueldos, el fisco simulado, el tablero de control y el mapa vivo), ni cómo se consigue un usuario.

## 2. La propuesta (a validar)

Una **página pública en `/`** para quien no inició sesión (con sesión, `/` sigue llevando a la empresa, como hoy), con el **ingreso** a mano (un botón "Ingresar" arriba que lleva a `/login`, que queda como está). Las secciones, de arriba hacia abajo:

1. **Portada.** Qué es, en una frase: la empresa simulada del aula, un sistema de gestión (ERP) educativo donde cada estudiante trabaja en un sector y las operaciones pasan de uno a otro como en una empresa real. El nombre y el logo de la escuela salen de su configuración (nunca del código, CA-15). Botones: **Ingresar** y **Ver la muestra**. La leyenda de siempre: simulación educativa, sin validez fiscal.
2. **Cómo funciona.** El aula es una empresa (Forestal del Norte en la demo, ficticia) con **ocho islas**: Gerencia y Control de Gestión, Compras, Ventas y Clientes, Contabilidad e Impuestos, Tesorería y Finanzas, RRHH y Sueldos, Producción y Costos, y Depósito y Logística. Cada estudiante tiene un rol; un documento nace en un sector y sigue en otro, con tareas, aprobaciones y auditoría. El banco y el fisco son simulados y los operan Tesorería e Impuestos.
3. **Un circuito completo**, contado en pasos con íconos: del pedido del cliente al cobro (pedido → reserva del stock → remito → hoja de ruta → factura autorizada por el fisco simulado → cobro → banco → asiento) y de la necesidad a la compra (solicitud → cotizaciones → orden → aprobación → recepción → factura del proveedor → pago).
4. **Qué se aprende:** separación de funciones y controles internos, trazabilidad (quién hizo qué y cuándo), la contabilidad que sale de cada operación, IVA e ingresos brutos, sueldos, costos de producción y decisiones con un tablero de control. Y el trabajo en equipo: nadie completa un circuito solo.
5. **Para el docente:** crea la empresa del curso desde la plantilla, asigna los roles, ve la actividad y la auditoría, genera la actividad de cada semana (los pedidos de los clientes) y puede volver a empezar.
6. **La muestra, con datos ficticios** (ver el punto 3).
7. **Preguntas frecuentes:** ¿quién puede entrar? (sólo con el usuario que da la escuela o el docente: no hay registro libre); ¿es un sistema real? (no: es una simulación, sin validez fiscal, con empresas y personas inventadas); ¿qué datos guarda de los estudiantes? (lo mínimo para entrar y saber quién hizo cada operación); ¿hay que instalar algo? (no: anda en el navegador, también en el celular).
8. **Pie:** la escuela (de su configuración), "INTEGR-AR, sistema de gestión educativo" y la leyenda de simulación.

**El tono:** español rioplatense, claro y concreto, para tres lectores: estudiantes (16 a 18 años), docentes y directivos o familias. Persuasivo por lo que muestra (un circuito real, una empresa que se mueve), no por adjetivos.

## 3. La muestra con datos ficticios (a validar)

Un panel de **sólo lectura** con la empresa de demostración, para ver cómo se trabaja sin usuario:

- **Qué muestra:** el tablero de control (los indicadores del mes y las alertas), el mapa vivo (los circuitos con los documentos en curso) y uno o dos documentos de ejemplo (un pedido con su próximo paso y una factura con su asiento).
- **De dónde salen los datos:** del simulador que ya trae la aplicación (la demo de siempre, con una semana de pedidos generada), armado en memoria en el navegador de quien mira. **No lee la base real** ni guarda nada: ni datos de estudiantes ni de los cursos.
- **Por qué así y no con capturas:** las capturas envejecen con cada cambio de la aplicación; los componentes reales con los datos de la demo se mantienen solos. El simulador ya está en el paquete de la aplicación (también en la versión con Supabase), así que no suma peso: la muestra se carga cuando se pide.
- **Lo que no hace:** no deja operar (no hay botones de acción) ni iniciar sesión con usuarios de demostración en el sitio publicado.

## 4. Restricciones

- **Acceso restringido:** sin registro ni prueba libre. La parte pública sólo explica y muestra datos ficticios.
- **Ningún dato real en la parte pública:** sólo lo que la escuela configuró para mostrar (su nombre oficial y su logo). Sin fotos ni nombres de estudiantes.
- **Sin marcas de terceros** ni imitación de sitios o formularios oficiales: el banco y el fisco se presentan como simulados.
- **Liviana y accesible:** anda en el celular (hoy el panel explicativo se oculta ahí), con buen contraste, navegable con teclado y sin animaciones pesadas.

## 5. Pasos

| Paso | Qué | Estado |
| --- | --- | --- |
| P1 | Los textos y la estructura de este documento, validados con el usuario | Hecho (23/11): el usuario pidió seguir con la página |
| P2 | La página pública: portada, cómo funciona, los circuitos, qué se aprende, el docente, las preguntas y el pie; `/` pública sin sesión; el ingreso, en `/login` como hoy | Hecho (23/11): `src/features/home/public-home-page.tsx` y `HomeGate` en los guardias |
| P3 | La muestra con datos ficticios: el tablero, el mapa vivo y los documentos de ejemplo, de sólo lectura, con el simulador en memoria | Hecho (23/11): `sample.ts` (con pruebas) y `sample-panel.tsx`; no toca la base guardada |

**Pruebas:** que sin sesión la página no consulte la base real (en la versión con Supabase), que con sesión `/` siga llevando a la empresa, el celular y la computadora, y el texto de la muestra (los datos de la demo).

## 6. Orden (a validar)

Propuesta: **después de la 9d** (la actividad del entorno: faltan la 9d.2 y la 9d.3) y **antes de los escenarios (8g)**, porque la muestra luce más con la empresa grande y una semana de pedidos. No necesita migraciones; se publica con el resto de `main` (que antes necesita las migraciones nuevas aplicadas en Supabase). Si se prefiere antes, se puede hacer ya: no depende de la 9d.
