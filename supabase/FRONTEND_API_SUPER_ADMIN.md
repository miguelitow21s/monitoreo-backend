# Frontend API Spec - Super Admin

Date: 2026-04-15

Base URL:
- `https://<SUPABASE_PROJECT>.supabase.co/functions/v1`

Role scope (UI)
- Super admin uses a management and oversight view, not the employee view.
- Super admin does not start or end shifts.
- Super admin can create, edit, activate, and deactivate users and restaurants.
- Super admin can assign supervisors to restaurants.
- Super admin can schedule, reschedule, cancel, and bulk schedule shifts.
- Super admin can view metrics, costs, productivity, supplies, and historical data.
- Super admin can deliver supplies and list supplies and deliveries.
- Super admin can generate and download reports.

Explicit exclusions
- Do not call `employee_self_service` with super_admin tokens. It returns 403.
- Do not call `shifts_start` or `shifts_end` for super admin.
- Do not call `evidence_upload` for shift photos (endpoint is employee and supervisora only).

---

## Global requirements

Required headers (all POST)
- `Authorization: Bearer <access_token>`
- `apikey: <SUPABASE_ANON_KEY>`
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>` (8-128 chars). Send on all POST actions.

Response envelope (all endpoints)
- Success: `{ success: true, data, error: null, request_id }`
- Error: `{ success: false, data: null, error: { code, error_code?, message, category, request_id }, request_id }`

Common error categories
- `401 AUTH`: missing or expired token.
- `403 PERMISSION`: role mismatch, missing legal consent, OTP missing or expired.
- `409 BUSINESS`: domain conflicts or RLS restrictions.
- `422 VALIDATION`: invalid payload or headers.
- `428 PERMISSION`: device must be registered on first login.
- `500 SYSTEM`: internal error.

Legal consent (required)
- If legal consent is not accepted, guarded endpoints return 403 with message "Debe aceptar tratamiento de datos para continuar".

Device fingerprint
- Send a stable fingerprint in a header or body.
- Accepted headers: `x-device-fingerprint`, `x-device-id`, `x-device-key`.
- Body key: `device_fingerprint`.
- Length 16-256 chars.

Shift OTP header (required for approvals and incidents)
- `x-shift-otp-token: <verification_token>` from `phone_otp_verify`.
- Required for: `shifts_approve`, `shifts_reject`, `incidents_create`.

Time format
- All timestamps are ISO 8601 strings in UTC.

---

## Required onboarding flow (Super Admin)

1. Legal consent status.
POST `/legal_consent`
Body: `{ "action": "status" }`

2. Accept legal consent if needed.
POST `/legal_consent`
Body: `{ "action": "accept", "legal_terms_id": <active_term.id> }`

3. Validate trusted device.
POST `/trusted_device_validate`
Body: `{ "device_fingerprint": "<fingerprint>" }`
If `registration_required: true`, continue to step 4.

4. Register trusted device.
POST `/trusted_device_register`
Body:
```
{
  "device_fingerprint": "<fingerprint>",
  "device_name": "Chrome on Windows",
  "platform": "web"
}
```

5. Request OTP (SMS).
POST `/phone_otp_send`
Body: `{ "device_fingerprint": "<fingerprint>" }`

6. Verify OTP and keep the token.
POST `/phone_otp_verify`
Body: `{ "code": "123456", "device_fingerprint": "<fingerprint>" }`
Save `verification_token` and send it in `x-shift-otp-token` for approvals and incidents.

---

## Endpoint details

### GET /health_ping
Used only for health checks.

---

### POST /legal_consent

Action: status
```
{ "action": "status" }
```
Action: accept
```
{ "action": "accept", "legal_terms_id": 1 }
```

---

### POST /trusted_device_validate
```
{ "device_fingerprint": "<fingerprint>" }
```

### POST /trusted_device_register
```
{
  "device_fingerprint": "<fingerprint>",
  "device_name": "Chrome on Windows",
  "platform": "web"
}
```

### POST /phone_otp_send
```
{ "device_fingerprint": "<fingerprint>" }
```

### POST /phone_otp_verify
```
{ "code": "123456", "device_fingerprint": "<fingerprint>" }
```

---

### POST /admin_users_manage

Action: create
```
{
  "action": "create",
  "email": "user@domain.com",
  "role": "super_admin|supervisora|empleado",
  "password": "optional",
  "first_name": "optional",
  "last_name": "optional",
  "full_name": "optional",
  "phone_number": "required for supervisora/empleado in E.164",
  "is_active": true
}
```

Action: update
```
{
  "action": "update",
  "user_id": "uuid",
  "email": "optional",
  "role": "optional",
  "first_name": "optional",
  "last_name": "optional",
  "full_name": "optional",
  "phone_number": "required if resulting role is supervisora/empleado, E.164 format",
  "is_active": true
}
```

Action: activate
```
{ "action": "activate", "user_id": "uuid" }
```

Action: deactivate
```
{ "action": "deactivate", "user_id": "uuid", "reason": "optional" }
```

Action: list
```
{ "action": "list", "role": "optional", "is_active": true, "search": "optional", "limit": 100 }
```

Notes
- If `password` is omitted, a temporary password is generated.
- `is_active: false` disables auth access.
- Backend now enforces `phone_number` for `supervisora` and `empleado`.
- Expected format: `+573001112233`.

---

### POST /admin_restaurants_manage

Action: create
```
{
  "action": "create",
  "name": "...",
  "lat": 0,
  "lng": 0,
  "radius": 100,
  "address_line": "optional",
  "city": "optional",
  "state": "optional",
  "postal_code": "optional",
  "country": "optional",
  "place_id": "optional",
  "is_active": true
}
```

Action: update
```
{
  "action": "update",
  "restaurant_id": 1,
  "name": "optional",
  "lat": 0,
  "lng": 0,
  "radius": 100,
  "address_line": "optional",
  "city": "optional",
  "state": "optional",
  "postal_code": "optional",
  "country": "optional",
  "place_id": "optional",
  "is_active": true
}
```

Action: activate
```
{ "action": "activate", "restaurant_id": 1 }
```

Action: deactivate
```
{ "action": "deactivate", "restaurant_id": 1 }
```

Action: list
```
{ "action": "list", "is_active": true, "search": "optional", "limit": 200 }
```

Notes
- `lat`, `lng`, and `radius` define geolocation rules for shift check-in/out.

---

### POST /admin_supervisors_manage

Action: assign
```
{ "action": "assign", "supervisor_id": "uuid", "restaurant_id": 1 }
```

Action: unassign
```
{ "action": "unassign", "supervisor_id": "uuid", "restaurant_id": 1 }
```

Action: list_by_restaurant
```
{ "action": "list_by_restaurant", "restaurant_id": 1 }
```

Action: list_by_supervisor
```
{ "action": "list_by_supervisor", "supervisor_id": "uuid" }
```

---

### POST /restaurant_staff_manage

Action: assign_employee
```
{ "action": "assign_employee", "employee_id": "uuid", "restaurant_id": 1 }
```

Action: unassign_employee
```
{ "action": "unassign_employee", "employee_id": "uuid", "restaurant_id": 1 }
```

Action: list_by_restaurant
```
{ "action": "list_by_restaurant", "restaurant_id": 1 }
```

Action: list_by_employee
```
{ "action": "list_by_employee", "employee_id": "uuid" }
```

---

### POST /scheduled_shifts_manage

Action: assign
```
{
  "action": "assign",
  "employee_id": "uuid",
  "restaurant_id": 1,
  "scheduled_start": "2026-03-12T08:00:00Z",
  "scheduled_end": "2026-03-12T16:00:00Z",
  "notes": "optional"
}
```

Action: bulk_assign
```
{
  "action": "bulk_assign",
  "entries": [
    { "employee_id": "uuid", "restaurant_id": 1, "scheduled_start": "...", "scheduled_end": "...", "notes": "optional" }
  ]
}
```

Action: reschedule
```
{
  "action": "reschedule",
  "scheduled_shift_id": 10,
  "scheduled_start": "...",
  "scheduled_end": "...",
  "notes": "optional"
}
```

Action: cancel
```
{ "action": "cancel", "scheduled_shift_id": 10, "reason": "optional" }
```

Action: list
```
{
  "action": "list",
  "employee_id": "uuid?",
  "restaurant_id": 1,
  "status": "scheduled",
  "from": "2026-03-01T00:00:00Z",
  "to": "2026-03-31T23:59:59Z",
  "limit": 100
}
```

---

### POST /shifts_approve

Headers (plus global)
- `x-shift-otp-token: <verification_token>`

Body:
```
{ "shift_id": 123 }
```

---

### POST /shifts_reject

Headers (plus global)
- `x-shift-otp-token: <verification_token>`

Body:
```
{ "shift_id": 123 }
```

---

### POST /operational_tasks_manage

Action: create
```
{
  "action": "create",
  "shift_id": 123,
  "assigned_employee_id": "uuid",
  "title": "Limpieza especial",
  "description": "Limpiar zona de cocina",
  "priority": "normal",
  "due_at": "2026-03-12T18:00:00Z"
}
```

Action: list_supervision
```
{ "action": "list_supervision", "restaurant_id": 1, "status": "pending", "limit": 100 }
```

Action: request_evidence_upload
```
{ "action": "request_evidence_upload", "task_id": 123, "mime_type": "image/jpeg" }
```

Action: request_manifest_upload
```
{ "action": "request_manifest_upload", "task_id": 123 }
```

Action: complete
```
{ "action": "complete", "task_id": 123, "evidence_path": "users/<employee_id>/task-evidence/<task_id>/<uuid>.jpg" }
```

Notes
- Use `restaurant_id` for clarity when listing supervision tasks.

---

### POST /incidents_create

Headers (plus global)
- `x-shift-otp-token: <verification_token>`

Body:
```
{
  "shift_id": 123,
  "description": "Novedad en turno",
  "task": {
    "assigned_employee_id": "uuid",
    "title": "Corregir",
    "description": "Subir foto de solucion",
    "priority": "normal",
    "due_at": "2026-03-12T18:00:00Z"
  }
}
```

---

### POST /supplies_deliver

Action: deliver
```
{ "action": "deliver", "supply_id": 10, "restaurant_id": 1, "quantity": 5 }
```

Action: list_supplies
```
{ "action": "list_supplies", "restaurant_id": 1, "limit": 200, "search": "optional" }
```

Action: list_deliveries
```
{ "action": "list_deliveries", "restaurant_id": 1, "delivered_by": "uuid?", "limit": 200 }
```

Notes
- For super admin, `restaurant_id` is optional, but recommended to scope results.
- Use `delivered_by` to see deliveries by a specific employee.

---

### POST /admin_dashboard_metrics
```
{ "action": "summary", "restaurant_id": 1, "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD" }
```

---

### POST /reports_generate
```
{
  "restaurant_id": 1,
  "period_start": "YYYY-MM-DD",
  "period_end": "YYYY-MM-DD",
  "filtros_json": {},
  "columns": ["..."],
  "export_format": "csv|pdf|both"
}
```

---

### POST /audit_log
```
{ "action": "ADMIN_CUSTOM_EVENT", "context": { "key": "value" } }
```

---

### POST /email_notifications_dispatch
```
{
  "enqueue_shift_not_started": true,
  "overdue_limit": 100,
  "grace_minutes": 15,
  "dispatch_limit": 50,
  "max_attempts": 5
}
```

---

## Recommended super admin flow (summary)

1. Legal consent status and accept if needed.
2. Validate or register trusted device.
3. Send and verify OTP, store `verification_token`.
4. Manage users and roles with `admin_users_manage`.
5. Manage restaurants and geolocation rules with `admin_restaurants_manage`.
6. Assign supervisors with `admin_supervisors_manage`.
7. Schedule shifts and bulk schedules with `scheduled_shifts_manage`.
8. Review and approve or reject shifts with `shifts_approve` or `shifts_reject` (OTP required).
9. Monitor metrics and costs with `admin_dashboard_metrics`.
10. Manage supplies with `supplies_deliver`.
11. Generate reports with `reports_generate`.

---

## Troubleshooting quick checks

403 PERMISSION on `employee_self_service`
Cause: Role mismatch. Super admin must not call this endpoint.

403 PERMISSION on approvals or incidents
Cause: Missing or expired `x-shift-otp-token`, or device not trusted.

422 VALIDATION
Cause: Missing Idempotency-Key or invalid payload shape.
