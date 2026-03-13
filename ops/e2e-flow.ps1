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

function New-IdempotencyKey() {
  return [guid]::NewGuid().ToString()
}

function Invoke-JsonRequest(
  [string]$method,
  [string]$uri,
  [hashtable]$headers,
  $body = $null
) {
  $json = $null
  if ($null -ne $body) {
    $json = $body | ConvertTo-Json -Depth 10
  }

  $resp = Invoke-WebRequest -Method $method -Uri $uri -Headers $headers -Body $json -SkipHttpErrorCheck -ContentType 'application/json'
  if ($resp.StatusCode -ge 400) {
    $content = $resp.Content
    if (-not $content) { $content = "HTTP $($resp.StatusCode)" }
    throw "HTTP error calling $uri -> $content"
  }

  if ([string]::IsNullOrWhiteSpace($resp.Content)) {
    return $null
  }

  return $resp.Content | ConvertFrom-Json
}

function Invoke-AuthToken([string]$supabaseUrl, [string]$anonKey, [string]$email, [string]$password, [string]$label) {
  $url = "$($supabaseUrl.TrimEnd('/'))/auth/v1/token?grant_type=password"
  $headers = @{ apikey = $anonKey; 'Content-Type' = 'application/json' }
  $body = @{ email = $email; password = $password }
  $resp = Invoke-JsonRequest -method 'POST' -uri $url -headers $headers -body $body
  if ([string]::IsNullOrWhiteSpace($resp.access_token)) {
    throw "[$label] could not obtain access token"
  }
  return [string]$resp.access_token
}

function Invoke-Postgrest(
  [string]$method,
  [string]$supabaseUrl,
  [string]$anonKey,
  [string]$jwt,
  [string]$table,
  [string]$query = $null,
  $body = $null,
  [string]$prefer = $null
) {
  $baseUrl = "$($supabaseUrl.TrimEnd('/'))/rest/v1/$table"
  $url = $baseUrl
  if ($query) { $url = "${baseUrl}?$query" }
  $headers = @{ apikey = $anonKey; Authorization = "Bearer $jwt"; Accept = 'application/json' }
  if ($prefer) { $headers['Prefer'] = $prefer }
  if ($null -ne $body) {
    $headers['Content-Type'] = 'application/json'
    return Invoke-JsonRequest -method $method -uri $url -headers $headers -body $body
  }
  return Invoke-JsonRequest -method $method -uri $url -headers $headers
}

function Invoke-Edge(
  [string]$supabaseUrl,
  [string]$anonKey,
  [string]$jwt,
  [string]$fnName,
  $payload,
  [hashtable]$extraHeaders = $null
) {
  $url = "$($supabaseUrl.TrimEnd('/'))/functions/v1/$fnName"
  $headers = @{
    apikey = $anonKey
    Authorization = "Bearer $jwt"
    'Content-Type' = 'application/json'
    'Idempotency-Key' = (New-IdempotencyKey)
  }
  if ($extraHeaders) {
    foreach ($key in $extraHeaders.Keys) {
      $headers[$key] = $extraHeaders[$key]
    }
  }
  $resp = Invoke-JsonRequest -method 'POST' -uri $url -headers $headers -body $payload
  if ($resp.success -ne $true) {
    throw "Edge $fnName failed: $($resp | ConvertTo-Json -Depth 8)"
  }
  return $resp
}

function Ensure-LegalConsent([string]$supabaseUrl, [string]$anonKey, [string]$jwt) {
  $status = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'legal_consent' -payload @{ action = 'status' }
  if (-not $status.data.accepted) {
    Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'legal_consent' -payload @{ action = 'accept' } | Out-Null
  }
}

function Ensure-TrustedDevice([string]$supabaseUrl, [string]$anonKey, [string]$jwt, [string]$fingerprint) {
  $validate = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'trusted_device_validate' -payload @{ device_fingerprint = $fingerprint }
  if (-not $validate.data.trusted) {
    Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'trusted_device_register' -payload @{
      device_fingerprint = $fingerprint
      device_name = 'E2E Demo'
      platform = 'web'
    } | Out-Null
  }
}

function Get-OtpToken([string]$supabaseUrl, [string]$anonKey, [string]$jwt, [string]$fingerprint) {
  $send = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'phone_otp_send' -payload @{ device_fingerprint = $fingerprint }
  $code = $send.data.debug_code
  if ([string]::IsNullOrWhiteSpace($code)) {
    throw 'OTP debug_code not returned; verify OTP_DEBUG_MODE or SMS delivery.'
  }
  $verify = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'phone_otp_verify' -payload @{
    code = $code
    device_fingerprint = $fingerprint
  }
  return [string]$verify.data.verification_token
}

function Ensure-ShiftEvidence(
  [string]$supabaseUrl,
  [string]$anonKey,
  [string]$jwt,
  [string]$otpToken,
  [string]$deviceFingerprint,
  [int]$shiftId,
  [double]$lat,
  [double]$lng,
  [string]$type
) {
  $headers = @{
    'x-shift-otp-token' = $otpToken
    'x-device-fingerprint' = $deviceFingerprint
  }
  $request = $null
  try {
    $request = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'evidence_upload' -payload @{
      action = 'request_upload'
      shift_id = $shiftId
      type = $type
    } -extraHeaders $headers
  } catch {
    if ($_.Exception.Message -match 'Evidencia duplicada') {
      return
    }
    throw
  }

  $upload = $request.data.upload
  $uploadUrl = $upload.signedUrl
  if (-not $uploadUrl) { $uploadUrl = $upload.signed_url }
  if (-not $uploadUrl) { $uploadUrl = $upload.uploadUrl }
  if (-not $uploadUrl) { throw 'Signed upload URL missing from response.' }

  $pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
  $pngBytes = [Convert]::FromBase64String($pngBase64)
  $tempFile = Join-Path $env:TEMP ("evidence-" + [guid]::NewGuid().ToString() + ".png")
  [IO.File]::WriteAllBytes($tempFile, $pngBytes)

  try {
    Invoke-RestMethod -Method Put -Uri $uploadUrl -ContentType 'image/png' -InFile $tempFile | Out-Null
  } finally {
    if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
  }

  Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'evidence_upload' -payload @{
    action = 'finalize_upload'
    shift_id = $shiftId
    type = $type
    path = $request.data.path
    lat = $lat
    lng = $lng
    accuracy = 12
    captured_at = (Get-Date).ToUniversalTime().ToString('o')
  } -extraHeaders $headers | Out-Null
}

function Get-ActiveShift([string]$supabaseUrl, [string]$anonKey, [string]$jwt) {
  $resp = Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -table 'rpc/get_my_active_shift' -body @{}
  if ($resp -and $resp.id) { return $resp }
  return $null
}

function Get-ShiftPhotoTypes([string]$supabaseUrl, [string]$anonKey, [string]$adminJwt, [int]$shiftId, [string]$userId) {
  $rows = Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'shift_photos' -query "select=type&shift_id=eq.$shiftId&user_id=eq.$userId"
  if (-not $rows) { return @() }
  return @($rows | ForEach-Object { [string]$_.type })
}

function Close-ActiveShiftIfAny(
  [string]$supabaseUrl,
  [string]$anonKey,
  [string]$adminJwt,
  [string]$jwt,
  [string]$otpToken,
  [string]$deviceFingerprint,
  [string]$userId,
  [string]$roleLabel
) {
  $active = Get-ActiveShift -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt
  if (-not $active) { return }

  $shiftId = [int]$active.id
  $shiftRow = Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'shifts' -query "select=id,restaurant_id&limit=1&id=eq.$shiftId"
  if (-not $shiftRow -or $shiftRow.Count -eq 0) {
    throw "Active shift $shiftId not found for $roleLabel."
  }

  $restaurantId = [int]$shiftRow[0].restaurant_id
  $restaurant = Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurants' -query "select=id,lat,lng&limit=1&id=eq.$restaurantId"
  $lat = [double]$restaurant[0].lat
  $lng = [double]$restaurant[0].lng

  $types = Get-ShiftPhotoTypes -supabaseUrl $supabaseUrl -anonKey $anonKey -adminJwt $adminJwt -shiftId $shiftId -userId $userId
  if (-not ($types -contains 'inicio')) {
    Ensure-ShiftEvidence -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -otpToken $otpToken -deviceFingerprint $deviceFingerprint -shiftId $shiftId -lat $lat -lng $lng -type 'inicio'
  }
  if (-not ($types -contains 'fin')) {
    Ensure-ShiftEvidence -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -otpToken $otpToken -deviceFingerprint $deviceFingerprint -shiftId $shiftId -lat $lat -lng $lng -type 'fin'
  }

  Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -fnName 'shifts_end' -payload @{
    shift_id = $shiftId
    lat = $lat
    lng = $lng
    fit_for_work = $true
    declaration = "Cierre automatico $roleLabel (demo)"
    early_end_reason = 'Cierre automatico por prueba E2E'
  } -extraHeaders @{ 'x-shift-otp-token' = $otpToken; 'x-device-fingerprint' = $deviceFingerprint } | Out-Null
}

function Range-Overlaps([datetimeoffset]$aStart, [datetimeoffset]$aEnd, [datetimeoffset]$bStart, [datetimeoffset]$bEnd) {
  return ($aStart -lt $bEnd) -and ($bStart -lt $aEnd)
}

function Parse-ShiftTime([string]$value) {
  try {
    return [DateTimeOffset]::Parse($value, [System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    return [DateTimeOffset](Get-Date $value)
  }
}

function Ensure-StartableScheduledShift(
  [string]$supabaseUrl,
  [string]$anonKey,
  [string]$adminJwt,
  [string]$actorJwt,
  [string]$employeeId,
  [int]$restaurantId,
  [string]$label
) {
  $now = [DateTimeOffset]::UtcNow
  $startWindow = $now.AddMinutes(30)

  $rows = Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'scheduled_shifts' -query "select=id,scheduled_start,scheduled_end,status&employee_id=eq.$employeeId&status=in.(scheduled,started)&order=scheduled_start.asc"

  $startable = $null
  foreach ($row in $rows) {
    if ($row.status -ne 'scheduled') { continue }
    $start = (Parse-ShiftTime $row.scheduled_start).ToUniversalTime()
    $end = (Parse-ShiftTime $row.scheduled_end).ToUniversalTime()
    if ($start -le $startWindow -and $end -ge $now) {
      $startable = $row
      break
    }
  }

  if ($startable) {
    return $startable
  }

  $candidateStart = $now.AddMinutes(10)
  $candidateEnd = $now.AddMinutes(40)

  $assign = $null
  try {
    $startIso = $candidateStart.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $endIso = $candidateEnd.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $assignPayload = @{
      action = 'assign'
      employee_id = $employeeId
      restaurant_id = $restaurantId
      scheduled_start = $startIso
      scheduled_end = $endIso
      notes = "E2E demo shift ($label)"
    }
    Write-Host "[E2E] Assign payload ($label): $($assignPayload | ConvertTo-Json -Compress)"
    $assign = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $actorJwt -fnName 'scheduled_shifts_manage' -payload $assignPayload
  } catch {
    $message = $_.Exception.Message
    if ($message -match 'turno programado' -or $message -match 'rango') {
      $overlaps = @()
      foreach ($row in $rows) {
        $start = (Parse-ShiftTime $row.scheduled_start).ToUniversalTime()
        $end = (Parse-ShiftTime $row.scheduled_end).ToUniversalTime()
        if (Range-Overlaps $candidateStart $candidateEnd $start $end) {
          $overlaps += $row
        }
      }

      foreach ($row in $overlaps) {
        if ($row.status -eq 'scheduled' -and $row.id) {
          Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $actorJwt -fnName 'scheduled_shifts_manage' -payload @{
            action = 'cancel'
            scheduled_shift_id = [int]$row.id
            reason = "Cancelado por demo E2E ($label)"
          } | Out-Null
        }
      }

      $assignPayload2 = @{
        action = 'assign'
        employee_id = $employeeId
        restaurant_id = $restaurantId
        scheduled_start = $startIso
        scheduled_end = $endIso
        notes = "E2E demo shift ($label)"
      }
      Write-Host "[E2E] Assign retry payload ($label): $($assignPayload2 | ConvertTo-Json -Compress)"
      $assign = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $actorJwt -fnName 'scheduled_shifts_manage' -payload $assignPayload2
    } else {
      throw
    }
  }

  return @{ id = $assign.data.scheduled_shift_id; scheduled_start = $candidateStart.ToString('o'); scheduled_end = $candidateEnd.ToString('o'); status = 'scheduled' }
}

$supabaseUrl = (Require-Env 'SUPABASE_URL').TrimEnd('/')
$anonKey = Require-Env 'SUPABASE_ANON_KEY'

$adminEmail = Require-Env 'E2E_ADMIN_EMAIL'
$adminPassword = Require-Env 'E2E_ADMIN_PASSWORD'
$supervisorEmail = Require-Env 'E2E_SUPERVISORA_EMAIL'
$supervisorPassword = Require-Env 'E2E_SUPERVISORA_PASSWORD'
$employeeEmail = Require-Env 'E2E_EMPLEADO_EMAIL'
$employeePassword = Require-Env 'E2E_EMPLEADO_PASSWORD'

$deviceEmployee = Get-OptionalEnv 'E2E_DEVICE_FINGERPRINT_EMPLOYEE'
if (-not $deviceEmployee) { $deviceEmployee = 'e2e-device-employee-001-abcdef' }
$deviceSupervisor = Get-OptionalEnv 'E2E_DEVICE_FINGERPRINT_SUPERVISOR'
if (-not $deviceSupervisor) { $deviceSupervisor = 'e2e-device-supervisor-001-abcdef' }

Write-Host '[E2E] Authenticating...'
$adminJwt = Invoke-AuthToken -supabaseUrl $supabaseUrl -anonKey $anonKey -email $adminEmail -password $adminPassword -label 'super_admin'
$supervisorJwt = Invoke-AuthToken -supabaseUrl $supabaseUrl -anonKey $anonKey -email $supervisorEmail -password $supervisorPassword -label 'supervisora'
$employeeJwt = Invoke-AuthToken -supabaseUrl $supabaseUrl -anonKey $anonKey -email $employeeEmail -password $employeePassword -label 'empleado'

function Get-ProfileByEmail([string]$jwt, [string]$email) {
  $encoded = [System.Uri]::EscapeDataString($email)
  $rows = Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -table 'profiles' -query "select=id,email,role,is_active&email=eq.$encoded&limit=1"
  if (-not $rows -or $rows.Count -eq 0) { return $null }
  return $rows[0]
}

$adminProfile = Get-ProfileByEmail -jwt $adminJwt -email $adminEmail
$employeeProfile = Get-ProfileByEmail -jwt $adminJwt -email $employeeEmail
$supervisorProfile = Get-ProfileByEmail -jwt $adminJwt -email $supervisorEmail

if (-not $adminProfile -or -not $employeeProfile -or -not $supervisorProfile) {
  throw 'Missing profiles for one or more users.'
}

$restaurantId = $null
$seedRestaurantId = Get-OptionalEnv 'E2E_RESTAURANT_ID'
if ($seedRestaurantId) { $restaurantId = [int]$seedRestaurantId }
if (-not $restaurantId) {
  $restaurants = Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurants' -query 'select=id,name,lat,lng,is_active&is_active=eq.true&limit=1'
  if ($restaurants.Count -gt 0) { $restaurantId = [int]$restaurants[0].id }
}
if (-not $restaurantId) { throw 'No active restaurant available for test.' }

$restaurant = (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurants' -query "select=id,lat,lng&limit=1&id=eq.$restaurantId")
$restaurantLat = [double]$restaurant[0].lat
$restaurantLng = [double]$restaurant[0].lng

Write-Host "[E2E] Using restaurant_id=$restaurantId"

function Upsert-RestaurantEmployee([string]$userId) {
  $payload = @(@{ restaurant_id = $restaurantId; user_id = $userId })
  Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurant_employees' -query 'on_conflict=restaurant_id,user_id' -body $payload -prefer 'resolution=merge-duplicates,return=representation' | Out-Null
}

Upsert-RestaurantEmployee -userId $employeeProfile.id
Upsert-RestaurantEmployee -userId $supervisorProfile.id

Write-Host '[E2E] Ensuring legal consent + trusted device + OTP...'
Ensure-LegalConsent -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt
Ensure-LegalConsent -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt
Ensure-LegalConsent -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt

Ensure-TrustedDevice -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -fingerprint $deviceEmployee
Ensure-TrustedDevice -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -fingerprint $deviceSupervisor

$employeeOtpToken = Get-OtpToken -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -fingerprint $deviceEmployee
$supervisorOtpToken = Get-OtpToken -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -fingerprint $deviceSupervisor

Write-Host '[E2E] Closing any active shifts...'
Close-ActiveShiftIfAny -supabaseUrl $supabaseUrl -anonKey $anonKey -adminJwt $adminJwt -jwt $employeeJwt -otpToken $employeeOtpToken -deviceFingerprint $deviceEmployee -userId $employeeProfile.id -roleLabel 'empleado'
Close-ActiveShiftIfAny -supabaseUrl $supabaseUrl -anonKey $anonKey -adminJwt $adminJwt -jwt $supervisorJwt -otpToken $supervisorOtpToken -deviceFingerprint $deviceSupervisor -userId $supervisorProfile.id -roleLabel 'supervisora'

Write-Host '[E2E] Seeding supplies if needed...'
$existingSupplies = Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'supplies' -query "select=id,name&restaurant_id=eq.$restaurantId"
if (-not $existingSupplies -or $existingSupplies.Count -eq 0) {
  $payload = @(
    @{ name = 'Jabon liquido'; unit = 'litro'; stock = 25; unit_cost = 7.5; restaurant_id = $restaurantId },
    @{ name = 'Desinfectante'; unit = 'litro'; stock = 18; unit_cost = 6.2; restaurant_id = $restaurantId }
  )
  Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'supplies' -body $payload -prefer 'return=representation' | Out-Null
}

Write-Host '[E2E] Scheduling shifts...'
Ensure-StartableScheduledShift -supabaseUrl $supabaseUrl -anonKey $anonKey -adminJwt $adminJwt -actorJwt $supervisorJwt -employeeId $employeeProfile.id -restaurantId $restaurantId -label 'empleado' | Out-Null
Ensure-StartableScheduledShift -supabaseUrl $supabaseUrl -anonKey $anonKey -adminJwt $adminJwt -actorJwt $supervisorJwt -employeeId $supervisorProfile.id -restaurantId $restaurantId -label 'supervisora' | Out-Null

Write-Host '[E2E] Starting employee shift...'
$employeeShift = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -fnName 'shifts_start' -payload @{
  restaurant_id = $restaurantId
  lat = $restaurantLat
  lng = $restaurantLng
  fit_for_work = $true
  declaration = 'Ingreso OK (demo)'
} -extraHeaders @{ 'x-shift-otp-token' = $employeeOtpToken; 'x-device-fingerprint' = $deviceEmployee }

$employeeShiftId = [int]$employeeShift.data.shift_id

Ensure-ShiftEvidence -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -otpToken $employeeOtpToken -deviceFingerprint $deviceEmployee -shiftId $employeeShiftId -lat $restaurantLat -lng $restaurantLng -type 'inicio'

Write-Host '[E2E] Creating task as supervisora...'
$taskCreate = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -fnName 'operational_tasks_manage' -payload @{
  action = 'create'
  shift_id = $employeeShiftId
  assigned_employee_id = $employeeProfile.id
  title = 'Limpieza demo'
  description = 'Limpieza de zona de pruebas y evidencia.'
  priority = 'normal'
} 
$taskId = [int]$taskCreate.data.task_id

Write-Host '[E2E] Completing task as empleado...'
$taskEvidence = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -fnName 'operational_tasks_manage' -payload @{
  action = 'request_evidence_upload'
  task_id = $taskId
  mime_type = 'image/png'
}

$taskUpload = $taskEvidence.data.upload
$taskUploadUrl = $taskUpload.signedUrl
if (-not $taskUploadUrl) { $taskUploadUrl = $taskUpload.signed_url }
if (-not $taskUploadUrl) { $taskUploadUrl = $taskUpload.uploadUrl }
if (-not $taskUploadUrl) { throw 'Task signed upload URL missing.' }

$pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
$pngBytes = [Convert]::FromBase64String($pngBase64)
$taskTemp = Join-Path $env:TEMP ("task-" + [guid]::NewGuid().ToString() + ".png")
[IO.File]::WriteAllBytes($taskTemp, $pngBytes)
try {
  Invoke-RestMethod -Method Put -Uri $taskUploadUrl -ContentType 'image/png' -InFile $taskTemp | Out-Null
} finally {
  if (Test-Path $taskTemp) { Remove-Item $taskTemp -Force }
}

Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -fnName 'operational_tasks_manage' -payload @{
  action = 'complete'
  task_id = $taskId
  evidence_path = $taskEvidence.data.path
} | Out-Null

Write-Host '[E2E] Supplies flow (supervisora)...'
$supplies = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -fnName 'supplies_deliver' -payload @{
  action = 'list_supplies'
  restaurant_id = $restaurantId
  limit = 5
}
if ($supplies.data.items.Count -gt 0) {
  $supplyId = [int]$supplies.data.items[0].id
  Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -fnName 'supplies_deliver' -payload @{
    action = 'deliver'
    supply_id = $supplyId
    restaurant_id = $restaurantId
    quantity = 1
  } | Out-Null
}

Write-Host '[E2E] Ending employee shift...'
Ensure-ShiftEvidence -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -otpToken $employeeOtpToken -deviceFingerprint $deviceEmployee -shiftId $employeeShiftId -lat $restaurantLat -lng $restaurantLng -type 'fin'

Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $employeeJwt -fnName 'shifts_end' -payload @{
  shift_id = $employeeShiftId
  lat = $restaurantLat
  lng = $restaurantLng
  fit_for_work = $true
  declaration = 'Salida OK (demo)'
  early_end_reason = 'Salida anticipada por demo'
} -extraHeaders @{ 'x-shift-otp-token' = $employeeOtpToken; 'x-device-fingerprint' = $deviceEmployee } | Out-Null

Write-Host '[E2E] Starting supervisora shift...'
$supervisorShift = Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -fnName 'shifts_start' -payload @{
  restaurant_id = $restaurantId
  lat = $restaurantLat
  lng = $restaurantLng
  fit_for_work = $true
  declaration = 'Ingreso supervisora OK (demo)'
} -extraHeaders @{ 'x-shift-otp-token' = $supervisorOtpToken; 'x-device-fingerprint' = $deviceSupervisor }

$supervisorShiftId = [int]$supervisorShift.data.shift_id
Ensure-ShiftEvidence -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -otpToken $supervisorOtpToken -deviceFingerprint $deviceSupervisor -shiftId $supervisorShiftId -lat $restaurantLat -lng $restaurantLng -type 'inicio'
Ensure-ShiftEvidence -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -otpToken $supervisorOtpToken -deviceFingerprint $deviceSupervisor -shiftId $supervisorShiftId -lat $restaurantLat -lng $restaurantLng -type 'fin'

Invoke-Edge -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $supervisorJwt -fnName 'shifts_end' -payload @{
  shift_id = $supervisorShiftId
  lat = $restaurantLat
  lng = $restaurantLng
  fit_for_work = $true
  declaration = 'Salida supervisora OK (demo)'
  early_end_reason = 'Salida anticipada por demo'
} -extraHeaders @{ 'x-shift-otp-token' = $supervisorOtpToken; 'x-device-fingerprint' = $deviceSupervisor } | Out-Null

Write-Host '[E2E] Flow completed successfully.'
