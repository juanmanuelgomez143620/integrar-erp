import { describe, expect, it } from 'vitest'
import { credentialsSheetHtml } from './credentials-sheet'

const options = { title: 'Usuarios del curso', subtitle: 'Escuela de prueba', appUrl: 'https://erp.escuela.test' }

describe('hoja de usuarios para imprimir', () => {
  it('incluye una tarjeta por estudiante con usuario y contraseña inicial', () => {
    const html = credentialsSheetHtml(
      [
        { user_id: '1', first_name: 'Juan', last_name: 'Pérez', username: 'jperez', password: 'k7m2pq9x' },
        { user_id: '2', first_name: 'Ana', last_name: 'Sosa', username: 'asosa', password: 'ab3cd4ef' },
      ],
      options,
    )
    expect(html.match(/class="card"/g)).toHaveLength(2)
    expect(html).toContain('Pérez, Juan')
    expect(html).toContain('<b class="mono">k7m2pq9x</b>')
    expect(html).toContain('https://erp.escuela.test')
  })

  it('escapa los nombres: lo que se carga como texto nunca se interpreta como HTML', () => {
    const html = credentialsSheetHtml(
      [
        {
          user_id: '1',
          first_name: '<img src=x onerror=alert(1)>',
          last_name: "O'Brien",
          username: 'x',
          password: 'y',
        },
      ],
      options,
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('O&#39;Brien')
  })
})
