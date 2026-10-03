// Hoja imprimible con los usuarios y contraseñas iniciales del alta masiva:
// una tarjeta por estudiante, para recortar y entregar en clase.

import type { StudentCredential } from '@/lib/api'

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function credentialsSheetHtml(
  credentials: StudentCredential[],
  { title, subtitle, appUrl }: { title: string; subtitle: string; appUrl: string },
): string {
  const cards = credentials
    .map(
      (c) => `<div class="card">
  <div class="name">${escapeHtml(c.last_name)}, ${escapeHtml(c.first_name)}</div>
  <div>Usuario: <b>${escapeHtml(c.username)}</b></div>
  <div>Contraseña inicial: <b class="mono">${escapeHtml(c.password)}</b></div>
  <div class="hint">Ingresá en ${escapeHtml(appUrl)}. La primera vez vas a elegir una contraseña propia.</div>
</div>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: Inter, system-ui, sans-serif; color: #1C2B4A; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  p { font-size: 11px; margin: 0 0 10px; color: #475569; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .card { border: 1px dashed #94a3b8; padding: 10px 12px; font-size: 12px; line-height: 1.6; break-inside: avoid; }
  .name { font-weight: 700; font-size: 13px; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 14px; letter-spacing: 0.05em; }
  .hint { color: #64748b; font-size: 10px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(subtitle)}</p>
<div class="grid">
${cards}
</div>
</body>
</html>`
}

/** Imprime la hoja desde un marco oculto: no abre ventanas emergentes ni deja copias en la página. */
export function printCredentialsSheet(html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' })
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) {
    frame.remove()
    return
  }
  doc.open()
  doc.write(html)
  doc.close()
  win.focus()
  win.print()
  setTimeout(() => frame.remove(), 1000)
}
