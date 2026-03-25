# Frontend Integration Guide (HTML/JS) - Supabase Edge API

Date: 2026-03-25
Project: monitoreo-backend
Base URL:
- https://orwingqtwoqfhcogggac.supabase.co/functions/v1

This document is the single integration guide for a plain HTML/JS frontend. It answers the open questions and includes concrete request/response examples.

---

## 1) Authentication (confirmado)

- Yes, the frontend should use Supabase Auth directly.
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

## 5) Evidence Upload Flow (confirmado)

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

---

## 6) Roles & Endpoints (resumen)

### Empleado
- `employee_self_service` (my_dashboard, my_hours_history, create_observation)
- `shifts_start`, `shifts_end`
- `evidence_upload`
- `operational_tasks_manage` (list_my_open, request_evidence_upload, request_manifest_upload, complete)

### Supervisora
- `scheduled_shifts_manage` (list/assign/bulk_assign/reschedule/cancel)
- `operational_tasks_manage` (list_supervision, create, complete)
- `restaurant_staff_manage` (list_by_restaurant, assign_employee, unassign_employee)
- `supervisor_presence_manage` (register, list_my, list_by_restaurant)
- `shifts_approve`, `shifts_reject`
- `incidents_create`

### Super Admin
- All supervisora endpoints +
- `admin_users_manage`
- `admin_restaurants_manage`
- `admin_dashboard_metrics`
- `reports_manage` + `reports_generate`

---

## 6.1) Common Utilities (all roles)

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
  "phone_e164": "+57..."
}
```

### GET /health_ping
Use for connectivity only (no auth).

---

## 6.2) Empleado (detalle)

### POST /employee_self_service
Actions:
- `my_dashboard`
- `my_hours_history`
- `create_observation`

Example:
```
{ "action": "my_dashboard", "schedule_limit": 10, "pending_tasks_limit": 10 }
```

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

### POST /evidence_upload
Actions:
- `request_upload`
- `finalize_upload`

Multiple photos per fase (inicio/fin) are supported.

### POST /shifts_end
Requires `x-shift-otp-token`.
```
{
  "shift_id": 123,
  "lat": 4.7110,
  "lng": -74.0721,
  "fit_for_work": true,
  "declaration": "Sin incidentes",
  "early_end_reason": "Terminé tareas"
}
```

### POST /operational_tasks_manage (Empleado)
Actions:
- `list_my_open`
- `request_evidence_upload`
- `request_manifest_upload`
- `complete`

---

## 6.3) Supervisora (detalle)

### POST /scheduled_shifts_manage
Actions:
- `list` (supports `status`, `from`, `to`, optional `restaurant_id`)
- `assign`
- `bulk_assign`
- `reschedule`
- `cancel`

Example (bulk):
```
{
  "action": "bulk_assign",
  "entries": [
    { "employee_id": "<uuid>", "restaurant_id": 5, "scheduled_start": "...", "scheduled_end": "...", "notes": "..." }
  ]
}
```

### POST /restaurant_staff_manage
Actions:
- `list_by_restaurant`
- `list_my_restaurants`
- `list_assignable_employees`
- `assign_employee`
- `unassign_employee`

### POST /operational_tasks_manage (Supervisora)
Actions:
- `list_supervision`
- `create`
- `request_evidence_upload` / `request_manifest_upload`
- `complete`
- `update`
- `cancel`
- `mark_in_progress`
- `close`

### POST /supervisor_presence_manage
Actions:
- `register`
- `list_my`
- `list_by_restaurant`

### POST /shifts_approve` / `shifts_reject`
Requires `x-shift-otp-token`.

### POST /incidents_create
Requires `x-shift-otp-token`.
```
{ "shift_id": 123, "description": "..." }
```

---

## 6.4) Super Admin (detalle)

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

### POST /admin_dashboard_metrics
Dashboard ejecutivo.

### POST /reports_manage
Actions:
- `list_shifts`
- `list_history`

### POST /reports_generate
Genera PDF + XLSX (excel nativo).

---

## 6.5) Evidencias (listado)

### POST /shift_evidence_manage
Action:
- `list_by_shift`
```
{ "action": "list_by_shift", "shift_id": 123, "type": "inicio" }
```
Respuesta:
```
{ "items": [ { "id": 1, "shift_id": 123, "type": "inicio", "storage_path": "...", "captured_at": "...", "lat": 4.7, "lng": -74.0 } ] }
```

---

## 7) Example: Login (HTML/JS)

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

## 8) Example: Generic Edge Call (fetch)

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

## 9) Reports (PDF + Excel nativo)

- `reports_manage` (list_shifts, list_history)
- `reports_generate`

`reports_generate` now returns:
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

## 10) Edge Contracts Confirmations

- Yes, the MD files are final and aligned.
- Yes, the response envelope applies to all Edge endpoints.
- Yes, headers are exactly as listed above.
- `legal_consent` status can be sent with Idempotency-Key (recommended) even if not strictly required.

---

## 11) Troubleshooting

- 401 AUTH: expired token -> refresh session.
- 403 PERMISSION: role mismatch or missing OTP.
- 409 BUSINESS: device limit, missing phone, conflicts.
- 422 VALIDATION: invalid payload or headers.

---

If you need any additional examples per role, we can attach full sample payloads and responses.
