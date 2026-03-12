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
- Roles: `empleado`, `supervisora` (turno propio)
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
{
  "shift_id": 1001,
  "pending_tasks_count": 2,
  "pending_tasks_preview": [
    { "id": 9001, "title": "Reponer jabon", "priority": "high", "due_at": "optional_iso" }
  ]
}
```

#### POST `/functions/v1/shifts_end`
- Roles: `empleado`, `supervisora` (turno propio)
- Requiere: legal consent + trusted device + `x-shift-otp-token`
- Validacion obligatoria previa: deben existir fotos `inicio` y `fin` en `evidence_upload` para el mismo `shift_id`.
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
- Regla operativa: para cerrar turno, se exige evidencia `inicio` y `fin` del turno.
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

- `request_evidence_upload` (roles: `empleado`, `supervisora`, `super_admin`)
```json
{ "action": "request_evidence_upload", "task_id": 9001, "mime_type": "image/jpeg" }
```
Data:
```json
{
  "upload": { "token": "...", "path": "..." },
  "bucket": "shift-evidence",
  "path": "users/{uid}/task-evidence/{task_id}/{request_id}.jpg",
  "allowed_mime": ["image/jpeg", "image/png", "image/webp"],
  "max_bytes": 8388608
}
```

- `complete` (roles: `empleado`, `supervisora`, `super_admin`)
```json
{ "action": "complete", "task_id": 9001, "evidence_path": "...jpg" }
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

### 5.14 Administracion de usuarios
#### POST `/functions/v1/admin_users_manage`
- Rol: `super_admin`
- Requiere: legal consent
- Acciones:

- `create`
```json
{
  "action": "create",
  "email": "nuevo@empresa.com",
  "role": "supervisora",
  "password": "Temporal123!",
  "first_name": "Ana",
  "last_name": "Lopez",
  "phone_number": "+573001112233",
  "is_active": true
}
```
Data: `{ "user": { ...profile } }`

- `update`
```json
{
  "action": "update",
  "user_id": "uuid",
  "role": "empleado",
  "is_active": true,
  "full_name": "Nombre Apellido"
}
```
Data: `{ "user": { ...profile } }`

- `activate` / `deactivate`
```json
{ "action": "deactivate", "user_id": "uuid", "reason": "Baja" }
```
Data: `{ "user": { ...profile } }`

- `list`
```json
{ "action": "list", "role": "supervisora", "is_active": true, "limit": 100 }
```
Data: `{ "items": [...] }`

### 5.15 Administracion de restaurantes
#### POST `/functions/v1/admin_restaurants_manage`
- Rol: `super_admin`
- Requiere: legal consent
- Acciones:

- `create`
```json
{
  "action": "create",
  "name": "Restaurante Centro",
  "lat": 4.711,
  "lng": -74.072,
  "radius": 120,
  "address_line": "Calle 10 # 20-30",
  "city": "Bogota",
  "state": "Cundinamarca",
  "country": "CO",
  "is_active": true
}
```
Data: `{ "restaurant": { ... } }`

- `update`
```json
{ "action": "update", "restaurant_id": 2, "radius": 150, "is_active": true }
```
Data: `{ "restaurant": { ... } }`

- `activate` / `deactivate`
```json
{ "action": "deactivate", "restaurant_id": 2 }
```
Data: `{ "restaurant": { ... } }`

- `list`
```json
{ "action": "list", "is_active": true, "search": "Centro", "limit": 200 }
```
Data: `{ "items": [...] }`

### 5.16 Asignacion de supervisoras
#### POST `/functions/v1/admin_supervisors_manage`
- Rol: `super_admin`
- Requiere: legal consent
- Acciones:

- `assign`
```json
{ "action": "assign", "supervisor_id": "uuid", "restaurant_id": 2 }
```

- `unassign`
```json
{ "action": "unassign", "supervisor_id": "uuid", "restaurant_id": 2 }
```

- `list_by_restaurant`
```json
{ "action": "list_by_restaurant", "restaurant_id": 2 }
```
Data: `{ "items": [{ "supervisor_id": "uuid", "assigned_at": "iso", "supervisor": { ... } }] }`

- `list_by_supervisor`
```json
{ "action": "list_by_supervisor", "supervisor_id": "uuid" }
```
Data: `{ "items": [{ "restaurant_id": 2, "assigned_at": "iso", "restaurant": { ... } }] }`

### 5.17 Dashboard ejecutivo
#### POST `/functions/v1/admin_dashboard_metrics`
- Rol: `super_admin`
- Requiere: legal consent
- Body:
```json
{
  "action": "summary",
  "period_start": "2026-03-01",
  "period_end": "2026-03-31",
  "restaurant_id": 2
}
```

### 5.18 Asignacion de empleados por restaurante
#### POST `/functions/v1/restaurant_staff_manage`
- Roles: `supervisora`, `super_admin`
- Requiere: legal consent
- Acciones:

- `assign_employee`
```json
{ "action": "assign_employee", "employee_id": "uuid", "restaurant_id": 2 }
```

- `unassign_employee`
```json
{ "action": "unassign_employee", "employee_id": "uuid", "restaurant_id": 2 }
```

- `list_by_restaurant`
```json
{ "action": "list_by_restaurant", "restaurant_id": 2 }
```
Data: `{ "items": [{ "employee_id": "uuid", "assigned_at": "iso", "employee": { ... } }] }`

- `list_by_employee`
```json
{ "action": "list_by_employee", "employee_id": "uuid" }
```
Data: `{ "items": [{ "restaurant_id": 2, "assigned_at": "iso", "restaurant": { ... } }] }`

### 5.19 Autoservicio empleado de aseo
#### POST `/functions/v1/employee_self_service`
- Rol: `empleado`
- Requiere: legal consent
- Acciones:

- `my_dashboard`
```json
{ "action": "my_dashboard", "schedule_limit": 10, "pending_tasks_limit": 10 }
```
Data:
```json
{
  "active_shift": { "id": 1001, "restaurant_id": 2, "start_time": "iso", "state": "activo" },
  "can_start_shift": false,
  "assigned_restaurants": [{ "restaurant_id": 2, "assigned_at": "iso", "restaurant": { "id": 2, "name": "Centro" } }],
  "scheduled_shifts": [{ "id": 77, "restaurant_id": 2, "scheduled_start": "iso", "scheduled_end": "iso", "status": "scheduled", "restaurant": { "id": 2, "name": "Centro" } }],
  "pending_tasks_count": 3,
  "pending_tasks_preview": [{ "id": 9001, "title": "Limpieza campana", "status": "pending" }],
  "worked_hours_last_30d": 124.5
}
```

- `my_hours_history`
```json
{ "action": "my_hours_history", "period_start": "2026-03-01", "period_end": "2026-03-31", "limit": 120 }
```
Data:
```json
{
  "period_start": "2026-03-01",
  "period_end": "2026-03-31",
  "total_shifts": 21,
  "total_hours_worked": 162.75,
  "items": [
    {
      "shift_id": 1001,
      "restaurant_id": 2,
      "start_time": "iso",
      "end_time": "iso",
      "state": "finalizado",
      "hours_worked": 7.75,
      "restaurant": { "id": 2, "name": "Centro" }
    }
  ]
}
```

- `create_observation`
```json
{ "action": "create_observation", "shift_id": 1001, "kind": "alert", "message": "Derrame en cuarto frio" }
```
Data:
```json
{ "incident_id": 501, "kind": "alert", "shift_id": 1001 }
```
- Data:
```json
{
  "period_start": "2026-03-01",
  "period_end": "2026-03-31",
  "restaurant_id": 2,
  "users": { "total": 20, "active": 18, "inactive": 2, "employees_total": 12, "supervisors_total": 5 },
  "restaurants": { "total": 5, "active": 4, "inactive": 1 },
  "shifts": { "total": 120, "active": 3, "approved": 70, "rejected": 5, "finished": 42 },
  "productivity": { "hours_worked_total": 820.5, "average_hours_per_shift": 6.84, "operational_tasks_completed": 250, "operational_tasks_pending": 17 },
  "supplies": { "deliveries_count": 34, "units_delivered_total": 510, "cost_total": 1820000 },
  "incidents": { "total": 8 },
  "top_restaurants_by_shifts": [{ "restaurant_id": 2, "restaurant_name": "Centro", "shifts": 44 }]
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
- Ajuste adicional de RLS para flujo de supervisora y turno propio:
`supabase/migrations/021_supervisora_shift_and_staff_alignment.sql`
- Para flujo de empleado: `shifts_end` valida evidencia obligatoria de tipo `inicio` y `fin`.

