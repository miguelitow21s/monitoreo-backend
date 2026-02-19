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
$encodedPassword = [System.Uri]::EscapeDataString($supabaseDbPassword)
$dbUrl = "postgresql://postgres:$encodedPassword@db.$supabaseProjectRef.supabase.co:5432/postgres"
supabase db push --db-url $dbUrl --include-all
if ($LASTEXITCODE -ne 0) {
  throw "supabase db push failed with code $LASTEXITCODE"
}

Write-Host "[STEP] Deploying edge functions"
& "$PSScriptRoot/deploy-functions.ps1" -ProjectRef $supabaseProjectRef
if ($LASTEXITCODE -ne 0) {
  throw "supabase functions deploy failed with code $LASTEXITCODE"
}

if ($RunFrontendHook) {
  $hook = Require-Env 'VERCEL_DEPLOY_HOOK_URL'
  Write-Host "[STEP] Triggering frontend deploy hook"
  Invoke-RestMethod -Method Post -Uri $hook | Out-Null
}

Write-Host "[STEP] Running health checks"
& "$PSScriptRoot/health-check.ps1"
if ($LASTEXITCODE -ne 0) {
  throw "health-check failed with code $LASTEXITCODE"
}

Write-Host "[DONE] Deploy pipeline completed for $Environment"
