param(
  [Parameter(Mandatory = $true)] [ValidateSet('dev','staging','prod')] [string]$Environment
)

$ErrorActionPreference = 'Stop'

$UseNpxSupabase = $false

function Require-Env([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing env var: $name"
  }
  return $value
}

function Invoke-Supabase([string[]]$Arguments) {
  if ($UseNpxSupabase) {
    npx -y supabase @Arguments
  }
  else {
    supabase @Arguments
  }
}

Write-Host "[STEP] Validating prerequisites"
if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw "Supabase CLI not found and npx is unavailable. Install Supabase CLI or Node.js npx."
  }
  $UseNpxSupabase = $true
  Write-Host "[INFO] Using npx supabase fallback"
}

$supabaseProjectRef = Require-Env 'SUPABASE_PROJECT_REF'
$supabaseDbPassword = Require-Env 'SUPABASE_DB_PASSWORD'
$supabaseAccessToken = Require-Env 'SUPABASE_ACCESS_TOKEN'
$env:SUPABASE_ACCESS_TOKEN = $supabaseAccessToken

Write-Host "[STEP] Linking project"
Invoke-Supabase @('link', '--project-ref', $supabaseProjectRef, '--password', $supabaseDbPassword)
if ($LASTEXITCODE -ne 0) {
  throw "supabase link failed with code $LASTEXITCODE"
}

Write-Host "[STEP] Pushing DB migrations (includes 018 release readiness)"
Invoke-Supabase @('db', 'push', '--linked', '--include-all', '--yes')
if ($LASTEXITCODE -ne 0) {
  throw "supabase db push failed with code $LASTEXITCODE"
}

Write-Host "[STEP] Running API/RLS health checks"
& "$PSScriptRoot/health-check.ps1"
if ($LASTEXITCODE -ne 0) {
  throw "health-check failed with code $LASTEXITCODE"
}

Write-Host "[STEP] Execute SQL smoke checks manually in Supabase SQL editor:"
Write-Host "       ops/release-readiness-smoke.sql"

Write-Host "[DONE] Release readiness DB update completed for $Environment"
