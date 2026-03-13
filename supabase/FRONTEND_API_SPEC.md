# Frontend API Spec (Backend Contract)

Date: 2026-03-12

Base URL:
- `https://<SUPABASE_PROJECT>.supabase.co/functions/v1`

Response envelope (all endpoints):
- Success: `{ success: true, data, error: null, request_id }`
- Error: `{ success: false, data: null, error: { code, message, category, request_id }, request_id }`

Common headers (all POST endpoints):
- `Authorization: Bearer <access_token>`
- `apikey: <SUPABASE_ANON_KEY>`
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>` (required for all POST except `legal_consent` action `status`)

Recommended practices (frontend):
- Always set `Idempotency-Key` per POST request; never reuse across different payloads.
- Use a 10–20s timeout per request and surface a clear retry UI.
- On network errors, retry once with exponential backoff; do **not** auto-retry non-idempotent actions without a fresh key.
- Log `X-Request-Id` from response headers for support/debugging.
- Treat `401` as re-authentication required; treat `403` as permission/role issue.
- Do not call employee-only endpoints with supervisora or super_admin.

Role-based UI rules (summary):
- `super_admin`: admin/supervision views only, no employee home or check-in/out UI.
- `supervisora`: supervision views + own check-in/out, no employee home view.
- `empleado`: employee home/self-service + check-in/out.

Device fingerprint (for trusted device flow):
- Header: `x-device-fingerprint` (preferred)
- Fallback headers: `x-device-id`, `x-device-key`
- Or body field: `device_fingerprint`

OTP flow (for shift operations):
1) `trusted_device_validate` -> if `registration_required=true`, call `trusted_device_register`
2) `phone_otp_send` -> `phone_otp_verify`
3) Use `x-shift-otp-token: <verification_token>` for protected endpoints

Protected endpoints requiring `x-shift-otp-token`:
- `shifts_start`, `shifts_end`, `shifts_approve`, `shifts_reject`
- `incidents_create`, `evidence_upload`

---

## Health

### GET `/health_ping`
- Method: **GET**
- Auth: optional (apikey ok)

---

## Legal

### POST `/legal_consent`
- Role: any authenticated
- Body:
  - Status:
    ```json
    {"action":"status"}
    ```
    - `Idempotency-Key` not required
  - Accept:
    ```json
    {"action":"accept","legal_terms_id":1}
    ```
    - `Idempotency-Key` required

---

## Employee self service (empleado only)

### POST `/employee_self_service`
- Role: **empleado** only
- Bodies:
  - Dashboard:
    ```json
    {"action":"my_dashboard","schedule_limit":10,"pending_tasks_limit":10}
    ```
  - Hours history:
    ```json
    {"action":"my_hours_history","period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD","limit":120}
    ```
  - Observation / alert:
    ```json
    {"action":"create_observation","shift_id":123,"kind":"observation","message":"..."}
    ```

---

## Trusted device

### POST `/trusted_device_validate`
```json
{"device_fingerprint":"optional"}
```

### POST `/trusted_device_register`
```json
{"device_fingerprint":"optional","device_name":"optional","platform":"optional"}
```

### POST `/trusted_device_revoke`
```json
{"device_id":123}
```
or
```json
{"device_fingerprint":"..."}
```

---

## Phone OTP

### POST `/phone_otp_send`
```json
{"device_fingerprint":"optional"}
```

### POST `/phone_otp_verify`
```json
{"code":"123456","device_fingerprint":"optional"}
```
Response includes `verification_token` -> use in `x-shift-otp-token`.

---

## Shifts

### POST `/shifts_start`
- Role: **empleado**, **supervisora**
- Headers: `x-shift-otp-token`
```json
{"restaurant_id":1,"lat":-34.6,"lng":-58.38,"fit_for_work":true,"declaration":"optional"}
```
Notes:
- Must have a scheduled shift for the user in the start window.
- Start window: from 30 minutes before `scheduled_start` until `scheduled_end`.

### POST `/shifts_end`
- Role: **empleado**, **supervisora**
- Headers: `x-shift-otp-token`
```json
{"shift_id":123,"lat":-34.6,"lng":-58.38,"fit_for_work":true,"declaration":"optional","early_end_reason":"optional"}
```
Notes:
- Requires evidence photos `inicio` and `fin` before checkout.
- If ending before `scheduled_end`, `early_end_reason` is required.

### POST `/shifts_approve`
- Role: **supervisora**, **super_admin**
- Headers: `x-shift-otp-token`
```json
{"shift_id":123}
```

### POST `/shifts_reject`
- Role: **supervisora**, **super_admin**
- Headers: `x-shift-otp-token`
```json
{"shift_id":123}
```

---

## Evidence (empleado only)

### POST `/evidence_upload`
- Role: **empleado**
- Headers: `x-shift-otp-token`

Request upload:
```json
{"action":"request_upload","shift_id":123,"type":"inicio"}
```

Finalize upload:
```json
{"action":"finalize_upload","shift_id":123,"type":"inicio","path":"...","lat":-34.6,"lng":-58.38,"accuracy":12,"captured_at":"2026-03-12T00:00:00Z"}
```

---

## Incidents

### POST `/incidents_create`
- Role: **empleado**, **supervisora**, **super_admin**
- Headers: `x-shift-otp-token`
```json
{
  "shift_id":123,
  "description":"...",
  "task":{
    "assigned_employee_id":"uuid",
    "title":"...",
    "description":"...",
    "priority":"normal",
    "due_at":"2026-03-12T00:00:00Z"
  }
}
```

---

## Scheduled shifts

### POST `/scheduled_shifts_manage`
- Role: **supervisora**, **super_admin**

Assign:
```json
{"action":"assign","employee_id":"uuid","restaurant_id":1,"scheduled_start":"...","scheduled_end":"...","notes":"optional"}
```

Bulk assign:
```json
{"action":"bulk_assign","entries":[{"employee_id":"uuid","restaurant_id":1,"scheduled_start":"...","scheduled_end":"...","notes":"optional"}]}
```

Reschedule:
```json
{"action":"reschedule","scheduled_shift_id":10,"scheduled_start":"...","scheduled_end":"...","notes":"optional"}
```

Cancel:
```json
{"action":"cancel","scheduled_shift_id":10,"reason":"optional"}
```

List:
```json
{"action":"list","employee_id":"uuid?","restaurant_id":1,"status":"scheduled","from":"...","to":"...","limit":100}
```

---

## Operational tasks

### POST `/operational_tasks_manage`
- Role:
  - create: **supervisora**, **super_admin**
  - list_my_open: **empleado**
  - list_supervision: **supervisora**, **super_admin**
  - request_manifest_upload / request_evidence_upload / complete: **empleado**, **supervisora**, **super_admin**

Create:
```json
{"action":"create","shift_id":123,"assigned_employee_id":"uuid","title":"...","description":"...","priority":"normal","due_at":"optional"}
```

Request manifest upload:
```json
{"action":"request_manifest_upload","task_id":123}
```

Request evidence upload:
```json
{"action":"request_evidence_upload","task_id":123,"mime_type":"image/jpeg"}
```

Complete:
```json
{"action":"complete","task_id":123,"evidence_path":"..."}
```

List my open (empleado):
```json
{"action":"list_my_open","shift_id":123,"limit":50}
```

List supervision:
```json
{"action":"list_supervision","restaurant_id":1,"status":"pending","limit":100}
```

---

## Supplies (deliver + read)

### POST `/supplies_deliver`
- Role: **supervisora**, **super_admin**

Deliver:
```json
{"action":"deliver","supply_id":1,"restaurant_id":1,"quantity":10}
```

List supplies (inventory):
```json
{"action":"list_supplies","restaurant_id":1,"limit":200,"search":"optional"}
```
Note: `restaurant_id` is required for **supervisora**.

List deliveries:
```json
{"action":"list_deliveries","restaurant_id":1,"delivered_by":"uuid?","limit":200}
```
Note: `restaurant_id` is required for **supervisora**.
Note: Use `delivered_by` to filter deliveries for a specific employee.

---

## Admin users

### POST `/admin_users_manage` (super_admin only)

Create:
```json
{"action":"create","email":"...","role":"super_admin|supervisora|empleado","password":"optional","first_name":"optional","last_name":"optional","full_name":"optional","phone_number":"required for supervisora/empleado in E.164","is_active":true}
```

Update:
```json
{"action":"update","user_id":"uuid","email":"optional","role":"optional","first_name":"optional","last_name":"optional","full_name":"optional","phone_number":"required if resulting role is supervisora/empleado, E.164 format","is_active":true}
```

Activate / deactivate:
```json
{"action":"activate","user_id":"uuid"}
```
```json
{"action":"deactivate","user_id":"uuid","reason":"optional"}
```

List:
```json
{"action":"list","role":"optional","is_active":true,"search":"optional","limit":100}
```

---

## Admin restaurants

### POST `/admin_restaurants_manage` (super_admin only)

Create:
```json
{"action":"create","name":"...","lat":0,"lng":0,"radius":100,"address_line":"optional","city":"optional","state":"optional","postal_code":"optional","country":"optional","place_id":"optional","is_active":true}
```

Update:
```json
{"action":"update","restaurant_id":1,"name":"optional","lat":0,"lng":0,"radius":100,"address_line":"optional","city":"optional","state":"optional","postal_code":"optional","country":"optional","place_id":"optional","is_active":true}
```

Activate / deactivate:
```json
{"action":"activate","restaurant_id":1}
```
```json
{"action":"deactivate","restaurant_id":1}
```

List:
```json
{"action":"list","is_active":true,"search":"optional","limit":200}
```

---

## Admin supervisors

### POST `/admin_supervisors_manage` (super_admin only)

Assign:
```json
{"action":"assign","supervisor_id":"uuid","restaurant_id":1}
```

Unassign:
```json
{"action":"unassign","supervisor_id":"uuid","restaurant_id":1}
```

List by restaurant:
```json
{"action":"list_by_restaurant","restaurant_id":1}
```

List by supervisor:
```json
{"action":"list_by_supervisor","supervisor_id":"uuid"}
```

---

## Admin dashboard metrics

### POST `/admin_dashboard_metrics` (super_admin only)
```json
{"action":"summary","restaurant_id":1,"period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD"}
```

---

## Restaurant staff

### POST `/restaurant_staff_manage`
- Role: **super_admin**, **supervisora**

Assign employee:
```json
{"action":"assign_employee","employee_id":"uuid","restaurant_id":1}
```

Unassign employee:
```json
{"action":"unassign_employee","employee_id":"uuid","restaurant_id":1}
```

List by restaurant:
```json
{"action":"list_by_restaurant","restaurant_id":1}
```

List by employee:
```json
{"action":"list_by_employee","employee_id":"uuid"}
```

---

## Reports

### POST `/reports_generate`
- Role: **supervisora**, **super_admin**
```json
{"restaurant_id":1,"period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD","filtros_json":{},"columns":["..."],"export_format":"csv|pdf|both"}
```

---

## Audit logs

### POST `/audit_log` (super_admin only)
```json
{"action":"...","context":{"key":"value"}}
```

---

## Email notifications (admin)

### POST `/email_notifications_dispatch` (super_admin only)
```json
{"enqueue_shift_not_started":true,"overdue_limit":100,"grace_minutes":15,"dispatch_limit":50,"max_attempts":5}
```
