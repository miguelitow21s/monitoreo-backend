param(
  [Parameter(Mandatory = $true)] [string]$ProjectRef
)

$ErrorActionPreference = 'Stop'

$functions = @(
  'health_ping',
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
  supabase functions deploy $fn --project-ref $ProjectRef
}
