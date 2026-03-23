import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
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
  export_format: z.enum(["csv", "pdf", "both"]).optional(),
});

const allowedColumns = [
  "shift_id",
  "employee_id",
  "employee_name",
  "restaurant_id",
  "restaurant_name",
  "start_time",
  "end_time",
  "hours_worked",
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
  "restaurant_name",
  "employee_name",
  "start_time",
  "end_time",
  "hours_worked",
  "state",
  "start_evidence_path",
  "end_evidence_path",
] as const;

const columnLabel: Record<string, string> = {
  shift_id: "Shift ID",
  employee_id: "Empleado ID",
  employee_name: "Empleado",
  restaurant_id: "Restaurante ID",
  restaurant_name: "Restaurante",
  start_time: "Inicio",
  end_time: "Fin",
  hours_worked: "Horas",
  state: "Estado",
  status: "Status",
  approved_by: "Aprobado por (ID)",
  approved_by_name: "Aprobado por",
  rejected_by: "Rechazado por (ID)",
  rejected_by_name: "Rechazado por",
  start_evidence_path: "Evidencia inicio",
  end_evidence_path: "Evidencia fin",
};

function csvEscape(value: unknown) {
  const raw = value == null ? "" : String(value);
  if (raw.includes(",") || raw.includes("\n") || raw.includes("\"")) {
    return `"${raw.replaceAll("\"", "\"\"")}"`;
  }
  return raw;
}

function formatCell(value: unknown, maxLen = 40) {
  const raw = value == null ? "" : String(value);
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(0, maxLen - 3))}...`;
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
    const selectedColumns = (payload.columns && payload.columns.length > 0)
      ? payload.columns
      : [...defaultColumns];

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
      .select("id, employee_id, restaurant_id, start_time, end_time, state, status, approved_by, rejected_by")
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

    const [usersRes, restaurantsRes, photosRes] = await Promise.all([
      employeeIds.length || supervisorIds.length
        ? clientAdmin.from("users").select("id, full_name").in("id", [...new Set([...employeeIds, ...supervisorIds])])
        : Promise.resolve({ data: [], error: null }),
      restaurantIds.length
        ? clientAdmin.from("restaurants").select("id, name").in("id", restaurantIds)
        : Promise.resolve({ data: [], error: null }),
      (shifts ?? []).length
        ? clientAdmin
            .from("shift_photos")
            .select("shift_id, type, storage_path, created_at")
            .in("shift_id", (shifts ?? []).map((s) => s.id))
            .in("type", ["inicio", "fin"])
            .order("created_at", { ascending: true })
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

    const userNameMap = new Map((usersRes as { data?: Array<{ id: string; full_name: string | null }> }).data?.map((u) => [String(u.id), u.full_name ?? null]) ?? []);
    const restaurantNameMap = new Map((restaurantsRes as { data?: Array<{ id: number; name: string | null }> }).data?.map((r) => [Number(r.id), r.name ?? null]) ?? []);

    const startEvidence = new Map<number, string>();
    const endEvidence = new Map<number, string>();
    for (const photo of ((photosRes as { data?: Array<{ shift_id: number; type: string; storage_path: string | null }> }).data ?? [])) {
      if (photo.type === "inicio" && !startEvidence.has(photo.shift_id)) {
        if (photo.storage_path) startEvidence.set(photo.shift_id, photo.storage_path);
      }
      if (photo.type === "fin" && !endEvidence.has(photo.shift_id)) {
        if (photo.storage_path) endEvidence.set(photo.shift_id, photo.storage_path);
      }
    }

    const rows = (shifts ?? []).map((s) => {
      const start = s.start_time ? new Date(String(s.start_time)) : null;
      const end = s.end_time ? new Date(String(s.end_time)) : null;
      const hours = start && end ? Math.max(0, (end.getTime() - start.getTime()) / 3600000) : null;
      return {
        shift_id: s.id,
        employee_id: s.employee_id,
        employee_name: userNameMap.get(String(s.employee_id)) ?? null,
        restaurant_id: s.restaurant_id,
        restaurant_name: restaurantNameMap.get(Number(s.restaurant_id)) ?? null,
        start_time: s.start_time,
        end_time: s.end_time,
        hours_worked: hours == null ? null : Number(hours.toFixed(2)),
        state: s.state,
        status: s.status,
        approved_by: s.approved_by ?? null,
        approved_by_name: s.approved_by ? userNameMap.get(String(s.approved_by)) ?? null : null,
        rejected_by: s.rejected_by ?? null,
        rejected_by_name: s.rejected_by ? userNameMap.get(String(s.rejected_by)) ?? null : null,
        start_evidence_path: startEvidence.get(Number(s.id)) ?? null,
        end_evidence_path: endEvidence.get(Number(s.id)) ?? null,
      };
    });

    const csvHeader = selectedColumns;
    const csvHeaderLabels = selectedColumns.map((col) => columnLabel[col] ?? col);
    const csvBody = rows.map((r) => csvHeader.map((h) => csvEscape((r as Record<string, unknown>)[h])).join(",")).join("\n");
    const csvContent = `${csvHeaderLabels.join(",")}\n${csvBody}`;

    const pdfHeaderLine = selectedColumns.map((col) => {
      const label = columnLabel[col] ?? col;
      return label;
    });

    const baseWidths = selectedColumns.map((col) => {
      const widthMap: Record<string, number> = {
        restaurant_name: 20,
        employee_name: 20,
        start_time: 16,
        end_time: 16,
        hours_worked: 6,
        state: 10,
        status: 10,
        start_evidence_path: 22,
        end_evidence_path: 22,
        employee_id: 12,
        restaurant_id: 10,
        shift_id: 10,
        approved_by: 12,
        approved_by_name: 18,
        rejected_by: 12,
        rejected_by_name: 18,
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
        .map((col, idx) => formatCell((r as Record<string, unknown>)[col], widths[idx]).padEnd(widths[idx], " "))
        .join(" | ")
    );

    const infoLines = [
      `Reporte restaurante #${restaurant_id}`,
      `Periodo: ${period_start} a ${period_end}`,
      `Generado: ${generatedAt}`,
      `Total turnos: ${rows.length}`,
      `Horas acumuladas: ${rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0).toFixed(2)}`,
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
      },
      columns: selectedColumns,
      rows,
    };

    const uploadOperations: Array<Promise<unknown>> = [];
    const csvPath = `${basePath}.csv`;
    const pdfPath = `${basePath}.pdf`;

    if ((payload.export_format ?? "both") !== "pdf") {
      uploadOperations.push(
        clientAdmin.storage.from("reports").upload(csvPath, new Blob([csvContent], { type: "text/csv; charset=utf-8" }), {
          contentType: "text/csv; charset=utf-8",
          upsert: true,
        })
      );
    }

    if ((payload.export_format ?? "both") !== "csv") {
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

    if ((payload.export_format ?? "both") !== "pdf") {
      const { data: csvSigned, error: csvSignedError } = await clientAdmin.storage.from("reports").createSignedUrl(csvPath, 60 * 60 * 24 * 7);
      if (csvSignedError || !csvSigned?.signedUrl) {
        throw { code: 500, message: "No se pudo generar URL firmada CSV", category: "SYSTEM", details: csvSignedError };
      }
      url_excel = csvSigned.signedUrl;
    }

    if ((payload.export_format ?? "both") !== "csv") {
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

