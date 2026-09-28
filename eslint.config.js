// Configuración de ESLint (flat config).
//
// - Reglas sin información de tipos: el chequeo de tipos ya lo hace `tsc`.
// - Reglas de React Hooks sólo para el código de la aplicación (src/).
// - TypeScript se fija en 6.0.x porque typescript-eslint todavía no soporta
//   TypeScript 7 (ver ARCHITECTURE.md §7.10).

import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'node_modules', 'supabase/.temp', 'docs']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // Un guion bajo inicial marca "lo descarto a propósito" (igual que `tsc`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ['*.config.{js,ts}', 'scripts/**/*.{js,mjs,ts}', 'e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
])
