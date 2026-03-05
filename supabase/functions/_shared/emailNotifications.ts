import { clientAdmin } from "./supabaseClient.ts";

type NotificationEventType =
  | "shift_scheduled"
  | "shift_started"
  | "shift_ended"
  | "shift_not_started"
  | "incident_created"
  | "shift_approved"
  | "shift_rejected";

type Recipient = {
  id: string;
  email: string;
};

type DispatchSummary = {
  queued_shift_not_started: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
};

let cachedRoleIds: { super_admin: number; supervisora: number } | null = null;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function sanitizeText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

async function getRoleIds(): Promise<{ super_admin: number; supervisora: number }> {
  if (cachedRoleIds) return cachedRoleIds;

  const { data, error } = await clientAdmin.from("roles").select("id, name").in("name", ["super_admin", "supervisora"]);
  if (error || !data) {
    throw { code: 500, message: "No se pudieron cargar roles para notificaciones", category: "SYSTEM", details: error };
  }

  const map = new Map<string, number>();
  for (const row of data as { id: number; name: string }[]) {
    map.set(row.name, row.id);
  }

  const superAdminId = map.get("super_admin");
  const supervisorId = map.get("supervisora");
  if (!superAdminId || !supervisorId) {
    throw { code: 500, message: "Roles requeridos no encontrados", category: "SYSTEM" };
  }

  cachedRoleIds = {
    super_admin: superAdminId,
    supervisora: supervisorId,
  };

  return cachedRoleIds;
}

async function loadUserById(userId: string): Promise<Recipient | null> {
  const { data, error } = await clientAdmin
    .from("users")
    .select("id, email, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw { code: 500, message: "No se pudo cargar usuario de notificacion", category: "SYSTEM", details: error };
  }

  if (!data || !(data as { is_active?: boolean }).is_active || !(data as { email?: string | null }).email) {
    return null;
  }

  return {
    id: (data as { id: string }).id,
    email: normalizeEmail((data as { email: string }).email),
  };
}

async function loadActiveUsersByRoleId(roleId: number): Promise<Recipient[]> {
  const { data, error } = await clientAdmin
    .from("users")
    .select("id, email")
    .eq("role_id", roleId)
    .eq("is_active", true)
    .not("email", "is", null);

  if (error) {
    throw { code: 500, message: "No se pudieron cargar usuarios por rol", category: "SYSTEM", details: error };
  }

  return ((data ?? []) as { id: string; email: string }[])
    .filter((row) => Boolean(row.email))
    .map((row) => ({ id: row.id, email: normalizeEmail(row.email) }));
}

async function loadSupervisorsForRestaurant(restaurantId: number): Promise<Recipient[]> {
  const { data: relData, error: relError } = await clientAdmin
    .from("restaurant_employees")
    .select("user_id")
    .eq("restaurant_id", restaurantId);

  if (relError) {
    throw { code: 500, message: "No se pudo cargar alcance de supervisoras", category: "SYSTEM", details: relError };
  }

  const userIds = [...new Set(((relData ?? []) as { user_id: string }[]).map((row) => row.user_id))];
  if (userIds.length === 0) return [];

  const { supervisora: supervisoraRoleId } = await getRoleIds();

  const { data, error } = await clientAdmin
    .from("users")
    .select("id, email")
    .in("id", userIds)
    .eq("role_id", supervisoraRoleId)
    .eq("is_active", true)
    .not("email", "is", null);

  if (error) {
    throw { code: 500, message: "No se pudieron cargar supervisoras del restaurante", category: "SYSTEM", details: error };
  }

  return ((data ?? []) as { id: string; email: string }[])
    .filter((row) => Boolean(row.email))
    .map((row) => ({ id: row.id, email: normalizeEmail(row.email) }));
}

async function loadShiftContext(shiftId: number): Promise<{ shift_id: number; restaurant_id: number; employee_id: string }> {
  const { data, error } = await clientAdmin
    .from("shifts")
    .select("id, restaurant_id, employee_id")
    .eq("id", shiftId)
    .single();

  if (error || !data) {
    throw { code: 404, message: "Turno no encontrado para notificacion", category: "BUSINESS", details: error };
  }

  return {
    shift_id: (data as { id: number }).id,
    restaurant_id: (data as { restaurant_id: number }).restaurant_id,
    employee_id: (data as { employee_id: string }).employee_id,
  };
}

async function buildStakeholders(params: {
  restaurantId: number;
  employeeId?: string;
  includeEmployee?: boolean;
}): Promise<Recipient[]> {
  const recipients = new Map<string, Recipient>();

  if (params.includeEmployee !== false && params.employeeId) {
    const employee = await loadUserById(params.employeeId);
    if (employee) recipients.set(employee.id, employee);
  }

  const { super_admin: superAdminRoleId } = await getRoleIds();
  const [admins, supervisors] = await Promise.all([
    loadActiveUsersByRoleId(superAdminRoleId),
    loadSupervisorsForRestaurant(params.restaurantId),
  ]);

  for (const recipient of [...admins, ...supervisors]) {
    recipients.set(recipient.id, recipient);
  }

  return [...recipients.values()];
}

async function enqueueForRecipients(params: {
  eventType: NotificationEventType;
  dedupePrefix: string;
  recipients: Recipient[];
  subject: string;
  bodyText: string;
  payload: Record<string, unknown>;
  restaurantId?: number;
  shiftId?: number;
  incidentId?: number;
  scheduledShiftId?: number;
}) {
  if (params.recipients.length === 0) return;

  const nowIso = new Date().toISOString();
  const rows = params.recipients.map((recipient) => ({
    event_type: params.eventType,
    dedupe_key: `${params.dedupePrefix}:${recipient.id}`,
    recipient_email: recipient.email,
    recipient_user_id: recipient.id,
    subject: sanitizeText(params.subject, 300),
    body_text: sanitizeText(params.bodyText, 5000),
    payload: params.payload,
    restaurant_id: params.restaurantId ?? null,
    shift_id: params.shiftId ?? null,
    incident_id: params.incidentId ?? null,
    scheduled_shift_id: params.scheduledShiftId ?? null,
    status: "pending",
    attempts: 0,
    scheduled_for: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
  }));

  const { error } = await clientAdmin
    .from("email_notifications")
    .upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });

  if (error) {
    throw { code: 500, message: "No se pudo encolar notificacion email", category: "SYSTEM", details: error };
  }
}

async function sendEmailViaResend(params: {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}): Promise<{ ok: true; provider_ref: string | null } | { ok: false; error: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("EMAIL_FROM")?.trim();

  if (!apiKey || !from) {
    return { ok: false, error: "provider_not_configured" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: params.subject,
      text: params.text,
      html: params.html ?? undefined,
    }),
  });

  const payload = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!res.ok) {
    return {
      ok: false,
      error: payload?.message ?? `email_send_failed_${res.status}`,
    };
  }

  return {
    ok: true,
    provider_ref: payload?.id ?? null,
  };
}

export async function dispatchPendingEmailNotifications(params?: {
  limit?: number;
  maxAttempts?: number;
}): Promise<DispatchSummary> {
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);
  const maxAttempts = Math.min(Math.max(params?.maxAttempts ?? 5, 1), 20);
  const nowIso = new Date().toISOString();

  const { data, error } = await clientAdmin
    .from("email_notifications")
    .select("id, recipient_email, subject, body_text, body_html, attempts")
    .in("status", ["pending", "failed"])
    .lt("attempts", maxAttempts)
    .lte("scheduled_for", nowIso)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw { code: 500, message: "No se pudo consultar cola de emails", category: "SYSTEM", details: error };
  }

  const rows = (data ?? []) as Array<{
    id: number;
    recipient_email: string;
    subject: string;
    body_text: string;
    body_html: string | null;
    attempts: number;
  }>;

  const summary: DispatchSummary = {
    queued_shift_not_started: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    const nextAttempts = (row.attempts ?? 0) + 1;
    const { data: claimed, error: claimError } = await clientAdmin
      .from("email_notifications")
      .update({
        status: "sending",
        attempts: nextAttempts,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .in("status", ["pending", "failed"])
      .select("id")
      .maybeSingle();

    if (claimError) {
      summary.failed += 1;
      continue;
    }

    if (!claimed) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;

    const sent = await sendEmailViaResend({
      to: row.recipient_email,
      subject: row.subject,
      text: row.body_text,
      html: row.body_html,
    });

    if (sent.ok) {
      const { error: sentUpdateError } = await clientAdmin
        .from("email_notifications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          provider_ref: sent.provider_ref,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      if (sentUpdateError) {
        summary.failed += 1;
      } else {
        summary.sent += 1;
      }
      continue;
    }

    const { error: failedUpdateError } = await clientAdmin
      .from("email_notifications")
      .update({
        status: "failed",
        last_error: sent.error,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    if (failedUpdateError) {
      summary.failed += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

export async function safeDispatchPendingEmailNotifications(params?: {
  limit?: number;
  maxAttempts?: number;
}) {
  try {
    await dispatchPendingEmailNotifications(params);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "EMAIL_DISPATCH_ERROR",
        error,
        ts: new Date().toISOString(),
      })
    );
  }
}

export async function notifyShiftEvent(params: {
  eventType: "shift_started" | "shift_ended" | "shift_approved" | "shift_rejected";
  shiftId: number;
  actorUserId: string;
}) {
  const context = await loadShiftContext(params.shiftId);
  const recipients = await buildStakeholders({
    restaurantId: context.restaurant_id,
    employeeId: context.employee_id,
    includeEmployee: true,
  });

  const actionLabel =
    params.eventType === "shift_started"
      ? "iniciado"
      : params.eventType === "shift_ended"
      ? "finalizado"
      : params.eventType === "shift_approved"
      ? "aprobado"
      : "rechazado";

  const subject = `Turno ${actionLabel} | #${context.shift_id}`;
  const bodyText = `El turno #${context.shift_id} fue ${actionLabel}. Actor: ${params.actorUserId}. Restaurante: ${context.restaurant_id}.`;

  await enqueueForRecipients({
    eventType: params.eventType,
    dedupePrefix: `${params.eventType}:${context.shift_id}`,
    recipients,
    subject,
    bodyText,
    payload: {
      shift_id: context.shift_id,
      restaurant_id: context.restaurant_id,
      employee_id: context.employee_id,
      actor_user_id: params.actorUserId,
    },
    restaurantId: context.restaurant_id,
    shiftId: context.shift_id,
  });
}

export async function notifyIncidentCreated(params: {
  incidentId: number;
  shiftId: number;
  actorUserId: string;
}) {
  const context = await loadShiftContext(params.shiftId);
  const recipients = await buildStakeholders({
    restaurantId: context.restaurant_id,
    employeeId: context.employee_id,
    includeEmployee: true,
  });

  await enqueueForRecipients({
    eventType: "incident_created",
    dedupePrefix: `incident_created:${params.incidentId}`,
    recipients,
    subject: `Incidente reportado | #${params.incidentId}`,
    bodyText: `Se reporto la incidencia #${params.incidentId} en el turno #${params.shiftId}. Actor: ${params.actorUserId}.`,
    payload: {
      incident_id: params.incidentId,
      shift_id: params.shiftId,
      restaurant_id: context.restaurant_id,
      employee_id: context.employee_id,
      actor_user_id: params.actorUserId,
    },
    restaurantId: context.restaurant_id,
    shiftId: params.shiftId,
    incidentId: params.incidentId,
  });
}

async function enqueueShiftNotStartedNotificationForSchedule(params: {
  scheduledShiftId: number;
  restaurantId: number;
  employeeId: string;
  scheduledStart: string;
  scheduledEnd: string;
}) {
  const recipients = await buildStakeholders({
    restaurantId: params.restaurantId,
    employeeId: params.employeeId,
    includeEmployee: true,
  });

  const subject = `Turno no iniciado | Programacion #${params.scheduledShiftId}`;
  const bodyText = `El turno programado #${params.scheduledShiftId} no se inicio a tiempo. Inicio: ${params.scheduledStart}. Fin: ${params.scheduledEnd}.`;

  await enqueueForRecipients({
    eventType: "shift_not_started",
    dedupePrefix: `shift_not_started:${params.scheduledShiftId}`,
    recipients,
    subject,
    bodyText,
    payload: {
      scheduled_shift_id: params.scheduledShiftId,
      restaurant_id: params.restaurantId,
      employee_id: params.employeeId,
      scheduled_start: params.scheduledStart,
      scheduled_end: params.scheduledEnd,
    },
    restaurantId: params.restaurantId,
    scheduledShiftId: params.scheduledShiftId,
  });
}

export async function enqueueOverdueShiftNotStartedNotifications(params?: {
  limit?: number;
  graceMinutes?: number;
}): Promise<number> {
  const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500);
  const graceMinutes = Math.min(Math.max(params?.graceMinutes ?? 15, 1), 240);
  const thresholdIso = new Date(Date.now() - graceMinutes * 60 * 1000).toISOString();

  const { data, error } = await clientAdmin
    .from("scheduled_shifts")
    .select("id, restaurant_id, employee_id, scheduled_start, scheduled_end")
    .eq("status", "scheduled")
    .lte("scheduled_start", thresholdIso)
    .order("scheduled_start", { ascending: true })
    .limit(limit);

  if (error) {
    throw { code: 500, message: "No se pudieron consultar turnos no iniciados", category: "SYSTEM", details: error };
  }

  const overdueRows = (data ?? []) as Array<{
    id: number;
    restaurant_id: number;
    employee_id: string;
    scheduled_start: string;
    scheduled_end: string;
  }>;

  for (const row of overdueRows) {
    await enqueueShiftNotStartedNotificationForSchedule({
      scheduledShiftId: row.id,
      restaurantId: row.restaurant_id,
      employeeId: row.employee_id,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
    });
  }

  return overdueRows.length;
}
