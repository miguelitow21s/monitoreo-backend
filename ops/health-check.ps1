$ErrorActionPreference = 'Stop'

function Require-Env([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing env var: $name"
  }
  return $value
}

function Assert-Status([int]$actual, [int]$expected, [string]$label) {
  if ($actual -ne $expected) {
    throw "[$label] expected HTTP $expected but got $actual"
  }
  Write-Host "[OK] $label -> $actual"
}

$supabaseUrl = (Require-Env 'SUPABASE_URL').TrimEnd('/')
$anon = Require-Env 'SUPABASE_ANON_KEY'
$employeeJwt = Require-Env 'HEALTH_EMPLOYEE_JWT'
$supervisorJwt = Require-Env 'HEALTH_SUPERVISOR_JWT'
$adminJwt = Require-Env 'HEALTH_ADMIN_JWT'

$baseFn = "$supabaseUrl/functions/v1"
$baseRest = "$supabaseUrl/rest/v1"

# 1) Health endpoint
$health = Invoke-WebRequest -Method Get -Uri "$baseFn/health_ping" -UseBasicParsing
Assert-Status $health.StatusCode 200 'health_ping'

# 2) Method hardening for POST endpoint
$methodProbe = Invoke-WebRequest -Method Get -Uri "$baseFn/shifts_start" -Headers @{ Authorization = "Bearer $employeeJwt" } -SkipHttpErrorCheck -UseBasicParsing
Assert-Status $methodProbe.StatusCode 405 'shifts_start method guard'

# 3) Idempotency required
$idempotencyProbe = Invoke-WebRequest -Method Post -Uri "$baseFn/shifts_start" -Headers @{ Authorization = "Bearer $employeeJwt"; 'Content-Type' = 'application/json' } -Body '{"restaurant_id":1,"lat":0,"lng":0}' -SkipHttpErrorCheck -UseBasicParsing
Assert-Status $idempotencyProbe.StatusCode 422 'shifts_start idempotency guard'

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
Assert-Status $auditForbidden.StatusCode 403 'audit_log supervisor forbidden'

# 7) Evidence endpoint guards
$evMethod = Invoke-WebRequest -Method Get -Uri "$baseFn/evidence_upload" -Headers @{ Authorization = "Bearer $employeeJwt" } -SkipHttpErrorCheck -UseBasicParsing
Assert-Status $evMethod.StatusCode 405 'evidence_upload method guard'

$evIdemp = Invoke-WebRequest -Method Post -Uri "$baseFn/evidence_upload" -Headers @{ Authorization = "Bearer $employeeJwt"; 'Content-Type' = 'application/json' } -Body '{"action":"request_upload","shift_id":1,"type":"inicio"}' -SkipHttpErrorCheck -UseBasicParsing
Assert-Status $evIdemp.StatusCode 422 'evidence_upload idempotency guard'

Write-Host '[DONE] Post-deploy health checks passed'
