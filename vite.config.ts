import path from 'node:path'
// `defineConfig` de vitest/config extiende el de Vite con el campo `test`:
// un solo archivo de configuración sirve para el servidor de desarrollo y
// para las pruebas.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: { port: 5173, host: true },
  test: {
    // Las pruebas de esta fase son del motor de negocio (funciones puras
    // sobre un objeto DB en memoria): no hace falta un DOM simulado.
    environment: 'node',
  },
})
