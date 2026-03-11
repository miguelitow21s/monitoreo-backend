# API Contract Frontend Complete

Fuente: `supabase/functions/*/index.ts`.
Objetivo: contrato unico para frontend, con reglas para evitar fallos en produccion.

## 1) Base URL y formato
- Base URL Edge Functions: `/functions/v1/{endpoint}`
- Respuesta estandar en todos los endpoints:
```json
{
  "success": true,
  "data": {},
  "error": null,
  "request_id": "uuid"
}
```
- En error:
```json
{
  "success": false,
  "data": null,
  "error": {
    "code": 409,
    "message": "...",
    "category": "BUSINESS",
    "request_id": "uuid"
  },
  "request_id": "uuid"
}
```

## 2) Headers globales
Headers requeridos para casi todos los `POST`:
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`
- `Idempotency-Key: <unique_key>`

Headers de seguridad por flujo:
- `x-device-fingerprint: <device_id>` requerido en flujos de trusted device / OTP / turnos.
- `x-shift-otp-token: <verification_token>` requerido para operar turnos y acciones sensibles.

CORS permite:
- `authorization, x-client-info, apikey, content-type, idempotency-key, x-device-fingerprint, x-shift-otp-token`

## 3) Reglas criticas de negocio
- Rol obligatorio por endpoint. No intentar llamadas fuera de rol.
- `Idempotency-Key` nuevo por intento logico nuevo.
- No iniciar turno con turno activo.
- Geocerca valida en inicio/fin de turno y evidencia de turno.
- Turnos requieren: dispositivo confiable + sesion OTP valida + terminos legales aceptados.
- Supervisora siempre bajo alcance de restaurante.

## 4) Flujo recomendado de autenticacion operativa
1. `trusted_device_validate`
2. si `registration_required=true` -> `trusted_device_register`
3. `phone_otp_send`
4. `phone_otp_verify` (guardar `verification_token`)
5. enviar `x-shift-otp-token` en operaciones de turno

## 5) Catalogo de endpoints

### 5.1 Health
#### GET `/functions/v1/health_ping`
- Auth: no obligatoria en codigo.
- Body: none
- Data:
```json
{ "status": "ok", "service": "health_ping" }
```

### 5.2 Trusted Device
#### POST `/functions/v1/trusted_device_validate`
- Roles: cualquier usuario autenticado.
- Body:
```json
{ "device_fingerprint": "optional_string_16_256" }
```
- Data:
```json
{
  "trusted": true,
  "first_login_binding": false,
  "registration_required": false,
  "trusted_devices_count": 1,
  "device_id": 10,
  "trusted_at": "iso",
  "last_seen_at": "iso"
}
```

#### POST `/functions/v1/trusted_device_register`
- Roles: cualquier usuario autenticado.
- Body:
```json
{
  "device_fingerprint": "optional_string_16_256",
  "device_name": "optional",
  "platform": "optional"
}
```
- Data:
```json
{
  "device_id": 10,
  "trusted_at": "iso",
  "last_seen_at": "iso",
  "first_login_binding": true,
  "device_name": "Android 15",
  "platform": "android"
}
```

#### POST `/functions/v1/trusted_device_revoke`
- Roles: cualquier usuario autenticado.
- Body (al menos uno):
```json
{ "device_id": 10 }
```
```json
{ "device_fingerprint": "..." }
```
- Data:
```json
{ "revoked_device_id": 10 }
```

### 5.3 OTP movil
#### POST `/functions/v1/phone_otp_send`
- Roles: cualquier usuario autenticado.
- Requiere device trusted.
- Body:
```json
{ "device_fingerprint": "optional" }
```
- Data:
```json
{
  "trusted_device_id": 10,
  "otp_id": 22,
  "expires_at": "iso",
  "masked_phone": "+57***123",
  "delivery_status": "sent"
}
```

#### POST `/functions/v1/phone_otp_verify`
- Roles: cualquier usuario autenticado.
- Requiere device trusted.
- Body:
```json
{ "code": "123456", "device_fingerprint": "optional" }
```
- Data:
```json
{
  "trusted_device_id": 10,
  "verification_token": "token_hex",
  "expires_at": "iso"
}
```

### 5.4 Legal consent
#### POST `/functions/v1/legal_consent`
Acciones:
- `status`
```json
{ "action": "status" }
```
Data:
```json
{
  "accepted": true,
  "accepted_at": "iso_or_null",
  "active_term": {
    "id": 1,
    "code": "...",
    "version": "..."
  }
}
```

- `accept`
```json
{ "action": "accept", "legal_terms_id": 1 }
```
Data:
```json
{ "accepted": true, "legal_terms_id": 1, "accepted_at": "iso" }
```

### 5.5 Turnos operativos
#### POST `/functions/v1/shifts_start`
- Rol: `empleado`
- Requiere: legal consent + trusted device + `x-shift-otp-token`
- Body:
```json
{
  "restaurant_id": 1,
  "lat": 4.711,
  "lng": -74.072,
  "fit_for_work": true,
  "declaration": "optional"
}
```
- Data:
```json
{ "shift_id": 1001 }
```

#### POST `/functions/v1/shifts_end`
- Rol: `empleado`
- Requiere: legal consent + trusted device + `x-shift-otp-token`
- Body:
```json
{
  "shift_id": 1001,
  "lat": 4.711,
  "lng": -74.072,
  "fit_for_work": true,
  "declaration": "optional"
}
```
- Data: `{}`

#### POST `/functions/v1/shifts_approve`
- Roles: `supervisora`, `super_admin`
- Requiere: legal consent + trusted device + `x-shift-otp-token`
- Body:
```json
{ "shift_id": 1001 }
```
- Data: `{}`

#### POST `/functions/v1/shifts_reject`
- Roles: `supervisora`, `super_admin`
- Requiere: legal consent + trusted device + `x-shift-otp-token`
- Body:
```json
{ "shift_id": 1001 }
```
- Data: `{}`

### 5.6 Evidencia
#### POST `/functions/v1/evidence_upload`
- Rol: `empleado`
- Requiere: legal consent + trusted device + `x-shift-otp-token`
- Accion `request_upload`:
```json
{ "action": "request_upload", "shift_id": 1001, "type": "inicio" }
```
- Data:
```json
{
  "upload": { "token": "...", "path": "..." },
  "bucket": "shift-evidence",
  "path": "user/shift/type/file.bin",
  "max_bytes": 8388608,
  "allowed_mime": ["image/jpeg", "image/png", "image/webp"]
}
```

- Accion `finalize_upload`:
```json
{
  "action": "finalize_upload",
  "shift_id": 1001,
  "type": "inicio",
  "path": "<path_devuelto>",
  "lat": 4.711,
  "lng": -74.072,
  "accuracy": 12,
  "captured_at": "2026-03-10T14:00:00.000Z"
}
```
- Data:
```json
{ "shift_id": 1001, "type": "inicio", "storage_path": "...", "sha256": "..." }
```

### 5.7 Incidentes
#### POST `/functions/v1/incidents_create`
- Roles: `empleado`, `supervisora`, `super_admin`
- Requiere: legal consent + trusted device + `x-shift-otp-token`
- Body minimo:
```json
{ "shift_id": 1001, "description": "detalle incidente" }
```
- Body con tarea opcional (solo supervisora/super_admin):
```json
{
  "shift_id": 1001,
  "description": "detalle incidente",
  "task": {
    "assigned_employee_id": "uuid",
    "title": "Reponer stock",
    "description": "...",
    "priority": "normal",
    "due_at": "2026-03-10T18:00:00.000Z"
  }
}
```
- Data:
```json
{ "incident_id": 501, "task_id": 9001 }
```

### 5.8 Insumos
#### POST `/functions/v1/supplies_deliver`
- Roles: `supervisora`, `super_admin`
- Requiere: legal consent
- Body:
```json
{ "supply_id": 1, "restaurant_id": 2, "quantity": 5 }
```
- Data:
```json
{ "delivery_id": 7001 }
```

### 5.9 Reportes
#### POST `/functions/v1/reports_generate`
- Roles: `supervisora`, `super_admin`
- Requiere: legal consent
- Body:
```json
{
  "restaurant_id": 2,
  "period_start": "2026-03-01",
  "period_end": "2026-03-10",
  "filtros_json": {},
  "columns": ["shift_id", "employee_id"],
  "export_format": "both"
}
```
- Data:
```json
{
  "report_id": 88,
  "generated_at": "iso",
  "file_path": "reports/...json",
  "hash_documento": "sha256",
  "url_pdf": "signed_url_or_empty",
  "url_excel": "signed_url_or_empty"
}
```

### 5.10 Agenda programada
#### POST `/functions/v1/scheduled_shifts_manage`
- Roles: `supervisora`, `super_admin`
- Requiere: legal consent

Acciones:
- `assign`
```json
{
  "action": "assign",
  "employee_id": "uuid",
  "restaurant_id": 2,
  "scheduled_start": "2026-03-11T08:00:00.000Z",
  "scheduled_end": "2026-03-11T16:00:00.000Z",
  "notes": "optional"
}
```
Data: `{ "scheduled_shift_id": 1 }`

- `bulk_assign`
```json
{
  "action": "bulk_assign",
  "entries": [
    {
      "employee_id": "uuid",
      "restaurant_id": 2,
      "scheduled_start": "2026-03-11T08:00:00.000Z",
      "scheduled_end": "2026-03-11T16:00:00.000Z",
      "notes": "optional"
    }
  ]
}
```
Data:
```json
{
  "total": 1,
  "created": 1,
  "failed": 0,
  "created_ids": [1],
  "errors": []
}
```

- `reschedule`
```json
{
  "action": "reschedule",
  "scheduled_shift_id": 1,
  "scheduled_start": "2026-03-11T09:00:00.000Z",
  "scheduled_end": "2026-03-11T17:00:00.000Z",
  "notes": "optional"
}
```
Data: `{ "scheduled_shift_id": 1 }`

- `cancel`
```json
{ "action": "cancel", "scheduled_shift_id": 1, "reason": "optional" }
```
Data: `{ "scheduled_shift_id": 1 }`

- `list`
```json
{
  "action": "list",
  "employee_id": "optional_uuid",
  "restaurant_id": 2,
  "status": "scheduled",
  "from": "2026-03-01T00:00:00.000Z",
  "to": "2026-03-31T23:59:59.999Z",
  "limit": 100
}
```
Data: `{ "items": [...] }`

### 5.11 Tareas operativas
#### POST `/functions/v1/operational_tasks_manage`
- Requiere: legal consent

Acciones:
- `create` (roles: `supervisora`, `super_admin`)
```json
{
  "action": "create",
  "shift_id": 1001,
  "assigned_employee_id": "uuid",
  "title": "...",
  "description": "...",
  "priority": "normal",
  "due_at": "optional_iso"
}
```
Data: `{ "task_id": 9001 }`

- `request_manifest_upload` (roles: `empleado`, `supervisora`, `super_admin`)
```json
{ "action": "request_manifest_upload", "task_id": 9001 }
```
Data:
```json
{
  "upload": { "token": "...", "path": "..." },
  "bucket": "shift-evidence",
  "path": "users/{uid}/task-manifest/{task_id}/{request_id}.json",
  "required_mime": "application/json"
}
```

- `complete` (roles: `empleado`, `supervisora`, `super_admin`)
```json
{ "action": "complete", "task_id": 9001, "evidence_path": "...json" }
```
Data: `{ "task_id": 9001 }`

- `list_my_open` (rol: `empleado`)
```json
{ "action": "list_my_open", "shift_id": 1001, "limit": 50 }
```
Data: `{ "items": [...] }`

- `list_supervision` (roles: `supervisora`, `super_admin`)
```json
{
  "action": "list_supervision",
  "restaurant_id": 2,
  "status": "pending",
  "limit": 100
}
```
Data: `{ "items": [...] }`

### 5.12 Auditoria admin
#### POST `/functions/v1/audit_log`
- Rol: `super_admin`
- Requiere: legal consent
- Body:
```json
{ "action": "ANY_ACTION", "context": { "k": "v" } }
```
- Data: `{}`

### 5.13 Dispatch de emails
#### POST `/functions/v1/email_notifications_dispatch`
- Rol: `super_admin`
- Body:
```json
{
  "enqueue_shift_not_started": true,
  "overdue_limit": 100,
  "grace_minutes": 15,
  "dispatch_limit": 50,
  "max_attempts": 5
}
```
- Data:
```json
{
  "queued_shift_not_started": 3,
  "attempted": 10,
  "sent": 8,
  "failed": 1,
  "skipped": 1
}
```

## 6) Errores frecuentes que frontend debe manejar
- `401 AUTH`: token invalido, expirado o anon.
- `403 PERMISSION`: rol no permitido, OTP invalido/expirado, dispositivo no confiable.
- `409 BUSINESS`: conflictos de estado (turno activo, turno no encontrado en estado esperado, etc).
- `422 VALIDATION`: payload o parametros invalidos.
- `500 SYSTEM`: error interno.

Mensajes comunes esperables:
- `Ya existe un turno activo`
- `GPS fuera de radio`
- `OTP de celular requerido para operar turnos`
- `OTP de celular invalido`
- `OTP de celular expirado`
- `Dispositivo no confiable para esta cuenta`
- `Debes registrar tu dispositivo en el primer login`

## 7) Checklist de integracion frontend (obligatorio)
1. Implementar cliente HTTP unico que siempre adjunte headers base.
2. Generar y guardar `Idempotency-Key` por intento logico.
3. Guardar `x-shift-otp-token` tras `phone_otp_verify`.
4. Reusar `x-device-fingerprint` estable por dispositivo.
5. Mostrar `request_id` en errores UI para soporte.
6. No ocultar mensaje backend en errores de negocio.
7. Probar flujos por rol: empleado, supervisora, super_admin.
8. Probar expiracion OTP y retry con flujo completo.
9. Probar geocerca dentro/fuera de radio.
10. Probar idempotencia en reintentos de red.

## 8) Nota operativa importante
- Para `shifts_start` y `shifts_end`, ya existe fix de RLS aplicado en migracion:
`supabase/migrations/020_fix_shifts_employee_rls_for_edge_functions.sql`

