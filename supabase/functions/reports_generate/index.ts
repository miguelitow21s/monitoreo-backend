import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { ensureSupervisorRestaurantAccess } from "../_shared/scopeGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "reports_generate";
const payloadSchema = z.object({
  restaurant_id: commonSchemas.restaurantId,
  period_start: commonSchemas.dateYmd,
  period_end: commonSchemas.dateYmd,
  filtros_json: z.record(z.any()).optional(),
  columns: z.array(z.string().min(1).max(64)).max(100).optional(),
  export_format: z.enum(["csv", "pdf", "both", "xlsx"]).optional(),
});

const allowedColumns = [
  "shift_id",
  "employee_id",
  "employee_name",
  "supervisor_name",
  "restaurant_id",
  "restaurant_name",
  "start_time",
  "end_time",
  "hours_worked",
  "scheduled_start",
  "scheduled_end",
  "scheduled_hours",
  "early_end_reason",
  "incidents_count",
  "state",
  "status",
  "approved_by",
  "approved_by_name",
  "rejected_by",
  "rejected_by_name",
  "start_evidence_path",
  "end_evidence_path",
] as const;

const defaultColumns = [
  "shift_id",
  "restaurant_name",
  "employee_name",
  "supervisor_name",
  "start_time",
  "end_time",
  "hours_worked",
  "state",
  "incidents_count",
  "start_evidence_path",
  "end_evidence_path",
] as const;

const columnLabel: Record<string, string> = {
  shift_id: "Turno",
  employee_id: "Empleado ID",
  employee_name: "Empleado",
  supervisor_name: "Supervisora",
  restaurant_id: "Restaurante ID",
  restaurant_name: "Restaurante",
  start_time: "Inicio",
  end_time: "Fin",
  hours_worked: "Duracion (HH:MM)",
  scheduled_start: "Inicio programado",
  scheduled_end: "Fin programado",
  scheduled_hours: "Horas programadas",
  early_end_reason: "Motivo salida anticipada",
  incidents_count: "Novedades",
  state: "Estado",
  status: "Status",
  approved_by: "Aprobado por (ID)",
  approved_by_name: "Aprobado por",
  rejected_by: "Rechazado por (ID)",
  rejected_by_name: "Rechazado por",
  start_evidence_path: "Evidencia inicial",
  end_evidence_path: "Evidencia final",
};

const columnAliases: Record<string, string> = {
  turno: "shift_id",
  restaurante: "restaurant_name",
  empleado: "employee_name",
  supervisora: "supervisor_name",
  inicio: "start_time",
  fin: "end_time",
  estado: "state",
  duracion: "hours_worked",
  inicio_programado: "scheduled_start",
  fin_programado: "scheduled_end",
  horas_programadas: "scheduled_hours",
  motivo_salida_anticipada: "early_end_reason",
  novedades: "incidents_count",
  evidencia_inicial: "start_evidence_path",
  evidencia_final: "end_evidence_path",
};

function csvEscape(value: unknown) {
  const raw = value == null ? "" : String(value);
  if (raw.includes(",") || raw.includes("\n") || raw.includes("\"")) {
    return `"${raw.replaceAll("\"", "\"\"")}"`;
  }
  return raw;
}

function normalizeColumnKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatCell(value: unknown, maxLen = 40) {
  const raw = value == null ? "" : String(value);
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatDateTime(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatDuration(hoursValue: number | null) {
  if (hoursValue == null || Number.isNaN(hoursValue)) return "";
  const totalMinutes = Math.round(hoursValue * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function diffHours(startIso: string | null, endIso: string | null) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Number((ms / 3600000).toFixed(2));
}

function formatState(value: string | null) {
  const map: Record<string, string> = {
    activo: "Activo",
    finalizado: "Finalizado",
    aprobado: "Aprobado",
    rechazado: "Rechazado",
    scheduled: "Programado",
    started: "Iniciado",
    completed: "Completado",
    cancelled: "Cancelado",
  };
  if (!value) return "";
  return map[value] ?? value;
}

function shortenEvidencePath(path: string, maxLen = 40) {
  const parts = path.split("/");
  const tail = parts.slice(-2).join("/");
  if (tail.length <= maxLen) return tail;
  return `${tail.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatEvidence(path: string | null, mode: "csv" | "pdf") {
  if (!path) return "NO";
  if (mode === "pdf") return "SI";
  return `SI (${shortenEvidencePath(path, 48)})`;
}

function formatValue(row: Record<string, unknown>, column: string, mode: "csv" | "pdf") {
  switch (column) {
    case "start_time":
    case "end_time":
    case "scheduled_start":
    case "scheduled_end":
      return formatDateTime(row[column] as string | null);
    case "hours_worked":
    case "scheduled_hours":
      return formatDuration(row[column] as number | null);
    case "early_end_reason":
      return row[column] ?? "";
    case "state":
    case "status":
      return formatState(row[column] ? String(row[column]) : null);
    case "incidents_count":
      return row[column] == null ? "0" : String(row[column]);
    case "employee_name":
      return (row.employee_name as string | null) ?? (row.employee_id as string | number | null) ?? "";
    case "supervisor_name":
      return (row.supervisor_name as string | null) ?? "";
    case "restaurant_name":
      return (row.restaurant_name as string | null) ?? (row.restaurant_id as string | number | null) ?? "";
    case "approved_by_name":
      return (row.approved_by_name as string | null) ?? (row.approved_by as string | number | null) ?? "";
    case "rejected_by_name":
      return (row.rejected_by_name as string | null) ?? (row.rejected_by as string | number | null) ?? "";
    case "start_evidence_path":
      return formatEvidence(row.start_evidence_path as string | null, mode);
    case "end_evidence_path":
      return formatEvidence(row.end_evidence_path as string | null, mode);
    default:
      return row[column] ?? "";
  }
}

function buildXlsxWorkbook(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  headerLabels: string[],
  meta: {
    restaurantLabel: string;
    period_start: string;
    period_end: string;
    generatedAt: string;
    totalShifts: number;
    totalHours: number;
  }
) {
  const dataRows = rows.map((r) => columns.map((col) => formatValue(r, col, "csv")));
  const title = `Reporte de turnos`;
  const headerOffset = 5;
  const sheetData: Array<Array<string | number>> = [
    [title],
    [`Restaurante: ${meta.restaurantLabel}`],
    [`Periodo: ${meta.period_start} a ${meta.period_end}`],
    [`Generado: ${formatDateTime(meta.generatedAt)}`],
    [],
    headerLabels,
    ...dataRows,
    [],
    [`Totales: turnos ${meta.totalShifts}, horas ${formatDuration(meta.totalHours)}`],
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
  const lastCol = Math.max(columns.length - 1, 0);

  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } },
    { s: { r: headerOffset + dataRows.length + 1, c: 0 }, e: { r: headerOffset + dataRows.length + 1, c: lastCol } },
  ];

  const widths = columns.map((col, idx) => {
    const base = Math.max((headerLabels[idx] ?? col).length, 10);
    const maxValue = dataRows.reduce((acc, row) => {
      const value = row[idx];
      const len = value == null ? 0 : String(value).length;
      return Math.max(acc, len);
    }, base);
    return { wch: Math.min(40, Math.max(10, maxValue + 2)) };
  });

  worksheet["!cols"] = widths;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Reporte");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}
function buildSimplePdf(lines: string[]): Uint8Array {
  const escaped = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\r", " ").replaceAll("\n", " "));
  const textCommands = escaped.map((line, idx) => `${idx === 0 ? "" : "T* "}(${line}) Tj`).join("\n");
  const stream = `BT\n/F1 10 Tf\n50 780 Td\n14 TL\n${textCommands}\nET`;

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    `5 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(body);
}

function buildPagedPdf(pages: string[][]): Uint8Array {
  const fontSize = 10;
  const lineHeight = 12;
  const startX = 40;
  const startY = 800;

  const fontObjId = 3 + pages.length * 2;
  const objects: string[] = [];

  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
  const kids = pages.map((_, idx) => `${3 + idx * 2} 0 R`).join(" ");
  objects.push(`2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages.length} >> endobj\n`);

  pages.forEach((lines, idx) => {
    const pageObjId = 3 + idx * 2;
    const contentObjId = pageObjId + 1;

    const escaped = lines.map((line) =>
      line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\r", " ").replaceAll("\n", " ")
    );
    const textCommands = escaped.map((line, i) => `${i === 0 ? "" : "T* "}(${line}) Tj`).join("\n");
    const stream = `BT\n/F1 ${fontSize} Tf\n${startX} ${startY} Td\n${lineHeight} TL\n${textCommands}\nET`;

    objects.push(
      `${pageObjId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >> endobj\n`
    );
    objects.push(`${contentObjId} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`);
  });

  objects.push(`${fontObjId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj\n`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(body);
}

serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const request_id = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  let status = 200;
  let error_code: string | undefined;
  let userId: string | undefined;
  let userRole: "super_admin" | "supervisora" | "empleado" | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["supervisora", "super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 10, window_seconds: 60 });

    const { restaurant_id, period_start, period_end } = payload;
    if (period_start > period_end) {
      throw { code: 422, message: "Rango de fechas invalido", category: "VALIDATION" };
    }

    if (user.role === "supervisora") {
      await ensureSupervisorRestaurantAccess(user.id, restaurant_id);
    }

    const generatedAt = new Date().toISOString();
    const rawColumns = payload.columns && payload.columns.length > 0
      ? payload.columns
      : [...defaultColumns];

    const selectedColumns = rawColumns.map((col) => {
      const normalized = normalizeColumnKey(col);
      return columnAliases[normalized] ?? col;
    });

    const invalidColumns = selectedColumns.filter((col) => !allowedColumns.includes(col as (typeof allowedColumns)[number]));
    if (invalidColumns.length > 0) {
      throw {
        code: 422,
        message: `Columnas no soportadas: ${invalidColumns.join(", ")}`,
        category: "VALIDATION",
        details: { allowed: allowedColumns },
      };
    }

    const filtros_json = {
      period_start,
      period_end,
      filters: payload.filtros_json ?? {},
      columns: selectedColumns,
      export_format: payload.export_format ?? "both",
    };
    const hash_documento = await hashCanonicalJson(filtros_json);
    const basePath = `reports/${restaurant_id}/${period_start}_${period_end}/${request_id}`;
    const file_path = `${basePath}.json`;

    const fromIso = `${period_start}T00:00:00.000Z`;
    const toIso = `${period_end}T23:59:59.999Z`;

    const { data: shifts, error: shiftsError } = await clientUser
      .from("shifts")
      .select("id, employee_id, restaurant_id, start_time, end_time, state, status, approved_by, rejected_by, early_end_reason")
      .eq("restaurant_id", restaurant_id)
      .gte("start_time", fromIso)
      .lte("start_time", toIso)
      .order("start_time", { ascending: true });

    if (shiftsError) {
      throw { code: 409, message: "No se pudieron consultar turnos para el reporte", category: "BUSINESS", details: shiftsError };
    }

    const employeeIds = [...new Set((shifts ?? []).map((s) => String(s.employee_id)).filter((id) => id && id !== "null"))];
    const supervisorIds = [...new Set((shifts ?? []).map((s) => [s.approved_by, s.rejected_by]).flat().filter(Boolean).map((id) => String(id)))];
    const restaurantIds = [restaurant_id];
    const shiftIds = (shifts ?? []).map((s) => s.id);

    const [usersRes, restaurantsRes, photosRes, incidentsRes, scheduledRes] = await Promise.all([
      employeeIds.length || supervisorIds.length
        ? clientAdmin.from("users").select("id, full_name").in("id", [...new Set([...employeeIds, ...supervisorIds])])
        : Promise.resolve({ data: [], error: null }),
      restaurantIds.length
        ? clientAdmin.from("restaurants").select("id, name").in("id", restaurantIds)
        : Promise.resolve({ data: [], error: null }),
      (shifts ?? []).length
        ? clientAdmin
            .from("shift_photos")
            .select("shift_id, type, storage_path, captured_at, meta, created_at")
            .in("shift_id", (shifts ?? []).map((s) => s.id))
            .in("type", ["inicio", "fin"])
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      shiftIds.length
        ? clientAdmin
            .from("shift_incidents")
            .select("id, shift_id")
            .in("shift_id", shiftIds)
        : Promise.resolve({ data: [], error: null }),
      shiftIds.length
        ? clientAdmin
            .from("scheduled_shifts")
            .select("started_shift_id, scheduled_start, scheduled_end")
            .in("started_shift_id", shiftIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if ((usersRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar nombres de usuarios", category: "BUSINESS", details: (usersRes as { error?: unknown }).error };
    }
    if ((restaurantsRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar restaurantes", category: "BUSINESS", details: (restaurantsRes as { error?: unknown }).error };
    }
    if ((photosRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar evidencias de turnos", category: "BUSINESS", details: (photosRes as { error?: unknown }).error };
    }
    if ((incidentsRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar incidentes", category: "BUSINESS", details: (incidentsRes as { error?: unknown }).error };
    }
    if ((scheduledRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar turnos programados", category: "BUSINESS", details: (scheduledRes as { error?: unknown }).error };
    }

    const userNameMap = new Map((usersRes as { data?: Array<{ id: string; full_name: string | null }> }).data?.map((u) => [String(u.id), u.full_name ?? null]) ?? []);
    const restaurantNameMap = new Map((restaurantsRes as { data?: Array<{ id: number; name: string | null }> }).data?.map((r) => [Number(r.id), r.name ?? null]) ?? []);

    const startEvidence = new Map<number, string>();
    const endEvidence = new Map<number, string>();
    const evidenceByShift = new Map<
      number,
      { start: Array<Record<string, unknown>>; end: Array<Record<string, unknown>> }
    >();

    for (const photo of ((photosRes as {
      data?: Array<{ shift_id: number; type: string; storage_path: string | null; captured_at: string | null; meta: Record<string, unknown> | null }>;
    }).data ?? [])) {
      if (!photo.storage_path) continue;

      if (photo.type === "inicio" && !startEvidence.has(photo.shift_id)) {
        startEvidence.set(photo.shift_id, photo.storage_path);
      }
      if (photo.type === "fin" && !endEvidence.has(photo.shift_id)) {
        endEvidence.set(photo.shift_id, photo.storage_path);
      }

      const meta = (photo.meta && typeof photo.meta === "object") ? (photo.meta as Record<string, unknown>) : {};
      const areaLabel = typeof meta.area_label === "string" ? meta.area_label : null;
      const subareaLabel = typeof meta.subarea_label === "string" ? meta.subarea_label : null;
      const photoLabel = typeof meta.photo_label === "string" ? meta.photo_label : null;

      const entry = evidenceByShift.get(photo.shift_id) ?? { start: [], end: [] };
      const payload = {
        path: photo.storage_path,
        captured_at: photo.captured_at ?? null,
        area_label: areaLabel,
        subarea_label: subareaLabel,
        photo_label: photoLabel,
      };

      if (photo.type === "inicio") entry.start.push(payload);
      if (photo.type === "fin") entry.end.push(payload);
      evidenceByShift.set(photo.shift_id, entry);
    }

    const scheduledByShiftId = new Map<number, { scheduled_start: string | null; scheduled_end: string | null }>();
    for (const row of ((scheduledRes as { data?: Array<{ started_shift_id: number | null; scheduled_start: string | null; scheduled_end: string | null }> }).data ?? [])) {
      if (row.started_shift_id == null) continue;
      const key = Number(row.started_shift_id);
      if (!Number.isFinite(key)) continue;
      if (!scheduledByShiftId.has(key)) {
        scheduledByShiftId.set(key, { scheduled_start: row.scheduled_start ?? null, scheduled_end: row.scheduled_end ?? null });
      }
    }

    const incidentsCount = new Map<number, number>();
    for (const incident of ((incidentsRes as { data?: Array<{ shift_id: number }> }).data ?? [])) {
      const key = Number(incident.shift_id);
      incidentsCount.set(key, (incidentsCount.get(key) ?? 0) + 1);
    }

    const rows = (shifts ?? []).map((s) => {
      const start = s.start_time ? new Date(String(s.start_time)) : null;
      const end = s.end_time ? new Date(String(s.end_time)) : null;
      const hours = start && end ? Math.max(0, (end.getTime() - start.getTime()) / 3600000) : null;
      const scheduled = scheduledByShiftId.get(Number(s.id));
      const scheduled_hours = diffHours(String(scheduled?.scheduled_start ?? null), String(scheduled?.scheduled_end ?? null));
      const ended_early =
        !!scheduled?.scheduled_end &&
        !!s.end_time &&
        new Date(String(s.end_time)).getTime() < new Date(String(scheduled.scheduled_end)).getTime();
      return {
        shift_id: s.id,
        employee_id: s.employee_id,
        employee_name: userNameMap.get(String(s.employee_id)) ?? null,
        restaurant_id: s.restaurant_id,
        restaurant_name: restaurantNameMap.get(Number(s.restaurant_id)) ?? null,
        start_time: s.start_time,
        end_time: s.end_time,
        hours_worked: hours == null ? null : Number(hours.toFixed(2)),
        worked_hours: hours == null ? null : Number(hours.toFixed(2)),
        scheduled_start: scheduled?.scheduled_start ?? null,
        scheduled_end: scheduled?.scheduled_end ?? null,
        scheduled_hours,
        state: s.state,
        status: s.status,
        ended_early,
        early_end_reason: (s as { early_end_reason?: string | null }).early_end_reason ?? null,
        approved_by: s.approved_by ?? null,
        approved_by_name: s.approved_by ? userNameMap.get(String(s.approved_by)) ?? null : null,
        rejected_by: s.rejected_by ?? null,
        rejected_by_name: s.rejected_by ? userNameMap.get(String(s.rejected_by)) ?? null : null,
        supervisor_name: s.approved_by
          ? userNameMap.get(String(s.approved_by)) ?? null
          : s.rejected_by
            ? userNameMap.get(String(s.rejected_by)) ?? null
            : null,
        start_evidence_path: startEvidence.get(Number(s.id)) ?? null,
        end_evidence_path: endEvidence.get(Number(s.id)) ?? null,
        start_evidences: evidenceByShift.get(Number(s.id))?.start ?? [],
        end_evidences: evidenceByShift.get(Number(s.id))?.end ?? [],
        incidents_count: incidentsCount.get(Number(s.id)) ?? 0,
      };
    });

    const totalScheduledHours = rows.reduce((acc, r) => acc + (r.scheduled_hours ?? 0), 0);
    const totalWorkedHours = rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0);

    const csvHeader = selectedColumns;
    const csvHeaderLabels = selectedColumns.map((col) => columnLabel[col] ?? col);
    const csvBody = rows
      .map((r) =>
        csvHeader
          .map((h) => csvEscape(formatValue(r as Record<string, unknown>, h, "csv")))
          .join(",")
      )
      .join("\n");
    const csvContent = `sep=,\n${csvHeaderLabels.join(",")}\n${csvBody}`;

    const pdfHeaderLine = selectedColumns.map((col) => {
      const label = columnLabel[col] ?? col;
      return label;
    });

    const baseWidths = selectedColumns.map((col) => {
      const widthMap: Record<string, number> = {
        restaurant_name: 22,
        employee_name: 18,
        start_time: 16,
        end_time: 16,
        hours_worked: 8,
        incidents_count: 8,
        state: 10,
        status: 10,
        start_evidence_path: 12,
        end_evidence_path: 12,
        employee_id: 12,
        restaurant_id: 10,
        shift_id: 10,
        approved_by: 12,
        approved_by_name: 16,
        rejected_by: 12,
        rejected_by_name: 16,
        supervisor_name: 18,
      };
      return widthMap[col] ?? Math.max(10, (columnLabel[col] ?? col).length);
    });

    const minWidths = selectedColumns.map(() => 6);
    const maxLineWidth = 110;
    const widths = [...baseWidths];
    const totalWidth = () => widths.reduce((acc, w) => acc + w, 0) + Math.max(0, widths.length - 1) * 3;
    while (totalWidth() > maxLineWidth) {
      let maxIdx = 0;
      for (let i = 1; i < widths.length; i += 1) {
        if (widths[i] > widths[maxIdx]) maxIdx = i;
      }
      if (widths[maxIdx] <= minWidths[maxIdx]) break;
      widths[maxIdx] -= 1;
    }

    const headerLine = selectedColumns
      .map((col, idx) => formatCell(columnLabel[col] ?? col, widths[idx]).padEnd(widths[idx], " "))
      .join(" | ");
    const separator = "-".repeat(Math.min(headerLine.length, maxLineWidth));

    const dataLines = rows.map((r) =>
      selectedColumns
        .map((col, idx) => formatCell(formatValue(r as Record<string, unknown>, col, "pdf"), widths[idx]).padEnd(widths[idx], " "))
        .join(" | ")
    );

    const totalHours = rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0);
    const restaurantLabel = restaurantNameMap.get(Number(restaurant_id)) ?? `#${restaurant_id}`;
    const infoLines = [
      `Reporte restaurante: ${restaurantLabel}`,
      `Periodo: ${period_start} a ${period_end}`,
      `Generado: ${formatDateTime(generatedAt)}`,
      `Total turnos: ${rows.length}`,
      `Horas acumuladas: ${formatDuration(totalHours)}`,
    ];

    const maxLinesPerPage = 60;
    const pages: string[][] = [];
    let current: string[] = [];
    const pushPage = () => {
      if (current.length > 0) pages.push(current);
      current = [];
    };

    const appendLines = (lines: string[]) => {
      for (const line of lines) {
        if (current.length >= maxLinesPerPage) {
          pushPage();
          current.push("Reporte (continuacion)");
          current.push(...[headerLine, separator]);
        }
        current.push(line);
      }
    };

    appendLines(infoLines);
    current.push(headerLine);
    current.push(separator);
    appendLines(dataLines);
    pushPage();

    const reportJson = {
      report_id: null,
      restaurant_id,
      period_start,
      period_end,
      generated_at: generatedAt,
      generated_by: user.id,
      filtros_json,
      totals: {
        shifts: rows.length,
        hours_worked: Number(rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0).toFixed(2)),
        total_scheduled_hours: Number(totalScheduledHours.toFixed(2)),
        total_worked_hours: Number(totalWorkedHours.toFixed(2)),
        restaurant_worked_hours_total: Number(totalWorkedHours.toFixed(2)),
        restaurant_scheduled_hours_total: Number(totalScheduledHours.toFixed(2)),
      },
      columns: selectedColumns,
      rows,
    };

    const uploadOperations: Array<Promise<unknown>> = [];
    const csvPath = `${basePath}.csv`;
    const xlsxPath = `${basePath}.xlsx`;
    const pdfPath = `${basePath}.pdf`;

    const exportFormat = payload.export_format ?? "both";
    const includeCsv = exportFormat === "csv";
    const includeXlsx = exportFormat === "xlsx" || exportFormat === "both";
    const includePdf = exportFormat === "pdf" || exportFormat === "both";

    if (includeCsv) {
      uploadOperations.push(
        clientAdmin.storage.from("reports").upload(csvPath, new Blob([csvContent], { type: "text/csv; charset=utf-8" }), {
          contentType: "text/csv; charset=utf-8",
          upsert: true,
        })
      );
    }

    if (includeXlsx) {
      const xlsxBinary = buildXlsxWorkbook(rows as Array<Record<string, unknown>>, selectedColumns, csvHeaderLabels, {
        restaurantLabel,
        period_start,
        period_end,
        generatedAt,
        totalShifts: rows.length,
        totalHours,
      });
      uploadOperations.push(
        clientAdmin.storage.from("reports").upload(
          xlsxPath,
          new Blob([xlsxBinary], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          {
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            upsert: true,
          }
        )
      );
    }

    if (includePdf) {
      uploadOperations.push(
        clientAdmin.storage.from("reports").upload(pdfPath, new Blob([buildPagedPdf(pages)], { type: "application/pdf" }), {
          contentType: "application/pdf",
          upsert: true,
        })
      );
    }

    uploadOperations.push(
      clientAdmin.storage.from("reports").upload(file_path, new Blob([JSON.stringify(reportJson, null, 2)], { type: "application/json" }), {
        contentType: "application/json",
        upsert: true,
      })
    );

    const uploads = await Promise.all(uploadOperations);
    for (const uploaded of uploads) {
      const typed = uploaded as { error?: unknown };
      if (typed?.error) {
        throw { code: 500, message: "No se pudieron subir artefactos del reporte", category: "SYSTEM", details: typed.error };
      }
    }

    let url_excel = "";
    let url_pdf = "";

    if (includeCsv) {
      const { data: csvSigned, error: csvSignedError } = await clientAdmin.storage.from("reports").createSignedUrl(csvPath, 60 * 60 * 24 * 7);
      if (csvSignedError || !csvSigned?.signedUrl) {
        throw { code: 500, message: "No se pudo generar URL firmada CSV", category: "SYSTEM", details: csvSignedError };
      }
      url_excel = csvSigned.signedUrl;
    }

    if (includeXlsx) {
      const { data: xlsxSigned, error: xlsxSignedError } = await clientAdmin.storage.from("reports").createSignedUrl(xlsxPath, 60 * 60 * 24 * 7);
      if (xlsxSignedError || !xlsxSigned?.signedUrl) {
        throw { code: 500, message: "No se pudo generar URL firmada XLSX", category: "SYSTEM", details: xlsxSignedError };
      }
      url_excel = xlsxSigned.signedUrl;
    }

    if (includePdf) {
      const { data: pdfSigned, error: pdfSignedError } = await clientAdmin.storage.from("reports").createSignedUrl(pdfPath, 60 * 60 * 24 * 7);
      if (pdfSignedError || !pdfSigned?.signedUrl) {
        throw { code: 500, message: "No se pudo generar URL firmada PDF", category: "SYSTEM", details: pdfSignedError };
      }
      url_pdf = pdfSigned.signedUrl;
    }

    const { data, error } = await clientUser
      .from("reports")
      .insert({
        restaurant_id,
        period_start,
        period_end,
        generated_by: user.id,
        generado_por: user.id,
        generated_at: generatedAt,
        filtros_json,
        file_path,
        hash_documento,
        url_pdf,
        url_excel,
      })
      .select("id, generated_at, file_path, hash_documento, url_pdf, url_excel")
      .single();

    if (error || !data) {
      throw { code: 409, message: "No se pudo generar reporte", category: "BUSINESS", details: error };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "REPORT_GENERATE",
      context: {
        report_id: data.id,
        restaurant_id,
        period_start,
        period_end,
        file_path: data.file_path ?? file_path,
        hash_documento: data.hash_documento ?? hash_documento,
      },
      request_id,
    });

    const successPayload = {
      success: true,
      data: {
        report_id: data.id,
        generated_at: data.generated_at ?? generatedAt,
        file_path: data.file_path ?? file_path,
        hash_documento: data.hash_documento ?? hash_documento,
        url_pdf: data.url_pdf ?? url_pdf,
        url_excel: data.url_excel ?? url_excel,
        totals: reportJson.totals,
      },
      error: null,
      request_id,
    };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, successPayload.data, null, request_id);
  } catch (err) {
    const apiError = errorHandler(err, request_id);
    status = apiError.code;
    error_code = apiError.category;

    if (userId && idempotencyKey) {
      const failPayload = { success: false, data: null, error: apiError, request_id };
      await safeFinalizeIdempotency({ userId, endpoint, key: idempotencyKey, statusCode: apiError.code, responseBody: failPayload });
    }

    return response(false, null, apiError, request_id);
  } finally {
    logRequest({
      request_id,
      endpoint,
      method: req.method,
      ip,
      user_agent: userAgent,
      user: userId && userRole ? { id: userId, role: userRole } : undefined,
      duration_ms: Date.now() - startedAt,
      status,
      error_code,
    });
  }
});

