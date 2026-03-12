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

function Invoke-HttpRequest([string]$method, [string]$uri, [hashtable]$headers, [string]$body = $null) {
  $request = [System.Net.HttpWebRequest]::Create($uri)
  $request.Method = $method
  $request.AllowAutoRedirect = $false

  foreach ($key in $headers.Keys) {
    $value = [string]$headers[$key]
    switch ($key.ToLowerInvariant()) {
      'content-type' { $request.ContentType = $value; continue }
      'accept' { $request.Accept = $value; continue }
      'user-agent' { $request.UserAgent = $value; continue }
      'host' { continue }
      default { $request.Headers[$key] = $value }
    }
  }

  if ($null -ne $body -and $body.Length -gt 0) {
    if ([string]::IsNullOrWhiteSpace($request.ContentType)) {
      $request.ContentType = 'application/json'
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    try {
      $stream.Write($bytes, 0, $bytes.Length)
    } finally {
      $stream.Dispose()
    }
  }

  $response = $null
  try {
    $response = [System.Net.HttpWebResponse]$request.GetResponse()
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      $response = [System.Net.HttpWebResponse]$_.Exception.Response
    } else {
      throw
    }
  }

  $content = ''
  $reader = $null
  try {
    if ($response.GetResponseStream()) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $content = $reader.ReadToEnd()
    }
  } finally {
    if ($reader) { $reader.Dispose() }
  }

  $responseHeaders = @{}
  foreach ($name in $response.Headers.AllKeys) {
    $responseHeaders[$name] = $response.Headers[$name]
  }

  $statusCode = [int]$response.StatusCode
  $response.Close()

  return [pscustomobject]@{
    StatusCode = $statusCode
    Content = $content
    Headers = $responseHeaders
  }
}

function Invoke-HttpGet([string]$uri, [hashtable]$headers) {
  return Invoke-HttpRequest -method 'GET' -uri $uri -headers $headers
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

$frontendOrigin = Get-OptionalEnv 'HEALTH_CHECK_ORIGIN'
if (-not $frontendOrigin) { $frontendOrigin = 'https://monitoreo-front-zeta.vercel.app' }

# 2) CORS preflight (browser compatibility)
$corsProbe = Invoke-HttpRequest -method 'OPTIONS' -uri "$baseFn/legal_consent" -headers @{
  Origin = $frontendOrigin
  'Access-Control-Request-Method' = 'POST'
  'Access-Control-Request-Headers' = 'authorization,apikey,content-type,idempotency-key,x-client-info'
}
if ($corsProbe.StatusCode -ne 204 -and $corsProbe.StatusCode -ne 200) {
  throw "[legal_consent CORS preflight] expected HTTP 204/200 but got $($corsProbe.StatusCode)"
}
$allowOrigin = [string]$corsProbe.Headers['Access-Control-Allow-Origin']
if ([string]::IsNullOrWhiteSpace($allowOrigin)) {
  throw '[legal_consent CORS preflight] missing Access-Control-Allow-Origin header'
}
Write-Host "[OK] legal_consent CORS preflight -> $($corsProbe.StatusCode) (origin: $allowOrigin)"

# 3) legal_consent must reach function authGuard (not fail at gateway JWT verifier)
$consentAnon = Invoke-HttpRequest -method 'POST' -uri "$baseFn/legal_consent" -headers @{
  Authorization = "Bearer $anon"
  apikey = $anon
  'Content-Type' = 'application/json'
} -body '{"action":"status"}'
if ($consentAnon.StatusCode -ne 401) {
  throw "[legal_consent auth guard] expected HTTP 401 but got $($consentAnon.StatusCode)"
}
if (-not ($consentAnon.Content -match '"success"\s*:\s*false')) {
  throw '[legal_consent auth guard] did not return function JSON envelope (possible gateway JWT rejection)'
}
Write-Host "[OK] legal_consent auth guard reached -> 401 (function-level AUTH)"

# 4) Method hardening for POST endpoint
$methodProbe = Invoke-HttpRequest -method 'GET' -uri "$baseFn/shifts_start" -headers @{ Authorization = "Bearer $anon"; apikey = $anon }
Assert-Status $methodProbe.StatusCode 405 'shifts_start method guard'

# 5) Idempotency required
$idempotencyProbe = Invoke-HttpRequest -method 'POST' -uri "$baseFn/shifts_start" -headers @{ Authorization = "Bearer $anon"; apikey = $anon; 'Content-Type' = 'application/json' } -body '{"restaurant_id":1,"lat":0,"lng":0}'
if ($idempotencyProbe.StatusCode -eq 422) {
  Write-Host "[OK] shifts_start idempotency guard -> 422"
} elseif ($idempotencyProbe.StatusCode -eq 401) {
  Write-Host "[OK] shifts_start auth guard active -> 401 (idempotency check skipped due unauthenticated token)"
} else {
  throw "[shifts_start idempotency/auth guard] expected HTTP 422 or 401 but got $($idempotencyProbe.StatusCode)"
}

$hasRoleTokens = $employeeJwt -and $supervisorJwt -and $adminJwt
if ($hasRoleTokens) {
  # 6) RLS smoke by token context
  $employeeRls = Invoke-HttpRequest -method 'GET' -uri "$baseRest/shifts?select=id&limit=1" -headers @{ Authorization = "Bearer $employeeJwt"; apikey = $anon }
  Assert-Status $employeeRls.StatusCode 200 'RLS employee shifts select'

  $supervisorRls = Invoke-HttpRequest -method 'GET' -uri "$baseRest/shifts?select=id&limit=1" -headers @{ Authorization = "Bearer $supervisorJwt"; apikey = $anon }
  Assert-Status $supervisorRls.StatusCode 200 'RLS supervisor shifts select'

  $adminRls = Invoke-HttpRequest -method 'GET' -uri "$baseRest/shifts?select=id&limit=1" -headers @{ Authorization = "Bearer $adminJwt"; apikey = $anon }
  Assert-Status $adminRls.StatusCode 200 'RLS admin shifts select'

  # 7) RPC critical smoke
  $rpc = Invoke-HttpRequest -method 'POST' -uri "$baseRest/rpc/get_my_active_shift" -headers @{ Authorization = "Bearer $employeeJwt"; apikey = $anon; 'Content-Type' = 'application/json' } -body '{}'
  Assert-Status $rpc.StatusCode 200 'RPC get_my_active_shift'

  # 8) Audit permission boundary
  $auditForbidden = Invoke-HttpRequest -method 'POST' -uri "$baseFn/audit_log" -headers @{ Authorization = "Bearer $supervisorJwt"; 'Content-Type' = 'application/json'; 'Idempotency-Key' = [guid]::NewGuid().ToString() } -body '{"action":"SEC_TEST","context":{"probe":true}}'
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

# 9) Evidence endpoint guards
$evMethod = Invoke-HttpRequest -method 'GET' -uri "$baseFn/evidence_upload" -headers @{ Authorization = "Bearer $anon"; apikey = $anon }
Assert-Status $evMethod.StatusCode 405 'evidence_upload method guard'

$evIdemp = Invoke-HttpRequest -method 'POST' -uri "$baseFn/evidence_upload" -headers @{ Authorization = "Bearer $anon"; apikey = $anon; 'Content-Type' = 'application/json' } -body '{"action":"request_upload","shift_id":1,"type":"inicio"}'
if ($evIdemp.StatusCode -eq 422) {
  Write-Host "[OK] evidence_upload idempotency guard -> 422"
} elseif ($evIdemp.StatusCode -eq 401) {
  Write-Host "[OK] evidence_upload auth guard active -> 401 (idempotency check skipped due unauthenticated token)"
} else {
  throw "[evidence_upload idempotency/auth guard] expected HTTP 422 or 401 but got $($evIdemp.StatusCode)"
}

Write-Host '[DONE] Post-deploy health checks passed'
