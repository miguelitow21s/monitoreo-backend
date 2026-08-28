# Cómo contribuir a WorkTrace (backend)

Guía corta del flow de trabajo del repo. Léela antes de tu primer commit.

Stack: **Supabase Edge Functions (Deno / TypeScript) + Postgres (RLS) + GitHub Actions**. El frontend vive en otro repo (`miguelitow21s/html`).

## Reglas de branches

- **`main`** es la rama de producción (la que se despliega a prod).
- **Nadie hace push directo a `main`.** GitHub lo bloquea (branch protection).
- Todo cambio pasa por Pull Request → review de @miguelitow21s → merge squash.

> **Importante:** a diferencia del frontend, mergear a `main` **NO** despliega solo.
> El deploy a producción es **manual**: se dispara el workflow **"Deploy Backend +
> Supabase + Vercel"** (Actions → Run workflow → `environment: prod`), que corre las
> migraciones (`supabase db push --include-all`) y despliega las Edge Functions.
> Coordiná el deploy con @miguelitow21s; no lo dispares sin avisar.

## Nombres de rama

| Prefijo | Cuándo |
|---------|--------|
| `feature/…` | Nuevo endpoint o capacidad |
| `fix/…` | Bug en producción |
| `refactor/…` | Reorganización sin cambio de comportamiento |
| `migration/…` | Cambio de esquema DB (nueva migración) |
| `chore/…` | Dependencias, config, tooling del repo |
| `docs/…` | Documentación |

Ejemplo: `fix/shift-evidence-clientuser`, `feature/reporte-mensual`.

## Flujo del PR

1. Cortá una rama desde `main` actualizada:
   ```
   git checkout main
   git pull
   git checkout -b fix/mi-cambio
   ```
2. Hacé tus commits (podés hacer varios pequeños; se squashean al mergear).
3. Validá localmente antes de pushear:
   ```
   deno check supabase/functions/<fn>/index.ts   # o el archivo que tocaste
   ```
4. Pushá y abrí el PR:
   ```
   git push -u origin fix/mi-cambio
   gh pr create --fill
   ```
5. Completá el template del PR (qué cambia, cómo probar, checklist).
6. Esperá review de @miguelitow21s. Aplicá los cambios pedidos en la misma rama.
7. Una vez aprobado, @miguelitow21s hace el merge (squash). Tu rama se borra automáticamente.

## Cómo se aprueba

- El PR **debe** tener 1 review aprobado de @miguelitow21s (via CODEOWNERS).
- Las conversaciones abiertas deben resolverse antes del merge.
- Los conflictos con `main` los resolvés vos antes del merge (rebase preferido).
- No se permite auto-approval ni auto-merge.

## Migraciones (leé esto si tocás la DB)

- Van en `supabase/migrations/NNN_descripcion.sql`, numeradas en orden.
- Deben ser **idempotentes** (`if not exists`, `create or replace`, guards) y
  **backward-compatible**: el pipeline aplica **todas** las pendientes con
  `supabase db push --include-all`, y las Edge Functions viejas conviven unos
  segundos con el esquema nuevo durante el deploy.
- Cambios de **RLS / grants**: describí en el PR qué rol gana/pierde acceso y por qué.
- Nunca escribas DDL destructivo (drop de columnas/tablas con datos) sin un plan
  de migración y el OK de @miguelitow21s.

## Convenciones de commit

Formato: `<Tipo>: <descripción corta>`

Ejemplos reales del repo:
```
Add migration 064: allow site-task closure by active visit
Route shift writes through the service role (fix #1, step 1)
```

Cierre del commit body, si aplica:
```
Co-Authored-By: <nombre> <email>
```

## Qué NO hacer

- **No push a `main`** directo (te rebota por branch protection).
- **No commitees secretos.** El repo es **público**: nada de `.env`, anon/service_role
  keys, `SUPABASE_ACCESS_TOKEN` ni tokens de gestión en el diff. Las secrets viven en
  el environment `prod` de GitHub y en Supabase.
- **No dispares el deploy a prod** por tu cuenta — coordiná con @miguelitow21s.
- **No apruebes tu propio PR.** Requerido review externo.
- **No metas migraciones destructivas** ni cambios de RLS/grants sin describirlos.

## Contexto rápido del stack

Endpoints y contratos: ver los `FRONTEND_API_*.md` en la raíz y `supabase/`.
Esquema y evolución: `supabase/migrations/`.

## Ante duda

Preguntá a @miguelitow21s antes de mergear algo grande. Vale más una pregunta a
tiempo que revertir en producción.
