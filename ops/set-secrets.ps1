param(
  [Parameter(Mandatory = $true)] [ValidateSet('dev','staging','prod')] [string]$Environment
)

$ErrorActionPreference = 'Stop'

function Require-Env([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing env var: $name"
  }
  return $value
}

function Get-VercelTarget([string]$envName) {
  switch ($envName) {
    'dev' { return @('development') }
    'staging' { return @('preview') }
    'prod' { return @('production') }
  }
}

$vercelToken = Require-Env 'VERCEL_TOKEN'
$vercelProjectId = Require-Env 'VERCEL_PROJECT_ID'
$vercelTeamId = [Environment]::GetEnvironmentVariable('VERCEL_TEAM_ID')

$supabaseUrl = Require-Env 'SUPABASE_URL'
$supabaseAnon = Require-Env 'SUPABASE_ANON_KEY'
$supabaseProjectRef = Require-Env 'SUPABASE_PROJECT_REF'
$supabaseAccessToken = Require-Env 'SUPABASE_ACCESS_TOKEN'

$headers = @{ Authorization = "Bearer $vercelToken"; 'Content-Type' = 'application/json' }
$targets = Get-VercelTarget $Environment
$queryTeam = ''
if (-not [string]::IsNullOrWhiteSpace($vercelTeamId)) { $queryTeam = "?teamId=$vercelTeamId" }

$vars = @(
  @{ key = 'NEXT_PUBLIC_SUPABASE_URL'; value = $supabaseUrl; type = 'encrypted' },
  @{ key = 'NEXT_PUBLIC_SUPABASE_ANON_KEY'; value = $supabaseAnon; type = 'encrypted' },
  @{ key = 'SUPABASE_URL'; value = $supabaseUrl; type = 'encrypted' },
  @{ key = 'SUPABASE_ANON_KEY'; value = $supabaseAnon; type = 'encrypted' },
  @{ key = 'SUPABASE_PROJECT_REF'; value = $supabaseProjectRef; type = 'encrypted' }
)

foreach ($item in $vars) {
  foreach ($target in $targets) {
    $body = @{
      key = $item.key
      value = $item.value
      type = $item.type
      target = @($target)
    } | ConvertTo-Json -Depth 5

    try {
      Invoke-RestMethod -Method Post -Uri "https://api.vercel.com/v10/projects/$vercelProjectId/env$queryTeam" -Headers $headers -Body $body | Out-Null
      Write-Host "[VERCEL] upserted $($item.key) for $target"
    } catch {
      $list = Invoke-RestMethod -Method Get -Uri "https://api.vercel.com/v10/projects/$vercelProjectId/env$queryTeam" -Headers $headers
      $existing = $list.envs | Where-Object { $_.key -eq $item.key -and $_.target -contains $target } | Select-Object -First 1
      if ($null -ne $existing) {
        Invoke-RestMethod -Method Delete -Uri "https://api.vercel.com/v9/projects/$vercelProjectId/env/$($existing.id)$queryTeam" -Headers $headers | Out-Null
        Invoke-RestMethod -Method Post -Uri "https://api.vercel.com/v10/projects/$vercelProjectId/env$queryTeam" -Headers $headers -Body $body | Out-Null
        Write-Host "[VERCEL] replaced $($item.key) for $target"
      } else {
        throw
      }
    }
  }
}

$env:SUPABASE_ACCESS_TOKEN = $supabaseAccessToken
Write-Host "[SECURITY] SUPABASE_SERVICE_ROLE_KEY is intentionally NOT synced to Vercel env."
Write-Host "[SUPABASE] skipping reserved SUPABASE_* secret updates; manage those in Supabase project settings."
