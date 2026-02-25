param(
  [Parameter(Mandatory = $true)] [string]$ProjectRef
)

$ErrorActionPreference = 'Stop'

$functions = @(
  'health_ping',
  'legal_consent',
  'audit_log',
  'shifts_start',
  'shifts_end',
  'shifts_approve',
  'shifts_reject',
  'supplies_deliver',
  'reports_generate',
  'incidents_create',
  'evidence_upload'
)

foreach ($fn in $functions) {
  Write-Host "[DEPLOY] supabase function: $fn"
  # Auth is handled in-function via authGuard where required.
  # Keep gateway JWT verification disabled to support current Auth JWT signing mode
  # and allow public endpoints (e.g., health_ping) without Authorization header.
  supabase functions deploy $fn --project-ref $ProjectRef --no-verify-jwt
  if ($LASTEXITCODE -ne 0) {
    throw "Failed deploying function $fn with exit code $LASTEXITCODE"
  }
}
