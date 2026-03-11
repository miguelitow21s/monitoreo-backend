# Release E2E Sign-off (Produccion)

Fecha: 2026-03-10
Scope: turnos, agenda, roles, estado usuario y reset de contrasena.

## 1) Precondiciones

- Tener al menos 1 usuario por rol: `empleado`, `supervisora`, `super_admin`.
- Tener al menos 1 restaurante activo con geocerca valida.
- Tener un dispositivo confiable y sesion OTP activa para pruebas de `shifts_start` y `shifts_end`.
- Tener tokens JWT por rol para pruebas de Edge Functions.

## 2) Flujo de turnos programados

### Caso A: Agendar turno (single)

1. Como `super_admin` o `supervisora`, crear un registro en `scheduled_shifts` con `status='scheduled'`.
2. Verificar que se crea sin solape contra turnos activos del mismo empleado.
3. Esperado: insercion exitosa y visible en panel de agenda.

### Caso B: Agendar varios turnos (bulk)

1. Crear N turnos para el mismo empleado sin solape de rango.
2. Intentar crear al menos 1 solapado en ventana activa (`scheduled`/`started`).
3. Esperado: los no solapados se crean; el solapado falla por exclusion constraint.

### Caso C: Reprogramar turno

1. Actualizar `scheduled_start` y `scheduled_end` de un turno `scheduled`.
2. Esperado: actualizacion exitosa si no genera solape.
3. Esperado negativo: si genera solape, falla por constraint.

### Caso D: Cancelar turno

1. Actualizar `status='cancelled'` sobre turno `scheduled`.
2. Esperado: no debe iniciar via `start_shift`.

## 3) Flujo de iniciar/finalizar turno (operacion real)

### Caso E: Iniciar turno (`shifts_start`)

1. Llamar `POST /functions/v1/shifts_start` como `empleado` con `restaurant_id`, `lat`, `lng`, checklist.
2. Header obligatorio: `Idempotency-Key`.
3. Esperado: crea `shifts.state='activo'` y cambia `scheduled_shifts.status='started'` cuando aplica.
4. Esperado negativo:
- sin OTP o sin dispositivo confiable: rechazo.
- fuera de geocerca: rechazo.
- ya existe turno activo: rechazo.

### Caso F: Finalizar turno (`shifts_end`)

1. Llamar `POST /functions/v1/shifts_end` como `empleado` con `shift_id`, `lat`, `lng`, checklist.
2. Header obligatorio: `Idempotency-Key`.
3. Esperado: `shifts.state='finalizado'`, `end_time` no nulo y `scheduled_shifts.status='completed'`.
4. Esperado negativo:
- turno de otro empleado: rechazo.
- turno no activo: rechazo.
- fuera de geocerca: rechazo.

## 4) Cambio de rol y estado de usuario

### Caso G: Cambio de rol (empleado -> supervisora -> super_admin)

1. Cambiar rol en `public.users.role_id` (o via `profiles` si aplica).
2. Consumir endpoint protegido por rol:
- `shifts_start` solo `empleado`.
- `reports_generate` permite `supervisora/super_admin`.
- `audit_log` solo `super_admin`.
3. Esperado: permisos cambian acorde al nuevo rol.

Nota: Edge Functions leen el rol desde `public.users` en cada request, por lo que el cambio debe verse inmediatamente en backend. Si el frontend cachea permisos, refrescar sesion/pantalla.

### Caso H: Activacion/desactivacion de usuario

1. Cambiar `users.is_active`.
2. Verificar impacto en flujos de notificacion y acceso operativo segun politica front.
3. Esperado: usuario inactivo no debe participar en operaciones habilitadas por estado activo.

## 5) Reset de contrasena

### Caso I: Recuperacion de contrasena (Supabase Auth)

1. Ejecutar flujo de recovery desde frontend o endpoint de Supabase Auth.
2. Completar cambio de contrasena con link/token de recovery.
3. Esperado:
- login con clave anterior falla.
- login con clave nueva funciona.
- sesion en cliente se renueva correctamente.

Nota: este flujo es de Supabase Auth; no hay Edge Function custom de reset en este repo.

## 6) Criterio de aprobacion final

- Todos los casos A-I en estado PASS.
- Sin errores de RLS ni fuga de datos cross-user.
- Sin inconsistencias de estado (`scheduled`, `started`, `completed`, `cancelled`; `activo`, `finalizado`).
- Evidencia y auditoria generadas en operaciones clave.
