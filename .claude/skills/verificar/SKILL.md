---
name: verificar
description: Verifica un cambio de INTEGR-AR antes de commitear, con chequeos de salida mínima y una prueba en el navegador con los usuarios demo. Usar después de cada mejora y antes de cada commit.
---

# Verificar un cambio

## 1. Chequeos automáticos

- `npx prettier --write <archivos tocados>` y después `npm run -s check`. Si falla, corregí y repetí.
- `npm run build` sólo si tocaste el router, dependencias o configuración, o al cerrar una tarea (tarda unos 25 s en esta máquina).

## 2. Navegador

- Servidor: `npm run dev`. Si la herramienta de vista previa no lo encuentra, levantalo como proceso aparte (`Start-Process npm.cmd -ArgumentList "run","dev","--","--strictPort" -WindowStyle Hidden`) y abrí http://localhost:5173 por URL.
- Probá en una pestaña de fondo para no interrumpir la que mira el usuario, y dejá la visible en un estado razonable.
- Cambiar de usuario sin clics (desde `javascript_tool`): `const m = await import('/src/lib/api/index.ts'); await m.auth.loginAs('compras1')` y después navegá. El mismo módulo expone `api` y `commands` para preparar datos.
- Usuarios demo (contraseña `demo1234`): admin, docente, gerencia, auditor, compras1, compras2, ventas, contabilidad, tesoreria, rrhh, produccion, deposito.
- Circuito de compras: produccion crea y envía la SC → compras1 arma la OC → aprueba compras2 (hasta $ 500.000) o gerencia (más) → compras1 la envía → deposito recibe. Quien crea la OC no puede aprobarla.
- Leé con `get_page_text` o `javascript_tool`. Capturas sólo para diseño.
- Descargas (CSV): no descargues archivos a la PC del usuario. Interceptá `HTMLAnchorElement.prototype.click` y leé el blob con `fetch(this.href)` (con `arrayBuffer()` si hay que ver el BOM: `text()` lo descarta).
- Tiempo (por ejemplo, inactividad): reemplazá `Date.now` por una versión adelantada. Una pestaña oculta hace mucho sólo corre un temporizador por minuto.
- Consola: los errores con `?t=` viejos son de estados intermedios de la recarga en caliente, no del código final.

## 3. Cierre

- Commit chico en español con el porqué y lo probado.
- Al terminar la sesión, actualizá la sección "Estado" de CLAUDE.md.
