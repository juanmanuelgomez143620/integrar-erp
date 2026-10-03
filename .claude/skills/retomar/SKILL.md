---
name: retomar
description: Retoma el trabajo en INTEGR-AR al empezar una sesión o cuando el usuario dice "continuá", "seguí" o "¿qué sigue?". Arma el estado con git y CLAUDE.md, sin releer documentación larga ni transcripciones.
---

# Retomar el trabajo

1. Estado de git (PowerShell, una sola llamada):
   `git branch --show-current; git status --short; git log --oneline -12; git log --oneline main..HEAD`
2. Leé la sección "Estado" de CLAUDE.md (ya está en contexto). No abras ARCHITECTURE.md, DATABASE.md ni MVP.md completos; si hace falta un dato, buscá su sección con Grep.
3. Si hay cambios sin commitear que no hiciste vos en esta sesión, preguntá antes de tocarlos.
4. Corré `npm run -s check`. Si falla, eso es lo primero.
5. Si se va a trabajar con Supabase, comprobá que el MCP `supabase-integrar` esté conectado (por ejemplo, con su herramienta de listar tablas). Si pide autenticación, indicá al usuario que escriba `/mcp` e inicie sesión eligiendo la organización "juanmanuelgomez143620's Org".
6. Respondé en 3 a 6 líneas: dónde quedó, qué sigue y si hay una decisión que le toca al usuario. Si el usuario pidió continuar, arrancá con el siguiente paso sin esperar.
