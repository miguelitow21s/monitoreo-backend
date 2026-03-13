  # Frontend API Spec - Supervisora

  Date: 2026-03-12

  Base URL:
  - `https://<SUPABASE_PROJECT>.supabase.co/functions/v1`

  Role scope (UI)
  - Supervisora uses a supervision view, not the employee home view.
  - Supervisora can start and end her own shifts.
  - Supervisora can assign employees to restaurants.
  - Supervisora can schedule, reschedule, cancel, and bulk schedule shifts for employees.
  - Supervisora can create and supervise operational tasks.
  - Supervisora can report incidents and optionally create tasks from incidents.
  - Supervisora can validate employee shift checkout (approve or reject).
  - Supervisora can deliver supplies and view supplies and deliveries.
  - Supervisora can generate reports for assigned restaurants.

  Explicit exclusions
  - Do not call `employee_self_service` with supervisora tokens. It returns 403.

  ---

  ## Global requirements

  Required headers (all POST)
  - `Authorization: Bearer <access_token>`
  - `apikey: <SUPABASE_ANON_KEY>`
  - `Content-Type: application/json`
  - `Idempotency-Key: <uuid>` (8-128 chars). Send on all POST actions.

  Response envelope (all endpoints)
  - Success: `{ success: true, data, error: null, request_id }`
  - Error: `{ success: false, data: null, error: { code, message, category, request_id }, request_id }`

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

  Shift OTP header (required for shift ops, evidence, and incidents)
  - `x-shift-otp-token: <verification_token>` from `phone_otp_verify`.
  - Required for: `shifts_start`, `shifts_end`, `shifts_approve`, `shifts_reject`, `incidents_create`, `evidence_upload`.

  Time format
  - All timestamps are ISO 8601 strings in UTC.

  ---

  ## Required onboarding flow (Supervisora)

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
  Save `verification_token` and send it in `x-shift-otp-token` for shift ops.

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

  ### POST /shifts_start (own shift)

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

  Rules
  - Must not have an active shift.
  - Restaurant must be assigned to the supervisora.
  - Geo validation is enforced.
  - Health form is required at start (`fit_for_work` + optional `declaration`).

  ---

  ### POST /evidence_upload (shift photos for supervisora)

  Headers (plus global)
  - `x-shift-otp-token: <verification_token>`

  Action: request_upload
  ```
  { "action": "request_upload", "shift_id": 123, "type": "inicio" }
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

  Rules
  - Required photos: `inicio` and `fin`.
  - File must be jpeg/png/webp and <= 8 MB.
  - Upload file using the signed URL, then call `finalize_upload`.

  ---

  ### POST /shifts_end (own shift)

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

  Rules
  - Must have both shift photos: `inicio` and `fin`.
  - Health form is required at end.
  - Geo validation is enforced.

  ---

  ### POST /shifts_approve (validate employee checkout)

  Headers (plus global)
  - `x-shift-otp-token: <verification_token>`

  Body:
  ```
  { "shift_id": 123 }
  ```

  Rules
  - Shift must be in state `finalizado`.
  - Supervisora must have access to the shift restaurant.

  ---

  ### POST /shifts_reject (validate employee checkout)

  Headers (plus global)
  - `x-shift-otp-token: <verification_token>`

  Body:
  ```
  { "shift_id": 123 }
  ```

  Rules
  - Shift must be in state `finalizado`.
  - Supervisora must have access to the shift restaurant.

  ---

  ### POST /scheduled_shifts_manage (schedule employees)

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

  Rules
  - Supervisora can only operate on assigned restaurants.
  - Bulk scheduling supports up to 200 entries.

  ---

  ### POST /restaurant_staff_manage (assign employees)

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

  Rules
  - Supervisora can only assign and list inside assigned restaurants.

  ---

  ### POST /operational_tasks_manage (tasks for employees)

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

  Rules
  - Use `list_supervision` scoped by `restaurant_id` to avoid cross-scope errors.
  - Evidence path must belong to the assigned employee.
  - Evidence can be image or JSON manifest.

  ---

  ### POST /incidents_create (report incident, optional task)

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

  Rules
  - Supervisora can create tasks from incidents.
  - Supervisora must have access to the shift restaurant.

  ---

  ### POST /supplies_deliver (deliveries and inventory)

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
  - For supervisora, `restaurant_id` is required on list actions.
  - Use `delivered_by` to see deliveries for a specific employee.

  ---

  ### POST /reports_generate
  ```
  {
    "restaurant_id": 1,
    "period_start": "2026-03-01",
    "period_end": "2026-03-31",
    "filtros_json": {},
    "columns": ["..."],
    "export_format": "csv|pdf|both"
  }
  ```

  Rules
  - Supervisora can only generate reports for assigned restaurants.

  ---

  ## Recommended supervisora flow (summary)

  1. Legal consent status and accept if needed.
  2. Validate or register trusted device.
  3. Send and verify OTP, store `verification_token`.
  4. Schedule shifts with `scheduled_shifts_manage`.
  5. Assign employees with `restaurant_staff_manage`.
  6. Start own shift with `shifts_start` (use OTP header).
  7. Upload `inicio` photo using `evidence_upload`.
  8. Create and supervise tasks with `operational_tasks_manage`.
  9. Report incidents with `incidents_create` when needed.
  10. Upload `fin` photo, then end own shift with `shifts_end`.
  11. Validate employee checkouts with `shifts_approve` or `shifts_reject`.
  12. Manage supplies with `supplies_deliver`.

  ---

  ## Troubleshooting quick checks

  403 PERMISSION on shift ops
  Cause: Missing or expired `x-shift-otp-token`, or device not trusted.

  403 PERMISSION on `employee_self_service`
  Cause: Role mismatch. Supervisora must not call this endpoint.

  422 VALIDATION on `shifts_end`
  Cause: Missing required shift photos (`inicio` and `fin`).

  403 or 409 on scheduling or staff assignment
  Cause: Supervisora is not assigned to that restaurant.
