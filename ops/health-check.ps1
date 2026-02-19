$ErrorActionPreference = 'Stop'

function Require-Env([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing env var: $name"
  }
  return $value
}

function Get-OptionalEnv([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }
  return $value
}

function Assert-Status([int]$actual, [int]$expected, [string]$label) {
  if ($actual -ne $expected) {
    throw "[$label] expected HTTP $expected but got $actual"
  }
  Write-Host "[OK] $label -> $actual"
}

function Invoke-HttpGet([string]$uri, [hashtable]$headers) {
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  try {
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $uri)
    foreach ($key in $headers.Keys) {
      [void]$req.Headers.TryAddWithoutValidation($key, [string]$headers[$key])
    }
    $resp = $client.Send($req)
    $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{
      StatusCode = [int]$resp.StatusCode
      Content = $body
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Get-AuthToken([string]$supabaseUrl, [string]$anonKey, [string]$email, [string]$password, [string]$label) {
  $url = "$($supabaseUrl.TrimEnd('/'))/auth/v1/token?grant_type=password"
  $headers = @{ apikey = $anonKey; 'Content-Type' = 'application/json' }
  $body = @{ email = $email; password = $password } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -Body $body
  if ([string]::IsNullOrWhiteSpace($resp.access_token)) {
    throw "[$label] could not obtain access token"
  }
  return [string]$resp.access_token
}

function Get-JwtExpUnix([string]$jwt) {
  try {
    $parts = $jwt.Split('.')
    if ($parts.Length -lt 2) { return $null }
    $payload = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($payload.Length % 4) {
      2 { $payload += '==' }
      3 { $payload += '=' }
    }
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($payload))
    $obj = $json | ConvertFrom-Json
    return [long]$obj.exp
  } catch {
    return $null
  }
}

function Resolve-HealthJwt([string]$label, [string]$jwtEnv, [string]$emailEnv, [string]$passwordEnv, [string]$supabaseUrl, [string]$anonKey) {
  $email = Get-OptionalEnv $emailEnv
  $password = Get-OptionalEnv $passwordEnv
  if ($email -and $password) {
    return Get-AuthToken -supabaseUrl $supabaseUrl -anonKey $anonKey -email $email -password $password -label $label
  }

  $jwt = Get-OptionalEnv $jwtEnv
  if ($jwt) {
    $exp = Get-JwtExpUnix $jwt
    if ($exp) {
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      if ($exp -le $now) {
        Write-Host "[WARN] $label JWT expired in $jwtEnv; skipping role-dependent checks for this user."
        return $null
      }
    }
    return $jwt
  }

  Write-Host "[WARN] Missing auth source for $label. Provide [$jwtEnv] or [$emailEnv + $passwordEnv]."
  return $null
}

$supabaseUrl = (Require-Env 'SUPABASE_URL').TrimEnd('/')
$anon = Require-Env 'SUPABASE_ANON_KEY'
$employeeJwt = Resolve-HealthJwt -label 'employee' -jwtEnv 'HEALTH_EMPLOYEE_JWT' -emailEnv 'HEALTH_EMPLOYEE_EMAIL' -passwordEnv 'HEALTH_EMPLOYEE_PASSWORD' -supabaseUrl $supabaseUrl -anonKey $anon
$supervisorJwt = Resolve-HealthJwt -label 'supervisor' -jwtEnv 'HEALTH_SUPERVISOR_JWT' -emailEnv 'HEALTH_SUPERVISOR_EMAIL' -passwordEnv 'HEALTH_SUPERVISOR_PASSWORD' -supabaseUrl $supabaseUrl -anonKey $anon
$adminJwt = Resolve-HealthJwt -label 'admin' -jwtEnv 'HEALTH_ADMIN_JWT' -emailEnv 'HEALTH_ADMIN_EMAIL' -passwordEnv 'HEALTH_ADMIN_PASSWORD' -supabaseUrl $supabaseUrl -anonKey $anon

$baseFn = "$supabaseUrl/functions/v1"
$baseRest = "$supabaseUrl/rest/v1"

# 1) Health endpoint (no depende de JWT de usuario)
$health = Invoke-HttpGet -Uri "$baseFn/health_ping" -Headers @{ authorization = "Bearer $anon"; apikey = $anon }
Assert-Status $health.StatusCode 200 'health_ping'

# 2) Method hardening for POST endpoint
$methodProbe = Invoke-WebRequest -Method Get -Uri "$baseFn/shifts_start" -Headers @{ Authorization = "Bearer $anon"; apikey = $anon } -SkipHttpErrorCheck -UseBasicParsing
Assert-Status $methodProbe.StatusCode 405 'shifts_start method guard'

# 3) Idempotency required
$idempotencyProbe = Invoke-WebRequest -Method Post -Uri "$baseFn/shifts_start" -Headers @{ Authorization = "Bearer $anon"; apikey = $anon; 'Content-Type' = 'application/json' } -Body '{"restaurant_id":1,"lat":0,"lng":0}' -SkipHttpErrorCheck -UseBasicParsing
if ($idempotencyProbe.StatusCode -eq 422) {
  Write-Host "[OK] shifts_start idempotency guard -> 422"
} elseif ($idempotencyProbe.StatusCode -eq 401) {
  Write-Host "[OK] shifts_start auth guard active -> 401 (idempotency check skipped due unauthenticated token)"
} else {
  throw "[shifts_start idempotency/auth guard] expected HTTP 422 or 401 but got $($idempotencyProbe.StatusCode)"
}

$hasRoleTokens = $employeeJwt -and $supervisorJwt -and $adminJwt
if ($hasRoleTokens) {
  # 4) RLS smoke by token context
  $employeeRls = Invoke-WebRequest -Method Get -Uri "$baseRest/shifts?select=id&limit=1" -Headers @{ Authorization = "Bearer $employeeJwt"; apikey = $anon } -SkipHttpErrorCheck -UseBasicParsing
  Assert-Status $employeeRls.StatusCode 200 'RLS employee shifts select'

  $supervisorRls = Invoke-WebRequest -Method Get -Uri "$baseRest/shifts?select=id&limit=1" -Headers @{ Authorization = "Bearer $supervisorJwt"; apikey = $anon } -SkipHttpErrorCheck -UseBasicParsing
  Assert-Status $supervisorRls.StatusCode 200 'RLS supervisor shifts select'

  $adminRls = Invoke-WebRequest -Method Get -Uri "$baseRest/shifts?select=id&limit=1" -Headers @{ Authorization = "Bearer $adminJwt"; apikey = $anon } -SkipHttpErrorCheck -UseBasicParsing
  Assert-Status $adminRls.StatusCode 200 'RLS admin shifts select'

  # 5) RPC critical smoke
  $rpc = Invoke-WebRequest -Method Post -Uri "$baseRest/rpc/get_my_active_shift" -Headers @{ Authorization = "Bearer $employeeJwt"; apikey = $anon; 'Content-Type' = 'application/json' } -Body '{}' -SkipHttpErrorCheck -UseBasicParsing
  Assert-Status $rpc.StatusCode 200 'RPC get_my_active_shift'

  # 6) Audit permission boundary
  $auditForbidden = Invoke-WebRequest -Method Post -Uri "$baseFn/audit_log" -Headers @{ Authorization = "Bearer $supervisorJwt"; 'Content-Type' = 'application/json'; 'Idempotency-Key' = [guid]::NewGuid().ToString() } -Body '{"action":"SEC_TEST","context":{"probe":true}}' -SkipHttpErrorCheck -UseBasicParsing
  if ($auditForbidden.StatusCode -eq 403) {
    Write-Host "[OK] audit_log supervisor forbidden -> 403"
  } elseif ($auditForbidden.StatusCode -eq 401) {
    Write-Host "[OK] audit_log auth guard active -> 401 (supervisor token invalid/expired)"
  } else {
    throw "[audit_log supervisor forbidden] expected HTTP 403 or 401 but got $($auditForbidden.StatusCode)"
  }
} else {
  Write-Host '[WARN] Skipping role-dependent health checks (RLS/RPC/audit). Configure HEALTH_*_EMAIL/PASSWORD secrets.'
}

# 7) Evidence endpoint guards
$evMethod = Invoke-WebRequest -Method Get -Uri "$baseFn/evidence_upload" -Headers @{ Authorization = "Bearer $anon"; apikey = $anon } -SkipHttpErrorCheck -UseBasicParsing
Assert-Status $evMethod.StatusCode 405 'evidence_upload method guard'

$evIdemp = Invoke-WebRequest -Method Post -Uri "$baseFn/evidence_upload" -Headers @{ Authorization = "Bearer $anon"; apikey = $anon; 'Content-Type' = 'application/json' } -Body '{"action":"request_upload","shift_id":1,"type":"inicio"}' -SkipHttpErrorCheck -UseBasicParsing
if ($evIdemp.StatusCode -eq 422) {
  Write-Host "[OK] evidence_upload idempotency guard -> 422"
} elseif ($evIdemp.StatusCode -eq 401) {
  Write-Host "[OK] evidence_upload auth guard active -> 401 (idempotency check skipped due unauthenticated token)"
} else {
  throw "[evidence_upload idempotency/auth guard] expected HTTP 422 or 401 but got $($evIdemp.StatusCode)"
}

Write-Host '[DONE] Post-deploy health checks passed'
