## Qué cambia

<!-- Breve descripción del cambio, en 1-3 oraciones. -->

## Tipo

- [ ] Fix (bug)
- [ ] Feature (nuevo endpoint / capacidad)
- [ ] Refactor (sin cambio de comportamiento)
- [ ] Migration (cambio de esquema DB)
- [ ] Chore (deps, config, tooling)
- [ ] Docs

## Cómo probar

<!-- Comando curl, ejemplo de payload, o test/validación que corriste.
Ej: deno check supabase/functions/<fn>/index.ts, o el curl al endpoint. -->

## Checklist

- [ ] Compila / valida localmente (`deno check` o esbuild del/los archivo(s) tocados)
- [ ] Sin secrets en el diff (.env, anon/service_role keys, SUPABASE_ACCESS_TOKEN, tokens de gestión). **El repo es público.**
- [ ] Si toca esquema: migración `supabase/migrations/NNN_*.sql` adjunta, idempotente y backward-compatible (el pipeline corre `supabase db push --include-all`)
- [ ] Si toca un endpoint: doc actualizada (FRONTEND_API_*.md)
- [ ] Si toca rate limits, RLS o grants: descrito explícitamente en el PR
- [ ] Escrituras a tablas sensibles van por el cliente correcto (service role vs. clientUser) según la autorización

## Notas para @miguelitow21s

<!-- Decisiones que dejaste al criterio del reviewer, dudas, o algo a verificar
aparte del código (p. ej. probar un check-in real en prod tras el deploy). -->
