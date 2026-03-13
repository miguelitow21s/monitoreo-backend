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

function To-Array($value) {
  if ($null -eq $value) { return @() }
  if ($value -is [array]) { return $value }
  return @($value)
}

function Escape([string]$text) {
  return [System.Uri]::EscapeDataString($text)
}

function Invoke-AuthToken([string]$supabaseUrl, [string]$anonKey, [string]$email, [string]$password, [string]$label) {
  $url = "$($supabaseUrl.TrimEnd('/'))/auth/v1/token?grant_type=password"
  $headers = @{ apikey = $anonKey; 'Content-Type' = 'application/json' }
  $body = @{ email = $email; password = $password } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -Body $body
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
  if ($script:seedDebug) { Write-Host "[DEBUG] method=$method base=$supabaseUrl table=$table url=$url" }
  $headers = @{ apikey = $anonKey; Authorization = "Bearer $jwt"; Accept = 'application/json' }
  if ($prefer) { $headers['Prefer'] = $prefer }
  if ($null -ne $body) {
    $headers['Content-Type'] = 'application/json'
    $json = $body | ConvertTo-Json -Depth 8
    return Invoke-RestMethod -Method $method -Uri $url -Headers $headers -Body $json
  }
  return Invoke-RestMethod -Method $method -Uri $url -Headers $headers
}

$supabaseUrl = (Require-Env 'SUPABASE_URL').TrimEnd('/')
$anonKey = Require-Env 'SUPABASE_ANON_KEY'
$adminEmail = Require-Env 'SEED_SUPER_ADMIN_EMAIL'
$adminPassword = Require-Env 'SEED_SUPER_ADMIN_PASSWORD'
$employeeEmail = Require-Env 'SEED_EMPLEADO_EMAIL'
$employeePassword = Require-Env 'SEED_EMPLEADO_PASSWORD'
$employeeEmail2 = Get-OptionalEnv 'SEED_EMPLEADO_EMAIL_2'
$employeePassword2 = Get-OptionalEnv 'SEED_EMPLEADO_PASSWORD_2'
$supervisorEmail = Get-OptionalEnv 'SEED_SUPERVISORA_EMAIL'
$seedRestaurantIdRaw = Get-OptionalEnv 'SEED_RESTAURANT_ID'
$script:seedDebug = Get-OptionalEnv 'SEED_DEBUG'

Write-Host '[SEED] Authenticating...'
$adminJwt = Invoke-AuthToken -supabaseUrl $supabaseUrl -anonKey $anonKey -email $adminEmail -password $adminPassword -label 'super_admin'
$employeeJwt = Invoke-AuthToken -supabaseUrl $supabaseUrl -anonKey $anonKey -email $employeeEmail -password $employeePassword -label 'empleado'
$employeeJwt2 = $null
if ($employeeEmail2 -and $employeePassword2) {
  $employeeJwt2 = Invoke-AuthToken -supabaseUrl $supabaseUrl -anonKey $anonKey -email $employeeEmail2 -password $employeePassword2 -label 'empleado_2'
}

function Get-ProfileByEmail([string]$jwt, [string]$email) {
  $encoded = Escape $email
  $query = "select=id,email,role,is_active&email=eq.$encoded&limit=1"
  $rows = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -table 'profiles' -query $query)
  if ($rows.Count -eq 0) { return $null }
  return $rows[0]
}

$adminProfile = Get-ProfileByEmail -jwt $adminJwt -email $adminEmail
if (-not $adminProfile) { throw "Admin profile not found for $adminEmail" }

$employeeProfile = Get-ProfileByEmail -jwt $adminJwt -email $employeeEmail
if (-not $employeeProfile) { throw "Empleado profile not found for $employeeEmail" }

$employeeProfile2 = $null
if ($employeeEmail2) {
  $employeeProfile2 = Get-ProfileByEmail -jwt $adminJwt -email $employeeEmail2
  if (-not $employeeProfile2) { throw "Empleado2 profile not found for $employeeEmail2" }
}

$supervisorProfile = $null
if ($supervisorEmail) {
  $supervisorProfile = Get-ProfileByEmail -jwt $adminJwt -email $supervisorEmail
  if (-not $supervisorProfile) { Write-Host "[WARN] Supervisora profile not found for $supervisorEmail" }
}

$restaurantId = $null
if ($seedRestaurantIdRaw) { $restaurantId = [int]$seedRestaurantIdRaw }

if (-not $restaurantId -and $supervisorProfile) {
  $links = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurant_employees' -query "select=restaurant_id&user_id=eq.$($supervisorProfile.id)&limit=1")
  if ($links.Count -gt 0) { $restaurantId = [int]$links[0].restaurant_id }
}

if (-not $restaurantId) {
  $restaurants = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurants' -query 'select=id,name,is_active&is_active=eq.true&limit=1')
  if ($restaurants.Count -gt 0) { $restaurantId = [int]$restaurants[0].id }
}

if (-not $restaurantId) {
  Write-Host '[SEED] Creating demo restaurant...'
  $payload = @{
    name = 'Restaurante Demo'
    lat = 4.651
    lng = -74.094
    radius = 150
    geofence_radius_m = 150
    is_active = $true
    city = 'Bogota'
    state = 'Cundinamarca'
    country = 'CO'
  }
  $created = To-Array (Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurants' -body $payload -prefer 'return=representation')
  if ($created.Count -eq 0) { throw 'Failed to create demo restaurant' }
  $restaurantId = [int]$created[0].id
}

Write-Host "[SEED] Using restaurant_id=$restaurantId"

$upsertPrefer = 'resolution=merge-duplicates,return=representation'
function Upsert-RestaurantEmployee([string]$userId) {
  $body = @(@{ restaurant_id = $restaurantId; user_id = $userId })
  Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'restaurant_employees' -query 'on_conflict=restaurant_id,user_id' -body $body -prefer $upsertPrefer | Out-Null
}

if ($supervisorProfile) { Upsert-RestaurantEmployee -userId $supervisorProfile.id }
Upsert-RestaurantEmployee -userId $employeeProfile.id
if ($employeeProfile2) { Upsert-RestaurantEmployee -userId $employeeProfile2.id }

$existingSupplies = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'supplies' -query "select=id,name,restaurant_id&restaurant_id=eq.$restaurantId")
$existingNames = @{}
foreach ($row in $existingSupplies) { $existingNames[[string]$row.name] = $true }

$desiredSupplies = @(
  @{ name = 'Jabon liquido'; unit = 'litro'; stock = 25; unit_cost = 7.5 },
  @{ name = 'Desinfectante'; unit = 'litro'; stock = 18; unit_cost = 6.2 },
  @{ name = 'Toallas de papel'; unit = 'paquete'; stock = 30; unit_cost = 4.9 },
  @{ name = 'Guantes de nitrilo'; unit = 'caja'; stock = 12; unit_cost = 11.5 },
  @{ name = 'Bolsas de basura'; unit = 'rollo'; stock = 20; unit_cost = 3.8 }
)

$suppliesInserted = 0
foreach ($item in $desiredSupplies) {
  if (-not $existingNames.ContainsKey($item.name)) {
    $payload = @{
      name = $item.name
      unit = $item.unit
      stock = $item.stock
      unit_cost = $item.unit_cost
      restaurant_id = $restaurantId
    }
    Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'supplies' -body $payload -prefer 'return=representation' | Out-Null
    $suppliesInserted++
  }
}

$allSupplies = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'supplies' -query "select=id,name,restaurant_id&restaurant_id=eq.$restaurantId")
$deliveriesInserted = 0
if ($allSupplies.Count -gt 0) {
  $hasDeliveries = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'supply_deliveries' -query "select=id&restaurant_id=eq.$restaurantId&limit=1")
  if ($hasDeliveries.Count -eq 0) {
    $now = [DateTime]::UtcNow
    $targets = $allSupplies | Select-Object -First ([Math]::Min(3, $allSupplies.Count))
    $payload = @()
    $offset = 0
    foreach ($supply in $targets) {
      $payload += @{
        supply_id = $supply.id
        restaurant_id = $restaurantId
        quantity = 6 + ($offset * 2)
        delivered_at = $now.AddDays(-3 - $offset).ToString('o')
        delivered_by = $adminProfile.id
      }
      $offset++
    }
    Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'supply_deliveries' -body $payload -prefer 'return=representation' | Out-Null
    $deliveriesInserted = $payload.Count
  }
}

$scheduledInserted = 0
$nowIso = [DateTime]::UtcNow.ToString('o')
$scheduledExisting = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'scheduled_shifts' -query "select=id&employee_id=eq.$($employeeProfile.id)&status=eq.scheduled&scheduled_start=gte.$(Escape $nowIso)&limit=1")
if ($scheduledExisting.Count -eq 0) {
  $base = [DateTime]::UtcNow.Date
  $start1 = $base.AddDays(1).AddHours(13)
  $end1 = $start1.AddHours(8)
  $start2 = $base.AddDays(2).AddHours(13)
  $end2 = $start2.AddHours(8)
  $payload = @(
    @{ employee_id = $employeeProfile.id; restaurant_id = $restaurantId; scheduled_start = $start1.ToString('o'); scheduled_end = $end1.ToString('o'); status = 'scheduled' },
    @{ employee_id = $employeeProfile.id; restaurant_id = $restaurantId; scheduled_start = $start2.ToString('o'); scheduled_end = $end2.ToString('o'); status = 'scheduled' }
  )
  Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'scheduled_shifts' -body $payload -prefer 'return=representation' | Out-Null
  $scheduledInserted = $payload.Count
}

function Create-CompletedShift([string]$jwt, [string]$employeeId, [int]$restaurantId, [datetime]$startUtc, [datetime]$endUtc) {
  $payload = @{
    employee_id = $employeeId
    restaurant_id = $restaurantId
    start_time = $startUtc.ToString('o')
    start_lat = 4.651
    start_lng = -74.094
    state = 'activo'
  }
  $created = To-Array (Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -table 'shifts' -body $payload -prefer 'return=representation')
  if ($created.Count -eq 0) { throw 'Failed to create shift' }
  $shiftId = [int]$created[0].id
  $update = @{
    end_time = $endUtc.ToString('o')
    end_lat = 4.651
    end_lng = -74.094
    state = 'finalizado'
  }
  Invoke-Postgrest -method 'PATCH' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $jwt -table 'shifts' -query "id=eq.$shiftId" -body $update -prefer 'return=representation' | Out-Null
  return $shiftId
}

$shiftIds = @()
$historyExisting = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'shifts' -query "select=id&employee_id=eq.$($employeeProfile.id)&end_time=is.not_null&limit=1")
if ($historyExisting.Count -eq 0) {
  $base = [DateTime]::UtcNow.Date
  $shift1Start = $base.AddDays(-3).AddHours(13)
  $shift1End = $shift1Start.AddHours(6)
  $shift2Start = $base.AddDays(-1).AddHours(13)
  $shift2End = $shift2Start.AddHours(7)
  $shiftIds += Create-CompletedShift -jwt $employeeJwt -employeeId $employeeProfile.id -restaurantId $restaurantId -startUtc $shift1Start -endUtc $shift1End
  $shiftIds += Create-CompletedShift -jwt $employeeJwt -employeeId $employeeProfile.id -restaurantId $restaurantId -startUtc $shift2Start -endUtc $shift2End
}

$taskShiftId = $null
if ($shiftIds.Count -gt 0) {
  $taskShiftId = $shiftIds[0]
} else {
  $latestShift = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'shifts' -query "select=id&employee_id=eq.$($employeeProfile.id)&order=start_time.desc&limit=1")
  if ($latestShift.Count -gt 0) { $taskShiftId = [int]$latestShift[0].id }
}

$tasksInserted = 0
if ($taskShiftId) {
  $taskExisting = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'operational_tasks' -query "select=id&assigned_employee_id=eq.$($employeeProfile.id)&status=in.(pending,in_progress)&limit=1")
  if ($taskExisting.Count -eq 0) {
    $dueAt = [DateTime]::UtcNow.AddDays(1).ToString('o')
    $payload = @(
      @{
        shift_id = $taskShiftId
        restaurant_id = $restaurantId
        assigned_employee_id = $employeeProfile.id
        created_by = $adminProfile.id
        title = 'Limpieza de banos'
        description = 'Realizar limpieza profunda y reportar evidencia.'
        priority = 'high'
        status = 'pending'
        due_at = $dueAt
      },
      @{
        shift_id = $taskShiftId
        restaurant_id = $restaurantId
        assigned_employee_id = $employeeProfile.id
        created_by = $adminProfile.id
        title = 'Desinfeccion de cocina'
        description = 'Desinfectar superficies de cocina y dejar evidencia.'
        priority = 'normal'
        status = 'pending'
        due_at = $dueAt
      }
    )
    Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'operational_tasks' -body $payload -prefer 'return=representation' | Out-Null
    $tasksInserted = $payload.Count
  }
}

$incidentsInserted = 0
if ($taskShiftId) {
  $incidentExisting = To-Array (Invoke-Postgrest -method 'GET' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'incidents' -query "select=id&shift_id=eq.$taskShiftId&limit=1")
  if ($incidentExisting.Count -eq 0) {
    $payload = @{
      shift_id = $taskShiftId
      description = 'Incidencia demo: se encontro una zona con riesgo de resbalon.'
      created_by = $adminProfile.id
      created_at = [DateTime]::UtcNow.ToString('o')
      status = 'open'
    }
    Invoke-Postgrest -method 'POST' -supabaseUrl $supabaseUrl -anonKey $anonKey -jwt $adminJwt -table 'incidents' -body $payload -prefer 'return=representation' | Out-Null
    $incidentsInserted = 1
  }
}

Write-Host "[SEED] Supplies inserted: $suppliesInserted"
Write-Host "[SEED] Deliveries inserted: $deliveriesInserted"
Write-Host "[SEED] Scheduled shifts inserted: $scheduledInserted"
Write-Host "[SEED] Shifts created: $($shiftIds.Count)"
Write-Host "[SEED] Tasks inserted: $tasksInserted"
Write-Host "[SEED] Incidents inserted: $incidentsInserted"
Write-Host '[SEED] Done'
