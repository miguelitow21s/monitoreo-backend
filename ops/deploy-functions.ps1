param(
  [Parameter(Mandatory = $true)] [string]$ProjectRef
)

$ErrorActionPreference = 'Stop'

$UseNpxSupabase = $false

function Invoke-Supabase([string[]]$Arguments) {
  if ($UseNpxSupabase) {
    npx -y supabase @Arguments
  }
  else {
    supabase @Arguments
  }
}

if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw "Supabase CLI not found and npx is unavailable. Install Supabase CLI or Node.js npx."
  }
  $UseNpxSupabase = $true
  Write-Host "[INFO] Using npx supabase fallback"
}

$functions = @(
  'health_ping',
  'legal_consent',
  'audit_log',
  'employee_self_service',
  'trusted_device_validate',
  'trusted_device_register',
  'trusted_device_revoke',
  'phone_otp_send',
  'phone_otp_verify',
  'email_notifications_dispatch',
  'shifts_start',
  'shifts_end',
  'shifts_approve',
  'shifts_reject',
  'supplies_deliver',
  'reports_generate',
  'incidents_create',
  'evidence_upload',
  'scheduled_shifts_manage',
  'operational_tasks_manage',
  'admin_users_manage',
  'admin_restaurants_manage',
  'admin_supervisors_manage',
  'admin_dashboard_metrics',
  'restaurant_staff_manage',
  'supervisor_presence_manage'
)

foreach ($fn in $functions) {
  Write-Host "[DEPLOY] supabase function: $fn"
  # Auth is handled in-function via authGuard where required.
  # Keep gateway JWT verification disabled to support current Auth JWT signing mode
  # and allow public endpoints (e.g., health_ping) without Authorization header.
  Invoke-Supabase @('functions', 'deploy', $fn, '--project-ref', $ProjectRef, '--no-verify-jwt')
  if ($LASTEXITCODE -ne 0) {
    throw "Failed deploying function $fn with exit code $LASTEXITCODE"
  }
}
