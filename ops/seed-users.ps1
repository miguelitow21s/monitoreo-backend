param(
  [Parameter(Mandatory=$true)] [string]$SupabaseUrl,
  [Parameter(Mandatory=$true)] [string]$AnonKey,
  [Parameter(Mandatory=$true)] [string]$AdminJwt
)

$ErrorActionPreference = 'Stop'

$headers = @{
  "Authorization"  = "Bearer $AdminJwt"
  "apikey"         = $AnonKey
  "Content-Type"   = "application/json"
}

$users = @(
  @{ role="supervisora"; first_name="Brandon"; last_name="Martinez"; email="Bm9335929@gmail.com";                  phone="+12137251080"; password="384729" },
  @{ role="supervisora"; first_name="Veronica"; last_name="Castro";   email="veronicacastro73@yahoo.com";           phone="+16572367682"; password="051846" },
  @{ role="empleado";    first_name="Arturo";   last_name="Munoz";    email="arturo.munoz96@yahoo.com";             phone="+17143539683"; password="729403" },
  @{ role="empleado";    first_name="Alexander"; last_name="Jarquin"; email="alexanderjarquin910@gmail.com";        phone="+18183355820"; password="163850" },
  @{ role="empleado";    first_name="Eliezer";  last_name="Velasquez";email="velasquezeliezer992@gmail.com";        phone="+13234037410"; password="508274" },
  @{ role="empleado";    first_name="Carlos";   last_name="Lux";      email="cluxcamaja@gmail.com";                 phone="+13239632605"; password="847031" },
  @{ role="empleado";    first_name="Wendy";    last_name="Jimenez";  email="madrid2016wendy@gmail.com";            phone="+12132759303"; password="293617" },
  @{ role="empleado";    first_name="Jonathan"; last_name="Jarol";    email="jaroljonathan8@gmail.com";             phone="+12132784035"; password="750192" },
  @{ role="empleado";    first_name="Pedro";    last_name="Mendoza";  email="dylananthuan3@gmail.com";              phone="+12132735146"; password="416083" },
  # Elizabeth Mendoza omitida — email duplicado (dylananthuan3@gmail.com)
  @{ role="empleado";    first_name="Jose";     last_name="Peralta";  email="jaseangelsevillasevilla@gmail.com";    phone="+12134403547"; password="637259" },
  @{ role="empleado";    first_name="Douglas";  last_name="Tercero";  email="douglastercero98@gmail.com";           phone="+12138181740"; password="924705" },
  @{ role="empleado";    first_name="Abraham";  last_name="Vivas";    email="sofiab.lemus@hotmail.com";             phone="+17147819779"; password="381064" }
)

$endpoint = "$SupabaseUrl/functions/v1/admin_users_manage"
$created  = @()
$failed   = @()

foreach ($u in $users) {
  $idempotencyKey = [System.Guid]::NewGuid().ToString()
  $reqHeaders = $headers.Clone()
  $reqHeaders["Idempotency-Key"] = $idempotencyKey

  $body = @{
    action       = "create"
    email        = $u.email
    role         = $u.role
    password     = $u.password
    first_name   = $u.first_name
    last_name    = $u.last_name
    phone_number = $u.phone
    is_active    = $true
  } | ConvertTo-Json

  try {
    $res = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $reqHeaders -Body $body
    Write-Host "[OK] $($u.first_name) $($u.last_name) — $($u.email)"
    $created += [PSCustomObject]@{
      Nombre   = "$($u.first_name) $($u.last_name)"
      Email    = $u.email
      Rol      = $u.role
      PIN      = $u.password
      Telefono = $u.phone
    }
  } catch {
    $errMsg = $_.Exception.Message
    Write-Host "[FAIL] $($u.first_name) $($u.last_name) — $errMsg" -ForegroundColor Red
    $failed += [PSCustomObject]@{
      Nombre = "$($u.first_name) $($u.last_name)"
      Email  = $u.email
      Error  = $errMsg
    }
  }

  Start-Sleep -Milliseconds 300
}

Write-Host ""
Write-Host "===== RESULTADO =====" -ForegroundColor Cyan
Write-Host "Creados : $($created.Count)"
Write-Host "Fallidos: $($failed.Count)"

if ($created.Count -gt 0) {
  Write-Host ""
  Write-Host "--- Usuarios creados ---" -ForegroundColor Green
  $created | Format-Table -AutoSize
}

if ($failed.Count -gt 0) {
  Write-Host ""
  Write-Host "--- Errores ---" -ForegroundColor Red
  $failed | Format-Table -AutoSize
}
