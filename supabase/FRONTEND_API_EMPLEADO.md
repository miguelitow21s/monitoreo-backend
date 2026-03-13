# Frontend API Spec - Empleado

Date: 2026-03-12

Base URL:
- `https://<SUPABASE_PROJECT>.supabase.co/functions/v1`

Role scope (UI)
- Empleado uses the employee home/self-service views only.
- Empleado can start and end own shift.
- Empleado must complete health form at start and end.
- Empleado must upload mandatory shift photos (inicio + fin).
- Empleado can see assigned restaurants and schedule.
- Empleado can see assigned tasks and upload evidence.
- Empleado can create observations and alerts.

---

## Global requirements

Required headers (all POST)
- `Authorization: Bearer <access_token>`
- `apikey: <SUPABASE_ANON_KEY>`
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>` (8-128 chars). Send on every POST to avoid 422.

Response envelope (all endpoints)
- Success: `{ success: true, data, error: null, request_id }`
- Error: `{ success: false, data: null, error: { code, message, category, request_id }, request_id }`

Common error categories
- `401 AUTH`: missing/expired token.
- `403 PERMISSION`: role mismatch, legal consent missing, OTP missing/expired.
- `409 BUSINESS`: domain conflicts (active shift exists, missing phone, etc).
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

Shift OTP header (required for shift ops)
- `x-shift-otp-token: <verification_token>` from `phone_otp_verify`.
- Required for: `shifts_start`, `shifts_end`, `evidence_upload`.

Time format
- All timestamps are ISO 8601 strings in UTC.

---

## Required onboarding flow (Empleado)

1. Legal consent status.
POST `/legal_consent`
Body: `{ "action": "status" }`

2. Accept legal consent if needed.
POST `/legal_consent`
Body: `{ "action": "accept", "legal_terms_id": <active_term.id> }`
`legal_terms_id` is optional if you accept the current active term.

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
Response includes `otp_id`, `masked_phone`, `expires_at`.

6. Verify OTP and keep the token.
POST `/phone_otp_verify`
Body: `{ "code": "123456", "device_fingerprint": "<fingerprint>" }`
Save `verification_token` and send it in `x-shift-otp-token` for shift ops.

---

## Endpoint details

### POST /legal_consent

Action: status
```
{ "action": "status" }
```
Response data:
```
{
  "accepted": true,
  "accepted_at": "2026-03-12T00:00:00.000Z",
  "active_term": { "id": 1, "code": "...", "version": "..." }
}
```

Action: accept
```
{ "action": "accept", "legal_terms_id": 1 }
```
Response data:
```
{ "accepted": true, "legal_terms_id": 1, "accepted_at": "..." }
```

---

### POST /trusted_device_validate

Body:
```
{ "device_fingerprint": "<fingerprint>" }
```
Response data:
```
{
  "trusted": true,
  "registration_required": false,
  "first_login_binding": false,
  "trusted_devices_count": 2,
  "device_id": 10,
  "trusted_at": "...",
  "last_seen_at": "..."
}
```

---

### POST /trusted_device_register

Body:
```
{
  "device_fingerprint": "<fingerprint>",
  "device_name": "Chrome on Windows",
  "platform": "web"
}
```
Response data:
```
{
  "device_id": 10,
  "trusted_at": "...",
  "last_seen_at": "...",
  "first_login_binding": true,
  "device_name": "Chrome on Windows",
  "platform": "web"
}
```

---

### POST /phone_otp_send

Body:
```
{ "device_fingerprint": "<fingerprint>" }
```
Response data:
```
{
  "otp_id": 55,
  "expires_at": "...",
  "masked_phone": "+573***233",
  "delivery_status": "sent"
}
```

---

### POST /phone_otp_verify

Body:
```
{ "code": "123456", "device_fingerprint": "<fingerprint>" }
```
Response data:
```
{ "verification_token": "<token>", "expires_at": "..." }
```

---

### POST /employee_self_service

Action: my_dashboard
```
{ "action": "my_dashboard", "schedule_limit": 10, "pending_tasks_limit": 10 }
```
Response data:
```
{
  "active_shift": { "id": 123, "restaurant_id": 5, "start_time": "...", "state": "activo" },
  "can_start_shift": true,
  "assigned_restaurants": [
    { "restaurant_id": 5, "assigned_at": "...", "restaurant": { "id": 5, "name": "...", "city": "...", "state": "...", "address_line": "..." } }
  ],
  "scheduled_shifts": [
    { "id": 22, "restaurant_id": 5, "scheduled_start": "...", "scheduled_end": "...", "status": "scheduled", "notes": "...", "restaurant": { "id": 5, "name": "...", "city": "...", "state": "..." } }
  ],
  "pending_tasks_count": 2,
  "pending_tasks_preview": [
    { "id": 77, "title": "...", "priority": "normal", "status": "pending", "due_at": "...", "restaurant_id": 5 }
  ],
  "worked_hours_last_30d": 42.5
}
```

Action: my_hours_history
```
{ "action": "my_hours_history", "period_start": "2026-03-01", "period_end": "2026-03-31", "limit": 120 }
```
Response data:
```
{
  "period_start": "2026-03-01",
  "period_end": "2026-03-31",
  "total_shifts": 5,
  "total_hours_worked": 38.5,
  "items": [
    {
      "shift_id": 123,
      "restaurant_id": 5,
      "start_time": "...",
      "end_time": "...",
      "state": "finalizado",
      "hours_worked": 7.75,
      "restaurant": { "id": 5, "name": "...", "city": "...", "state": "..." }
    }
  ]
}
```

Action: create_observation
```
{ "action": "create_observation", "shift_id": 123, "kind": "observation", "message": "..." }
```
Response data:
```
{ "incident_id": 999, "kind": "observation", "shift_id": 123 }
```

Notes
- `create_observation` requires a valid `shift_id` owned by the employee.
- `kind` supports `observation` or `alert`.

---

### POST /shifts_start

Headers (plus global)
- `x-shift-otp-token: <verification_token>`

Body:
```
{
  "restaurant_id": 5,
  "lat": 4.7110,
  "lng": -74.0721,
  "fit_for_work": true,
  "declaration": "Me siento en capacidad de laborar"
}
```

Response data:
```
{
  "shift_id": 123,
  "pending_tasks_count": 2,
  "pending_tasks_preview": [
    { "id": 77, "title": "...", "priority": "normal", "due_at": "..." }
  ]
}
```

Rules
- Must not have an active shift.
- Must use a restaurant from the assigned list.
- Geo validation is enforced.
- Health form is required at start (`fit_for_work` + optional `declaration`).

---

### POST /evidence_upload (shift photos)

Headers (plus global)
- `x-shift-otp-token: <verification_token>`

Action: request_upload
```
{ "action": "request_upload", "shift_id": 123, "type": "inicio" }
```
Response data:
```
{
  "upload": { "signedUrl": "...", "path": "..." },
  "bucket": "shift-evidence",
  "path": "<user>/<shift>/inicio/<uuid>.bin",
  "max_bytes": 8388608,
  "allowed_mime": ["image/jpeg", "image/png", "image/webp"]
}
```

Action: finalize_upload
```
{
  "action": "finalize_upload",
  "shift_id": 123,
  "type": "inicio",
  "path": "<user>/<shift>/inicio/<uuid>.bin",
  "lat": 4.7110,
  "lng": -74.0721,
  "accuracy": 12.5,
  "captured_at": "2026-03-12T12:34:56.000Z"
}
```
Response data:
```
{ "shift_id": 123, "type": "inicio", "storage_path": "<path>", "sha256": "<hash>" }
```

Rules
- `type` only supports `inicio` and `fin`.
- Upload file using the signed URL, then call `finalize_upload`.
- File must be jpeg/png/webp and <= 8 MB.
- `finalize_upload` validates geo location and file contents.

---

### POST /shifts_end

Headers (plus global)
- `x-shift-otp-token: <verification_token>`

Body:
```
{
  "shift_id": 123,
  "lat": 4.7110,
  "lng": -74.0721,
  "fit_for_work": true,
  "declaration": "Sin incidentes"
}
```

Response data:
```
{}
```

Rules
- Must have both shift photos: `inicio` and `fin`.
- Health form is required at end (`fit_for_work` + optional `declaration`).
- Geo validation is enforced.

---

### POST /operational_tasks_manage (Empleado)

Action: list_my_open
```
{ "action": "list_my_open", "limit": 40 }
```
Response data:
```
{ "items": [ { "id": 77, "shift_id": 123, "restaurant_id": 5, "title": "...", "status": "pending", "priority": "normal", "due_at": "...", "created_at": "...", "updated_at": "..." } ] }
```

Action: request_evidence_upload
```
{ "action": "request_evidence_upload", "task_id": 77, "mime_type": "image/jpeg" }
```
Response data:
```
{
  "upload": { "signedUrl": "...", "path": "..." },
  "bucket": "shift-evidence",
  "path": "users/<employee_id>/task-evidence/<task_id>/<uuid>.jpg",
  "allowed_mime": ["image/jpeg", "image/png", "image/webp"],
  "max_bytes": 8388608
}
```

Action: request_manifest_upload
```
{ "action": "request_manifest_upload", "task_id": 77 }
```
Response data:
```
{
  "upload": { "signedUrl": "...", "path": "..." },
  "bucket": "shift-evidence",
  "path": "users/<employee_id>/task-manifest/<task_id>/<uuid>.json",
  "required_mime": "application/json"
}
```

Action: complete
```
{ "action": "complete", "task_id": 77, "evidence_path": "users/<employee_id>/task-evidence/<task_id>/<uuid>.jpg" }
```
Response data:
```
{ "task_id": 77 }
```

Rules
- Employee can only see and complete tasks assigned to them.
- `evidence_path` must match the assigned employee path.
- Evidence can be image (jpg/png/webp) or JSON manifest.

---

## Required employee flow (summary)

1. On login, check legal consent and accept if needed.
2. Validate or register trusted device.
3. Send and verify OTP, store the `verification_token`.
4. Load employee dashboard via `employee_self_service` action `my_dashboard`.
5. Start shift with `shifts_start`, include `x-shift-otp-token`.
6. Upload shift photo `inicio` with `evidence_upload`.
7. Show pending tasks and allow evidence upload for each task.
8. Before ending shift, upload shift photo `fin`.
9. End shift with `shifts_end`, include `x-shift-otp-token`.

---

## Troubleshooting quick checks

405 METHOD NOT ALLOWED
Cause: The endpoint only accepts POST. Verify method.

403 PERMISSION on `employee_self_service`
Cause: Role mismatch or legal consent not accepted.

403 PERMISSION on shift ops
Cause: Missing or expired `x-shift-otp-token`, or device not trusted.

428 PERMISSION
Cause: Device must be registered first (`trusted_device_register`).

422 VALIDATION on `shifts_end`
Cause: Missing required shift photos (`inicio` and `fin`).
