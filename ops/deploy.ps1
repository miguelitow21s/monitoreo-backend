param(
  [Parameter(Mandatory = $true)] [ValidateSet('dev','staging','prod')] [string]$Environment,
  [switch]$RunFrontendHook
)

$ErrorActionPreference = 'Stop'

function Require-Env([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing env var: $name"
  }
  return $value
}

$supabaseProjectRef = Require-Env 'SUPABASE_PROJECT_REF'
$supabaseDbPassword = Require-Env 'SUPABASE_DB_PASSWORD'
$supabaseAccessToken = Require-Env 'SUPABASE_ACCESS_TOKEN'

$env:SUPABASE_ACCESS_TOKEN = $supabaseAccessToken

Write-Host "[STEP] Applying ordered migrations"
supabase db push --project-ref $supabaseProjectRef --password $supabaseDbPassword --include-all

Write-Host "[STEP] Deploying edge functions"
& "$PSScriptRoot/deploy-functions.ps1" -ProjectRef $supabaseProjectRef

if ($RunFrontendHook) {
  $hook = Require-Env 'VERCEL_DEPLOY_HOOK_URL'
  Write-Host "[STEP] Triggering frontend deploy hook"
  Invoke-RestMethod -Method Post -Uri $hook | Out-Null
}

Write-Host "[STEP] Running health checks"
& "$PSScriptRoot/health-check.ps1"

Write-Host "[DONE] Deploy pipeline completed for $Environment"
