# Frontend Integration Guide (HTML/JS) - Supabase Edge API

Date: 2026-03-25
Project: monitoreo-backend
Base URL:
- https://orwingqtwoqfhcogggac.supabase.co/functions/v1

This document is the single integration guide for a plain HTML/JS frontend. It includes confirmed contracts, headers, and examples. The backend now enforces system settings (not just stores them).

---

## 1) Authentication (confirmado)

- The frontend should use Supabase Auth directly.
- The `access_token` from the Supabase session MUST be sent as:
  - `Authorization: Bearer <access_token>`
- Session refresh:
  - Supabase JS auto-refreshes if `persistSession` is true.
  - If you do manual fetch, refresh before calling Edge when `expires_at` is near:

```js
const { data: { session } } = await supabase.auth.getSession();
if (!session || session.expires_at * 1000 < Date.now() + 60_000) {
  await supabase.auth.refreshSession();
}
```

---

## 1.1) Login + PIN (clarificación)

El login usa Supabase Auth (email/usuario + password). El backend **no valida el PIN en el login**; la validación de longitud aplica solo a `users_manage -> change_my_pin`.

Flujo recomendado:
1. Login con Supabase Auth.
2. Llamar `users_manage -> me`.
3. Si `must_change_pin=true`, forzar cambio con `users_manage -> change_my_pin`.
4. Luego continuar con el resto de endpoints y cargar `system_settings_manage`.

Confirmado:
- `users_manage -> me` **NO** queda bloqueado por `must_change_pin`.
- `users_manage -> change_my_pin` **NO** queda bloqueado por `must_change_pin`.

---

## 2) Required Headers (ALL POST)

Always send these headers:
- `Authorization: Bearer <access_token>`
- `apikey: <SUPABASE_ANON_KEY>`
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>`
- `x-device-fingerprint: <stable-id>`

Notes:
- Use `crypto.randomUUID()` for `Idempotency-Key` on every POST.
- `x-device-fingerprint` must be stable across sessions (store in localStorage).
- For shift operations and evidence, add:
  - `x-shift-otp-token: <verification_token>`

---

## 3) Response Envelope (global)

Success:
```
{ success: true, data, error: null, request_id }
```
Error:
```
{ success: false, data: null, error: { code, message, category, request_id }, request_id }
```

---

## 4) OTP Flow (screen or SMS)

Correct flow:
1. `legal_consent` -> `status`
2. `trusted_device_validate` (then `register` if required)
3. `phone_otp_send`
4. `phone_otp_verify`
5. Use `verification_token` in `x-shift-otp-token`

Screen mode:
- If `OTP_SCREEN_MODE=true`, `phone_otp_send` returns `debug_code` and `masked_phone: "OTP en pantalla"`.
- User types `debug_code` manually and you call `phone_otp_verify`.

SMS mode:
- If `OTP_SCREEN_MODE=false`, OTP is sent by SMS.
- `users.phone_e164` must be a valid E.164.

---

## 5) System Settings (backend enforced)

`system_settings_manage` now validates schema and applies settings to logic (GPS, shifts, evidence, tasks, PIN policy).

### POST /system_settings_manage
Actions:
- `get`
- `update`

Example:
```
{ "action": "get" }
```
```
{ "action": "update", "settings": { "gps": { "default_radius_meters": 120 } } }
```

### Schema (validated)
```
security:
  pin_length: 4..12 (int)
  force_password_change_on_first_login: boolean
  otp_expiration_minutes: 1..120 (int)
  trusted_device_days: 1..3650 (int)

legal:
  consent_text: string (5..5000)
  support_email: email

gps:
  default_radius_meters: 10..20000 (int)
  min_accuracy_meters: 1..10000 (int)
  require_gps_for_shift_start: boolean
  require_gps_for_supervision: boolean

shifts:
  default_hours: 1..24
  min_hours: 1..24
  max_hours: 1..24
  early_start_tolerance_minutes: 0..10080
  late_start_tolerance_minutes: 0..10080

evidence:
  require_start_photos: boolean
  require_end_photos: boolean
  require_supervision_photos: boolean
  default_cleaning_areas: string[]
  areas_mode: "restaurant_or_default" | "default_only" | "restaurant_only"

tasks:
  require_special_task_completion_check: boolean
  require_special_task_notes: boolean
```

### Backend behavior (important)
- GPS validations and min accuracy use `gps.*`.
- Shift start window uses `early_start_tolerance_minutes` and `late_start_tolerance_minutes`.
- Evidence required per phase uses `evidence.*`.
- Task notes required if `tasks.require_special_task_notes=true`.
- If `security.force_password_change_on_first_login=true`, most protected endpoints return 403 until the user changes PIN.

---

## 6) Evidence Upload Flow (shift photos)

Sequence:
1. `evidence_upload` -> `request_upload`
2. Upload binary to signed URL
3. `evidence_upload` -> `finalize_upload`

Example:
```
POST /evidence_upload
{ "action": "request_upload", "shift_id": 123, "type": "inicio" }
```
Upload file to `signedUrl` (PUT), then:
```
POST /evidence_upload
{
  "action": "finalize_upload",
  "shift_id": 123,
  "type": "inicio",
  "path": "...",
  "lat": 4.7110,
  "lng": -74.0721,
  "accuracy": 8,
  "captured_at": "2026-03-25T12:00:00.000Z",
  "meta": {
    "area_key": "cocina",
    "area_label": "Cocina",
    "subarea_key": "campana",
    "subarea_label": "Campana"
  }
}
```

Notes:
- Multiple photos per phase are supported.
- If `gps.require_gps_for_shift_start=true`, accuracy is validated against `gps.min_accuracy_meters`.

---

## 7) Roles & Endpoints (resumen)

### Empleado
- `employee_self_service` (my_dashboard, my_hours_history, create_observation)
- `shifts_start`, `shifts_end`
- `evidence_upload`
- `operational_tasks_manage` (list_my_open, request_evidence_upload, request_manifest_upload, complete, close)

### Supervisora
- `scheduled_shifts_manage` (list/assign/bulk_assign/reschedule/cancel)
- `operational_tasks_manage` (list_supervision, create, complete, update, cancel, mark_in_progress, close)
- `restaurant_staff_manage` (list_by_restaurant, list_my_restaurants, list_assignable_employees, assign_employee, unassign_employee)
- `supervisor_presence_manage` (request_evidence_upload, finalize_evidence_upload, register, list_my, list_by_restaurant, list_today)
- `shifts_approve`, `shifts_reject`
- `incidents_create`

### Super Admin
- All supervisora endpoints +
- `admin_users_manage`
- `admin_restaurants_manage`
- `admin_dashboard_metrics`
- `reports_manage` + `reports_generate`
- `system_settings_manage`

---

## 7.1) Common Utilities (all roles)

### POST /users_manage (who am I)
```
{ "action": "me" }
```
Response:
```
{
  "id": "<uuid>",
  "email": "...",
  "role": "super_admin|supervisora|empleado",
  "is_active": true,
  "full_name": "...",
  "phone_e164": "+57...",
  "must_change_pin": false,
  "pin_updated_at": "2026-03-25T00:00:00.000Z"
}
```

### POST /users_manage (change PIN)
```
{ "action": "change_my_pin", "new_pin": "123456" }
```
Notes:
- PIN must be numeric and length = `security.pin_length`.
- If `must_change_pin=true`, call this before accessing protected endpoints.
- This endpoint is allowed even when `must_change_pin=true`.

### GET /health_ping
Use for connectivity only (no auth).

---

## 7.2) Empleado (detalle)

### POST /employee_self_service
Actions:
- `my_dashboard`
- `my_hours_history`
- `create_observation`

Example:
```
{ "action": "my_dashboard", "schedule_limit": 10, "pending_tasks_limit": 10 }
```

Notes:
- `assigned_restaurants[].restaurant.cleaning_areas` ya viene resuelto con fallback según `evidence.areas_mode` y `evidence.default_cleaning_areas`.

### POST /shifts_start
Requires `x-shift-otp-token`.
```
{
  "restaurant_id": 5,
  "lat": 4.7110,
  "lng": -74.0721,
  "fit_for_work": true,
  "declaration": "Me siento bien",
  "scheduled_shift_id": 123
}
```
Notes:
- Start window is enforced using settings:
  - `early_start_tolerance_minutes`
  - `late_start_tolerance_minutes`

### POST /shifts_end
Requires `x-shift-otp-token`.
```
{
  "shift_id": 123,
  "lat": 4.7110,
  "lng": -74.0721,
  "fit_for_work": true,
  "declaration": "Sin incidentes",
  "early_end_reason": "Termine tareas"
}
```
Notes:
- Evidence required depends on `evidence.require_start_photos` and `evidence.require_end_photos`.
- If `tasks.require_special_task_completion_check=true`, backend blocks shift end until tasks are closed.

### POST /operational_tasks_manage (Empleado)
Actions:
- `list_my_open`
- `request_evidence_upload`
- `request_manifest_upload`
- `complete`
- `close` (only if `requires_evidence=false`)

Close example:
```
{ "action": "close", "task_id": 123, "notes": "Listo" }
```

Complete example:
```
{ "action": "complete", "task_id": 123, "evidence_path": "users/<uid>/task-evidence/...", "notes": "Listo" }
```

List response includes:
- `id` and `task_id`
- `title`, `description`, `status`
- `requires_evidence`
- `notes_required`
- `assigned_employee_id`, `restaurant_id`

---

## 7.3) Supervisora (detalle)

### POST /scheduled_shifts_manage
Actions:
- `list` (supports `status`, `from`, `to`, optional `restaurant_id`)
- `assign`
- `bulk_assign`
- `reschedule`
- `cancel`

Notes:
- Duration is validated against `shifts.min_hours` and `shifts.max_hours`.

### POST /restaurant_staff_manage
Actions:
- `list_by_restaurant`
- `list_my_restaurants`
- `list_assignable_employees`
- `assign_employee`
- `unassign_employee`

Notes:
- `list_my_restaurants` devuelve `cleaning_areas` ya resuelto con fallback según `evidence.areas_mode`.

### POST /operational_tasks_manage (Supervisora)
Actions:
- `list_supervision`
- `create` (supports `requires_evidence`)
- `request_evidence_upload` / `request_manifest_upload`
- `complete`
- `update`
- `cancel`
- `mark_in_progress`
- `close`

List response includes:
- `id` and `task_id`
- `title`, `description`, `status`
- `requires_evidence`
- `notes_required`
- `assigned_employee_id`, `restaurant_id`

### POST /supervisor_presence_manage
Actions:
- `request_evidence_upload`
- `finalize_evidence_upload`
- `register`
- `list_my`
- `list_by_restaurant`
- `list_today`

Register (multiple photos):
```
{
  "action": "register",
  "restaurant_id": 5,
  "phase": "start",
  "lat": 4.7110,
  "lng": -74.0721,
  "evidences": [
    { "path": "users/<uid>/supervisor-start/<uuid>.jpg", "label": "Area general" }
  ]
}
```

Upload flow:
```
{ "action": "request_evidence_upload", "phase": "start", "mime_type": "image/jpeg" }
```
Then upload to signed URL and call:
```
{ "action": "finalize_evidence_upload", "path": "users/<uid>/supervisor-start/<uuid>.jpg" }
```

Responses from `list_*` include `evidences: []`.

---

## 7.4) Super Admin (detalle)

### POST /admin_users_manage
Actions:
- `list`
- `create`
- `update`
- `activate`
- `deactivate`

### POST /admin_restaurants_manage
Actions:
- `list`
- `create`
- `update`
- `activate`
- `deactivate`

Notes:
- `cleaning_areas` is supported in create/update and returned in list.
- En endpoints operativos (empleado/supervisora) se entrega ya resuelto con fallback.

### POST /admin_dashboard_metrics
Dashboard ejecutivo.

### POST /reports_manage
Actions:
- `list_shifts`
- `list_history`

### POST /reports_generate
Genera PDF + XLSX (excel nativo).

---

## 7.5) Audit Logs (server-side filters)

### POST /audit_logs_manage
```
{
  "action": "list",
  "limit": 100,
  "from": "2026-03-01T00:00:00Z",
  "to": "2026-03-25T23:59:59Z",
  "search": "scheduled_shifts_manage",
  "action_name": "SHIFT_START",
  "endpoint": "scheduled_shifts_manage",
  "user_id": "<uuid>",
  "request_id": "<uuid>"
}
```
Notes:
- `from` and `to` must be sent together.
- `action_name` or `action_filter` are accepted.
- `endpoint` matches `context.endpoint` when present.

---

## 8) Reports (PDF + Excel nativo)

`reports_generate` returns:
- `url_pdf`
- `url_excel` (XLSX native)

Example request:
```
POST /reports_generate
{
  "restaurant_id": 5,
  "period_start": "2026-02-22",
  "period_end": "2026-03-24",
  "export_format": "both",
  "columns": [
    "Turno","Restaurante","Empleado","Supervisora","Inicio","Fin",
    "Estado","Duracion","Novedades","Evidencia inicial","Evidencia final"
  ]
}
```

---

## 9) Example: Login (HTML/JS)

```html
<script type="module">
  import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

  const SUPABASE_URL = "https://orwingqtwoqfhcogggac.supabase.co";
  const SUPABASE_ANON_KEY = "<anon_key>";

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data, error } = await supabase.auth.signInWithPassword({
    email: "user@example.com",
    password: "123456",
  });

  if (error) console.error(error);
  const accessToken = data.session?.access_token;
</script>
```

---

## 10) Example: Generic Edge Call (fetch)

```js
const idempotencyKey = crypto.randomUUID();
const fingerprint = localStorage.getItem("app_device_fingerprint")
  || (localStorage.setItem("app_device_fingerprint", crypto.randomUUID()), localStorage.getItem("app_device_fingerprint"));

const res = await fetch("https://orwingqtwoqfhcogggac.supabase.co/functions/v1/employee_self_service", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
    "x-device-fingerprint": fingerprint,
  },
  body: JSON.stringify({ action: "my_dashboard", schedule_limit: 10, pending_tasks_limit: 10 }),
});

const payload = await res.json();
```

---

## 11) Troubleshooting

- 401 AUTH: expired token -> refresh session.
- 403 PERMISSION: role mismatch, missing OTP, or must_change_pin.
- 409 BUSINESS: device limit, missing phone, conflicts.
- 422 VALIDATION: invalid payload or headers.

---

If you need additional examples per role, we can attach full sample payloads and responses.
