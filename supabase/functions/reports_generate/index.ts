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

function csvEscape(value: unknown) {
  const raw = value == null ? "" : String(value);
  if (raw.includes(",") || raw.includes("\n") || raw.includes("\"")) {
    return `"${raw.replaceAll("\"", "\"\"")}"`;
  }
  return raw;
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
    const filtros_json = {
      period_start,
      period_end,
      filters: payload.filtros_json ?? {},
      columns: payload.columns ?? [],
      export_format: payload.export_format ?? "both",
    };
    const hash_documento = await hashCanonicalJson(filtros_json);
    const basePath = `reports/${restaurant_id}/${period_start}_${period_end}/${request_id}`;
    const file_path = `${basePath}.json`;

    const fromIso = `${period_start}T00:00:00.000Z`;
    const toIso = `${period_end}T23:59:59.999Z`;

    const { data: shifts, error: shiftsError } = await clientUser
      .from("shifts")
      .select("id, employee_id, restaurant_id, start_time, end_time, state, status")
      .eq("restaurant_id", restaurant_id)
      .gte("start_time", fromIso)
      .lte("start_time", toIso)
      .order("start_time", { ascending: true });

    if (shiftsError) {
      throw { code: 409, message: "No se pudieron consultar turnos para el reporte", category: "BUSINESS", details: shiftsError };
    }

    const rows = (shifts ?? []).map((s) => {
      const start = s.start_time ? new Date(String(s.start_time)) : null;
      const end = s.end_time ? new Date(String(s.end_time)) : null;
      const hours = start && end ? Math.max(0, (end.getTime() - start.getTime()) / 3600000) : null;
      return {
        shift_id: s.id,
        employee_id: s.employee_id,
        restaurant_id: s.restaurant_id,
        start_time: s.start_time,
        end_time: s.end_time,
        hours_worked: hours == null ? null : Number(hours.toFixed(2)),
        state: s.state,
        status: s.status,
      };
    });

    const csvHeader = ["shift_id", "employee_id", "restaurant_id", "start_time", "end_time", "hours_worked", "state", "status"];
    const csvBody = rows.map((r) => csvHeader.map((h) => csvEscape((r as Record<string, unknown>)[h])).join(",")).join("\n");
    const csvContent = `${csvHeader.join(",")}\n${csvBody}`;

    const pdfLines = [
      `Reporte restaurante #${restaurant_id}`,
      `Periodo: ${period_start} a ${period_end}`,
      `Generado: ${generatedAt}`,
      `Total turnos: ${rows.length}`,
      `Horas acumuladas: ${rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0).toFixed(2)}`,
    ];

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
        clientAdmin.storage.from("reports").upload(pdfPath, new Blob([buildSimplePdf(pdfLines)], { type: "application/pdf" }), {
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

