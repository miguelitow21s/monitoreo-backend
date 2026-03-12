# Frontend Handoff Updates

## 2026-03-11 - Admin scope expansion (super_admin)

### Backend changes delivered
- Added new Edge Function: `/functions/v1/admin_users_manage`
- Added new Edge Function: `/functions/v1/admin_restaurants_manage`
- Added new Edge Function: `/functions/v1/admin_supervisors_manage`
- Added new Edge Function: `/functions/v1/admin_dashboard_metrics`
- Hardened auth guard to block inactive users (`users.is_active = false`)

### Frontend actions required
- Add admin-only screens for:
  - User management
  - Restaurant management
  - Supervisor assignment
  - Executive metrics dashboard
- Ensure all calls include:
  - `Authorization: Bearer <access_token>`
  - `Idempotency-Key: <unique-per-request>` (required for these endpoints)
  - `Content-Type: application/json`
- Hide employee UI routes for super_admin profile while still allowing admin operational actions.
- Handle standardized API envelope:
  - success: `{ success: true, data, error: null, request_id }`
  - error: `{ success: false, data: null, error, request_id }`

### QA checklist for frontend
- Verify super_admin can create/edit/activate/deactivate users.
- Verify super_admin can create/edit/activate/deactivate restaurants.
- Verify super_admin can assign and unassign supervisors by restaurant.
- Verify super_admin can load dashboard metrics by date range and optional restaurant filter.
- Verify inactive users are blocked in app flows after deactivation.

## 2026-03-11 - Supervisor operational flow alignment

### Backend changes delivered
- Updated shift endpoints so `supervisora` can start/end own shifts:
  - `/functions/v1/shifts_start`
  - `/functions/v1/shifts_end`
- Added RLS migration for supervisor own shift lifecycle:
  - `supabase/migrations/021_supervisora_shift_and_staff_alignment.sql`
- Added new Edge Function for restaurant employee assignment:
  - `/functions/v1/restaurant_staff_manage`
- Expanded operational tasks evidence flow with photo uploads:
  - New action: `request_evidence_upload`
  - Existing `complete` now supports image evidence (`jpeg/png/webp`) and JSON manifest.

### Frontend actions required
- In supervisor UI, enable own check-in/check-out using existing shift start/end endpoints.
- Add staff assignment flow (supervisor + super admin) using `/functions/v1/restaurant_staff_manage`.
- In employee task flow, request photo upload URL using `request_evidence_upload` and then send the resulting `evidence_path` in `complete`.
- Show task alert badge/count on check-in screen using open task queries (`list_my_open`) right after shift start.

### QA checklist for frontend
- Verify supervisora can only start shift in assigned restaurants.
- Verify supervisora can end only own active shift.
- Verify supervisor can assign/unassign employees only within authorized restaurants.
- Verify employee can upload photo evidence and complete operational tasks successfully.
- Verify old JSON-manifest task completion flow remains backward compatible.

## 2026-03-11 - Empleado de Aseo self-service and mandatory evidence

### Backend changes delivered
- Added new Edge Function for employee self-service:
  - `/functions/v1/employee_self_service`
- Added employee self-service actions:
  - `my_dashboard` (restaurante asignado, agenda programada, tareas pendientes, turno activo)
  - `my_hours_history` (historial y total de horas trabajadas por periodo)
  - `create_observation` (observaciones y alertas del empleado durante su turno)
- Hardened shift end flow:
  - `/functions/v1/shifts_end` now requires evidence of both types `inicio` and `fin` before check-out.

### Frontend actions required
- Add employee home widget backed by `employee_self_service` action `my_dashboard`.
- Add employee hours history screen backed by `employee_self_service` action `my_hours_history`.
- Add employee report button/form for observations and alerts backed by `employee_self_service` action `create_observation`.
- Enforce evidence sequence in employee UX:
  - Upload `inicio` photo after check-in.
  - Upload `fin` photo before check-out.
  - Block check-out UI if any mandatory shift evidence is missing.
- Keep current task-evidence flow for supervisor-assigned tasks using `operational_tasks_manage` (`request_evidence_upload` + `complete`).

### QA checklist for frontend
- Verify employee can view assigned restaurant(s) and upcoming schedule.
- Verify employee can view worked-hours history by date range.
- Verify employee can create both observation and alert records from active shift.
- Verify check-out fails with clear UX when `inicio` or `fin` photo is missing.
- Verify check-out succeeds after both mandatory photos are uploaded.

## 2026-03-12 - Supervisora hitting employee_self_service (403 expected)

### Backend behavior (expected)
- `/functions/v1/employee_self_service` is **empleado-only**.
- If a `supervisora` token calls it, the backend returns **403 PERMISSION** via the standard envelope.

### Frontend actions required
- Route supervisor flows to supervisor endpoints instead of `employee_self_service`:
  - Programacion/agenda: `/functions/v1/scheduled_shifts_manage` (list/assign/reschedule/cancel)
  - Tareas operativas: `/functions/v1/operational_tasks_manage` (list_supervision/create/complete)
  - Metrica ejecutiva: `/functions/v1/admin_dashboard_metrics`
- If UI is shared between roles, gate calls by role:
  - `empleado` => `employee_self_service`
  - `supervisora` => supervisor endpoints above

### Error example (expected for supervisora)
- `403` with body `{ success: false, data: null, error: { code: 403, category: "PERMISSION", ... }, request_id }`

### Notes (frontend-only)
- Console warning about zustand default export is from FE code; switch to `import { create } from 'zustand'`.
- Realtime WebSocket disconnect is not required by backend; disable if not used.
