-- 064_operational_tasks_active_visit_closure.sql
-- ============================================================================
-- Gap de la migración a visitas: el endpoint MUESTRA una tarea de sitio
-- (task_scope='restaurant') a cualquiera con VISITA ACTIVA ahí (list_my_open usa
-- lógica de visita activa por service role), pero el CIERRE (complete, vía
-- clientUser) está gobernado por RLS que aún exige pertenencia en
-- restaurant_employees. Esa tabla ya no se puebla en el flujo de visitas
-- (solo la creaba assign_scheduled_shift, y el agendamiento está en 410); las
-- filas actuales son legado. => un contratista en visita ad-hoc a un sitio sin
-- fila legado ve la tarea pero no puede cerrarla.
--
-- Fix: alinear la RLS al modelo de presencia por visita -- permitir cerrar/ver
-- una tarea de sitio si el usuario tiene una VISITA ACTIVA en ese restaurante,
-- ADEMÁS de la rama legado de restaurant_employees (se conserva, sin regresión).
--
-- Seguro por diseño: el trigger operational_tasks_guard_update (026) ya acota
-- QUÉ puede cambiar un empleado (solo status=completed + resolved_by=uid +
-- evidencia válida con ruta/hash/mime + campos base inmutables). Ampliar QUIÉN
-- puede cerrar no habilita manipular nada más: solo cerrar-con-evidencia una
-- tarea del sitio donde el usuario está físicamente (visita geocercada, ya que
-- shifts_start valida la geocerca y ahora es el único escritor de shifts).
--
-- La subconsulta EXISTS sobre shifts se apoya en el índice parcial
-- uq_shifts_one_active_per_employee (employee_id WHERE state='activo'): a lo sumo
-- 1 fila por usuario, costo despreciable en RLS.
--
-- ALTER POLICY es atómico: no hay instante en que la política no exista.

begin;

-- 1) UPDATE: habilita el cierre por visita activa (rama nueva en OR).
alter policy operational_tasks_update_supervision on public.operational_tasks
  using (
    (actor_role_secure() = ANY (ARRAY['super_admin'::text, 'supervisora'::text]))
    OR (
      (actor_role_secure() = 'empleado'::text)
      AND (
        (assigned_employee_id = auth.uid())
        OR (
          (task_scope = 'restaurant'::text)
          AND (
            (restaurant_id IN (
              SELECT re.restaurant_id FROM public.restaurant_employees re
              WHERE re.user_id = auth.uid()
            ))
            OR EXISTS (
              SELECT 1 FROM public.shifts s
              WHERE s.employee_id = auth.uid()
                AND s.restaurant_id = operational_tasks.restaurant_id
                AND s.state = 'activo'::public.shift_state
            )
          )
        )
      )
    )
  )
  with check (
    (actor_role_secure() = ANY (ARRAY['super_admin'::text, 'supervisora'::text]))
    OR (
      (actor_role_secure() = 'empleado'::text)
      AND (
        (assigned_employee_id = auth.uid())
        OR (
          (task_scope = 'restaurant'::text)
          AND (
            (restaurant_id IN (
              SELECT re.restaurant_id FROM public.restaurant_employees re
              WHERE re.user_id = auth.uid()
            ))
            OR EXISTS (
              SELECT 1 FROM public.shifts s
              WHERE s.employee_id = auth.uid()
                AND s.restaurant_id = operational_tasks.restaurant_id
                AND s.state = 'activo'::public.shift_state
            )
          )
        )
      )
    )
  );

-- 2) SELECT: misma alineación, para que una lectura directa por PostgREST vea
--    las tareas de sitio del lugar donde el usuario tiene visita activa
--    (la app las lista por service role, pero deja la RLS consistente).
alter policy operational_tasks_select_scoped on public.operational_tasks
  using (
    (assigned_employee_id = auth.uid())
    OR (actor_role_secure() = ANY (ARRAY['super_admin'::text, 'supervisora'::text]))
    OR (
      (task_scope = 'restaurant'::text)
      AND (
        (restaurant_id IN (
          SELECT re.restaurant_id FROM public.restaurant_employees re
          WHERE re.user_id = auth.uid()
        ))
        OR EXISTS (
          SELECT 1 FROM public.shifts s
          WHERE s.employee_id = auth.uid()
            AND s.restaurant_id = operational_tasks.restaurant_id
            AND s.state = 'activo'::public.shift_state
        )
      )
    )
  );

commit;
