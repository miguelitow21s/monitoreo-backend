# Deploy Ops Runbook

## Required environment variables
Use `ops/.env.template` as the source of truth and define values per environment (`dev`, `staging`, `prod`).

## One-shot local deploy
1. Export environment variables for target env.
2. Configure remote secrets:
   `pwsh ./ops/set-secrets.ps1 -Environment dev`
3. Run ordered pipeline:
   `pwsh ./ops/deploy.ps1 -Environment dev -RunFrontendHook`

## Pipeline stages
1. SQL migrations (`supabase db push --include-all`)
2. Edge Functions deploy (canonical list)
3. Frontend deploy trigger (Vercel deploy hook)
4. Post-deploy health checks

## Health checks covered
- Function liveness (`health_ping`)
- Method guard (`405`) on protected endpoints
- Idempotency guard (`422` when missing key)
- RLS smoke tests using employee/supervisor/admin JWTs
- Critical RPC smoke (`get_my_active_shift`)
- Audit permission boundary (`audit_log` forbidden for supervisor)
- Evidence endpoint guard checks

## GitHub Actions
Workflow: `.github/workflows/deploy.yml`

Set environment-level secrets in GitHub for each target environment:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_ACCESS_TOKEN`
- `VERCEL_TOKEN`
- `VERCEL_PROJECT_ID`
- `VERCEL_TEAM_ID`
- `VERCEL_DEPLOY_HOOK_URL`
- `HEALTH_EMPLOYEE_JWT`
- `HEALTH_SUPERVISOR_JWT`
- `HEALTH_ADMIN_JWT`
