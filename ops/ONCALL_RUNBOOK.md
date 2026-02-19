# On-Call And Escalation Runbook

## Ownership (required before production GO)
- Primary on-call: `miguelopsal@gmail.com` (super_admin)
- Secondary on-call: `migue22lopsal@gmail.com` (supervisora)
- Escalation manager: `miguel.lopez81@correo.tdea.edu.co`

## Incident channels
- Primary channel: `WhatsApp - Monitoreo Backend OnCall`
- Backup channel: `Email group: miguelopsal@gmail.com, migue22lopsal@gmail.com, miguel.lopez81@correo.tdea.edu.co`

## Severity and response SLA
- Sev-1 (service down/security incident): acknowledge in <= 5 min
- Sev-2 (critical feature degraded): acknowledge in <= 15 min
- Sev-3 (non-critical): acknowledge in <= 60 min

## First response checklist
1. Confirm impacted environment (`dev` / `staging` / `prod`).
2. Identify failing deploy run URL and commit SHA.
3. Check Supabase Edge Functions logs for request_id correlation.
4. Validate DB migration state (`supabase_migrations.schema_migrations`).
5. Decide mitigation:
   - function rollback to previous known-good commit
   - forward-fix migration
   - frontend rollback in Vercel

## Rollback procedures
### Edge Functions rollback
1. Checkout previous stable commit.
2. Run deploy workflow for target environment with same secret set.
3. Validate health checks and role-based smoke tests.

### SQL rollback (safe strategy)
1. Prefer forward-fix migration to restore integrity without history rewrite.
2. If data corruption/security impact: execute PITR/backup restore per Supabase runbook.
3. Re-run smoke and audit checks before reopening traffic.

### Frontend rollback
1. Promote previous successful Vercel deployment.
2. Confirm API base URL still maps to correct Supabase environment.
